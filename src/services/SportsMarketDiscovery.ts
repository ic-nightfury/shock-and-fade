/**
 * Sports Market Discovery Service
 *
 * Discovers and tracks active sports markets in real-time for the SSS strategy.
 * Polls Gamma API at configurable intervals and emits events for market state changes.
 *
 * Features:
 * - Filters for moneyline markets only (excludes spread, totals, props)
 * - Excludes e-sports markets
 * - Sport-specific filtering based on sss_sport_params.json config
 * - Tracks market states: discovered, pending_entry, active, closed
 * - Emits events: newMarket, marketStartingSoon, marketEnded
 * - Rate limit compliant with Gamma API limits
 *
 * Usage:
 *   const discovery = new SportsMarketDiscovery();
 *   discovery.on('newMarket', (market) => { ... });
 *   discovery.on('marketStartingSoon', (countdown) => { ... });
 *   discovery.on('marketEnded', (info) => { ... });
 *   await discovery.start();
 */

import { EventEmitter } from "events";
import axios from "axios";
import * as fs from "fs";
import * as path from "path";

// Configuration
const GAMMA_API = "https://gamma-api.polymarket.com";
const DEFAULT_DISCOVERY_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const ENTRY_WINDOW_MINUTES = 10; // First 10 minutes after game start
const STATE_CHECK_INTERVAL_MS = 30 * 1000; // 30 seconds

// Load sport params from config file
const CONFIG_PATH = path.join(
  __dirname,
  "..",
  "config",
  "sss_sport_params.json",
);

// Soccer league prefixes (from US-700 feasibility analysis)
// EPL and UCL have CONDITIONAL GO status, others need more data
const SOCCER_LEAGUE_PREFIXES = [
  "epl", // English Premier League - CONDITIONAL GO ($15.6M avg/game)
  "ucl", // UEFA Champions League - CONDITIONAL GO ($7.5M avg/game)
  "lal", // La Liga - NEEDS MORE DATA
  "bun", // Bundesliga - NEEDS MORE DATA
  "sea", // Serie A - NEEDS MORE DATA
  "fl1", // Ligue 1 - NO DATA
  "uel", // UEFA Europa League - NO-GO (below threshold)
] as const;

// Individual game MONEYLINE slug pattern (excludes spread, total, props)
// Format: {sport}-{team1}-{team2} or {sport}-{team1}-vs-{team2} or {sport}-{team1}-{team2}-{date}
// Soccer format varies: epl-tottenham-vs-everton, ucl-real-madrid-vs-vfb-stuttgart, etc.
const US_SPORTS_PATTERN =
  /^(nba|nhl|nfl|mlb|cbb|cfb)-[a-z]{2,10}-[a-z]{2,10}-\d{4}-\d{2}-\d{2}$/i;
const SOCCER_PATTERN =
  /^(epl|ucl|lal|bun|sea|fl1|uel)-[a-z]{2,15}(-vs)?-[a-z]{2,15}(-[a-z]{2,15})?(-\d{4}-\d{2}-\d{2})?$/i;

// Combined pattern for any individual game market
const INDIVIDUAL_GAME_PATTERN = {
  test: (slug: string): boolean => {
    return US_SPORTS_PATTERN.test(slug) || SOCCER_PATTERN.test(slug);
  },
};

// E-sports keywords to exclude
const EXCLUDED_KEYWORDS = [
  "esports",
  "e-sports",
  "league-of-legends",
  "counter-strike",
  "cs2",
  "valorant",
  "dota",
  "overwatch",
  "call-of-duty",
  "rocket-league",
  "fortnite",
  "pubg",
];

// Sports list (for slug extraction) - US sports
const US_SPORTS = [
  "nba",
  "nhl",
  "nfl",
  "mlb",
  "cbb",
  "cfb",
  "tennis",
  "ufc",
  "boxing",
  "cricket",
];

// Combined list of all sport prefixes (US sports + soccer leagues)
const ALL_SPORTS = [...US_SPORTS, ...SOCCER_LEAGUE_PREFIXES];

/**
 * Market state enumeration
 */
export enum MarketState {
  DISCOVERED = "discovered", // Newly found, before game start
  PENDING_ENTRY = "pending_entry", // Within entry window (first 10 mins of game)
  ACTIVE = "active", // Game in progress (past entry window)
  CLOSED = "closed", // Game ended
}

/**
 * Sport configuration from sss_sport_params.json
 */
export interface SportConfig {
  enabled: boolean;
  priority: number;
  sell_threshold: number;
  reversal_rate_at_threshold: number;
  expected_ev_per_dollar: number;
  min_volume_24h: number;
  min_bet_size: number;
  max_bet_size: number;
  feasibility_tier: string;
  confidence_level: string;
  season?: {
    start_month: number;
    end_month: number;
  };
}

/**
 * Discovered sports market info
 */
export interface SportsMarket {
  // Identification
  eventSlug: string;
  marketSlug: string;
  conditionId?: string;

  // Market details
  sport: string;
  question: string;
  outcomes: string[];
  tokenIds: string[];

  // Soccer-specific: league prefix (EPL, UCL, etc.)
  leaguePrefix?: string;

  // Pricing (string format from API, parsed to numbers)
  outcomePrices: number[];

  // Timing
  gameStartTime: Date | null;
  discoveredAt: Date;

  // Volume/Liquidity
  volume: number;
  liquidity: number;

  // State
  state: MarketState;
  stateChangedAt: Date;

  // Sport config (from sss_sport_params.json)
  sportConfig: SportConfig | null;

  // NegRisk flag from Polymarket API
  // true = multi-outcome market using NegRiskAdapter (requires 0% fee)
  // false = standard binary market (requires 10% fee for 15-min markets)
  negRisk: boolean;
}

/**
 * Event data for marketStartingSoon event
 */
export interface MarketCountdown {
  market: SportsMarket;
  minutesUntilStart: number;
  isWithinEntryWindow: boolean;
}

/**
 * Event data for marketEnded event
 */
export interface MarketClosure {
  market: SportsMarket;
  reason: "game_ended" | "expired" | "settled";
}

/**
 * Discovery statistics
 */
export interface DiscoveryStats {
  marketsTracked: number;
  marketsDiscovered: number;
  marketsInEntryWindow: number;
  marketsActive: number;
  marketsClosed: number;
  lastDiscoveryAt: number;
  errors: number;
  discoveryCount: number;
}

/**
 * Sports Market Discovery Service
 */
export class SportsMarketDiscovery extends EventEmitter {
  private running = false;
  private discoveryInterval: NodeJS.Timeout | null = null;
  private stateCheckInterval: NodeJS.Timeout | null = null;
  private discoveryIntervalMs: number;

  // Market tracking
  private markets: Map<string, SportsMarket> = new Map(); // marketSlug -> market

  // Configuration
  private sportParams: Record<string, SportConfig> = {};
  private enabledSports: string[] = [];
  private globalDefaults: Record<string, any> = {};

  // Stats
  private stats: DiscoveryStats = {
    marketsTracked: 0,
    marketsDiscovered: 0,
    marketsInEntryWindow: 0,
    marketsActive: 0,
    marketsClosed: 0,
    lastDiscoveryAt: 0,
    errors: 0,
    discoveryCount: 0,
  };

  constructor(
    discoveryIntervalMs: number = DEFAULT_DISCOVERY_INTERVAL_MS,
    configOverride?: { enabled_sports?: string[] }
  ) {
    super();
    this.discoveryIntervalMs = discoveryIntervalMs;
    this.loadConfig(configOverride);
  }

  /**
   * Load configuration from sss_sport_params.json
   * Accepts optional configOverride to isolate different use cases (e.g., spread scanner vs shock-fade)
   */
  private loadConfig(configOverride?: { enabled_sports?: string[] }): void {
    try {
      if (fs.existsSync(CONFIG_PATH)) {
        const config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
        this.sportParams = config.sports || {};
        
        // Use override if provided, otherwise use file config
        if (configOverride?.enabled_sports) {
          this.enabledSports = configOverride.enabled_sports;
          this.log(
            `Config override applied: ${this.enabledSports.length} sports enabled (${this.enabledSports.join(", ")})`,
          );
        } else {
          this.enabledSports = config.enabled_sports || [];
          this.log(
            `Loaded config: ${this.enabledSports.length} sports enabled (${this.enabledSports.join(", ")})`,
          );
        }
        
        this.globalDefaults = config.global_defaults || {};
      } else {
        // Default config if file not found
        this.enabledSports = configOverride?.enabled_sports || ["NHL", "NFL", "NBA"];
        this.log(
          `Config file not found, using ${configOverride ? 'override' : 'defaults'}: ${this.enabledSports.join(", ")}`,
          "WARN",
        );
      }
    } catch (err) {
      this.log(`Error loading config: ${err}`, "ERROR");
      this.enabledSports = configOverride?.enabled_sports || ["NHL", "NFL", "NBA"];
    }
  }

  /**
   * Get sport config for a sport
   */
  getSportConfig(sport: string): SportConfig | null {
    const upperSport = sport.toUpperCase();
    return this.sportParams[upperSport] || null;
  }

  /**
   * Check if a sport is enabled for trading
   */
  isSportEnabled(sport: string): boolean {
    const upperSport = sport.toUpperCase();
    return this.enabledSports.includes(upperSport);
  }

  /**
   * Log helper
   */
  private log(
    message: string,
    level: "INFO" | "WARN" | "ERROR" = "INFO",
  ): void {
    const timestamp = new Date().toISOString();
    const prefix = level === "ERROR" ? "❌" : level === "WARN" ? "⚠️" : "📊";
    console.log(`${timestamp} [${level}] ${prefix} [Discovery] ${message}`);
  }

  /**
   * Check if a market is e-sports
   */
  private isEsports(slug: string, tags?: string[]): boolean {
    const lowerSlug = slug.toLowerCase();

    for (const keyword of EXCLUDED_KEYWORDS) {
      if (lowerSlug.includes(keyword)) {
        return true;
      }
    }

    if (tags) {
      for (const tag of tags) {
        const lowerTag = tag.toLowerCase();
        if (
          lowerTag.includes("esport") ||
          lowerTag.includes("gaming") ||
          EXCLUDED_KEYWORDS.some((kw) => lowerTag.includes(kw))
        ) {
          return true;
        }
      }
    }

    return false;
  }

  /**
   * Extract sport category from slug
   * Maps soccer league prefixes (epl, ucl, etc.) to 'SOCCER' sport category
   */
  private extractSportFromSlug(slug: string): string | null {
    const lowerSlug = slug.toLowerCase();

    // Check if it's a soccer league prefix - map to 'SOCCER'
    for (const prefix of SOCCER_LEAGUE_PREFIXES) {
      if (lowerSlug.startsWith(prefix + "-")) {
        return "SOCCER";
      }
    }

    // Check US sports - return uppercase name
    for (const sport of US_SPORTS) {
      if (lowerSlug.startsWith(sport + "-")) {
        return sport.toUpperCase();
      }
    }

    return null;
  }

  /**
   * Extract league prefix from slug (for soccer markets)
   * Returns the league code (EPL, UCL, etc.) or null for non-soccer markets
   */
  private extractLeaguePrefixFromSlug(slug: string): string | null {
    const lowerSlug = slug.toLowerCase();

    for (const prefix of SOCCER_LEAGUE_PREFIXES) {
      if (lowerSlug.startsWith(prefix + "-")) {
        return prefix.toUpperCase();
      }
    }

    return null;
  }

  /**
   * Parse Polymarket timestamp format
   * Handles: "YYYY-MM-DD HH:MM:SS+00" -> valid ISO
   */
  private parsePolymarketTimestamp(timeStr: string): Date | null {
    if (!timeStr) return null;

    try {
      let normalized = timeStr;
      // Handle Polymarket's non-standard +00 suffix
      if (normalized.endsWith("+00")) {
        normalized = normalized.replace("+00", "+00:00");
      }
      // Replace space with T for ISO format
      normalized = normalized.replace(" ", "T");

      const date = new Date(normalized);
      if (isNaN(date.getTime())) {
        return null;
      }
      return date;
    } catch {
      return null;
    }
  }

  /**
   * Determine market state based on game timing
   */
  private determineMarketState(gameStartTime: Date | null): MarketState {
    if (!gameStartTime) {
      return MarketState.DISCOVERED;
    }

    const now = Date.now();
    const gameStart = gameStartTime.getTime();

    // Before game start
    if (now < gameStart) {
      return MarketState.DISCOVERED;
    }

    // Within entry window (first 10 minutes after start)
    const entryWindowEnd = gameStart + ENTRY_WINDOW_MINUTES * 60 * 1000;
    if (now < entryWindowEnd) {
      return MarketState.PENDING_ENTRY;
    }

    // Past entry window but game likely still in progress (4 hours max)
    const gameEndEstimate = gameStart + 4 * 60 * 60 * 1000;
    if (now < gameEndEstimate) {
      return MarketState.ACTIVE;
    }

    // Game likely ended
    return MarketState.CLOSED;
  }

  /**
   * Fetch and discover sports markets from Gamma API
   */
  async discoverMarkets(): Promise<SportsMarket[]> {
    const discovered: SportsMarket[] = [];
    this.stats.lastDiscoveryAt = Date.now();
    this.stats.discoveryCount++;

    try {
      // Fetch ALL active events from Gamma API with pagination
      // CBB and lower-volume sports markets can be past the first 500 results
      const PAGE_SIZE = 500;
      const MAX_PAGES = 6; // Up to 3000 events total — well beyond typical active count
      const allActiveEvents: any[] = [];

      for (let page = 0; page < MAX_PAGES; page++) {
        const response = await axios.get(`${GAMMA_API}/events`, {
          params: {
            active: true,
            closed: false,
            limit: PAGE_SIZE,
            offset: page * PAGE_SIZE,
            order: "volume",
            ascending: false,
          },
          timeout: 30000,
        });

        if (!response.data || !Array.isArray(response.data) || response.data.length === 0) {
          break; // No more events
        }

        allActiveEvents.push(...response.data);

        // If we got fewer than PAGE_SIZE, we've reached the end
        if (response.data.length < PAGE_SIZE) {
          break;
        }
      }

      // Also fetch live events (games currently in progress)
      // Gamma API returns different results for live=true vs active=true
      const liveResponse = await axios.get(`${GAMMA_API}/events`, {
        params: {
          live: true,
          closed: false,
          limit: 200,
        },
        timeout: 30000,
      });

      if (allActiveEvents.length === 0) {
        this.log("No events data received from Gamma API", "WARN");
        return discovered;
      }

      // Merge active and live events, dedupe by slug
      const eventMap = new Map<string, any>();
      for (const event of allActiveEvents) {
        eventMap.set(event.slug, event);
      }
      if (liveResponse.data && Array.isArray(liveResponse.data)) {
        for (const event of liveResponse.data) {
          if (!eventMap.has(event.slug)) {
            eventMap.set(event.slug, event);
          }
        }
      }

      const events = Array.from(eventMap.values());
      this.log(
        `Fetched ${allActiveEvents.length} active (paginated) + ${liveResponse.data?.length || 0} live events from Gamma API (${events.length} unique)`,
      );

      for (const event of events) {
        // Skip if not an individual game pattern
        if (!INDIVIDUAL_GAME_PATTERN.test(event.slug)) {
          continue;
        }

        // Skip stale markets: if slug contains a date older than 2 days, skip
        const slugDateMatch = (event.slug as string).match(/(\d{4}-\d{2}-\d{2})$/);
        if (slugDateMatch) {
          const slugDate = new Date(slugDateMatch[1] + "T00:00:00Z");
          const twoDaysAgo = Date.now() - 2 * 24 * 60 * 60 * 1000;
          if (slugDate.getTime() < twoDaysAgo) {
            continue;
          }
        }

        // Skip e-sports
        const tags = event.tags?.map((t: { slug: string }) => t.slug) || [];
        if (this.isEsports(event.slug, tags)) {
          continue;
        }

        // Extract sport
        const sport = this.extractSportFromSlug(event.slug);
        if (!sport) {
          continue;
        }

        // Check if sport is enabled
        if (!this.isSportEnabled(sport)) {
          continue;
        }

        // Find moneyline market(s)
        // For US sports: single market per event
        // For soccer: 3 markets (Home Win, Draw, Away Win) - we want "Will X Win?" markets (NOT draw)
        const eventMarkets = event.markets || [];
        let moneylineMarkets: any[] = [];

        if (sport === "SOCCER") {
          // Soccer: Filter for "Will X beat/win" markets, exclude draw markets
          moneylineMarkets = eventMarkets.filter(
            (m: any) =>
              m.clobTokenIds &&
              m.question &&
              (m.question.toLowerCase().includes("beat") ||
                (m.question.toLowerCase().includes("win") &&
                  !m.question.toLowerCase().includes("draw"))),
          );
        } else {
          // US sports: Find single moneyline market
          const found = eventMarkets.find(
            (m: any) =>
              m.sportsMarketType === "moneyline" || m.slug === event.slug,
          );
          if (found) {
            moneylineMarkets = [found];
          }
        }

        if (moneylineMarkets.length === 0) {
          continue;
        }

        // For soccer, we'll add both "Will X Win?" markets (not draw)
        // For US sports, there's only one market
        const moneylineMarket = moneylineMarkets[0];

        if (!moneylineMarket || !moneylineMarket.clobTokenIds) {
          continue;
        }

        // Double-check: market slug must match base game slug
        const marketSlug = moneylineMarket.slug || event.slug;
        if (!INDIVIDUAL_GAME_PATTERN.test(marketSlug)) {
          continue;
        }

        try {
          const tokenIds = JSON.parse(moneylineMarket.clobTokenIds);
          const outcomes = JSON.parse(moneylineMarket.outcomes || "[]");
          const outcomePrices = JSON.parse(
            moneylineMarket.outcomePrices || "[]",
          ).map((p: string) => parseFloat(p));

          if (!tokenIds || tokenIds.length < 2) {
            continue;
          }

          // Parse game start time
          const gameStartTime = this.parsePolymarketTimestamp(
            moneylineMarket.gameStartTime,
          );

          // Get sport config
          const sportConfig = this.getSportConfig(sport);

          // Check volume requirement
          const volume = parseFloat(moneylineMarket.volume || "0");
          if (sportConfig && volume < sportConfig.min_volume_24h) {
            continue;
          }

          // Determine initial state
          const state = this.determineMarketState(gameStartTime);

          // Extract league prefix for soccer markets
          const leaguePrefix = this.extractLeaguePrefixFromSlug(event.slug);

          const market: SportsMarket = {
            eventSlug: event.slug,
            marketSlug,
            conditionId: moneylineMarket.conditionId,
            sport,
            question: moneylineMarket.question || event.title,
            outcomes,
            tokenIds,
            leaguePrefix: leaguePrefix || undefined,
            outcomePrices,
            gameStartTime,
            discoveredAt: new Date(),
            volume,
            liquidity: parseFloat(moneylineMarket.liquidity || "0"),
            state,
            stateChangedAt: new Date(),
            sportConfig,
            negRisk: moneylineMarket.negRisk === true, // From Gamma API response
          };

          discovered.push(market);
        } catch (err) {
          this.log(`Error parsing market ${event.slug}: ${err}`, "WARN");
        }
      }

      this.log(
        `Discovered ${discovered.length} valid sports markets (${this.enabledSports.join(", ")})`,
      );
    } catch (err) {
      this.log(`Error discovering markets: ${err}`, "ERROR");
      this.stats.errors++;
    }

    return discovered;
  }

  /**
   * Refresh markets and process state changes
   */
  async refreshMarkets(): Promise<void> {
    try {
      const discovered = await this.discoverMarkets();
      const now = Date.now();

      // Track expired markets to remove
      const toRemove: string[] = [];

      // Update existing markets and detect state changes
      const marketEntries = Array.from(this.markets.entries());
      for (const [slug, market] of marketEntries) {
        const oldState = market.state;
        const newState = this.determineMarketState(market.gameStartTime);

        if (oldState !== newState) {
          market.state = newState;
          market.stateChangedAt = new Date();

          // Emit state change events
          if (newState === MarketState.PENDING_ENTRY) {
            const countdown: MarketCountdown = {
              market,
              minutesUntilStart: 0,
              isWithinEntryWindow: true,
            };
            this.emit("marketStartingSoon", countdown);
            this.log(
              `🎯 Entry window open: ${market.marketSlug} [${market.sport}]`,
            );
          } else if (newState === MarketState.CLOSED) {
            const closure: MarketClosure = {
              market,
              reason: "game_ended",
            };
            this.emit("marketEnded", closure);
            this.log(`🏁 Market ended: ${market.marketSlug}`);
          }
        }

        // Remove markets that have been closed for > 1 hour
        if (
          market.state === MarketState.CLOSED &&
          now - market.stateChangedAt.getTime() > 60 * 60 * 1000
        ) {
          toRemove.push(slug);
        }
      }

      // Remove expired markets
      for (const slug of toRemove) {
        this.markets.delete(slug);
      }

      // Add new markets
      for (const market of discovered) {
        if (!this.markets.has(market.marketSlug)) {
          this.markets.set(market.marketSlug, market);
          this.stats.marketsDiscovered++;

          // Emit newMarket event
          this.emit("newMarket", market);
          this.log(
            `🆕 New market: ${market.marketSlug} [${market.sport}] ${market.question}`,
          );

          // If already in entry window, emit that too
          if (market.state === MarketState.PENDING_ENTRY) {
            const countdown: MarketCountdown = {
              market,
              minutesUntilStart: 0,
              isWithinEntryWindow: true,
            };
            this.emit("marketStartingSoon", countdown);
          }
        } else {
          // Update prices and volume for existing markets
          const existing = this.markets.get(market.marketSlug)!;
          existing.outcomePrices = market.outcomePrices;
          existing.volume = market.volume;
          existing.liquidity = market.liquidity;
        }
      }

      // Update stats
      this.updateStats();
    } catch (err) {
      this.log(`Error refreshing markets: ${err}`, "ERROR");
      this.stats.errors++;
    }
  }

  /**
   * Check markets for "starting soon" notifications
   */
  private checkMarketCountdowns(): void {
    const now = Date.now();
    const allMarkets = Array.from(this.markets.values());

    for (const market of allMarkets) {
      if (market.state === MarketState.DISCOVERED && market.gameStartTime) {
        const msUntilStart = market.gameStartTime.getTime() - now;
        const minutesUntilStart = msUntilStart / (60 * 1000);

        // Emit countdown for markets starting within 10 minutes
        if (
          minutesUntilStart > 0 &&
          minutesUntilStart <= ENTRY_WINDOW_MINUTES
        ) {
          const countdown: MarketCountdown = {
            market,
            minutesUntilStart,
            isWithinEntryWindow: false,
          };
          this.emit("marketStartingSoon", countdown);
        }
      }
    }
  }

  /**
   * Update statistics
   */
  private updateStats(): void {
    let inEntryWindow = 0;
    let active = 0;
    let closed = 0;

    const allMarkets = Array.from(this.markets.values());
    for (const market of allMarkets) {
      switch (market.state) {
        case MarketState.PENDING_ENTRY:
          inEntryWindow++;
          break;
        case MarketState.ACTIVE:
          active++;
          break;
        case MarketState.CLOSED:
          closed++;
          break;
      }
    }

    this.stats.marketsTracked = this.markets.size;
    this.stats.marketsInEntryWindow = inEntryWindow;
    this.stats.marketsActive = active;
    this.stats.marketsClosed = closed;
  }

  /**
   * Get all tracked markets
   */
  getMarkets(): SportsMarket[] {
    return Array.from(this.markets.values());
  }

  /**
   * Get markets by state
   */
  getMarketsByState(state: MarketState): SportsMarket[] {
    return Array.from(this.markets.values()).filter((m) => m.state === state);
  }

  /**
   * Get markets in entry window (ready for SPLIT)
   */
  getMarketsInEntryWindow(): SportsMarket[] {
    return this.getMarketsByState(MarketState.PENDING_ENTRY);
  }

  /**
   * Get markets by sport
   */
  getMarketsBySport(sport: string): SportsMarket[] {
    const upperSport = sport.toUpperCase();
    return Array.from(this.markets.values()).filter(
      (m) => m.sport === upperSport,
    );
  }

  /**
   * Get a specific market by slug
   */
  getMarket(slug: string): SportsMarket | undefined {
    return this.markets.get(slug);
  }

  /**
   * Get current stats
   */
  getStats(): DiscoveryStats {
    return { ...this.stats };
  }

  /**
   * Get enabled sports list
   */
  getEnabledSports(): string[] {
    return [...this.enabledSports];
  }

  /**
   * Start the discovery service
   */
  async start(): Promise<void> {
    if (this.running) {
      this.log("Discovery service already running", "WARN");
      return;
    }

    this.running = true;
    this.log("=".repeat(60));
    this.log("Starting Sports Market Discovery Service");
    this.log(`Discovery interval: ${this.discoveryIntervalMs / 1000}s`);
    this.log(`Enabled sports: ${this.enabledSports.join(", ")}`);
    this.log(`Entry window: ${ENTRY_WINDOW_MINUTES} minutes`);
    this.log("=".repeat(60));

    // Initial discovery
    await this.refreshMarkets();

    // Setup periodic discovery
    this.discoveryInterval = setInterval(async () => {
      this.log("Running periodic market discovery...");
      await this.refreshMarkets();
    }, this.discoveryIntervalMs);

    // Setup periodic state check (for countdowns)
    this.stateCheckInterval = setInterval(() => {
      this.checkMarketCountdowns();
    }, STATE_CHECK_INTERVAL_MS);

    this.log("Discovery service started successfully");
    this.logStats();
  }

  /**
   * Stop the discovery service
   */
  stop(): void {
    this.running = false;

    if (this.discoveryInterval) {
      clearInterval(this.discoveryInterval);
      this.discoveryInterval = null;
    }

    if (this.stateCheckInterval) {
      clearInterval(this.stateCheckInterval);
      this.stateCheckInterval = null;
    }

    this.log("=".repeat(60));
    this.log("Discovery service stopped");
    this.logStats();
    this.log("=".repeat(60));
  }

  /**
   * Log current statistics
   */
  private logStats(): void {
    this.log(
      `[STATS] tracked=${this.stats.marketsTracked}, ` +
        `discovered=${this.stats.marketsDiscovered}, ` +
        `entry_window=${this.stats.marketsInEntryWindow}, ` +
        `active=${this.stats.marketsActive}, ` +
        `closed=${this.stats.marketsClosed}, ` +
        `errors=${this.stats.errors}`,
    );
  }

  /**
   * Check if service is running
   */
  isRunning(): boolean {
    return this.running;
  }
}

// Export types
export type {
  SportsMarket as SportsMarketInfo,
  MarketCountdown as MarketCountdownInfo,
  MarketClosure as MarketClosureInfo,
};
