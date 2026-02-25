#!/usr/bin/env npx tsx
/**
 * Sports Tick Data Collector
 *
 * Collects real-time order book and trade data from live Polymarket sports markets.
 * Used for RQ-006/007 analysis to determine liquidity, slippage, and feasibility
 * for the SSS (Sports Split-Sell) strategy.
 *
 * Features:
 * - Polls Gamma API every 5 minutes to discover new live sports markets
 * - Connects to WebSocket for real-time price/trade updates
 * - Stores data in JSONL format with full order book depth
 * - Excludes e-sports markets
 * - Handles reconnections gracefully
 *
 * Usage:
 *   npx tsx src/collectors/SportsTickCollector.ts [--data-dir /path/to/data]
 */

import dns from "dns";
dns.setDefaultResultOrder("ipv4first");

import * as fs from "fs";
import * as path from "path";
import axios from "axios";
import {
  OrderBookWebSocket,
  PriceUpdateEvent,
  TradeEvent,
  OrderBookData,
} from "../services/OrderBookWS";

// Configuration
const GAMMA_API = "https://gamma-api.polymarket.com";
const DEFAULT_DATA_DIR = "/root/poly_arbitrage/sports_tick_data";
const MARKET_DISCOVERY_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const FLUSH_INTERVAL_MS = 10 * 1000; // 10 seconds
const STATS_INTERVAL_MS = 60 * 1000; // 1 minute
const MAX_DEPTH_LEVELS = 5; // Top 5 levels of order book

// Sports to include (exclude e-sports)
const INCLUDED_SPORTS = [
  "nba",
  "nhl",
  "nfl",
  "mlb",
  "soccer",
  "tennis",
  "cbb",
  "cfb",
  "ufc",
  "boxing",
  "cricket",
];

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

// Individual game MONEYLINE slug pattern (excludes spread, total, props)
// Format: {sport}-{team1}-{team2}-{date} WITHOUT additional suffixes
const INDIVIDUAL_GAME_PATTERN =
  /^(nba|nhl|nfl|mlb|cbb|cfb|soccer|tennis|ufc|boxing|cricket)-[a-z]{2,10}-[a-z]{2,10}-\d{4}-\d{2}-\d{2}$/i;

// Keywords that indicate non-moneyline markets (to be excluded)
const NON_MONEYLINE_KEYWORDS = [
  "spread",
  "total",
  "points",
  "assists",
  "rebounds",
  "steals",
  "blocks",
  "threes",
  "1h",
  "1q",
  "2h",
  "2q",
  "3q",
  "4q",
  "pt5", // common suffix for half-point lines
  "over",
  "under",
  "props",
];

interface SportsMarketInfo {
  eventSlug: string;
  marketSlug: string;
  sport: string;
  question: string;
  outcomes: string[];
  tokenIds: string[];
  gameStartTime: Date | null;
  volume: number;
  liquidity: number;
  discoveredAt: number;
}

interface SportsTickData {
  event_type: "book" | "trade";
  timestamp: number;
  iso_timestamp: string;
  market_slug: string;
  sport_category: string;
  token_id: string;
  outcome: string;
  // Book data (for event_type: "book")
  bids?: Array<{ price: string; size: string }>;
  asks?: Array<{ price: string; size: string }>;
  best_bid?: number;
  best_ask?: number;
  bid_depth_5?: number; // Total size in top 5 bid levels
  ask_depth_5?: number; // Total size in top 5 ask levels
  // Trade data (for event_type: "trade")
  trade_price?: number;
  trade_size?: number;
  trade_side?: string;
}

interface CollectorStats {
  booksReceived: number;
  tradesReceived: number;
  ticksWritten: number;
  marketsTracked: number;
  marketsDiscovered: number;
  reconnections: number;
  errors: number;
  lastDiscoveryAt: number;
}

export class SportsTickCollector {
  private dataDir: string;
  private orderBookWS: OrderBookWebSocket | null = null;
  private activeMarkets: Map<string, SportsMarketInfo> = new Map(); // marketSlug -> info
  private tokenToMarket: Map<string, SportsMarketInfo> = new Map(); // tokenId -> info
  private tokenToOutcome: Map<string, string> = new Map(); // tokenId -> outcome name
  private writeBuffers: Map<string, SportsTickData[]> = new Map(); // date -> ticks
  private allTokenIds: string[] = [];
  private running = false;
  private discoveryInterval: NodeJS.Timeout | null = null;
  private flushInterval: NodeJS.Timeout | null = null;
  private statsInterval: NodeJS.Timeout | null = null;

  private stats: CollectorStats = {
    booksReceived: 0,
    tradesReceived: 0,
    ticksWritten: 0,
    marketsTracked: 0,
    marketsDiscovered: 0,
    reconnections: 0,
    errors: 0,
    lastDiscoveryAt: 0,
  };

  constructor(dataDir: string = DEFAULT_DATA_DIR) {
    this.dataDir = dataDir;
    this.ensureDirectories();
  }

  private ensureDirectories(): void {
    const dirs = [this.dataDir, path.join(this.dataDir, "logs")];
    for (const dir of dirs) {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    }
  }

  private log(
    message: string,
    level: "INFO" | "WARN" | "ERROR" = "INFO"
  ): void {
    const timestamp = new Date().toISOString();
    const logLine = `${timestamp} [${level}] ${message}`;
    console.log(logLine);

    // Also write to log file
    try {
      const logFile = path.join(this.dataDir, "logs", "sports_collector.log");
      fs.appendFileSync(logFile, logLine + "\n");
    } catch {
      // Ignore log file errors
    }
  }

  /**
   * Check if a market is e-sports based on slug, tags, or keywords
   */
  private isEsports(slug: string, tags?: string[]): boolean {
    const lowerSlug = slug.toLowerCase();

    // Check excluded keywords in slug
    for (const keyword of EXCLUDED_KEYWORDS) {
      if (lowerSlug.includes(keyword)) {
        return true;
      }
    }

    // Check tags if available
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
   */
  private extractSportFromSlug(slug: string): string | null {
    const lowerSlug = slug.toLowerCase();

    for (const sport of INCLUDED_SPORTS) {
      if (lowerSlug.startsWith(sport + "-")) {
        return sport.toUpperCase();
      }
    }

    // Try to extract from pattern
    const match = lowerSlug.match(/^([a-z]+)-/);
    if (match) {
      const sport = match[1];
      if (!EXCLUDED_KEYWORDS.some((kw) => sport.includes(kw))) {
        return sport.toUpperCase();
      }
    }

    return null;
  }

  /**
   * Discover live sports markets from Gamma API
   */
  async discoverSportsMarkets(): Promise<SportsMarketInfo[]> {
    const markets: SportsMarketInfo[] = [];
    this.stats.lastDiscoveryAt = Date.now();

    try {
      // Fetch active events
      const response = await axios.get(`${GAMMA_API}/events`, {
        params: {
          active: true,
          closed: false,
          limit: 500,
          order: "volume",
          ascending: false,
        },
        timeout: 30000,
      });

      if (!response.data || !Array.isArray(response.data)) {
        this.log("No events data received from Gamma API", "WARN");
        return markets;
      }

      const events = response.data;
      this.log(`Fetched ${events.length} active events from Gamma API`);

      for (const event of events) {
        // Skip if not an individual game pattern (must be moneyline - base slug without suffixes)
        if (!INDIVIDUAL_GAME_PATTERN.test(event.slug)) {
          continue;
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

        // Find moneyline market in this event
        // STRICT matching: only sportsMarketType === "moneyline" or base slug match
        const eventMarkets = event.markets || [];
        const moneylineMarket = eventMarkets.find(
          (m: any) =>
            m.sportsMarketType === "moneyline" || m.slug === event.slug
        );

        if (!moneylineMarket || !moneylineMarket.clobTokenIds) {
          // No strict moneyline found - skip
          continue;
        }

        // Double-check: the market slug must match the base game slug (no suffixes)
        const marketSlug = moneylineMarket.slug || event.slug;
        if (!INDIVIDUAL_GAME_PATTERN.test(marketSlug)) {
          continue;
        }

        try {
          const tokenIds = JSON.parse(moneylineMarket.clobTokenIds);
          const outcomes = JSON.parse(moneylineMarket.outcomes || "[]");

          if (!tokenIds || tokenIds.length < 2) {
            continue;
          }

          // Parse game start time
          let gameStartTime: Date | null = null;
          if (moneylineMarket.gameStartTime) {
            try {
              // Handle Polymarket timestamp format: "YYYY-MM-DD HH:MM:SS+00"
              let timeStr = moneylineMarket.gameStartTime;
              if (timeStr.endsWith("+00")) {
                timeStr = timeStr.replace("+00", "+00:00");
              }
              gameStartTime = new Date(timeStr);
            } catch {
              gameStartTime = null;
            }
          }

          const marketInfo: SportsMarketInfo = {
            eventSlug: event.slug,
            marketSlug: moneylineMarket.slug || event.slug,
            sport,
            question: moneylineMarket.question || event.title,
            outcomes,
            tokenIds,
            gameStartTime,
            volume: parseFloat(moneylineMarket.volume || "0"),
            liquidity: parseFloat(moneylineMarket.liquidity || "0"),
            discoveredAt: Date.now(),
          };

          markets.push(marketInfo);
        } catch (err) {
          this.log(`Error parsing market ${event.slug}: ${err}`, "WARN");
        }
      }

      this.log(
        `Discovered ${markets.length} individual sports game markets (excluding e-sports)`
      );
    } catch (err) {
      this.log(`Error discovering sports markets: ${err}`, "ERROR");
      this.stats.errors++;
    }

    return markets;
  }

  /**
   * Update active markets and WebSocket subscriptions
   */
  private async refreshMarkets(): Promise<void> {
    try {
      const markets = await this.discoverSportsMarkets();

      // Remove expired markets (games that have ended)
      const now = Date.now();
      for (const [slug, market] of this.activeMarkets) {
        if (
          market.gameStartTime &&
          now > market.gameStartTime.getTime() + 4 * 60 * 60 * 1000
        ) {
          // 4 hours after game start
          this.activeMarkets.delete(slug);
          for (const tokenId of market.tokenIds) {
            this.tokenToMarket.delete(tokenId);
            this.tokenToOutcome.delete(tokenId);
          }
          this.log(`Expired market: ${slug}`);
        }
      }

      // Add new markets
      const newTokenIds: string[] = [];
      for (const market of markets) {
        if (!this.activeMarkets.has(market.marketSlug)) {
          this.activeMarkets.set(market.marketSlug, market);

          for (let i = 0; i < market.tokenIds.length; i++) {
            const tokenId = market.tokenIds[i];
            const outcome = market.outcomes[i] || `Outcome${i + 1}`;

            this.tokenToMarket.set(tokenId, market);
            this.tokenToOutcome.set(tokenId, outcome);

            if (!this.allTokenIds.includes(tokenId)) {
              newTokenIds.push(tokenId);
              this.allTokenIds.push(tokenId);
            }
          }

          this.stats.marketsDiscovered++;
          this.log(
            `Added market: ${market.marketSlug} [${market.sport}] ${market.question}`
          );
        }
      }

      // Subscribe to new tokens if WebSocket is connected
      if (
        newTokenIds.length > 0 &&
        this.orderBookWS &&
        this.orderBookWS.isConnected()
      ) {
        this.orderBookWS.addTokens(newTokenIds);
        this.log(`Subscribed to ${newTokenIds.length} new tokens`);
      }

      this.stats.marketsTracked = this.activeMarkets.size;
    } catch (err) {
      this.log(`Error refreshing markets: ${err}`, "ERROR");
      this.stats.errors++;
    }
  }

  /**
   * Handle order book snapshot events
   */
  private handlePriceUpdate(event: PriceUpdateEvent): void {
    const market = this.tokenToMarket.get(event.tokenId);
    if (!market) return;

    const outcome = this.tokenToOutcome.get(event.tokenId);
    if (!outcome) return;

    // Get full order book data
    const orderBook = this.orderBookWS?.getOrderBook(event.tokenId);

    // Calculate depth for top 5 levels
    const bidDepth5 = this.calculateDepth(orderBook?.bids || [], MAX_DEPTH_LEVELS);
    const askDepth5 = this.calculateDepth(orderBook?.asks || [], MAX_DEPTH_LEVELS);

    // Get top 5 levels only
    const topBids = this.getTopLevels(orderBook?.bids || [], MAX_DEPTH_LEVELS, "bids");
    const topAsks = this.getTopLevels(orderBook?.asks || [], MAX_DEPTH_LEVELS, "asks");

    const tick: SportsTickData = {
      event_type: "book",
      timestamp: event.timestamp,
      iso_timestamp: new Date(event.timestamp).toISOString(),
      market_slug: market.marketSlug,
      sport_category: market.sport,
      token_id: event.tokenId,
      outcome,
      bids: topBids,
      asks: topAsks,
      best_bid: event.bid,
      best_ask: event.ask,
      bid_depth_5: bidDepth5,
      ask_depth_5: askDepth5,
    };

    this.bufferTick(tick);
    this.stats.booksReceived++;
  }

  /**
   * Calculate total depth for top N levels
   */
  private calculateDepth(
    levels: Array<{ price: string; size: string }>,
    n: number
  ): number {
    if (!levels || levels.length === 0) return 0;

    // Bids are sorted ascending, so top N bids are the LAST N elements
    // Asks are sorted descending, so top N asks are the LAST N elements (lowest prices)
    const topLevels = levels.slice(-n);
    return topLevels.reduce((sum, level) => sum + parseFloat(level.size), 0);
  }

  /**
   * Get top N levels of order book
   */
  private getTopLevels(
    levels: Array<{ price: string; size: string }>,
    n: number,
    side: "bids" | "asks"
  ): Array<{ price: string; size: string }> {
    if (!levels || levels.length === 0) return [];

    // Bids: best bid is LAST (highest price), so take last N
    // Asks: best ask is LAST (lowest price), so take last N
    return levels.slice(-n);
  }

  /**
   * Handle trade events
   */
  private handleTradeEvent(event: TradeEvent): void {
    const market = this.tokenToMarket.get(event.tokenId);
    if (!market) return;

    const outcome = this.tokenToOutcome.get(event.tokenId);
    if (!outcome) return;

    const tick: SportsTickData = {
      event_type: "trade",
      timestamp: event.timestamp,
      iso_timestamp: new Date(event.timestamp).toISOString(),
      market_slug: market.marketSlug,
      sport_category: market.sport,
      token_id: event.tokenId,
      outcome,
      trade_price: event.tradePrice,
      trade_size: event.tradeSize,
      trade_side: event.side,
    };

    this.bufferTick(tick);
    this.stats.tradesReceived++;
  }

  /**
   * Buffer tick for batch writing
   */
  private bufferTick(tick: SportsTickData): void {
    const date = tick.iso_timestamp.slice(0, 10); // YYYY-MM-DD

    if (!this.writeBuffers.has(date)) {
      this.writeBuffers.set(date, []);
    }
    this.writeBuffers.get(date)!.push(tick);

    // Flush if buffer is large
    const buffer = this.writeBuffers.get(date)!;
    if (buffer.length >= 100) {
      this.flushBuffer(date);
    }
  }

  /**
   * Flush buffer to disk
   */
  private flushBuffer(date?: string): void {
    const datesToFlush = date ? [date] : Array.from(this.writeBuffers.keys());

    for (const d of datesToFlush) {
      const buffer = this.writeBuffers.get(d);
      if (!buffer || buffer.length === 0) continue;

      const filePath = path.join(this.dataDir, `${d}.jsonl`);
      const lines =
        buffer.map((tick) => JSON.stringify(tick)).join("\n") + "\n";

      try {
        fs.appendFileSync(filePath, lines);
        this.stats.ticksWritten += buffer.length;
        this.writeBuffers.set(d, []);
      } catch (err) {
        this.log(`Error writing to ${filePath}: ${err}`, "ERROR");
        this.stats.errors++;
      }
    }
  }

  /**
   * Initialize WebSocket connection
   */
  private async initializeWebSocket(): Promise<void> {
    // Start with tokens from current active markets or placeholder
    const initialTokens =
      this.allTokenIds.length > 0 ? [...this.allTokenIds] : ["placeholder"];

    this.orderBookWS = new OrderBookWebSocket(initialTokens);

    // Subscribe to book updates
    this.orderBookWS.on("priceUpdate", (event: PriceUpdateEvent) => {
      this.handlePriceUpdate(event);
    });

    // Subscribe to trade events
    this.orderBookWS.on("trade", (event: TradeEvent) => {
      this.handleTradeEvent(event);
    });

    await this.orderBookWS.connect();
    this.log("WebSocket connected to Polymarket");
  }

  /**
   * Log current statistics
   */
  private logStats(): void {
    const uptimeMs = Date.now() - this.stats.lastDiscoveryAt + MARKET_DISCOVERY_INTERVAL_MS;
    const uptimeMins = Math.floor(uptimeMs / 60000);

    this.log(
      `[STATS] markets=${this.stats.marketsTracked}, ` +
        `books=${this.stats.booksReceived}, trades=${this.stats.tradesReceived}, ` +
        `written=${this.stats.ticksWritten}, discovered=${this.stats.marketsDiscovered}, ` +
        `errors=${this.stats.errors}, tokens=${this.allTokenIds.length}`
    );
  }

  /**
   * Start the collector
   */
  async start(): Promise<void> {
    this.running = true;
    this.log("=".repeat(60));
    this.log("Starting Sports Tick Data Collector");
    this.log(`Data directory: ${this.dataDir}`);
    this.log(`Discovery interval: ${MARKET_DISCOVERY_INTERVAL_MS / 1000}s`);
    this.log(`Included sports: ${INCLUDED_SPORTS.join(", ")}`);
    this.log("=".repeat(60));

    // Initial market discovery
    await this.refreshMarkets();

    // Initialize WebSocket
    await this.initializeWebSocket();

    // Setup periodic market discovery
    this.discoveryInterval = setInterval(async () => {
      this.log("Running periodic market discovery...");
      await this.refreshMarkets();
    }, MARKET_DISCOVERY_INTERVAL_MS);

    // Setup periodic buffer flush
    this.flushInterval = setInterval(() => {
      this.flushBuffer();
    }, FLUSH_INTERVAL_MS);

    // Setup periodic stats logging
    this.statsInterval = setInterval(() => {
      this.logStats();
    }, STATS_INTERVAL_MS);

    this.log("Collector started successfully");
    this.logStats();

    // Keep running
    await new Promise<void>((resolve) => {
      process.on("SIGINT", () => {
        this.log("Received SIGINT, stopping...");
        this.stop();
        resolve();
      });
      process.on("SIGTERM", () => {
        this.log("Received SIGTERM, stopping...");
        this.stop();
        resolve();
      });
    });
  }

  /**
   * Stop the collector
   */
  stop(): void {
    this.running = false;

    if (this.discoveryInterval) {
      clearInterval(this.discoveryInterval);
      this.discoveryInterval = null;
    }
    if (this.flushInterval) {
      clearInterval(this.flushInterval);
      this.flushInterval = null;
    }
    if (this.statsInterval) {
      clearInterval(this.statsInterval);
      this.statsInterval = null;
    }

    // Flush remaining data
    this.flushBuffer();

    // Disconnect WebSocket
    if (this.orderBookWS) {
      this.orderBookWS.disconnect();
      this.orderBookWS = null;
    }

    this.log("=".repeat(60));
    this.log("Collector stopped");
    this.log(
      `Final stats: books=${this.stats.booksReceived}, trades=${this.stats.tradesReceived}, ` +
        `written=${this.stats.ticksWritten}, markets=${this.stats.marketsDiscovered}`
    );
    this.log("=".repeat(60));
  }

  /**
   * Get current stats (for external monitoring)
   */
  getStats(): CollectorStats {
    return { ...this.stats };
  }
}

// CLI
async function main() {
  const args = process.argv.slice(2);

  let dataDir = DEFAULT_DATA_DIR;

  // Parse CLI args
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--data-dir" || args[i] === "-d") {
      dataDir = args[++i];
    } else if (args[i] === "--help" || args[i] === "-h") {
      console.log(`
Sports Tick Data Collector

Collects real-time order book and trade data from live Polymarket sports markets.
Excludes e-sports markets. Stores data in JSONL format.

Usage:
  npx tsx src/collectors/SportsTickCollector.ts [options]

Options:
  --data-dir, -d <PATH>   Data directory. Default: ${DEFAULT_DATA_DIR}
  --help, -h              Show this help

Output Format (JSONL):
  Book events: { event_type: "book", bids: [], asks: [], best_bid, best_ask, bid_depth_5, ask_depth_5, ... }
  Trade events: { event_type: "trade", trade_price, trade_size, trade_side, ... }

Data is stored as: <data-dir>/YYYY-MM-DD.jsonl
Logs are stored as: <data-dir>/logs/sports_collector.log

Supported Sports:
  NBA, NHL, NFL, MLB, CBB (College Basketball), CFB (College Football),
  Soccer, Tennis, UFC, Boxing, Cricket

Excluded:
  All e-sports (League of Legends, CS2, Valorant, Dota 2, etc.)
      `);
      process.exit(0);
    }
  }

  const collector = new SportsTickCollector(dataDir);
  await collector.start();
}

// Run if executed directly
if (require.main === module) {
  main().catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
  });
}
