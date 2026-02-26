/**
 * run-shock-fade-live.ts — Entry point for LIVE shock-fade trading bot.
 *
 * Same architecture as run-shock-fade-paper.ts but using real clients:
 *   - SplitClient for pre-splitting USDC into CTF shares
 *   - MergeClient for merging unsold shares back to USDC
 *   - PolymarketClient for placing real sell orders
 *
 * *** DRY-RUN BY DEFAULT *** — Must pass --live flag for real trading.
 *
 * CLI args:
 *   --live             Enable REAL trading (default is dry-run)
 *   --max-per-game N   Capital limit per game (default $30)
 *
 * Usage:
 *   npx tsx src/run-shock-fade-live.ts               # dry-run mode
 *   npx tsx src/run-shock-fade-live.ts --live         # REAL MONEY
 *   npx tsx src/run-shock-fade-live.ts --max-per-game 50
 *   npm run shock-fade:live
 */

import * as dotenv from "dotenv";
import * as path from "path";
import * as fs from "fs";
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
import { ShockFadeLive, ShockFadeLiveConfig } from "./strategies/ShockFadeLive";
import { UserChannelWS } from "./services/UserChannelWS";
import { ShockFadeDashboardServer } from "./dashboard/ShockFadeDashboard";
import { WalletBalanceService } from "./services/WalletBalanceService";
import { SplitClient } from "./services/SplitClient";
import { MergeClient } from "./services/MergeClient";
import { PolymarketClient } from "./services/PolymarketClient";
import { PolymarketConfig } from "./types";

// League API imports for game event confirmation
import { NbaLiveApi } from "./collectors/league-apis/NbaLiveApi";
import { NhlLiveApi, NormalizedGameEvent } from "./collectors/league-apis/NhlLiveApi";
import { MlbLiveApi } from "./collectors/league-apis/MlbLiveApi";
import { NflLiveApi } from "./collectors/league-apis/NflLiveApi";
import { EspnFallbackApi } from "./collectors/league-apis/EspnFallbackApi";

// ============================================================================
// CLI ARGS
// ============================================================================

function parseArgs(): { dryRun: boolean; maxPerGame: number } {
  const args = process.argv.slice(2);
  let dryRun = true;  // *** DRY-RUN BY DEFAULT ***
  let maxPerGame = parseFloat(process.env.SHOCK_MAX_PER_GAME ?? "1000");

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--live") {
      dryRun = false;  // Only explicit --live flag enables real trading
    } else if (args[i] === "--dry-run") {
      dryRun = true;   // Explicit dry-run (already default, but allows clarity)
    } else if (args[i] === "--max-per-game" && i + 1 < args.length) {
      maxPerGame = parseFloat(args[i + 1].replace("$", ""));
      i++;
    }
  }

  return { dryRun, maxPerGame };
}

// ============================================================================
// CONFIGURATION
// ============================================================================

function loadConfig(cliArgs: { dryRun: boolean; maxPerGame: number }): ShockFadeLiveConfig {
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
    dryRun: cliArgs.dryRun,
    maxPerGame: cliArgs.maxPerGame,
    maxConcurrentGames: parseInt(process.env.SHOCK_MAX_CONCURRENT_GAMES ?? "3", 10),
    maxCyclesPerGame: parseInt(process.env.SHOCK_MAX_CYCLES_PER_GAME ?? "1", 10),
    maxConsecutiveLosses: parseInt(process.env.SHOCK_MAX_CONSEC_LOSSES ?? "3", 10),
    maxSessionLoss: parseFloat(process.env.SHOCK_MAX_SESSION_LOSS ?? "30"),
    ladderSizes: (process.env.SHOCK_LADDER_SIZES ?? "5,10,15").split(",").map(s => parseFloat(s.trim())),
    sellPriceMax: parseFloat(process.env.SHOCK_PRICE_MAX ?? "0.85"),
  };
}

// ============================================================================
// GAME EVENT CONFIRMATION (reuse from paper trader pattern)
// ============================================================================

type Sport = "NHL" | "NBA" | "MLB" | "NFL" | "CBB";

interface GameMapping {
  marketSlug: string;
  gameId: string;
  sport: Sport;
}

interface MarketEventWindow {
  events: Array<{ ts: number; team: string; type: string }>;
  lastPollTs: number;
}

class GameEventConfirmation {
  private nbaApi: NbaLiveApi;
  private nhlApi: NhlLiveApi;
  private mlbApi: MlbLiveApi;
  private nflApi: NflLiveApi;
  private espnApi: EspnFallbackApi;

  private gameMappings: Map<string, GameMapping> = new Map();
  private eventWindows: Map<string, MarketEventWindow> = new Map();
  private seenEventKeys: Set<string> = new Set();

  private pollTimer: NodeJS.Timeout | null = null;
  private activeMarkets: Set<string> = new Set();
  private fastPollTimer: NodeJS.Timeout | null = null;

  private pbpBackoff: Map<string, { nextRetryAt: number; currentBackoffMs: number; failCount: number }> = new Map();

  public onClassificationReady: ((marketSlug: string, recentEvents: number, isStructural: boolean, sameTeamRun: number, lastScoringTeam: string, lastScoringTeamRun: string) => void) | null = null;
  public onScoreUpdate: ((marketSlug: string, homeTeam: string, awayTeam: string, homeScore: number, awayScore: number, period: string, clock: string, sport: string) => void) | null = null;

  private totalPolls = 0;
  private totalBurstPolls = 0;
  private scoreTimer: NodeJS.Timeout | null = null;
  
  // Game state tracking for late-game filters
  private gameStates: Map<string, { period: number; clock: string; lastUpdate: number; sport: string }> = new Map();

  constructor() {
    this.nbaApi = new NbaLiveApi(200);
    this.nhlApi = new NhlLiveApi(200);
    this.mlbApi = new MlbLiveApi(200);
    this.nflApi = new NflLiveApi();
    this.espnApi = new EspnFallbackApi(200);
  }

  start(): void {
    this.pollTimer = setInterval(() => this.pollAll(), 10000);
    this.fastPollTimer = setInterval(() => this.pollActiveMarkets(), 1000);
    // Poll scores every 1s (critical for detecting rapid NBA score changes)
    this.scoreTimer = setInterval(() => this.pollScores(), 1000);
    this.pollScores(); // immediate first poll
    this.log("Started (10s idle / 1s active adaptive polling)");
  }

  stop(): void {
    if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }
    if (this.fastPollTimer) { clearInterval(this.fastPollTimer); this.fastPollTimer = null; }
    if (this.scoreTimer) { clearInterval(this.scoreTimer); this.scoreTimer = null; }
  }

  /**
   * Check if a market is in late-game (last 3 minutes of Q4/OT or 2nd half)
   * Used for asymmetric sell price filter tightening
   */
  isLateGame(marketSlug: string): boolean {
    const state = this.gameStates.get(marketSlug);
    if (!state) return false;
    
    const clockMins = this.parseClockMinutes(state.clock);
    
    if (state.sport === "NBA") {
      // Last 3 minutes of Q4 (period 4) or any OT period (5+)
      if (state.period >= 4) {
        return clockMins <= 3.0;
      }
    } else if (state.sport === "CBB") {
      // Last 3 minutes of 2nd half (period 2) or any OT (3+)
      if (state.period >= 2) {
        return clockMins <= 3.0;
      }
    }
    // Add other sports as needed (NHL, NFL, etc.)
    
    return false;
  }

  /**
   * Parse game clock string to minutes (decimal)
   * Examples: "3:24" → 3.4, "0:45" → 0.75, "12:00" → 12.0
   */
  private parseClockMinutes(clock: string): number {
    if (!clock || clock === "") return 0;
    const parts = clock.split(":");
    if (parts.length !== 2) return 0;
    const mins = parseInt(parts[0], 10) || 0;
    const secs = parseInt(parts[1], 10) || 0;
    return mins + secs / 60.0;
  }

  private async pollScores(): Promise<void> {
    if (!this.onScoreUpdate) return;
    try {
      // NBA scores
      const nbaGames = await this.nbaApi.getTodaysScoreboard();
      for (const game of nbaGames) {
        // Find matching market slug
        for (const [slug, mapping] of this.gameMappings.entries()) {
          if (mapping.sport === "NBA" && mapping.gameId === game.gameId) {
            const periodStr = game.gameStatus === 2
              ? `Q${game.period}` 
              : game.gameStatus === 3 ? "Final" : "Pre";
            const cleanClock = game.gameClock?.replace(/^PT/, "").replace(/\.\d+S$/, "S").replace("M", ":").replace("S", "") || "";
            this.onScoreUpdate(
              slug,
              game.awayTeam.teamTricode,
              game.homeTeam.teamTricode,
              game.awayTeam.score,
              game.homeTeam.score,
              periodStr,
              cleanClock,
              "NBA"
            );
            // Store game state for late-game filtering
            this.gameStates.set(slug, {
              period: game.period,
              clock: cleanClock,
              lastUpdate: Date.now(),
              sport: "NBA"
            });
          }
        }
      }
      // NFL scores (via ESPN)
      for (const [slug, mapping] of this.gameMappings.entries()) {
        if (mapping.sport === "NFL") {
          try {
            const resp = await this.espnApi.getScoreboard("nfl");
            for (const event of resp) {
              if (mapping.gameId === event.id) {
                this.onScoreUpdate(
                  slug,
                  event.awayTeam.abbreviation || "AWAY",
                  event.homeTeam.abbreviation || "HOME",
                  parseInt(event.awayTeam.score || "0"),
                  parseInt(event.homeTeam.score || "0"),
                  event.status.type.description || "",
                  "",
                  "NFL"
                );
              }
            }
          } catch {}
        }
      }
      // CBB scores (via ESPN)
      for (const [slug, mapping] of this.gameMappings.entries()) {
        if (mapping.sport !== "CBB") continue;
        try {
          const resp = await this.espnApi.getScoreboard("cbb");
          const game = resp.find((e) => e.id === mapping.gameId);
          if (game) {
            const periodStr = game.status.type.state === "in"
              ? `H${game.status.period || "?"}`
              : game.status.type.state === "post" ? "Final" : "Pre";
            const displayClock = game.status.displayClock || "";
            this.onScoreUpdate(
              slug,
              game.awayTeam.abbreviation || "AWAY",
              game.homeTeam.abbreviation || "HOME",
              parseInt(game.awayTeam.score || "0"),
              parseInt(game.homeTeam.score || "0"),
              periodStr,
              displayClock,
              "CBB"
            );
            // Store game state for late-game filtering (CBB uses halves: period 1-2)
            this.gameStates.set(slug, {
              period: game.status.period || 0,
              clock: displayClock,
              lastUpdate: Date.now(),
              sport: "CBB"
            });
          }
        } catch {}
      }
    } catch (err: any) {
      // Non-critical — don't spam logs for score polling failures
    }
  }

  setMarketActive(marketSlug: string): void {
    this.activeMarkets.add(marketSlug);
  }

  setMarketIdle(marketSlug: string): void {
    this.activeMarkets.delete(marketSlug);
  }

  async buildMappings(markets: Map<string, SportsMarket>): Promise<void> {
    const allMarkets = Array.from(markets.values()).filter(
      (m) => m.sport === "NHL" || m.sport === "NBA" || m.sport === "MLB" || m.sport === "NFL" || m.sport === "CBB",
    );
    if (allMarkets.length === 0) return;

    const today = new Date();
    const dateStr = `${today.getUTCFullYear()}-${String(today.getUTCMonth() + 1).padStart(2, "0")}-${String(today.getUTCDate()).padStart(2, "0")}`;

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
              this.gameMappings.set(market.marketSlug, { marketSlug: market.marketSlug, gameId: game.gameId, sport: "NBA" });
              this.log(`🔗 Mapped ${market.marketSlug} → NBA game ${game.gameId}`);
            }
          }
        }
      } catch (err: any) {
        this.log(`⚠️ NBA mapping failed: ${err?.message || err}`);
      }
    }

    const nhlMarkets = allMarkets.filter((m) => m.sport === "NHL");
    if (nhlMarkets.length > 0) {
      try {
        const games = await this.nhlApi.getGamesByDate(dateStr);
        for (const game of games) {
          for (const market of nhlMarkets) {
            if (this.gameMappings.has(market.marketSlug)) continue;
            if (this.fuzzyMatchTeams(market.marketSlug, game.homeTeam.commonName?.default || "", game.awayTeam.commonName?.default || "")) {
              this.gameMappings.set(market.marketSlug, { marketSlug: market.marketSlug, gameId: String(game.id), sport: "NHL" });
              this.log(`🔗 Mapped ${market.marketSlug} → NHL game ${game.id}`);
            }
          }
        }
      } catch (err: any) {
        this.log(`⚠️ NHL mapping failed: ${err?.message || err}`);
      }
    }

    const mlbMarkets = allMarkets.filter((m) => m.sport === "MLB");
    if (mlbMarkets.length > 0) {
      try {
        const games = await this.mlbApi.getGamesByDate(dateStr);
        for (const game of games) {
          for (const market of mlbMarkets) {
            if (this.gameMappings.has(market.marketSlug)) continue;
            if (this.fuzzyMatchTeams(market.marketSlug, game.teams.home.team.name, game.teams.away.team.name)) {
              this.gameMappings.set(market.marketSlug, { marketSlug: market.marketSlug, gameId: String(game.gamePk), sport: "MLB" });
              this.log(`🔗 Mapped ${market.marketSlug} → MLB game ${game.gamePk}`);
            }
          }
        }
      } catch (err: any) {
        this.log(`⚠️ MLB mapping failed: ${err?.message || err}`);
      }
    }

    const nflMarkets = allMarkets.filter((m) => m.sport === "NFL");
    if (nflMarkets.length > 0) {
      try {
        const games = await this.nflApi.getTodaysGames();
        for (const game of games) {
          for (const market of nflMarkets) {
            if (this.gameMappings.has(market.marketSlug)) continue;
            if (this.fuzzyMatchTeams(market.marketSlug, game.homeTeam, game.awayTeam)) {
              this.gameMappings.set(market.marketSlug, { marketSlug: market.marketSlug, gameId: game.id, sport: "NFL" });
              this.log(`🔗 Mapped ${market.marketSlug} → NFL game ${game.id}`);
            }
          }
        }
      } catch (err: any) {
        this.log(`⚠️ NFL mapping failed: ${err?.message || err}`);
      }
    }

    // CBB mappings via ESPN
    const cbbMarkets = allMarkets.filter((m) => m.sport === "CBB");
    if (cbbMarkets.length > 0) {
      try {
        const resp = await this.espnApi.getScoreboard("cbb");
        for (const event of resp) {
          const awayName = event.awayTeam.displayName || event.awayTeam.shortDisplayName || "";
          const homeName = event.homeTeam.displayName || event.homeTeam.shortDisplayName || "";
          for (const market of cbbMarkets) {
            if (this.gameMappings.has(market.marketSlug)) continue;
            if (this.fuzzyMatchTeams(market.marketSlug, homeName, awayName)) {
              this.gameMappings.set(market.marketSlug, { marketSlug: market.marketSlug, gameId: event.id, sport: "CBB" });
              this.log(`🔗 Mapped ${market.marketSlug} → CBB game ${event.id} (${awayName} @ ${homeName})`);
            }
          }
        }
      } catch (err: any) {
        this.log(`⚠️ CBB mapping failed: ${err?.message || err}`);
      }
    }

    this.log(`Game mappings: ${this.gameMappings.size}/${allMarkets.length} markets mapped`);
  }

  private async pollActiveMarkets(): Promise<void> {
    if (this.activeMarkets.size === 0) return;
    for (const marketSlug of this.activeMarkets) {
      const mapping = this.gameMappings.get(marketSlug);
      if (!mapping) continue;
      await this.pollMarket(marketSlug, mapping, true);
    }
  }

  private async pollAll(): Promise<void> {
    for (const [marketSlug, mapping] of this.gameMappings.entries()) {
      if (this.activeMarkets.has(marketSlug)) continue;
      await this.pollMarket(marketSlug, mapping, false);
    }

    const cutoff = Date.now() - 300000;
    for (const [slug, window] of this.eventWindows.entries()) {
      window.events = window.events.filter((e) => e.ts >= cutoff);
      if (window.events.length === 0 && Date.now() - window.lastPollTs > 600000) {
        this.eventWindows.delete(slug);
      }
    }

    if (this.seenEventKeys.size > 10000) {
      this.seenEventKeys.clear();
    }
  }

  private async pollMarket(marketSlug: string, mapping: GameMapping, isBurst: boolean): Promise<void> {
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
      } else if (mapping.sport === "CBB") {
        // CBB uses ESPN play-by-play API for scoring events
        const espnEvents = await this.espnApi.getPlayByPlay("cbb", mapping.gameId);
        events = espnEvents.map((e) => ({
          type: e.type,
          team: e.team,
          period: e.period,
          clock: e.clock,
          description: e.description,
          timestamp: e.timestamp,
        }));
      }

      if (this.pbpBackoff.has(mapping.gameId)) {
        this.pbpBackoff.delete(mapping.gameId);
      }

      this.processEvents(marketSlug, mapping.gameId, events, isBurst);
    } catch (err: any) {
      const existing = this.pbpBackoff.get(mapping.gameId);
      const newBackoffMs = existing ? Math.min(existing.currentBackoffMs * 2, 300_000) : 30_000;
      const failCount = existing ? existing.failCount + 1 : 1;
      this.pbpBackoff.set(mapping.gameId, { nextRetryAt: Date.now() + newBackoffMs, currentBackoffMs: newBackoffMs, failCount });
      if (failCount === 1) {
        this.log(`⚠️ ${mapping.sport} PBP error for game ${mapping.gameId}: ${err?.message || err}`);
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

      if (ev.type === "goal") {
        window.events.push({ ts: ev.timestamp || Date.now(), team: ev.team, type: ev.type });
        newEventCount++;
      }
    }

    if (isBurst && newEventCount > 0 && this.onClassificationReady) {
      const info = this.getClassificationInfo(marketSlug);
      this.onClassificationReady(marketSlug, info.recentEvents, info.isStructural, info.sameTeamRun, info.lastScoringTeam, info.lastScoringTeamRun);
    }
  }

  getClassificationInfo(marketSlug: string): { recentEvents: number; isStructural: boolean; sameTeamRun: number; lastScoringTeam: string; lastScoringTeamRun: string } {
    const window = this.eventWindows.get(marketSlug);
    if (!window) return { recentEvents: 0, isStructural: false, sameTeamRun: 0, lastScoringTeam: "", lastScoringTeamRun: "" };

    const cutoff = Date.now() - 120000;
    const recent = window.events.filter((e) => e.ts >= cutoff);
    const recentEvents = recent.length;

    let maxRun = 0;
    let currentRun = 0;
    let currentTeam = "";
    let maxRunTeam = "";
    for (const ev of recent) {
      if (ev.team === currentTeam) { currentRun++; } else { currentRun = 1; currentTeam = ev.team; }
      if (currentRun > maxRun) { maxRun = currentRun; maxRunTeam = currentTeam; }
    }

    // Last scoring team: the most recent event's team tricode
    const lastScoringTeam = recent.length > 0 ? recent[recent.length - 1].team : "";

    return { recentEvents, isStructural: false, sameTeamRun: maxRun, lastScoringTeam, lastScoringTeamRun: maxRunTeam };
  }

  getStats(): { totalPolls: number; burstPolls: number; mappings: number; trackedMarkets: number } {
    return { totalPolls: this.totalPolls, burstPolls: this.totalBurstPolls, mappings: this.gameMappings.size, trackedMarkets: this.eventWindows.size };
  }

  /**
   * Resolve which team tricode corresponds to a tokenId on a given market.
   * Uses slug abbreviations + outcome names to map tokenId → tricode.
   *
   * @param market - SportsMarket with outcomes[] and tokenIds[]
   * @param tokenId - the token that spiked
   * @returns the tricode (uppercase, e.g. "GSW", "LAL") or "" if unmappable
   */
  resolveTokenTricode(market: SportsMarket, tokenId: string): string {
    const tokenIndex = market.tokenIds.indexOf(tokenId);
    if (tokenIndex === -1) return "";

    const outcomeName = market.outcomes[tokenIndex]; // e.g., "Warriors"
    if (!outcomeName) return "";

    // Extract slug abbreviations: nba-gsw-lal-2026-02-07 → ["gsw", "lal"]
    const slugParts = market.marketSlug.toLowerCase().split("-");
    const slugAbbrevs = slugParts.slice(1, -3); // skip sport prefix and date suffix

    if (slugAbbrevs.length < 2) return "";

    const TEAM_ABBREVS: Record<string, string[]> = {
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
      ne: ["patriots", "new england"], sf: ["49ers", "san francisco"],
      gb: ["packers", "green bay"], kc: ["chiefs", "kansas city"],
      tb: ["buccaneers", "tampa bay"], no: ["saints", "new orleans"],
      nyg: ["giants", "new york giants"], nyj: ["jets", "new york jets"],
      nym: ["mets", "new york mets"], chc: ["cubs", "chicago cubs"],
      chw: ["white sox", "chicago white sox"], tex: ["rangers", "texas"],
      sd: ["padres", "san diego"], bal: ["orioles", "baltimore"],
    };

    const outcomeLower = outcomeName.toLowerCase();

    // Find which slug abbreviation matches this outcome
    for (const abbrev of slugAbbrevs) {
      const possibleNames = TEAM_ABBREVS[abbrev] || [abbrev];
      for (const name of possibleNames) {
        if (outcomeLower.includes(name) || name.includes(outcomeLower)) {
          return abbrev.toUpperCase();
        }
      }
    }

    // Fallback: return first slug abbrev if it's tokenIds[0], second if [1]
    // This is a reasonable guess since slug format is sport-away-home-date
    if (tokenIndex < slugAbbrevs.length) {
      // slug is away-home, outcomes could be in any order
      // Try matching by index — if outcomes match slug order
      return slugAbbrevs[tokenIndex].toUpperCase();
    }

    return "";
  }

  private fuzzyMatchTeams(slug: string, homeTeamName: string, awayTeamName: string): boolean {
    const lowerSlug = slug.toLowerCase();
    const homeLower = (homeTeamName || "").toLowerCase();
    const awayLower = (awayTeamName || "").toLowerCase();

    const TEAM_ABBREVS: Record<string, string[]> = {
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
      ne: ["patriots", "new england"], sf: ["49ers", "san francisco"],
      gb: ["packers", "green bay"], kc: ["chiefs", "kansas city"],
      tb: ["buccaneers", "tampa bay"], no: ["saints", "new orleans"],
      nyg: ["giants", "new york giants"], nyj: ["jets", "new york jets"],
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

  private log(msg: string): void {
    const ts = new Date().toISOString();
    console.log(`${ts} [INFO] 🏟️  [GameEvents] ${msg}`);
  }
}

// ============================================================================
// MAIN
// ============================================================================

async function main(): Promise<void> {
  const cliArgs = parseArgs();

  console.log("=".repeat(70));
  console.log("  🔴 SHOCK-FADE LIVE TRADER");
  console.log("  Real-time shock detection & LIVE trading on Polymarket sports");
  if (cliArgs.dryRun) {
    console.log("  Mode: 🟡 DRY-RUN (no real orders — pass --live for real trading)");
  } else {
    console.log("  Mode: 🔴 ⚠️  LIVE TRADING — REAL MONEY ⚠️");
    console.log("  ┌─────────────────────────────────────────────────────┐");
    console.log("  │  WARNING: This bot will place REAL orders and       │");
    console.log("  │  spend REAL USDC. Ensure you understand the risks.  │");
    console.log("  └─────────────────────────────────────────────────────┘");
  }
  const envLadderSizes = (process.env.SHOCK_LADDER_SIZES ?? "5,10,15").split(",").map(s => parseFloat(s.trim()));
  const ladderSizesStr = envLadderSizes.join('+');
  const totalShares = envLadderSizes.reduce((a, b) => a + b, 0);
  const maxGamesEnv = parseInt(process.env.SHOCK_MAX_CONCURRENT_GAMES ?? "3", 10);
  const maxCyclesPerGame = parseInt(process.env.SHOCK_MAX_CYCLES_PER_GAME ?? "1", 10);
  const preSplitPerGame = (totalShares * maxCyclesPerGame) + (envLadderSizes[0] || 0);
  console.log(`  Max per game: $${cliArgs.maxPerGame}`);
  console.log(`  Cycle: ${totalShares} shares = ${envLadderSizes.length} ladders (${ladderSizesStr})`);
  console.log(`  Pre-split: $${preSplitPerGame}/game (${maxCyclesPerGame} cycles × $${totalShares} + L1 $${envLadderSizes[0] || 0} cushion)`);
  console.log(`  Max concurrent games: ${maxGamesEnv} ($${maxGamesEnv * preSplitPerGame} capital needed)`);
  console.log(`  Max cycles/game: ${process.env.SHOCK_MAX_CYCLES_PER_GAME ?? "1"}`);
  console.log("  Port: 3033");
  console.log("=".repeat(70));

  // ── 0. Validate environment ──────────────────────────────────────────
  const privateKey = process.env.POLYMARKET_PRIVATE_KEY || process.env.PRIVATE_KEY;
  if (!privateKey) {
    console.error("❌ PRIVATE_KEY or POLYMARKET_PRIVATE_KEY not set in .env");
    process.exit(1);
  }

  const funderAddress = process.env.POLYMARKET_FUNDER || process.env.FUNDER_ADDRESS || "";
  const authMode = (process.env.AUTH_MODE || "PROXY") as "EOA" | "PROXY";

  console.log(`\n🔑 Auth mode: ${authMode}`);

  // ── 1. Initialize real clients ───────────────────────────────────────
  console.log("\n🔧 Initializing trading clients...");

  const splitClient = new SplitClient(privateKey);
  const mergeClient = new MergeClient(privateKey);

  const polyConfig: PolymarketConfig = {
    host: process.env.POLYMARKET_HOST || "https://clob.polymarket.com",
    chainId: parseInt(process.env.POLYMARKET_CHAIN_ID || "137", 10),
    privateKey,
    funderAddress,
    authMode,
  };

  const polyClient = new PolymarketClient(polyConfig);
  await polyClient.initialize();
  console.log("  ✅ PolymarketClient initialized");

  // Initialize UserChannelWS for real-time fill detection (live mode only)
  let userChannelWS: UserChannelWS | undefined;
  if (!cliArgs.dryRun) {
    try {
      const apiCreds = await polyClient.getApiCreds();
      userChannelWS = new UserChannelWS({
        apiKey: apiCreds.key,
        secret: apiCreds.secret,
        passphrase: apiCreds.passphrase,
      });
      await userChannelWS.connect();
      console.log("  ✅ UserChannelWS connected (real-time fill detection)");
    } catch (err: any) {
      console.warn(`  ⚠️ UserChannelWS failed to connect (falling back to polling): ${err?.message || err}`);
      userChannelWS = undefined;
    }
  } else {
    console.log("  [DRY-RUN] Skipping UserChannelWS (not needed in dry-run)");
  }

  // Ensure CTF approvals
  console.log("  🔐 Ensuring CTF approvals...");
  if (!cliArgs.dryRun) {
    try {
      const approvalResult = await splitClient.ensureCTFApprovals();
      if (!approvalResult.success) {
        console.warn(`  ⚠️ CTF approval check failed (non-fatal, likely already approved): ${approvalResult.error}`);
      } else {
        console.log(`  ✅ CTF approvals: ${approvalResult.alreadyApproved ? "already set" : "done"}`);
      }
    } catch (err: any) {
      console.warn(`  ⚠️ CTF approval check failed (non-fatal): ${err.message}`);
    }
  } else {
    console.log("  [DRY-RUN] Skipping CTF approvals");
  }

  // ── 2. Load config ──────────────────────────────────────────────────
  const config = loadConfig(cliArgs);

  console.log("\n📋 Configuration:");
  console.log(`  σ threshold:    ${config.sigmaThreshold}`);
  console.log(`  Min absolute:   ${(config.minAbsoluteMove * 100).toFixed(0)}¢`);
  console.log(`  Ladder spacing: ${(config.ladderSpacing * 100).toFixed(0)}¢`);
  console.log(`  Fade target:    ${config.fadeTargetCents}¢`);
  console.log(`  Timeout:        ${config.fadeWindowMs / 1000}s`);
  console.log(`  Dry run:        ${config.dryRun}`);
  console.log(`  Max/game:       $${config.maxPerGame}`);

  // ── 3. Discover markets ──────────────────────────────────────────────
  console.log("\n📡 Discovering live sports markets...");
  const discovery = new SportsMarketDiscovery(5 * 60 * 1000);
  let discovered = await discovery.discoverMarkets();

  // Sport filter: only trade specific sports (default: NBA only until other strategies are backtested)
  const enabledSports = (process.env.SHOCK_ENABLED_SPORTS ?? "NBA").split(",").map(s => s.trim().toUpperCase());
  const preFilterCount = discovered.length;
  discovered = discovered.filter((m) => enabledSports.includes(m.sport?.toUpperCase() ?? ""));
  if (discovered.length < preFilterCount) {
    console.log(`  🎯 Sport filter: ${enabledSports.join(",")} — kept ${discovered.length}/${preFilterCount} markets`);
  }

  // Minimum volume filter: skip illiquid markets
  const minVolume = parseFloat(process.env.SHOCK_MIN_VOLUME ?? "10000");
  if (minVolume > 0) {
    const preVolCount = discovered.length;
    discovered = discovered.filter((m) => (m.volume ?? 0) >= minVolume);
    const filtered = preVolCount - discovered.length;
    if (filtered > 0) {
      console.log(`  💰 Volume filter: min $${minVolume.toLocaleString()} — dropped ${filtered} low-volume markets`);
    }
  }

  // All non-closed markets (for dashboard: upcoming + live + pending)
  const allMarkets = discovered.filter((m) => m.state !== MarketState.CLOSED);
  // Active/pending markets (for WS + shock detection)
  const liveMarkets = allMarkets.filter(
    (m) =>
      m.state === MarketState.ACTIVE ||
      m.state === MarketState.PENDING_ENTRY,
  );

  console.log(`  Found ${discovered.length} markets total, ${allMarkets.length} non-closed, ${liveMarkets.length} live/active`);

  const allTokenIds = liveMarkets.flatMap((m) => m.tokenIds);
  console.log(`  📊 Monitoring ${allTokenIds.length} tokens across ${liveMarkets.length} markets`);

  // ── 4. Connect WebSocket ─────────────────────────────────────────────
  console.log("\n🔌 Connecting to Polymarket WebSocket...");
  const ws = new OrderBookWebSocket(allTokenIds.length > 0 ? allTokenIds : ["placeholder"]);
  // Always connect WS — even if no active markets yet, the 5-min refresh
  // will addTokens() when markets go active. WS must be connected to subscribe.
  await ws.connect();
  console.log("  ✅ WebSocket connected");

  // ── 5. Initialize components ─────────────────────────────────────────
  console.log("\n🧠 Initializing shock detection engine...");
  const detector = new ShockFadeDetector(ws, config);

  console.log("🔴 Initializing LIVE trading engine...");
  const trader = new ShockFadeLive(
    ws,
    splitClient,
    mergeClient,
    polyClient,
    config,
    "./data/shock-fade-live-state.json",
    userChannelWS,
  );

  // Register ALL markets (upcoming ones will go to dashboard later)
  const marketsMap = new Map<string, SportsMarket>();
  const activeConditionIds: string[] = [];
  for (const market of allMarkets) {
    marketsMap.set(market.marketSlug, market);
    // Only register active markets for WS/trading
    if (market.state === MarketState.ACTIVE || market.state === MarketState.PENDING_ENTRY) {
      detector.registerMarketTokens(market.tokenIds, market.marketSlug);
      trader.registerTokenPair(market);
      if (market.conditionId) {
        activeConditionIds.push(market.conditionId);
      }
    }
  }

  // Subscribe UserChannelWS to all active condition IDs
  if (userChannelWS && activeConditionIds.length > 0) {
    userChannelWS.subscribe(activeConditionIds);
    console.log(`  📡 UserChannelWS subscribed to ${activeConditionIds.length} markets`);
  }

  // ── 6. Pre-split for live/active markets ─────────────────────────────
  // Pre-split up to maxConcurrentGames to manage capital.
  // Each game locks $cycleSize in CTF tokens. Capital needed = maxGames × cycleSize.
  const maxGames = config.maxConcurrentGames;
  const cycleSize = config.ladderSizes.reduce((a: number, b: number) => a + b, 0);
  const capitalNeeded = maxGames * cycleSize;
  console.log(`\n💧 Pre-splitting for up to ${maxGames} concurrent games ($${cycleSize}/game = $${capitalNeeded} total)...`);
  let preSplitCount = 0;
  for (const market of liveMarkets) {
    if (!trader.canPreSplitForGame(market.marketSlug)) {
      console.log(`  ⏸️ Reached max concurrent games (${maxGames}) — remaining games will wait for slots`);
      break;
    }
    if ((market.state === MarketState.ACTIVE || market.state === MarketState.PENDING_ENTRY) && market.conditionId) {
      // Skip games that are already decided (price >95¢ or <5¢)
      if (market.outcomePrices && market.outcomePrices.length >= 2) {
        const maxP = Math.max(...market.outcomePrices);
        const minP = Math.min(...market.outcomePrices);
        if (maxP > 0.95 || minP < 0.05) {
          console.log(`  ⏭️ Skipping ${market.marketSlug} — game decided (${market.outcomePrices.map((p: number) => (p * 100).toFixed(0) + '¢').join('/')})`);
          continue;
        }
      }
      const success = await trader.preSplitForMarket(market.marketSlug);
      if (success) {
        console.log(`  ✅ Pre-split ready for ${market.marketSlug}`);
        preSplitCount++;
      } else {
        console.log(`  ⚠️ Pre-split failed for ${market.marketSlug}`);
      }
    }
  }

  // ── 7. Game event confirmation ───────────────────────────────────────
  console.log("\n🏟️ Initializing game event confirmation...");
  const gameEvents = new GameEventConfirmation();
  await gameEvents.buildMappings(marketsMap);
  
  // Pass gameEvents to trader for late-game filtering
  trader.setGameEvents(gameEvents);

  // ── 8. Wire up events ────────────────────────────────────────────────
  const pendingShocks: Map<string, { shock: ShockEvent; detectedAt: number }> = new Map();
  const marketsWithPositions: Set<string> = new Set();
  const entryEventCounts: Map<string, number> = new Map();
  // Smart exit: track which team tricode caused the original shock for each market
  const shockTeams: Map<string, string> = new Map(); // marketSlug → shock team tricode (uppercase)

  // Score update callback → push to dashboard
  gameEvents.onScoreUpdate = (marketSlug, homeTeam, awayTeam, homeScore, awayScore, period, clock, sport) => {
    dashboard.updateScore({ marketSlug, homeTeam, awayTeam, homeScore, awayScore, period, clock, sport });
  };

  // Classification callback
  gameEvents.onClassificationReady = (marketSlug: string, recentEvents: number, isStructural: boolean, sameTeamRun: number, lastScoringTeam: string, lastScoringTeamRun: string) => {
    // ENTRY: classify pending shocks
    for (const [shockId, entry] of pendingShocks.entries()) {
      if (entry.shock.marketSlug !== marketSlug) continue;

      const classification = detector.classifyShock(entry.shock, recentEvents, isStructural);
      const latency = Date.now() - entry.detectedAt;

      if (classification === "single_event") {
        const mode = cliArgs.dryRun ? "[DRY-RUN] " : "";
        console.log(`✅ ${mode}CYCLE START: ${marketSlug} → single_event (${latency}ms) — placing orders`);
        dashboard.notifyShockClassified(marketSlug, "single_event", latency);
        dashboard.notifySystem(`${mode}Shock classified: ${marketSlug} → single_event (${latency}ms)`);

        // Resolve shock team tricode BEFORE calling handleShock so it's stored on the TP
        let resolvedShockTeam: string | null = null;
        const market = marketsMap.get(marketSlug);
        if (market) {
          const shockTricode = gameEvents.resolveTokenTricode(market, entry.shock.tokenId);
          if (shockTricode) {
            resolvedShockTeam = shockTricode;
            shockTeams.set(marketSlug, shockTricode);
            console.log(`🏷️ Shock team for ${marketSlug}: ${shockTricode} (token ${entry.shock.tokenId.slice(0, 8)}… = ${market.outcomes[market.tokenIds.indexOf(entry.shock.tokenId)] || "?"})`);
          } else if (lastScoringTeam) {
            resolvedShockTeam = lastScoringTeam;
            shockTeams.set(marketSlug, lastScoringTeam);
            console.log(`🏷️ Shock team for ${marketSlug}: ${lastScoringTeam} (from scoring event, fuzzy match failed)`);
          } else {
            console.log(`⚠️ Could not determine shock team for ${marketSlug} — will use default exit-on-any-event`);
          }
        }

        // Pass shockTeam to handleShock so it gets stored on the CumulativeTP
        (entry.shock as any).shockTeam = resolvedShockTeam;
        trader.handleShock(entry.shock);
        marketsWithPositions.add(marketSlug);
        entryEventCounts.set(marketSlug, recentEvents);
        gameEvents.setMarketActive(marketSlug);
      } else if (classification === "scoring_run" || classification === "structural") {
        console.log(`🚫 SKIP: ${marketSlug} → ${classification} (${recentEvents} events, ${latency}ms)`);
        dashboard.notifyShockClassified(marketSlug, classification, latency);
        dashboard.notifySystem(`Shock skipped: ${marketSlug} → ${classification} (${recentEvents} events)`);
        gameEvents.setMarketIdle(marketSlug);
        detector.resetCooldown(marketSlug); // Didn't trade → ready for next shock
      } else {
        console.log(`⏭️ SKIP: ${marketSlug} → unclassified (${recentEvents} events, ${latency}ms)`);
        dashboard.notifyShockClassified(marketSlug, "unclassified", latency);
        dashboard.notifySystem(`Shock unclassified: ${marketSlug} (${recentEvents} events)`);
        gameEvents.setMarketIdle(marketSlug);
        detector.resetCooldown(marketSlug); // Didn't trade → ready for next shock
      }

      pendingShocks.delete(shockId);
    }

    // EXIT: detect new events on markets with open positions
    if (marketsWithPositions.has(marketSlug)) {
      const openPositions = trader.getOpenPositions().filter(p => p.marketSlug === marketSlug);
      if (openPositions.length === 0) {
        marketsWithPositions.delete(marketSlug);
        entryEventCounts.delete(marketSlug);
        shockTeams.delete(marketSlug);
        gameEvents.setMarketIdle(marketSlug);
        return;
      }

      const entryCount = entryEventCounts.get(marketSlug) ?? 0;
      if (recentEvents > entryCount) {
        const oldestPosition = openPositions.reduce((a, b) => a.entryTime < b.entryTime ? a : b);
        const timeSinceEntry = Date.now() - oldestPosition.entryTime;
        const shockTeam = shockTeams.get(marketSlug); // team that caused original shock

        // Scoring run protection: 2+ same-team events → bail ALL cycles (conservative)
        if (sameTeamRun >= 2 && timeSinceEntry > 5000) {
          // Scoring run: always bail regardless of team (too dangerous)
          console.log(`🚨 SCORING RUN: ${marketSlug} — ${sameTeamRun} same-team events by ${lastScoringTeamRun || "unknown"} → bail ALL cycles`);
          dashboard.notifySystem(`🚨 Scoring run bail: ${marketSlug} (${sameTeamRun} events by ${lastScoringTeamRun || "?"})`, "warn");
          dashboard.addGameEvent(marketSlug, `Scoring run (${lastScoringTeamRun}) — bailing all positions`, "");
          trader.handleScoringRun(marketSlug);
          // Check if any positions remain (some cycles may have already closed)
          const remaining = trader.getOpenPositions().filter(p => p.marketSlug === marketSlug);
          if (remaining.length === 0) {
            marketsWithPositions.delete(marketSlug);
            entryEventCounts.delete(marketSlug);
            shockTeams.delete(marketSlug);
            gameEvents.setMarketIdle(marketSlug);
          } else {
            entryEventCounts.set(marketSlug, recentEvents);
          }
          return;
        }

        // Delegate per-cycle adverse/favorable decision to trader
        // The trader's handleGameEvent now handles per-cycle exit logic internally
        if (timeSinceEntry > 5000) {
          const effectiveEventTeam = lastScoringTeam || null;
          console.log(
            `🏟️ Event on ${marketSlug}: team=${effectiveEventTeam || "unknown"} ` +
              `(${(timeSinceEntry / 1000).toFixed(0)}s hold, events: ${entryCount}→${recentEvents}) → delegating to trader`,
          );
          dashboard.addGameEvent(marketSlug, `Scoring event by ${effectiveEventTeam || "unknown"} — trader deciding per-cycle`, "");
          trader.handleGameEvent(marketSlug, effectiveEventTeam);

          // Update entry event count
          entryEventCounts.set(marketSlug, recentEvents);

          // Check if all positions are closed now
          const remaining = trader.getOpenPositions().filter(p => p.marketSlug === marketSlug);
          if (remaining.length === 0) {
            marketsWithPositions.delete(marketSlug);
            entryEventCounts.delete(marketSlug);
            shockTeams.delete(marketSlug);
            gameEvents.setMarketIdle(marketSlug);
          }
        }
      }
    }
  };

  // Shock detection → event confirmation activation (+ dashboard notify already wired above)
  detector.on("shock", (shock: ShockEvent) => {
    const shockId = `${shock.tokenId}_${shock.timestamp}`;
    pendingShocks.set(shockId, { shock, detectedAt: Date.now() });
    gameEvents.setMarketActive(shock.marketSlug);

    // 10s hard cutoff — if no event confirmed by burst-polling within 10s, SKIP.
    // The overshoot window is gone by then. Matches backtest event_filtered logic.
    setTimeout(() => {
      if (pendingShocks.has(shockId)) {
        const info = gameEvents.getClassificationInfo(shock.marketSlug);
        console.log(`⏭️ SKIP (10s timeout): ${shock.marketSlug} — ${info.recentEvents} events found but too late to trade`);
        dashboard.notifyShockClassified(shock.marketSlug, "skipped (10s)", 10000);
        dashboard.notifySystem(`Shock expired: ${shock.marketSlug} (10s timeout, ${info.recentEvents} events)`);
        gameEvents.setMarketIdle(shock.marketSlug);
        pendingShocks.delete(shockId);
        // Reset cooldown — we didn't trade, so allow next shock immediately
        detector.resetCooldown(shock.marketSlug);
      }
    }, 10000);
  });

  // ── 9. Dashboard ─────────────────────────────────────────────────────
  console.log("\n📊 Starting dashboard on port 3033...");
  const dashboard = new ShockFadeDashboardServer({ port: 3033 });
  dashboard.setMode(cliArgs.dryRun ? "paper" : "live");
  dashboard.setDetector(detector);
  // ShockFadeLive has compatible interface with ShockFadePaperTrader for dashboard
  // (getStats, getOpenPositions, getActiveOrders, etc.)
  // Cast to satisfy the type — the dashboard only calls the query methods
  dashboard.setTrader(trader as any);
  dashboard.setMarkets(marketsMap);
  // Push all markets (including upcoming) to dashboard
  for (const market of marketsMap.values()) {
    dashboard.updateMarket(market);
  }
  await dashboard.start();

  // ── 9a. Wallet balance service ────────────────────────────────────────
  const rpcUrl = process.env.POLYGON_RPC_URL || "https://polygon-rpc.com";
  if (funderAddress) {
    console.log("\n💰 Starting wallet balance service...");
    const walletService = new WalletBalanceService(rpcUrl, funderAddress);
    dashboard.setWalletService(walletService);
    walletService.start();

    // Refresh wallet after key trading events
    trader.on("ordersPlaced", () => {
      // Split just happened — refresh after a short delay to let chain confirm
      setTimeout(() => walletService.refresh(), 3000);
    });

    trader.on("positionClosed", () => {
      // Merge/sell just happened
      setTimeout(() => walletService.refresh(), 3000);
    });

    console.log(`  ✅ Wallet service started for ${funderAddress.slice(0, 8)}...${funderAddress.slice(-6)}`);
  } else {
    console.log("\n⚠️ No POLYMARKET_FUNDER set — wallet balance service disabled");
  }

  // ── 9b. Wire trader events → dashboard ────────────────────────────────
  trader.on("ordersPlaced", (info: { shockId: string; marketSlug: string; sellTokenId: string; heldTokenId: string }) => {
    const orders = trader.getActiveOrders().filter(o => o.shockId === info.shockId);
    for (const order of orders) {
      dashboard.notifyOrderPlaced(order as any);
    }
    const mode = cliArgs.dryRun ? "[DRY-RUN] " : "";
    dashboard.notifySystem(`${mode}Placed ladder orders for ${info.marketSlug}`);
  });

  trader.on("positionOpened", (position: any) => {
    const allOrders = trader.getAllOrders();
    const order = allOrders.find(o => o.id === position.orderId);
    if (order) {
      dashboard.notifyOrderFilled(order as any);
    }
    const mode = cliArgs.dryRun ? "[DRY-RUN] " : "";
    dashboard.notifySystem(`${mode}Position opened: ${position.id} [${position.marketSlug}]`);
  });

  trader.on("positionClosed", (info: { position: any; record: any }) => {
    dashboard.notifyPositionClosed(info.position as any, info.record as any);
  });

  trader.on("orderFilled", (order: any) => {
    dashboard.notifyOrderFilled(order as any);
  });

  trader.on("orderCancelled", (order: any) => {
    dashboard.notifyOrderCancelled(order as any);
  });

  trader.on("tpUpdate", (tp: any) => {
    dashboard.notifyTPUpdate(tp);
  });

  // Wire shock detection → dashboard
  detector.on("shock", (shock: ShockEvent) => {
    dashboard.notifyShockDetected(shock);
  });

  // ── 10. Start everything ─────────────────────────────────────────────
  detector.start();
  trader.start();
  gameEvents.start();

  // ── 11. Periodic market refresh ──────────────────────────────────────
  setInterval(async () => {
    try {
      const refreshedRaw = await discovery.discoverMarkets();
      const refreshed = refreshedRaw
        .filter((m) => enabledSports.includes(m.sport?.toUpperCase() ?? ""))
        .filter((m) => minVolume <= 0 || (m.volume ?? 0) >= minVolume);
      const allRefreshed = refreshed.filter((m) => m.state !== MarketState.CLOSED);

      let newCount = 0;
      for (const market of allRefreshed) {
        // Always update dashboard (state may have changed: upcoming → active)
        dashboard.updateMarket(market);

        if (!marketsMap.has(market.marketSlug)) {
          marketsMap.set(market.marketSlug, market);
          newCount++;
        }

        // Register for WS/trading if active (handles upcoming → active transition)
        if (market.state === MarketState.ACTIVE || market.state === MarketState.PENDING_ENTRY) {
          if (!detector.hasMarket(market.marketSlug)) {
            detector.registerMarketTokens(market.tokenIds, market.marketSlug);
            trader.registerTokenPair(market);
            ws.addTokens(market.tokenIds);
            // Subscribe UserChannelWS to new condition IDs
            if (userChannelWS && market.conditionId) {
              userChannelWS.subscribe([market.conditionId]);
            }
          }
          // Pre-split for newly active markets (respects game limit)
          if ((market.state === MarketState.ACTIVE || market.state === MarketState.PENDING_ENTRY) && market.conditionId && trader.canPreSplitForGame(market.marketSlug)) {
            trader.preSplitForMarket(market.marketSlug);
          }
        }
      }

      if (newCount > 0) {
        console.log(`  🆕 Added ${newCount} new markets (total: ${marketsMap.size})`);
      }
      // Always rebuild game mappings — NBA CDN date can flip mid-session
      await gameEvents.buildMappings(marketsMap);
    } catch (err) {
      console.error("  ❌ Market refresh error:", err);
    }
  }, 5 * 60 * 1000);

  // ── 12. Status logging ───────────────────────────────────────────────
  setInterval(() => {
    const stats = trader.getStats();
    const shockCount = detector.getRecentShocks(60000).length;
    const pnl = stats.totalPnL;
    const emoji = pnl >= 0 ? "📈" : "📉";
    const evStats = gameEvents.getStats();
    const mode = cliArgs.dryRun ? "[DRY-RUN]" : "[LIVE]";
    const haltedTag = trader.isHalted() ? " 🛑HALTED" : "";

    console.log(
      `${emoji} ${mode}${haltedTag} Markets: ${marketsMap.size} | ` +
        `Shocks (1m): ${shockCount} | ` +
        `Orders: ${stats.totalOrdersFilled}/${stats.totalOrdersPlaced} filled | ` +
        `Positions: ${stats.totalPositionsOpened} opened, ${stats.totalPositionsClosed} closed | ` +
        `P&L: ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)} | ` +
        `Win: ${(stats.winRate * 100).toFixed(0)}% | ` +
        `API: ${evStats.totalPolls} polls (${evStats.burstPolls} burst) | ` +
        `Dashboard: :3033 (${dashboard.getClientCount()} clients)`,
    );
  }, 60000);

  console.log("\n" + "=".repeat(70));
  console.log(`  ✅ ALL SYSTEMS GO ${cliArgs.dryRun ? "(DRY-RUN)" : "⚠️  LIVE TRADING ACTIVE ⚠️"}`);
  console.log(`  📊 Dashboard: http://0.0.0.0:3033${cliArgs.dryRun ? "" : "?mode=live"}`);
  console.log(`  📡 Monitoring ${marketsMap.size} markets (${gameEvents.getStats().mappings} mapped to games)`);
  console.log(`  ⚡ Waiting for shocks... (10s idle / 1s active polling)`);
  console.log("=".repeat(70) + "\n");

  // ── 13. Graceful shutdown ────────────────────────────────────────────
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return; // Prevent double-shutdown (SIGINT + SIGTERM)
    shuttingDown = true;
    console.log("\n🛑 Shutting down...");

    // Merge remaining shares back to USDC
    console.log("🔄 Merging remaining inventory...");
    for (const inv of trader.getAllInventory()) {
      await trader.mergeRemainingShares(inv.marketSlug);
    }

    trader.stop();
    gameEvents.stop();
    dashboard.stop();
    ws.disconnect();
    if (userChannelWS) {
      userChannelWS.disconnect();
    }
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // ── 14. Hot-reload config on SIGHUP ──────────────────────────────────
  //
  // Usage: kill -HUP <pid>
  // Re-reads .env, applies changes to strategy + detector.
  // Only affects NEW shocks/cycles — in-progress cycles untouched.

  process.on("SIGHUP", () => {
    console.log("\n🔄 SIGHUP received — reloading config from .env...\n");
    try {
      // Re-read .env (dotenv won't override existing process.env by default,
      // so we read the file manually and parse it)
      const envPath = path.resolve(process.cwd(), ".env");
      const envParsed = dotenv.parse(fs.readFileSync(envPath));

      // Parse new values
      const newVals = {
        maxConcurrentGames: parseInt(envParsed.SHOCK_MAX_CONCURRENT_GAMES ?? "3", 10),
        maxCyclesPerGame: parseInt(envParsed.SHOCK_MAX_CYCLES_PER_GAME ?? "1", 10),
        maxConsecutiveLosses: parseInt(envParsed.SHOCK_MAX_CONSEC_LOSSES ?? "3", 10),
        maxSessionLoss: parseFloat(envParsed.SHOCK_MAX_SESSION_LOSS ?? "30"),
        ladderSizes: (envParsed.SHOCK_LADDER_SIZES ?? "5,10,15").split(",").map(s => parseFloat(s.trim())),
        ladderSpacing: parseFloat(envParsed.SHOCK_LADDER_SPACING ?? "0.03"),
        fadeTargetCents: parseFloat(envParsed.SHOCK_FADE_TARGET ?? "3"),
        // Detector params
        sigmaThreshold: parseFloat(envParsed.SHOCK_SIGMA ?? "3.0"),
        minAbsoluteMove: parseFloat(envParsed.SHOCK_MIN_MOVE ?? "0.03"),
        cooldownMs: parseInt(envParsed.SHOCK_COOLDOWN_MS ?? "30000", 10),
        targetPriceRange: [
          parseFloat(envParsed.SHOCK_PRICE_MIN ?? "0.07"),
          parseFloat(envParsed.SHOCK_PRICE_MAX ?? "0.91"),
        ] as [number, number],
        sellPriceMax: parseFloat(envParsed.SHOCK_PRICE_MAX ?? "0.85"),
      };

      // Apply to strategy (maxConcurrentGames, ladderSizes, etc.)
      const stratChanges = trader.reloadConfig(newVals);

      // Apply to detector (sigma, minMove, priceRange, cooldown)
      const detectorChanges = detector.updateConfig({
        sigmaThreshold: newVals.sigmaThreshold,
        minAbsoluteMove: newVals.minAbsoluteMove,
        cooldownMs: newVals.cooldownMs,
        targetPriceRange: newVals.targetPriceRange,
      });

      const allChanges = [...stratChanges, ...detectorChanges];
      if (allChanges.length === 0) {
        console.log("🔄 Config reloaded — no changes detected\n");
      } else {
        console.log("🔄 Config changes applied:");
        for (const c of allChanges) console.log(`   ${c}`);
        console.log("");
      }

      // Push config update to dashboard
      dashboard.addLog("SYS", allChanges.length > 0
        ? `Config reloaded: ${allChanges.join(", ")}`
        : "Config reloaded — no changes");

    } catch (err: any) {
      console.error(`❌ Config reload failed: ${err?.message || err}`);
      dashboard.addLog("SYS", `Config reload FAILED: ${err?.message || err}`);
    }
  });
}

// ============================================================================
// RUN
// ============================================================================

main().catch((err) => {
  console.error("❌ Fatal error:", err);
  process.exit(1);
});
