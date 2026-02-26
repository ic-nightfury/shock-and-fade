/**
 * run-shock-fade-paper.ts — Entry point for shock-fade paper trading engine.
 *
 * Loads .env config, discovers live sports markets, connects to Polymarket WS,
 * runs ShockFadeDetector + ShockFadePaperTrader + ShockFadeDashboard.
 *
 * Game event confirmation uses "burst-on-shock" pattern:
 *   - Normal: poll league APIs every 10s for background event tracking
 *   - On shock: immediate poll + 3 rapid follow-ups at 3s intervals
 *   - Classification happens as soon as data arrives, not on a fixed timer
 *
 * Usage:
 *   npx ts-node src/run-shock-fade-paper.ts
 *   npm run shock-fade:paper
 */

import * as dotenv from "dotenv";
dotenv.config();

import {
  SportsMarketDiscovery,
  SportsMarket,
  MarketState,
} from "./services/SportsMarketDiscovery";
import { OrderBookWebSocket, PriceUpdateEvent } from "./services/OrderBookWS";
import {
  ShockFadeDetector,
  ShockFadeConfig,
  ShockEvent,
  DEFAULT_SHOCK_FADE_CONFIG,
} from "./strategies/ShockFadeDetector";
import { ShockFadePaperTrader } from "./strategies/ShockFadePaper";
import { ShockFadeDashboardServer } from "./dashboard/ShockFadeDashboard";

// League API imports for game event confirmation
import { NbaLiveApi } from "./collectors/league-apis/NbaLiveApi";
import { NhlLiveApi, NormalizedGameEvent } from "./collectors/league-apis/NhlLiveApi";
import { MlbLiveApi } from "./collectors/league-apis/MlbLiveApi";
import { NflLiveApi } from "./collectors/league-apis/NflLiveApi";
import { EspnFallbackApi } from "./collectors/league-apis/EspnFallbackApi";

// ============================================================================
// CONFIGURATION
// ============================================================================

function loadConfig(): ShockFadeConfig {
  return {
    sigmaThreshold: parseFloat(process.env.SHOCK_SIGMA ?? "3.0"),
    minAbsoluteMove: parseFloat(process.env.SHOCK_MIN_MOVE ?? "0.03"),
    rollingWindowMs: parseInt(process.env.SHOCK_WINDOW_MS ?? "60000", 10),
    ladderLevels: parseInt(process.env.SHOCK_LADDER_LEVELS ?? "3", 10),
    ladderSpacing: parseFloat(process.env.SHOCK_LADDER_SPACING ?? "0.03"),
    fadeTargetCents: parseFloat(process.env.SHOCK_FADE_TARGET ?? "3"),
    fadeWindowMs: parseInt(process.env.SHOCK_FADE_WINDOW_MS ?? "600000", 10),
    maxPositionSize: parseFloat(process.env.SHOCK_MAX_POS_SIZE ?? "100"),
    cooldownMs: parseInt(process.env.SHOCK_COOLDOWN_MS ?? "30000", 10),
    targetPriceRange: [
      parseFloat(process.env.SHOCK_PRICE_MIN ?? "0.07"),
      parseFloat(process.env.SHOCK_PRICE_MAX ?? "0.91"),
    ],
  };
}

// ============================================================================
// GAME EVENT CONFIRMATION (burst-on-shock pattern)
// ============================================================================

type Sport = "NHL" | "NBA" | "MLB" | "NFL";

interface GameMapping {
  marketSlug: string;
  gameId: string;
  sport: Sport;
}

/** Tracks recent scoring events for a market to detect scoring runs */
interface MarketEventWindow {
  /** Recent scoring events: { timestamp, team } */
  events: Array<{ ts: number; team: string; type: string }>;
  /** Last time we polled this market's game */
  lastPollTs: number;
}

/**
 * Game event confirmation with adaptive polling rate.
 *
 * Idle mode: polls all mapped games every 10s.
 * Active mode (shock pending or position open): polls every 1s.
 * Tracks recent events per market for scoring run detection.
 */
class GameEventConfirmation {
  private nbaApi: NbaLiveApi;
  private nhlApi: NhlLiveApi;
  private mlbApi: MlbLiveApi;
  private nflApi: NflLiveApi;
  private espnApi: EspnFallbackApi;

  // Game mappings: marketSlug → game info
  private gameMappings: Map<string, GameMapping> = new Map();

  // Event tracking per market (sliding 2-minute window)
  private eventWindows: Map<string, MarketEventWindow> = new Map();

  // Dedup: "gameId:type:period:clock:team"
  private seenEventKeys: Set<string> = new Set();

  // Adaptive polling state
  private pollTimer: NodeJS.Timeout | null = null;
  private activeMarkets: Set<string> = new Set(); // markets needing 1s polling
  private fastPollTimer: NodeJS.Timeout | null = null;

  // PBP backoff per game (for 403s etc)
  private pbpBackoff: Map<string, { nextRetryAt: number; currentBackoffMs: number; failCount: number }> = new Map();

  // Callback for when new events are detected during a burst
  public onClassificationReady: ((marketSlug: string, recentEvents: number, isStructural: boolean) => void) | null = null;
  public onScoreUpdate: ((marketSlug: string, homeTeam: string, awayTeam: string, homeScore: number, awayScore: number, period: string, clock: string, sport: string) => void) | null = null;

  // Stats
  private totalPolls = 0;
  private totalBurstPolls = 0;
  private scoreTimer: NodeJS.Timeout | null = null;

  constructor() {
    // Minimal rate limits — 1s polling is fine for these CDN endpoints
    this.nbaApi = new NbaLiveApi(200);  // 200ms min gap (NBA CDN handles it)
    this.nhlApi = new NhlLiveApi(200);
    this.mlbApi = new MlbLiveApi(200);
    this.nflApi = new NflLiveApi();
    this.espnApi = new EspnFallbackApi(200);
  }

  // ── Lifecycle ──────────────────────────────────────────────────────

  start(): void {
    // Normal 10s polling for background event tracking
    this.pollTimer = setInterval(() => this.pollAll(), 10000);
    // Fast 1s polling for active markets (shock pending or position open)
    this.fastPollTimer = setInterval(() => this.pollActiveMarkets(), 1000);
    // Score polling every 1s (critical for detecting rapid NBA score changes)
    this.scoreTimer = setInterval(() => this.pollScores(), 1000);
    this.pollScores(); // immediate first poll
    this.log("Started (10s idle / 1s active adaptive polling)");
  }

  stop(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.fastPollTimer) {
      clearInterval(this.fastPollTimer);
      this.fastPollTimer = null;
    }
    if (this.scoreTimer) {
      clearInterval(this.scoreTimer);
      this.scoreTimer = null;
    }
  }

  private async pollScores(): Promise<void> {
    if (!this.onScoreUpdate) return;
    try {
      const nbaGames = await this.nbaApi.getTodaysScoreboard();
      for (const game of nbaGames) {
        for (const [slug, mapping] of this.gameMappings.entries()) {
          if (mapping.sport === "NBA" && mapping.gameId === game.gameId) {
            const periodStr = game.gameStatus === 2
              ? `Q${game.period}`
              : game.gameStatus === 3 ? "Final" : "Pre";
            this.onScoreUpdate(
              slug,
              game.awayTeam.teamTricode,
              game.homeTeam.teamTricode,
              game.awayTeam.score,
              game.homeTeam.score,
              periodStr,
              game.gameClock?.replace(/^PT/, "").replace(/\.\d+S$/, "S").replace("M", ":").replace("S", "") || "",
              "NBA"
            );
          }
        }
      }
    } catch {}
  }

  /**
   * Mark a market as active (needs 1s polling).
   * Called when shock detected or position opened.
   */
  setMarketActive(marketSlug: string): void {
    this.activeMarkets.add(marketSlug);
    this.log(`⚡ ${marketSlug} → active (1s polling)`);
  }

  /**
   * Mark a market as idle (back to 10s polling).
   * Called when all positions closed and no pending shocks.
   */
  setMarketIdle(marketSlug: string): void {
    this.activeMarkets.delete(marketSlug);
    this.log(`💤 ${marketSlug} → idle (10s polling)`);
  }

  // ── Game Mapping ───────────────────────────────────────────────────

  /**
   * Build game mappings from discovered markets.
   * Call this after market discovery and periodically on refresh.
   */
  async buildMappings(markets: Map<string, SportsMarket>): Promise<void> {
    const allMarkets = Array.from(markets.values()).filter(
      (m) => m.sport === "NHL" || m.sport === "NBA" || m.sport === "MLB" || m.sport === "NFL",
    );
    if (allMarkets.length === 0) return;

    const today = new Date();
    const dateStr = `${today.getUTCFullYear()}-${String(today.getUTCMonth() + 1).padStart(2, "0")}-${String(today.getUTCDate()).padStart(2, "0")}`;

    // NBA
    const nbaMarkets = allMarkets.filter((m) => m.sport === "NBA");
    if (nbaMarkets.length > 0) {
      try {
        const games = await this.nbaApi.getTodaysScoreboard();
        for (const game of games) {
          for (const market of nbaMarkets) {
            if (this.gameMappings.has(market.marketSlug)) continue;
            const homeName = `${game.homeTeam.teamCity} ${game.homeTeam.teamName}`;
            const awayName = `${game.awayTeam.teamCity} ${game.awayTeam.teamName}`;
            if (this.fuzzyMatchTeams(market.marketSlug, homeName, awayName)) {
              this.gameMappings.set(market.marketSlug, {
                marketSlug: market.marketSlug,
                gameId: game.gameId,
                sport: "NBA",
              });
              this.log(`🔗 Mapped ${market.marketSlug} → NBA game ${game.gameId}`);
            }
          }
        }
      } catch (err: any) {
        this.log(`⚠️ NBA mapping failed: ${err?.message || err}`);
      }
    }

    // NHL
    const nhlMarkets = allMarkets.filter((m) => m.sport === "NHL");
    if (nhlMarkets.length > 0) {
      try {
        const games = await this.nhlApi.getGamesByDate(dateStr);
        for (const game of games) {
          for (const market of nhlMarkets) {
            if (this.gameMappings.has(market.marketSlug)) continue;
            if (this.fuzzyMatchTeams(market.marketSlug, game.homeTeam.commonName?.default || "", game.awayTeam.commonName?.default || "")) {
              this.gameMappings.set(market.marketSlug, {
                marketSlug: market.marketSlug,
                gameId: String(game.id),
                sport: "NHL",
              });
              this.log(`🔗 Mapped ${market.marketSlug} → NHL game ${game.id}`);
            }
          }
        }
      } catch (err: any) {
        this.log(`⚠️ NHL mapping failed: ${err?.message || err}`);
      }
    }

    // MLB
    const mlbMarkets = allMarkets.filter((m) => m.sport === "MLB");
    if (mlbMarkets.length > 0) {
      try {
        const games = await this.mlbApi.getGamesByDate(dateStr);
        for (const game of games) {
          for (const market of mlbMarkets) {
            if (this.gameMappings.has(market.marketSlug)) continue;
            if (this.fuzzyMatchTeams(market.marketSlug, game.teams.home.team.name, game.teams.away.team.name)) {
              this.gameMappings.set(market.marketSlug, {
                marketSlug: market.marketSlug,
                gameId: String(game.gamePk),
                sport: "MLB",
              });
              this.log(`🔗 Mapped ${market.marketSlug} → MLB game ${game.gamePk}`);
            }
          }
        }
      } catch (err: any) {
        this.log(`⚠️ MLB mapping failed: ${err?.message || err}`);
      }
    }

    // NFL
    const nflMarkets = allMarkets.filter((m) => m.sport === "NFL");
    if (nflMarkets.length > 0) {
      try {
        const games = await this.nflApi.getTodaysGames();
        for (const game of games) {
          for (const market of nflMarkets) {
            if (this.gameMappings.has(market.marketSlug)) continue;
            if (this.fuzzyMatchTeams(market.marketSlug, game.homeTeam, game.awayTeam)) {
              this.gameMappings.set(market.marketSlug, {
                marketSlug: market.marketSlug,
                gameId: game.id,
                sport: "NFL",
              });
              this.log(`🔗 Mapped ${market.marketSlug} → NFL game ${game.id}`);
            }
          }
        }
      } catch (err: any) {
        this.log(`⚠️ NFL mapping failed: ${err?.message || err}`);
      }
    }

    this.log(`Game mappings: ${this.gameMappings.size}/${allMarkets.length} markets mapped`);
  }

  // ── Active Market Polling (1s) ───────────────────────────────────────

  /**
   * Poll markets that are in active state (shock pending or position open).
   * Runs every 1 second. Only polls markets in the activeMarkets set.
   */
  private async pollActiveMarkets(): Promise<void> {
    if (this.activeMarkets.size === 0) return;

    for (const marketSlug of this.activeMarkets) {
      const mapping = this.gameMappings.get(marketSlug);
      if (!mapping) continue;
      await this.pollMarket(marketSlug, mapping, true);
    }
  }

  // ── Normal Polling ─────────────────────────────────────────────────

  private async pollAll(): Promise<void> {
    for (const [marketSlug, mapping] of this.gameMappings.entries()) {
      // Skip if active (already polled at 1s)
      if (this.activeMarkets.has(marketSlug)) continue;

      await this.pollMarket(marketSlug, mapping, false);
    }

    // Prune old events (>5 min)
    const cutoff = Date.now() - 300000;
    for (const [slug, window] of this.eventWindows.entries()) {
      window.events = window.events.filter((e) => e.ts >= cutoff);
      if (window.events.length === 0 && Date.now() - window.lastPollTs > 600000) {
        this.eventWindows.delete(slug);
      }
    }

    // Prune seen event keys if they get too large
    if (this.seenEventKeys.size > 10000) {
      this.seenEventKeys.clear();
    }
  }

  private async pollMarket(marketSlug: string, mapping: GameMapping, isBurst: boolean): Promise<void> {
    // Check PBP backoff (skip for burst — burst overrides backoff)
    if (!isBurst) {
      const backoffState = this.pbpBackoff.get(mapping.gameId);
      if (backoffState && Date.now() < backoffState.nextRetryAt) return;
    }

    if (isBurst) this.totalBurstPolls++;
    this.totalPolls++;

    try {
      let events: NormalizedGameEvent[] = [];

      if (mapping.sport === "NBA") {
        events = await this.nbaApi.getPlayByPlay(mapping.gameId);
      } else if (mapping.sport === "NHL") {
        events = await this.nhlApi.getPlayByPlay(mapping.gameId);
      } else if (mapping.sport === "MLB") {
        events = await this.mlbApi.getPlayByPlay(Number(mapping.gameId));
      } else if (mapping.sport === "NFL") {
        const nflEvents = await this.nflApi.getPlayByPlay(mapping.gameId);
        events = nflEvents.map((e: any) => ({
          type: (["goal", "penalty", "period_start", "period_end", "shootout"].includes(e.type)) ? e.type : "other" as const,
          team: e.team,
          period: e.period,
          clock: e.clock,
          description: e.description,
          timestamp: e.timestamp,
        }));
      }

      // Clear backoff on success
      if (this.pbpBackoff.has(mapping.gameId)) {
        this.log(`✅ PBP recovered for ${mapping.sport} game ${mapping.gameId}`);
        this.pbpBackoff.delete(mapping.gameId);
      }

      this.processEvents(marketSlug, mapping.gameId, events, isBurst);

    } catch (err: any) {
      // Exponential backoff
      const existing = this.pbpBackoff.get(mapping.gameId);
      const newBackoffMs = existing
        ? Math.min(existing.currentBackoffMs * 2, 300_000)
        : 30_000;
      const failCount = existing ? existing.failCount + 1 : 1;

      this.pbpBackoff.set(mapping.gameId, {
        nextRetryAt: Date.now() + newBackoffMs,
        currentBackoffMs: newBackoffMs,
        failCount,
      });

      if (failCount === 1) {
        this.log(`⚠️ ${mapping.sport} PBP error for game ${mapping.gameId} — backoff ${(newBackoffMs / 1000).toFixed(0)}s: ${err?.message || err}`);
      }
    }
  }

  private processEvents(marketSlug: string, gameId: string, events: NormalizedGameEvent[], isBurst: boolean): void {
    let window = this.eventWindows.get(marketSlug);
    if (!window) {
      window = { events: [], lastPollTs: 0 };
      this.eventWindows.set(marketSlug, window);
    }
    window.lastPollTs = Date.now();

    let newEventCount = 0;

    for (const ev of events) {
      if (ev.type === "other") continue;

      const eventKey = `${gameId}:${ev.type}:${ev.period}:${ev.clock}:${ev.team}`;
      if (this.seenEventKeys.has(eventKey)) continue;
      this.seenEventKeys.add(eventKey);

      // Track scoring events in the sliding window
      if (ev.type === "goal") {
        window.events.push({
          ts: ev.timestamp || Date.now(),
          team: ev.team,
          type: ev.type,
        });
        newEventCount++;
      }

      const emoji = ev.type === "goal" ? "🏒" : ev.type === "penalty" ? "⚠️" : "📌";
      const burstTag = isBurst ? " [BURST]" : "";
      console.log(`${emoji}${burstTag} [${marketSlug}] ${ev.type} by ${ev.team} P${ev.period} ${ev.clock}`);
    }

    // If burst poll found new events, trigger classification callback immediately
    if (isBurst && newEventCount > 0 && this.onClassificationReady) {
      const info = this.getClassificationInfo(marketSlug);
      this.log(`⚡ Burst found ${newEventCount} new events → classify: ${info.recentEvents} recent, structural=${info.isStructural}`);
      this.onClassificationReady(marketSlug, info.recentEvents, info.isStructural);
    }
  }

  // ── Classification ─────────────────────────────────────────────────

  /**
   * Get classification info for a market based on recent event window.
   * Looks at scoring events in the last 2 minutes.
   */
  getClassificationInfo(marketSlug: string): {
    recentEvents: number;
    isStructural: boolean;
    sameTeamRun: number;  // max consecutive events from same team
  } {
    const window = this.eventWindows.get(marketSlug);
    if (!window) return { recentEvents: 0, isStructural: false, sameTeamRun: 0 };

    // Count scoring events in last 2 minutes
    const cutoff = Date.now() - 120000;
    const recent = window.events.filter((e) => e.ts >= cutoff);
    const recentEvents = recent.length;

    // Detect scoring run: max consecutive events from same team
    let maxRun = 0;
    let currentRun = 0;
    let currentTeam = "";
    for (const ev of recent) {
      if (ev.team === currentTeam) {
        currentRun++;
      } else {
        currentRun = 1;
        currentTeam = ev.team;
      }
      maxRun = Math.max(maxRun, currentRun);
    }

    // Structural detection: not available from free APIs yet
    // Could be added if we detect specific event types (injury, ejection)
    const isStructural = false;

    return { recentEvents, isStructural, sameTeamRun: maxRun };
  }

  // ── Stats ──────────────────────────────────────────────────────────

  getStats(): { totalPolls: number; burstPolls: number; mappings: number; trackedMarkets: number } {
    return {
      totalPolls: this.totalPolls,
      burstPolls: this.totalBurstPolls,
      mappings: this.gameMappings.size,
      trackedMarkets: this.eventWindows.size,
    };
  }

  // ── Fuzzy Matching (reused from recorder) ──────────────────────────

  private fuzzyMatchTeams(slug: string, homeTeamName: string, awayTeamName: string): boolean {
    const lowerSlug = slug.toLowerCase();
    const homeLower = (homeTeamName || "").toLowerCase();
    const awayLower = (awayTeamName || "").toLowerCase();

    const TEAM_ABBREVS: Record<string, string[]> = {
      // NBA
      atl: ["hawks", "atlanta"], bos: ["celtics", "boston"], bkn: ["nets", "brooklyn"],
      cha: ["hornets", "charlotte"], chi: ["bulls", "chicago"], cle: ["cavaliers", "cleveland"],
      dal: ["mavericks", "dallas"], den: ["nuggets", "denver"], det: ["pistons", "detroit"],
      gsw: ["warriors", "golden state"], hou: ["rockets", "houston"], ind: ["pacers", "indiana"],
      lac: ["clippers", "la clippers"], lal: ["lakers", "los angeles lakers"],
      mem: ["grizzlies", "memphis"], mia: ["heat", "miami"], mil: ["bucks", "milwaukee"],
      min: ["timberwolves", "minnesota"], nop: ["pelicans", "new orleans"],
      nyk: ["knicks", "new york knicks"], okc: ["thunder", "oklahoma"],
      orl: ["magic", "orlando"], phi: ["76ers", "philadelphia", "sixers"],
      phx: ["suns", "phoenix"], por: ["trail blazers", "blazers", "portland"],
      sac: ["kings", "sacramento"], sas: ["spurs", "san antonio"],
      tor: ["raptors", "toronto"], uta: ["jazz", "utah"], was: ["wizards", "washington"],
      // NHL
      ana: ["ducks", "anaheim"], ari: ["coyotes", "arizona"], buf: ["sabres", "buffalo"],
      car: ["hurricanes", "carolina"], cbj: ["blue jackets", "columbus"],
      cgy: ["flames", "calgary"], col: ["avalanche", "colorado"],
      edm: ["oilers", "edmonton"], fla: ["panthers", "florida"],
      lak: ["kings", "los angeles kings"], mtl: ["canadiens", "montreal"],
      njd: ["devils", "new jersey"], nsh: ["predators", "nashville"],
      nyi: ["islanders", "new york islanders"], nyr: ["rangers", "new york rangers"],
      ott: ["senators", "ottawa"], pit: ["penguins", "pittsburgh"],
      sea: ["kraken", "seattle"], stl: ["blues", "st. louis", "st louis"],
      tbl: ["lightning", "tampa bay"], van: ["canucks", "vancouver"],
      vgk: ["golden knights", "vegas"], wpg: ["jets", "winnipeg"],
      wsh: ["capitals", "washington"],
      // NFL
      ne: ["patriots", "new england"], sf: ["49ers", "san francisco"],
      gb: ["packers", "green bay"], kc: ["chiefs", "kansas city"],
      tb: ["buccaneers", "tampa bay"], no: ["saints", "new orleans"],
      nyg: ["giants", "new york giants"], nyj: ["jets", "new york jets"],
      // MLB
      nym: ["mets", "new york mets"], chc: ["cubs", "chicago cubs"],
      chw: ["white sox", "chicago white sox"], tex: ["rangers", "texas"],
      sd: ["padres", "san diego"], bal: ["orioles", "baltimore"],
    };

    const slugParts = lowerSlug.split("-");
    const teamAbbrevs = slugParts.slice(1, -3);

    if (teamAbbrevs.length < 2) {
      const homeWords = homeLower.split(/\s+/);
      const awayWords = awayLower.split(/\s+/);
      const homeMatch = homeWords.some((w) => w.length > 2 && lowerSlug.includes(w));
      const awayMatch = awayWords.some((w) => w.length > 2 && lowerSlug.includes(w));
      return homeMatch && awayMatch;
    }

    let homeMatched = false;
    let awayMatched = false;

    for (const abbrev of teamAbbrevs) {
      const possibleNames = TEAM_ABBREVS[abbrev] || [abbrev];
      for (const name of possibleNames) {
        if (homeLower.includes(name) || name.includes(homeLower.split(/\s+/).pop() || "")) homeMatched = true;
        if (awayLower.includes(name) || name.includes(awayLower.split(/\s+/).pop() || "")) awayMatched = true;
      }
      if (homeLower.includes(abbrev) || abbrev === homeLower.substring(0, 3)) homeMatched = true;
      if (awayLower.includes(abbrev) || abbrev === awayLower.substring(0, 3)) awayMatched = true;
    }

    return homeMatched && awayMatched;
  }

  // ── Logging ────────────────────────────────────────────────────────

  private log(msg: string): void {
    const ts = new Date().toISOString();
    console.log(`${ts} [INFO] 🏟️  [GameEvents] ${msg}`);
  }
}

// ============================================================================
// MAIN
// ============================================================================

async function main(): Promise<void> {
  console.log("=".repeat(70));
  console.log("  ⚡ SHOCK-FADE PAPER TRADER");
  console.log("  Real-time shock detection & paper trading on Polymarket sports");
  console.log("  Mode: event-filtered entry + event-driven exit (split-and-sell)");
  console.log("  Polling: 10s idle / 1s active (adaptive)");
  console.log("  Cycle: $300 = 3 ladders ($50+$100+$150), auto-replenish dry powder");
  console.log("=".repeat(70));

  const config = loadConfig();

  console.log("\n📋 Configuration:");
  console.log(`  σ threshold:    ${config.sigmaThreshold}`);
  console.log(`  Min absolute:   ${(config.minAbsoluteMove * 100).toFixed(0)}¢`);
  console.log(`  Rolling window: ${config.rollingWindowMs / 1000}s`);
  console.log(`  Ladder levels:  ${config.ladderLevels}`);
  console.log(`  Ladder spacing: ${(config.ladderSpacing * 100).toFixed(0)}¢`);
  console.log(`  Fade target:    ${config.fadeTargetCents}¢`);
  console.log(`  Fade window:    ${config.fadeWindowMs / 1000}s`);
  console.log(`  Max position:   $${config.maxPositionSize}/level`);
  console.log(`  Cooldown:       ${config.cooldownMs / 1000}s`);
  console.log(
    `  Price range:    [${config.targetPriceRange[0]}, ${config.targetPriceRange[1]}]`,
  );
  console.log();

  // ── 1. Discover markets ──────────────────────────────────────────────
  console.log("📡 Discovering live sports markets...");
  const discovery = new SportsMarketDiscovery(5 * 60 * 1000);
  const discovered = await discovery.discoverMarkets();

  // All non-closed markets (live + upcoming for dashboard)
  const liveMarkets = discovered.filter(
    (m) => m.state !== MarketState.CLOSED,
  );

  console.log(
    `  Found ${discovered.length} markets total, ${liveMarkets.length} live/active`,
  );

  if (liveMarkets.length === 0) {
    console.log("  ⚠️  No live markets found. Including all discovered markets for monitoring.");
    const allActive = discovered.filter((m) => m.state !== MarketState.CLOSED);
    if (allActive.length > 0) {
      liveMarkets.push(...allActive);
    } else {
      console.log("  ❌ No markets at all. The engine will wait for markets to appear.");
    }
  }

  // Collect all token IDs
  const allTokenIds = liveMarkets.flatMap((m) => m.tokenIds);
  console.log(`  📊 Monitoring ${allTokenIds.length} tokens across ${liveMarkets.length} markets`);

  // ── 2. Connect WebSocket ─────────────────────────────────────────────
  console.log("\n🔌 Connecting to Polymarket WebSocket...");
  const ws = new OrderBookWebSocket(allTokenIds.length > 0 ? allTokenIds : ["placeholder"]);

  if (allTokenIds.length > 0) {
    await ws.connect();
    console.log("  ✅ WebSocket connected");
  } else {
    console.log("  ⚠️  No tokens to subscribe. WS will connect when markets appear.");
  }

  // ── 3. Initialize components ─────────────────────────────────────────
  console.log("\n🧠 Initializing shock detection engine...");
  const detector = new ShockFadeDetector(ws, config);

  console.log("💰 Initializing paper trading engine (split-and-sell)...");
  const trader = new ShockFadePaperTrader(ws, config, "./data/shock-fade-state.json");

  // Register tokens with detector and trader (token pairs for split-and-sell)
  const marketsMap = new Map<string, SportsMarket>();
  for (const market of liveMarkets) {
    marketsMap.set(market.marketSlug, market);
    detector.registerMarketTokens(market.tokenIds, market.marketSlug);
    trader.registerTokenPair(market.tokenIds, market.marketSlug);
  }

  // ── 4. Game event confirmation (burst-on-shock) ──────────────────────
  console.log("🏟️  Initializing game event confirmation (burst-on-shock)...");
  const gameEvents = new GameEventConfirmation();
  await gameEvents.buildMappings(marketsMap);

  // ── 5. Wire up events (event-filtered entry + event-driven exit) ────

  // Track pending shocks waiting for classification before entry
  const pendingShocks: Map<string, { shock: ShockEvent; detectedAt: number }> = new Map();

  // Track which markets have open positions (for event-driven exit)
  const marketsWithPositions: Set<string> = new Set();

  // Track the last event count per market at time of entry (to detect NEW events for exit)
  const entryEventCounts: Map<string, number> = new Map();

  // Score update callback → push to dashboard
  gameEvents.onScoreUpdate = (marketSlug, homeTeam, awayTeam, homeScore, awayScore, period, clock, sport) => {
    dashboard.updateScore({ marketSlug, homeTeam, awayTeam, homeScore, awayScore, period, clock, sport });
  };

  // Classification callback from 1s polling — handles both entry and exit
  gameEvents.onClassificationReady = (marketSlug: string, recentEvents: number, isStructural: boolean) => {
    // ── ENTRY: classify pending shocks ──
    for (const [shockId, entry] of pendingShocks.entries()) {
      if (entry.shock.marketSlug !== marketSlug) continue;

      const classification = detector.classifyShock(entry.shock, recentEvents, isStructural);
      const latency = Date.now() - entry.detectedAt;

      if (classification === "single_event") {
        console.log(
          `✅ CYCLE START: ${marketSlug} → single_event (${latency}ms to classify) — placing orders`,
        );
        dashboard.notifySystem(`Shock classified: ${marketSlug} → single_event (${latency}ms)`);
        trader.handleShock(entry.shock);
        marketsWithPositions.add(marketSlug);
        entryEventCounts.set(marketSlug, recentEvents);
        // Keep market active for 1s exit polling
        gameEvents.setMarketActive(marketSlug);
      } else if (classification === "scoring_run" || classification === "structural") {
        console.log(
          `🚫 SKIP: ${marketSlug} → ${classification} (${recentEvents} events, ${latency}ms) — no trade`,
        );
        dashboard.notifySystem(`Shock skipped: ${marketSlug} → ${classification} (${recentEvents} events)`);
        gameEvents.setMarketIdle(marketSlug);
      } else {
        console.log(
          `⏭️ SKIP: ${marketSlug} → unclassified (${recentEvents} events, ${latency}ms)`,
        );
        dashboard.notifySystem(`Shock unclassified: ${marketSlug} (${recentEvents} events)`);
        gameEvents.setMarketIdle(marketSlug);
      }

      pendingShocks.delete(shockId);
    }

    // ── EXIT: detect new events on markets with open positions ──
    if (marketsWithPositions.has(marketSlug)) {
      const openPositions = trader.getOpenPositions().filter(p => p.marketSlug === marketSlug);
      if (openPositions.length === 0) {
        marketsWithPositions.delete(marketSlug);
        entryEventCounts.delete(marketSlug);
        gameEvents.setMarketIdle(marketSlug);
        return;
      }

      // Check if event count increased since entry (= new event happened)
      const entryCount = entryEventCounts.get(marketSlug) ?? 0;
      if (recentEvents > entryCount) {
        const oldestPosition = openPositions.reduce((a, b) => a.entryTime < b.entryTime ? a : b);
        const timeSinceEntry = Date.now() - oldestPosition.entryTime;

        // Only exit if >5s since entry (don't exit on the same event that triggered entry)
        if (timeSinceEntry > 5000) {
          console.log(
            `🏟️ CYCLE END (event exit): New scoring on ${marketSlug} — closing ${openPositions.length} positions ` +
              `(${(timeSinceEntry / 1000).toFixed(0)}s hold, events: ${entryCount}→${recentEvents})`,
          );
          dashboard.addGameEvent(marketSlug, `New scoring event — closing ${openPositions.length} positions`, "");
          trader.handleGameEvent(marketSlug);
          marketsWithPositions.delete(marketSlug);
          entryEventCounts.delete(marketSlug);
          gameEvents.setMarketIdle(marketSlug);
        }
      }
    }
  };

  // Detector → 1s polling activation (orders placed AFTER classification)
  detector.on("shock", (shock: ShockEvent) => {
    const shockId = `${shock.tokenId}_${shock.timestamp}`;

    // Notify dashboard
    dashboard.notifyShockDetected(shock);

    // 1. Track as pending classification (DO NOT place orders yet)
    pendingShocks.set(shockId, { shock, detectedAt: Date.now() });

    // 2. Switch market to active 1s polling
    gameEvents.setMarketActive(shock.marketSlug);

    // 3. Safety net: if classification doesn't arrive within 15s, final check
    setTimeout(() => {
      if (pendingShocks.has(shockId)) {
        const info = gameEvents.getClassificationInfo(shock.marketSlug);

        if (info.recentEvents === 1) {
          console.log(
            `⏰ Late classify: ${shock.marketSlug} → single_event (15s fallback) — placing orders`,
          );
          trader.handleShock(shock);
          marketsWithPositions.add(shock.marketSlug);
          entryEventCounts.set(shock.marketSlug, info.recentEvents);
        } else if (info.recentEvents === 0) {
          console.log(
            `⏭️ Timeout: ${shock.marketSlug} — no game event (noise), skipping`,
          );
          gameEvents.setMarketIdle(shock.marketSlug);
        } else {
          console.log(
            `🚫 Timeout: ${shock.marketSlug} — ${info.recentEvents} events (scoring run), skipping`,
          );
          gameEvents.setMarketIdle(shock.marketSlug);
        }

        pendingShocks.delete(shockId);
      }
    }, 15000);
  });

  // ── 6. Dashboard ─────────────────────────────────────────────────────
  console.log("📊 Starting dashboard on port 3032...");
  const dashboard = new ShockFadeDashboardServer({ port: 3032 });
  dashboard.setDetector(detector);
  dashboard.setTrader(trader);
  dashboard.setMarkets(marketsMap);
  await dashboard.start();

  // ── 6b. Wire trader events → dashboard ────────────────────────────────
  trader.on("ordersPlaced", (info: { shockId: string; marketSlug: string; orderCount: number; sellTokenId: string; heldTokenId: string }) => {
    // Notify for each order that was just placed
    const orders = trader.getActiveOrders().filter(o => o.shockId === info.shockId);
    for (const order of orders) {
      dashboard.notifyOrderPlaced(order);
    }
    dashboard.notifySystem(`Placed ${info.orderCount} ladder orders for ${info.marketSlug}`);
  });

  trader.on("positionOpened", (position: any) => {
    // Find the order that created this position and notify fill
    const allOrders = trader.getAllOrders();
    const order = allOrders.find(o => o.id === position.orderId);
    if (order) {
      dashboard.notifyOrderFilled(order);
    }
    dashboard.notifySystem(`Position opened: ${position.id} [${position.marketSlug}]`);
  });

  trader.on("positionClosed", (info: { position: any; record: any }) => {
    dashboard.notifyPositionClosed(info.position, info.record);
  });

  // ── 7. Start everything ──────────────────────────────────────────────
  detector.start();
  trader.start();
  gameEvents.start();

  // ── 8. Periodic market refresh ───────────────────────────────────────
  setInterval(async () => {
    try {
      const refreshed = await discovery.discoverMarkets();
      const newLive = refreshed.filter(
        (m) => m.state !== MarketState.CLOSED,
      );

      let newCount = 0;
      for (const market of newLive) {
        if (!marketsMap.has(market.marketSlug)) {
          marketsMap.set(market.marketSlug, market);
          detector.registerMarketTokens(market.tokenIds, market.marketSlug);
          trader.registerTokenPair(market.tokenIds, market.marketSlug);
          dashboard.updateMarket(market);
          ws.addTokens(market.tokenIds);
          newCount++;
        }
      }

      if (newCount > 0) {
        console.log(`  🆕 Added ${newCount} new markets (total: ${marketsMap.size})`);
        dashboard.notifySystem(`Added ${newCount} new markets (total: ${marketsMap.size})`);
      }
      // Always rebuild game mappings — NBA CDN date can flip mid-session
      await gameEvents.buildMappings(marketsMap);
    } catch (err) {
      console.error("  ❌ Market refresh error:", err);
      dashboard.notifySystem(`Market refresh error: ${err}`, "error");
    }
  }, 5 * 60 * 1000); // every 5 minutes

  // ── 9. Status logging ────────────────────────────────────────────────
  setInterval(() => {
    const stats = trader.getStats();
    const shockCount = detector.getRecentShocks(60000).length;
    const pnl = stats.totalPnL;
    const emoji = pnl >= 0 ? "📈" : "📉";
    const evStats = gameEvents.getStats();

    console.log(
      `${emoji} [STATUS] Markets: ${marketsMap.size} | ` +
        `Shocks (1m): ${shockCount} | ` +
        `Orders: ${stats.totalOrdersFilled}/${stats.totalOrdersPlaced} filled | ` +
        `Positions: ${stats.totalPositionsOpened} opened, ${stats.totalPositionsClosed} closed | ` +
        `P&L: ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)} | ` +
        `Win: ${(stats.winRate * 100).toFixed(0)}% | ` +
        `API: ${evStats.totalPolls} polls (${evStats.burstPolls} burst) | ` +
        `Dashboard: :${dashboard.getPort()} (${dashboard.getClientCount()} clients)`,
    );
  }, 60000); // every minute

  console.log("\n" + "=".repeat(70));
  console.log("  ✅ ALL SYSTEMS GO");
  console.log(`  📊 Dashboard: http://0.0.0.0:3032`);
  console.log(`  📡 Monitoring ${marketsMap.size} markets (${gameEvents.getStats().mappings} mapped to games)`);
  console.log(`  ⚡ Waiting for shocks... (10s idle / 1s active polling)`);
  console.log("=".repeat(70) + "\n");

  // ── 10. Graceful shutdown ────────────────────────────────────────────
  const shutdown = () => {
    console.log("\n🛑 Shutting down...");
    trader.stop();
    gameEvents.stop();
    dashboard.stop();
    ws.disconnect();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

// ============================================================================
// RUN
// ============================================================================

main().catch((err) => {
  console.error("❌ Fatal error:", err);
  process.exit(1);
});
