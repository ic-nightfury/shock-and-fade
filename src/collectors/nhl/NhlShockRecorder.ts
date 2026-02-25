import Database from "better-sqlite3";
import { OrderBookWebSocket } from "../../services/OrderBookWS";
import { SportsMarketDiscovery, SportsMarket } from "../../services/SportsMarketDiscovery";
import { NhlLiveApi, NormalizedGameEvent } from "../league-apis/NhlLiveApi";
import { NbaLiveApi } from "../league-apis/NbaLiveApi";
import { MlbLiveApi } from "../league-apis/MlbLiveApi";
import { NflLiveApi } from "../league-apis/NflLiveApi";
import { EspnFallbackApi } from "../league-apis/EspnFallbackApi";

export type RecorderConfig = {
  dbPath: string;
  snapshotThrottleMs?: number;
  discoveryIntervalMs?: number;
  alertFilePath?: string;
  /** Sportradar NHL API key — only used if USE_SPORTRADAR=true */
  sportradarApiKey?: string;
  sportradarAccessLevel?: string;
  /** Polling interval for play-by-play (ms). Default 10000. */
  sportradarPollMs?: number;
  /** Force Sportradar instead of free APIs (env: USE_SPORTRADAR=true) */
  useSportradar?: boolean;
};

/** Maps market slugs → game IDs (best-effort fuzzy match) */
type GameMapping = {
  marketSlug: string;
  gameId: string;
  sport: "NHL" | "NBA" | "MLB" | "NFL" | "CBB";
};

/** Data source being used for game events */
type DataSource = "free-league-apis" | "sportradar" | "none";

export class NhlShockRecorder {
  private db: Database.Database;
  private ws: OrderBookWebSocket | null = null;
  private discovery: SportsMarketDiscovery;
  private markets: Map<string, SportsMarket> = new Map();
  private lastSnapshotTs: Map<string, number> = new Map();
  private config: Required<RecorderConfig>;
  private discoveryTimer: NodeJS.Timeout | null = null;
  private alertFilePath: string;

  // Fair-value tracking: which tokens already have a fair value stored
  private fairValuesCaptured: Set<string> = new Set();

  // Data source
  private dataSource: DataSource = "none";

  // Free league API clients
  private nhlApi: NhlLiveApi | null = null;
  private nbaApi: NbaLiveApi | null = null;
  private mlbApi: MlbLiveApi | null = null;
  private nflApi: NflLiveApi | null = null;
  private espnApi: EspnFallbackApi | null = null;

  // Polling state
  private pollTimer: NodeJS.Timeout | null = null;
  private gameMappings: Map<string, GameMapping> = new Map(); // marketSlug → GameMapping
  private seenEventKeys: Set<string> = new Set(); // dedup events
  private firstPollGames: Set<string> = new Set(); // suppress log flood on restart
  private lastApiCallTs: number = 0;

  // Prepared statements (lazy-init)
  private stmtInsertSnapshot: Database.Statement | null = null;
  private stmtInsertTrade: Database.Statement | null = null;
  private stmtInsertDepth: Database.Statement | null = null;
  private stmtInsertFairValue: Database.Statement | null = null;
  private stmtInsertGameEvent: Database.Statement | null = null;
  private stmtInsertGap: Database.Statement | null = null;

  // Health monitoring
  private recorderStartedAt: number = Date.now();
  private healthMonitorTimer: NodeJS.Timeout | null = null;
  private totalGapsRecorded: number = 0;
  private snapshotCount: number = 0;
  private lastSnapshotTime: number = 0;

  // PBP backoff tracking: gameId → { nextRetryAt, currentBackoffMs, failCount }
  private pbpBackoff: Map<string, { nextRetryAt: number; currentBackoffMs: number; failCount: number }> = new Map();

  constructor(config: RecorderConfig) {
    this.config = {
      dbPath: config.dbPath,
      snapshotThrottleMs: config.snapshotThrottleMs ?? 1000,
      discoveryIntervalMs: config.discoveryIntervalMs ?? 60_000,
      alertFilePath: config.alertFilePath ?? "./data/live_market_alerts.jsonl",
      sportradarApiKey: config.sportradarApiKey ?? "",
      sportradarAccessLevel: config.sportradarAccessLevel ?? "trial",
      sportradarPollMs: Math.max(config.sportradarPollMs ?? 10_000, 2000),
      useSportradar: config.useSportradar ?? false,
    };

    const path = require("path");
    const fs = require("fs");
    fs.mkdirSync(path.dirname(this.config.dbPath), { recursive: true });
    fs.mkdirSync(path.dirname(this.config.alertFilePath), { recursive: true });

    this.alertFilePath = this.config.alertFilePath;

    this.db = new Database(this.config.dbPath);
    this.db.pragma("journal_mode = WAL");
    this.discovery = new SportsMarketDiscovery(5 * 60 * 1000);
    this.initSchema();
    this.initDataSource();
  }

  /* ─── Schema ─────────────────────────────────────────────────────── */

  private initSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS markets (
        market_slug TEXT PRIMARY KEY,
        condition_id TEXT,
        sport TEXT,
        outcome1 TEXT,
        outcome2 TEXT,
        token1 TEXT,
        token2 TEXT,
        created_at INTEGER
      );

      CREATE TABLE IF NOT EXISTS snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        market_slug TEXT NOT NULL,
        token_id TEXT NOT NULL,
        best_bid REAL NOT NULL,
        best_ask REAL NOT NULL,
        mid_price REAL NOT NULL
      );

      CREATE TABLE IF NOT EXISTS trades (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        market_slug TEXT NOT NULL,
        token_id TEXT NOT NULL,
        price REAL NOT NULL,
        size REAL NOT NULL,
        side TEXT
      );

      -- Orderbook depth snapshots (top N levels)
      CREATE TABLE IF NOT EXISTS depth_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        market_slug TEXT NOT NULL,
        token_id TEXT NOT NULL,
        level INTEGER NOT NULL,
        bid_price REAL,
        bid_size REAL,
        ask_price REAL,
        ask_size REAL
      );

      -- Pre-game fair value baseline
      CREATE TABLE IF NOT EXISTS fair_values (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        market_slug TEXT NOT NULL,
        token_id TEXT NOT NULL,
        fair_bid REAL NOT NULL,
        fair_ask REAL NOT NULL,
        captured_at INTEGER NOT NULL,
        UNIQUE(market_slug, token_id)
      );

      -- Game events (from free APIs or Sportradar)
      CREATE TABLE IF NOT EXISTS game_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        market_slug TEXT NOT NULL,
        sportradar_game_id TEXT,
        event_type TEXT NOT NULL,
        team TEXT,
        period TEXT,
        clock TEXT,
        description TEXT
      );

      -- Recorder gap tracking for reliability monitoring
      CREATE TABLE IF NOT EXISTS recorder_gaps (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        start_ts INTEGER NOT NULL,
        end_ts INTEGER NOT NULL,
        duration_ms INTEGER NOT NULL,
        reason TEXT
      );

      -- Indexes for query performance
      CREATE INDEX IF NOT EXISTS idx_snapshots_market_ts ON snapshots(market_slug, ts);
      CREATE INDEX IF NOT EXISTS idx_depth_market_ts ON depth_snapshots(market_slug, ts);
      CREATE INDEX IF NOT EXISTS idx_fair_values_market ON fair_values(market_slug);
      CREATE INDEX IF NOT EXISTS idx_game_events_market_ts ON game_events(market_slug, ts);
    `);
  }

  /* ─── Data source init ───────────────────────────────────────────── */

  private initDataSource() {
    // Free league APIs (no API keys needed)
    this.nhlApi = new NhlLiveApi(2000);
    this.nbaApi = new NbaLiveApi(2000);
    this.mlbApi = new MlbLiveApi(2000);
    this.nflApi = new NflLiveApi();
    this.espnApi = new EspnFallbackApi(2000);
    this.dataSource = "free-league-apis";
    console.log("✅ Data source: Free league APIs (NHL/NBA/MLB/NFL + ESPN fallback)");
  }

  /** Get the active data source name */
  getDataSource(): DataSource {
    return this.dataSource;
  }

  /* ─── Lifecycle ──────────────────────────────────────────────────── */

  async start(): Promise<void> {
    this.recorderStartedAt = Date.now();
    await this.refreshMarkets();
    await this.startWebSocket();

    this.discoveryTimer = setInterval(async () => {
      await this.refreshMarkets();
    }, this.config.discoveryIntervalMs);

    // Start game event polling
    if (this.dataSource !== "none") {
      this.startEventPolling();
    }

    // Start WS health monitor — checks every 15s
    this.startHealthMonitor();
  }

  stop(): void {
    if (this.discoveryTimer) {
      clearInterval(this.discoveryTimer);
      this.discoveryTimer = null;
    }
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.healthMonitorTimer) {
      clearInterval(this.healthMonitorTimer);
      this.healthMonitorTimer = null;
    }
    if (this.ws) {
      this.ws.disconnect();
      this.ws = null;
    }
  }

  /* ─── Market discovery ───────────────────────────────────────────── */

  private async refreshMarkets(): Promise<void> {
    const discovered = await this.discovery.discoverMarkets();
    const live = discovered.filter(
      (m) =>
        (m.sport === "NHL" || m.sport === "NBA" || m.sport === "MLB" || m.sport === "NFL" || m.sport === "CBB") &&
        m.state !== "closed",
    );

    for (const market of live) {
      if (this.markets.has(market.marketSlug)) continue;
      this.markets.set(market.marketSlug, market);
      this.upsertMarket(market);
      this.writeAlert(market);
    }

    if (this.ws) {
      const tokenIds = live.flatMap((m) => m.tokenIds);
      if (tokenIds.length > 0) this.ws.addTokens(tokenIds);
    }

    // Build game mappings
    await this.refreshGameMappings();

    // Log mapping status
    const mapped = this.gameMappings.size;
    const total = Array.from(this.markets.values()).filter(
      (m) => m.sport === "NHL" || m.sport === "NBA" || m.sport === "MLB" || m.sport === "NFL" || m.sport === "CBB",
    ).length;
    console.log(`🗺️  Game mappings: ${mapped}/${total} markets mapped to league games`);
    if (mapped < total) {
      for (const m of this.markets.values()) {
        if ((m.sport === "NHL" || m.sport === "NBA" || m.sport === "MLB" || m.sport === "NFL" || m.sport === "CBB") && !this.gameMappings.has(m.marketSlug)) {
          console.log(`   ❌ Unmapped: ${m.marketSlug} (${m.sport})`);
        }
      }
    }
  }

  /* ─── WebSocket ──────────────────────────────────────────────────── */

  private async startWebSocket(): Promise<void> {
    const tokenIds = Array.from(this.markets.values()).flatMap((m) => m.tokenIds);
    this.ws = new OrderBookWebSocket(tokenIds);
    await this.ws.connect();

    // Listen for reconnection events and log gaps
    this.ws.on("reconnected", (info: { reconnectCount: number; disconnectedAt: number; reconnectedAt: number; gapMs: number }) => {
      console.log(`📊 Recording gap: ${(info.gapMs / 1000).toFixed(1)}s (reconnect #${info.reconnectCount})`);
      this.recordGap(info.disconnectedAt, info.reconnectedAt, info.gapMs, `ws_reconnect_#${info.reconnectCount}`);
    });

    this.ws.on("priceUpdate", (event) => {
      const marketSlug = this.findMarketByToken(event.tokenId);
      if (!marketSlug) return;

      const now = Date.now();
      const last = this.lastSnapshotTs.get(event.tokenId) || 0;
      if (now - last < this.config.snapshotThrottleMs) return;
      this.lastSnapshotTs.set(event.tokenId, now);

      // Track snapshot rate for health
      this.snapshotCount++;
      this.lastSnapshotTime = now;

      // Record best bid/ask snapshot (backward-compatible)
      this.insertSnapshot(now, marketSlug, event.tokenId, event.bid, event.ask);

      // Record depth snapshot (top 5 levels)
      this.recordDepthSnapshot(now, marketSlug, event.tokenId);

      // Capture fair value on first sighting
      this.captureFairValue(marketSlug, event.tokenId, event.bid, event.ask);
    });

    this.ws.on("trade", (event: any) => {
      const marketSlug = this.findMarketByToken(event.tokenId);
      if (!marketSlug) return;
      this.insertTrade(event.timestamp, marketSlug, event.tokenId, event.tradePrice, event.tradeSize, event.side);
    });
  }

  /* ─── Depth recording ────────────────────────────────────────────── */

  private recordDepthSnapshot(ts: number, marketSlug: string, tokenId: string) {
    if (!this.ws) return;
    const book = this.ws.getOrderBook(tokenId);
    if (!book) return;

    const MAX_LEVELS = 5;

    const bids = [...(book.bids || [])].reverse(); // best bid first
    const asks = [...(book.asks || [])].reverse(); // best ask first

    const levels = Math.max(bids.length, asks.length, MAX_LEVELS);
    const stmt = this.getDepthStmt();

    for (let i = 0; i < Math.min(levels, MAX_LEVELS); i++) {
      const bidPrice = i < bids.length ? parseFloat(bids[i].price) : null;
      const bidSize = i < bids.length ? parseFloat(bids[i].size) : null;
      const askPrice = i < asks.length ? parseFloat(asks[i].price) : null;
      const askSize = i < asks.length ? parseFloat(asks[i].size) : null;

      if (bidPrice !== null || askPrice !== null) {
        stmt.run(ts, marketSlug, tokenId, i + 1, bidPrice, bidSize, askPrice, askSize);
      }
    }
  }

  /* ─── Fair value capture ─────────────────────────────────────────── */

  private captureFairValue(marketSlug: string, tokenId: string, bid: number, ask: number) {
    const key = `${marketSlug}:${tokenId}`;
    if (this.fairValuesCaptured.has(key)) return;
    if (bid <= 0 && ask <= 0) return;

    this.fairValuesCaptured.add(key);
    const stmt = this.getFairValueStmt();
    try {
      stmt.run(marketSlug, tokenId, bid, ask, Date.now());
      console.log(`📌 Fair value captured: ${marketSlug} ${tokenId.slice(0, 8)}… bid=${bid} ask=${ask}`);
    } catch (err: any) {
      // UNIQUE constraint — already exists (e.g. from previous run)
      if (!err.message?.includes("UNIQUE")) throw err;
    }
  }

  /* ─── Game-event polling (unified) ───────────────────────────────── */

  private startEventPolling() {
    const pollMs = this.config.sportradarPollMs;
    console.log(`📡 Starting game-event polling every ${pollMs}ms [${this.dataSource}]`);
    this.pollTimer = setInterval(async () => {
      await this.pollGameEvents();
    }, pollMs);
  }

  private async pollGameEvents() {
    if (this.dataSource === "sportradar") {
      await this.pollSportradarEvents();
    } else if (this.dataSource === "free-league-apis") {
      await this.pollFreeApiEvents();
    }
  }

  /* ─── Game mapping (works for both data sources) ─────────────────── */

  private async refreshGameMappings() {
    const allMarkets = Array.from(this.markets.values()).filter(
      (m) => m.sport === "NHL" || m.sport === "NBA" || m.sport === "MLB" || m.sport === "NFL" || m.sport === "CBB",
    );
    if (allMarkets.length === 0) return;

    if (this.dataSource === "sportradar") {
      await this.refreshSportradarGameMappings(allMarkets);
    } else if (this.dataSource === "free-league-apis") {
      await this.refreshFreeApiGameMappings(allMarkets);
    }
  }

  /* ═══════════════════════════════════════════════════════════════════
   * FREE LEAGUE API POLLING
   * ═══════════════════════════════════════════════════════════════════ */

  private async refreshFreeApiGameMappings(allMarkets: SportsMarket[]) {
    const today = new Date();
    const dateStr = `${today.getUTCFullYear()}-${String(today.getUTCMonth() + 1).padStart(2, "0")}-${String(today.getUTCDate()).padStart(2, "0")}`;

    // NHL
    const nhlMarkets = allMarkets.filter((m) => m.sport === "NHL");
    if (nhlMarkets.length > 0 && this.nhlApi) {
      try {
        const games = await this.nhlApi.getGamesByDate(dateStr);
        for (const game of games) {
          for (const market of nhlMarkets) {
            if (this.gameMappings.has(market.marketSlug)) continue;
            if (this.fuzzyMatchTeams(market.marketSlug, game.homeTeam.commonName?.default, game.awayTeam.commonName?.default)) {
              this.gameMappings.set(market.marketSlug, {
                marketSlug: market.marketSlug,
                gameId: String(game.id),
                sport: "NHL",
              });
              console.log(`🔗 Mapped ${market.marketSlug} → NHL game ${game.id}`);
            }
          }
        }
      } catch (err) {
        console.error("⚠️  NHL schedule fetch failed:", err);
      }
    }

    // NBA
    const nbaMarkets = allMarkets.filter((m) => m.sport === "NBA");
    if (nbaMarkets.length > 0 && this.nbaApi) {
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
              console.log(`🔗 Mapped ${market.marketSlug} → NBA game ${game.gameId}`);
            }
          }
        }
      } catch (err) {
        console.error("⚠️  NBA schedule fetch failed:", err);
      }
    }

    // MLB
    const mlbMarkets = allMarkets.filter((m) => m.sport === "MLB");
    if (mlbMarkets.length > 0 && this.mlbApi) {
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
              console.log(`🔗 Mapped ${market.marketSlug} → MLB game ${game.gamePk}`);
            }
          }
        }
      } catch (err) {
        console.error("⚠️  MLB schedule fetch failed:", err);
      }
    }

    // NFL
    const nflMarkets = allMarkets.filter((m) => m.sport === "NFL");
    if (nflMarkets.length > 0 && this.nflApi) {
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
              console.log(`🔗 Mapped ${market.marketSlug} → NFL game ${game.id}`);
            }
          }
        }
      } catch (err) {
        console.error("⚠️  NFL schedule fetch failed:", err);
      }
    }

    // CBB (College Basketball) — use ESPN scoreboard for mapping
    const cbbMarkets = allMarkets.filter((m) => m.sport === "CBB");
    if (cbbMarkets.length > 0 && this.espnApi) {
      try {
        const games = await this.espnApi.getScoreboard("cbb");
        for (const game of games) {
          for (const market of cbbMarkets) {
            if (this.gameMappings.has(market.marketSlug)) continue;
            // ESPN CBB uses full team names like "USC Trojans", "Penn State Nittany Lions"
            if (this.fuzzyMatchTeams(market.marketSlug, game.homeTeam.displayName, game.awayTeam.displayName)) {
              this.gameMappings.set(market.marketSlug, {
                marketSlug: market.marketSlug,
                gameId: game.id,
                sport: "CBB",
              });
              console.log(`🔗 Mapped ${market.marketSlug} → CBB game ${game.id} (ESPN)`);
            }
          }
        }
      } catch (err) {
        console.error("⚠️  CBB ESPN schedule fetch failed:", err);
      }
    }
  }

  private async pollFreeApiEvents() {
    for (const [marketSlug, mapping] of this.gameMappings.entries()) {
      // Check backoff before polling
      const backoffState = this.pbpBackoff.get(mapping.gameId);
      if (backoffState && Date.now() < backoffState.nextRetryAt) {
        continue; // Still in backoff, skip this game
      }

      try {
        let events: NormalizedGameEvent[] = [];

        if (mapping.sport === "NHL" && this.nhlApi) {
          events = await this.nhlApi.getPlayByPlay(mapping.gameId);
        } else if (mapping.sport === "NBA" && this.nbaApi) {
          events = await this.nbaApi.getPlayByPlay(mapping.gameId);
        } else if (mapping.sport === "MLB" && this.mlbApi) {
          events = await this.mlbApi.getPlayByPlay(Number(mapping.gameId));
        } else if (mapping.sport === "NFL" && this.nflApi) {
          const nflEvents = await this.nflApi.getPlayByPlay(mapping.gameId);
          events = nflEvents.map((e) => ({
            type: (e.type === "goal" || e.type === "penalty" || e.type === "period_start" || e.type === "period_end" || e.type === "shootout") ? e.type : "other" as const,
            team: e.team,
            period: e.period,
            clock: e.clock,
            description: e.description,
            timestamp: e.timestamp,
          }));
        } else if (mapping.sport === "CBB" && this.espnApi) {
          events = await this.espnApi.getPlayByPlay("cbb", mapping.gameId);
        }

        // Success — clear backoff if any
        if (this.pbpBackoff.has(mapping.gameId)) {
          console.log(`✅ PBP recovered for ${mapping.sport} game ${mapping.gameId}`);
          this.pbpBackoff.delete(mapping.gameId);
        }

        this.processNormalizedEvents(marketSlug, mapping.gameId, events);
      } catch (err: any) {
        const statusCode = err?.response?.status || err?.status || 0;
        const isAuthError = statusCode === 403 || statusCode === 401;

        // Apply exponential backoff for this game ID
        const existing = this.pbpBackoff.get(mapping.gameId);
        const newBackoffMs = existing
          ? Math.min(existing.currentBackoffMs * 2, 300_000) // double, cap at 5min
          : 30_000; // start at 30s
        const failCount = existing ? existing.failCount + 1 : 1;

        this.pbpBackoff.set(mapping.gameId, {
          nextRetryAt: Date.now() + newBackoffMs,
          currentBackoffMs: newBackoffMs,
          failCount,
        });

        // Only log at warn level on first failure to avoid log spam
        if (failCount === 1) {
          console.warn(
            `⚠️  ${mapping.sport} PBP ${isAuthError ? statusCode + " " : ""}error for game ${mapping.gameId} — ` +
            `backing off ${(newBackoffMs / 1000).toFixed(0)}s: ${err?.message || err}`,
          );
        }

        // Try ESPN fallback for score data
        await this.tryEspnFallback(marketSlug, mapping);
      }
    }
  }

  private processNormalizedEvents(marketSlug: string, gameId: string, events: NormalizedGameEvent[]) {
    const stmt = this.getGameEventStmt();
    const isFirstPoll = !this.firstPollGames.has(gameId);
    let newCount = 0;

    for (const ev of events) {
      // Only record significant events
      if (ev.type === "other") continue;

      const eventKey = `${gameId}:${ev.type}:${ev.period}:${ev.clock}:${ev.team}`;
      if (this.seenEventKeys.has(eventKey)) continue;
      this.seenEventKeys.add(eventKey);

      const ts = ev.timestamp || Date.now();
      stmt.run(ts, marketSlug, gameId, ev.type, ev.team, String(ev.period), ev.clock, ev.description);
      newCount++;

      if (!isFirstPoll) {
        const emoji = ev.type === "goal" ? "🏒" : ev.type === "penalty" ? "⚠️" : "📌";
        console.log(`${emoji} [${marketSlug}] ${ev.type} by ${ev.team} P${ev.period} ${ev.clock}`);
      }
    }

    if (isFirstPoll && newCount > 0) {
      this.firstPollGames.add(gameId);
      console.log(`📋 [${marketSlug}] Loaded ${newCount} historical events for game ${gameId}`);
    }
  }

  private async tryEspnFallback(marketSlug: string, mapping: GameMapping) {
    if (!this.espnApi) return;
    try {
      const sportKey = mapping.sport.toLowerCase() as "nhl" | "nba" | "mlb" | "nfl" | "cbb";
      const scores = await this.espnApi.getScoreboard(sportKey);
      // Just log — ESPN is for fallback awareness, not event recording
      const match = scores.find((g) => {
        const slug = marketSlug.toLowerCase();
        const home = g.homeTeam.shortDisplayName.toLowerCase().split(" ").pop() || "";
        const away = g.awayTeam.shortDisplayName.toLowerCase().split(" ").pop() || "";
        return home && away && slug.includes(home) && slug.includes(away);
      });
      if (match && match.status.type.state === "in") {
        console.log(
          `📺 [ESPN fallback] ${match.shortName}: ` +
          `${match.awayTeam.abbreviation} ${match.awayTeam.score} @ ` +
          `${match.homeTeam.abbreviation} ${match.homeTeam.score} ` +
          `(P${match.status.period} ${match.status.displayClock})`,
        );
      }
    } catch {
      // ESPN fallback is best-effort — silently ignore failures
    }
  }

  /* ═══════════════════════════════════════════════════════════════════
   * SPORTRADAR POLLING (legacy, opt-in via USE_SPORTRADAR=true)
   * ═══════════════════════════════════════════════════════════════════ */

  private async refreshSportradarGameMappings(allMarkets: SportsMarket[]) {
    if (!this.srClient) return;

    const nhlMarkets = allMarkets.filter((m) => m.sport === "NHL");
    if (nhlMarkets.length === 0) return;

    try {
      await this.rateLimitApi();

      const today = new Date();
      const yyyy = today.getUTCFullYear();
      const mm = String(today.getUTCMonth() + 1).padStart(2, "0");
      const dd = String(today.getUTCDate()).padStart(2, "0");

      const data = await this.srClient.get<any>(`/games/${yyyy}/${mm}/${dd}/schedule.json`);
      const games = data?.games || [];

      for (const game of games) {
        for (const market of nhlMarkets) {
          if (this.gameMappings.has(market.marketSlug)) continue;
          const slug = market.marketSlug.toLowerCase();
          const homeCity = (game.home?.name || "").toLowerCase().split(" ").pop() || "";
          const awayCity = (game.away?.name || "").toLowerCase().split(" ").pop() || "";
          if (homeCity && awayCity && slug.includes(homeCity) && slug.includes(awayCity)) {
            this.gameMappings.set(market.marketSlug, {
              marketSlug: market.marketSlug,
              gameId: game.id,
              sport: "NHL",
            });
            console.log(`🔗 Mapped ${market.marketSlug} → SR game ${game.id}`);
          }
        }
      }
    } catch (err) {
      console.error("⚠️  SR schedule fetch failed (will retry):", err);
    }
  }

  private async pollSportradarEvents() {
    if (!this.srClient) return;

    for (const [marketSlug, mapping] of this.gameMappings.entries()) {
      if (mapping.sport !== "NHL") continue; // SR only does NHL in this config
      try {
        await this.rateLimitApi();
        const data = await this.srClient.get<any>(`/games/${mapping.gameId}/pbp.json`);
        this.processSrPbpData(marketSlug, mapping.gameId, data);
      } catch (err: any) {
        if (err?.response?.status === 429) {
          console.warn("⚠️  SR 429 rate limit — backing off");
          await this.sleep(3000);
        } else {
          console.error(`⚠️  SR PBP error for ${mapping.gameId}:`, err?.message || err);
        }
      }
    }
  }

  private processSrPbpData(marketSlug: string, gameId: string, data: any) {
    const periods = data?.periods || [];
    const stmt = this.getGameEventStmt();

    for (const period of periods) {
      const periodNum = period.number || period.sequence || "";
      const events = period.events || [];

      for (const ev of events) {
        const eventType = (ev.type || ev.event_type || "").toLowerCase();
        if (!["goal", "penalty", "shootout"].some((t) => eventType.includes(t))) continue;

        const eventKey = `${gameId}:${ev.id || `${periodNum}-${ev.clock}-${eventType}`}`;
        if (this.seenEventKeys.has(eventKey)) continue;
        this.seenEventKeys.add(eventKey);

        const ts = ev.wall_clock ? new Date(ev.wall_clock).getTime() : Date.now();
        const team = ev.attribution?.name || ev.team?.name || "";
        const clock = ev.clock || "";
        const desc = ev.description || JSON.stringify(ev).slice(0, 200);

        stmt.run(ts, marketSlug, gameId, eventType, team, String(periodNum), clock, desc);
        console.log(`🏒 [${marketSlug}] ${eventType} by ${team} P${periodNum} ${clock}`);
      }
    }
  }

  /* ─── Fuzzy team matching ────────────────────────────────────────── */

  private fuzzyMatchTeams(slug: string, homeTeamName: string, awayTeamName: string): boolean {
    const lowerSlug = slug.toLowerCase();
    const homeLower = (homeTeamName || "").toLowerCase();
    const awayLower = (awayTeamName || "").toLowerCase();

    // Team abbreviation map (slug abbrev → possible team name fragments)
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
      dal: ["stars", "dallas"], edm: ["oilers", "edmonton"], fla: ["panthers", "florida"],
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
      cws: ["white sox", "chicago white sox"],
    };

    // Extract slug parts (e.g. "nba-mia-bos-2026-02-06" → ["mia", "bos"])
    const slugParts = lowerSlug.split("-");
    // Sport prefix is first, date parts are last 3, team abbrevs are in between
    const teamAbbrevs = slugParts.slice(1, -3);

    if (teamAbbrevs.length < 2) {
      // Fallback: check if any word from team names appears in slug
      const homeWords = homeLower.split(/\s+/);
      const awayWords = awayLower.split(/\s+/);
      const homeMatch = homeWords.some((w) => w.length > 2 && lowerSlug.includes(w));
      const awayMatch = awayWords.some((w) => w.length > 2 && lowerSlug.includes(w));
      return homeMatch && awayMatch;
    }

    // For each abbrev in slug, check if it matches one of the team names
    let homeMatched = false;
    let awayMatched = false;

    for (const abbrev of teamAbbrevs) {
      const possibleNames = TEAM_ABBREVS[abbrev] || [abbrev];
      for (const name of possibleNames) {
        if (homeLower.includes(name) || name.includes(homeLower.split(/\s+/).pop() || "")) {
          homeMatched = true;
        }
        if (awayLower.includes(name) || name.includes(awayLower.split(/\s+/).pop() || "")) {
          awayMatched = true;
        }
      }
      // Also direct abbrev check (e.g. team tricode)
      if (homeLower.includes(abbrev) || abbrev === homeLower.substring(0, 3)) homeMatched = true;
      if (awayLower.includes(abbrev) || abbrev === awayLower.substring(0, 3)) awayMatched = true;

      // CBB/CFB: slug abbrevs are often compressed school names (e.g. "pennst" = "penn state",
      // "txtech" = "texas tech", "ohiost" = "ohio state", "wvir" = "west virginia")
      // Try matching by concatenating consecutive words from team name and checking prefix
      if (!homeMatched) {
        homeMatched = this.fuzzyAbbrevMatch(abbrev, homeLower);
      }
      if (!awayMatched) {
        awayMatched = this.fuzzyAbbrevMatch(abbrev, awayLower);
      }
    }

    return homeMatched && awayMatched;
  }

  /**
   * Fuzzy match a slug abbreviation against a team name.
   * Handles compressed school names like "pennst" → "penn state",
   * "txtech" → "texas tech", "ohiost" → "ohio state", "wvir" → "west virginia",
   * "mich" → "michigan", "cin" → "cincinnati", etc.
   *
   * Strategy: check if the abbrev is a prefix of any word, or a concatenation of
   * prefixes of consecutive words in the team name.
   */
  private fuzzyAbbrevMatch(abbrev: string, teamNameLower: string): boolean {
    const words = teamNameLower.split(/\s+/);

    // 1) Direct: abbrev is a prefix of any single word (e.g. "mich" → "michigan")
    if (words.some(w => w.startsWith(abbrev) && abbrev.length >= 3)) return true;

    // 1b) Word starts with abbrev OR abbrev is a consonant-heavy truncation
    // e.g. "charlt" → "charlotte", "mphs" → "memphis"
    // Check if removing vowels from a word prefix matches
    for (const w of words) {
      if (w.length < 4) continue;
      // Check if abbrev matches a truncation of the word (allowing vowel drops)
      // Simple: check if all chars of abbrev appear in order within the word
      let wi = 0;
      let ai = 0;
      while (wi < w.length && ai < abbrev.length) {
        if (w[wi] === abbrev[ai]) ai++;
        wi++;
      }
      if (ai === abbrev.length && abbrev.length >= 3) return true;
    }

    // 2) Concatenated prefixes of consecutive words
    // e.g. "pennst" = "penn" + "st" from "penn state"
    // e.g. "txtech" = we'd need "texas tech" → won't match directly, so also check abbreviation-style
    for (let i = 0; i < words.length - 1; i++) {
      for (let prefixLen = 2; prefixLen <= Math.min(words[i].length, abbrev.length - 1); prefixLen++) {
        const firstPart = words[i].substring(0, prefixLen);
        if (abbrev.startsWith(firstPart)) {
          const rest = abbrev.substring(prefixLen);
          // Check if rest matches start of next word(s)
          for (let j = i + 1; j < words.length; j++) {
            if (words[j].startsWith(rest) && rest.length >= 1) return true;
          }
        }
      }
    }

    // 3) Special common abbreviation patterns for US states/schools
    const STATE_ABBREVS: Record<string, string> = {
      "tx": "texas", "nc": "north carolina", "sc": "south carolina",
      "wv": "west virginia", "nm": "new mexico", "nd": "north dakota",
      "sd": "south dakota", "nw": "northwestern", "ne": "nebraska",
    };
    for (const [prefix, fullName] of Object.entries(STATE_ABBREVS)) {
      if (abbrev.startsWith(prefix) && teamNameLower.includes(fullName)) {
        // Check if the rest of the abbrev matches a word in the team name after the state
        const rest = abbrev.substring(prefix.length);
        if (rest.length === 0) return true;
        const afterState = teamNameLower.substring(teamNameLower.indexOf(fullName) + fullName.length).trim();
        const afterWords = afterState.split(/\s+/);
        if (afterWords.some(w => w.startsWith(rest) && rest.length >= 1)) return true;
        // Also check if rest is a subsequence of the first word after the state name
        // e.g. "wvir" → rest "ir" is subsequence of "mountaineers"? No. 
        // But "wvir" → "west virginia" itself contains "ir" → check if rest appears anywhere in remaining name
        if (rest.length >= 2 && afterState.includes(rest)) return true;
        // Or rest is subsequence of any word
        for (const aw of afterWords) {
          let ri = 0;
          for (let ci = 0; ci < aw.length && ri < rest.length; ci++) {
            if (aw[ci] === rest[ri]) ri++;
          }
          if (ri === rest.length && rest.length >= 2) return true;
        }
      }
    }

    return false;
  }

  /* ─── Health monitoring ────────────────────────────────────────────── */

  private startHealthMonitor() {
    let consecutiveDisconnectedChecks = 0;
    this.healthMonitorTimer = setInterval(() => {
      if (!this.ws) return;

      if (!this.ws.isConnected()) {
        consecutiveDisconnectedChecks++;
        const disconnectedSec = consecutiveDisconnectedChecks * 15;
        if (disconnectedSec >= 30) {
          console.warn(`⚠️ WS disconnected for ${disconnectedSec}s — forcing reconnect`);
          this.ws.forceReconnect();
          consecutiveDisconnectedChecks = 0;
        }
      } else {
        consecutiveDisconnectedChecks = 0;
      }
    }, 15000);
  }

  private recordGap(startTs: number, endTs: number, durationMs: number, reason: string) {
    this.totalGapsRecorded++;
    const stmt = this.getGapStmt();
    stmt.run(startTs, endTs, durationMs, reason);
  }

  private getGapStmt(): Database.Statement {
    if (!this.stmtInsertGap) {
      this.stmtInsertGap = this.db.prepare(`
        INSERT INTO recorder_gaps (start_ts, end_ts, duration_ms, reason)
        VALUES (?, ?, ?, ?)
      `);
    }
    return this.stmtInsertGap;
  }

  /**
   * Get recorder health status for external monitoring
   */
  getHealth(): {
    uptimeMs: number;
    totalGaps: number;
    wsConnected: boolean;
    wsReconnectCount: number;
    wsLastDataTs: number;
    snapshotCount: number;
    lastSnapshotTime: number;
    snapshotsPerMinute: number;
    activeMarkets: number;
    gameMappings: number;
    pbpBackoffGames: number;
    dataSource: string;
  } {
    const uptimeMs = Date.now() - this.recorderStartedAt;
    const wsStats = this.ws?.getStats() ?? { connected: false, reconnectCount: 0, lastDataTs: 0, uptimeMs: 0 };
    const snapshotsPerMinute = uptimeMs > 0 ? (this.snapshotCount / (uptimeMs / 60_000)) : 0;

    return {
      uptimeMs,
      totalGaps: this.totalGapsRecorded,
      wsConnected: wsStats.connected,
      wsReconnectCount: wsStats.reconnectCount,
      wsLastDataTs: wsStats.lastDataTs,
      snapshotCount: this.snapshotCount,
      lastSnapshotTime: this.lastSnapshotTime,
      snapshotsPerMinute: Math.round(snapshotsPerMinute * 10) / 10,
      activeMarkets: this.markets.size,
      gameMappings: this.gameMappings.size,
      pbpBackoffGames: this.pbpBackoff.size,
      dataSource: this.dataSource,
    };
  }

  /* ─── Helpers ────────────────────────────────────────────────────── */

  private findMarketByToken(tokenId: string): string | null {
    for (const m of this.markets.values()) {
      if (m.tokenIds.includes(tokenId)) return m.marketSlug;
    }
    return null;
  }

  private async rateLimitApi() {
    const minGap = 2000;
    const elapsed = Date.now() - this.lastApiCallTs;
    if (elapsed < minGap) {
      await this.sleep(minGap - elapsed);
    }
    this.lastApiCallTs = Date.now();
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /* ─── Prepared statement getters (lazy) ──────────────────────────── */

  private getDepthStmt(): Database.Statement {
    if (!this.stmtInsertDepth) {
      this.stmtInsertDepth = this.db.prepare(`
        INSERT INTO depth_snapshots (ts, market_slug, token_id, level, bid_price, bid_size, ask_price, ask_size)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
    }
    return this.stmtInsertDepth;
  }

  private getFairValueStmt(): Database.Statement {
    if (!this.stmtInsertFairValue) {
      this.stmtInsertFairValue = this.db.prepare(`
        INSERT OR IGNORE INTO fair_values (market_slug, token_id, fair_bid, fair_ask, captured_at)
        VALUES (?, ?, ?, ?, ?)
      `);
    }
    return this.stmtInsertFairValue;
  }

  private getGameEventStmt(): Database.Statement {
    if (!this.stmtInsertGameEvent) {
      this.stmtInsertGameEvent = this.db.prepare(`
        INSERT INTO game_events (ts, market_slug, sportradar_game_id, event_type, team, period, clock, description)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
    }
    return this.stmtInsertGameEvent;
  }

  /* ─── DB writes ──────────────────────────────────────────────────── */

  private upsertMarket(market: SportsMarket) {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO markets (market_slug, condition_id, sport, outcome1, outcome2, token1, token2, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      market.marketSlug,
      market.conditionId || null,
      market.sport,
      market.outcomes[0] || "",
      market.outcomes[1] || "",
      market.tokenIds[0],
      market.tokenIds[1],
      Date.now(),
    );
  }

  private insertSnapshot(ts: number, marketSlug: string, tokenId: string, bid: number, ask: number) {
    if (!this.stmtInsertSnapshot) {
      this.stmtInsertSnapshot = this.db.prepare(`
        INSERT INTO snapshots (ts, market_slug, token_id, best_bid, best_ask, mid_price)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
    }
    const mid = (bid + ask) / 2;
    this.stmtInsertSnapshot.run(ts, marketSlug, tokenId, bid, ask, mid);
  }

  private insertTrade(ts: number, marketSlug: string, tokenId: string, price: number, size: number, side?: string) {
    if (!this.stmtInsertTrade) {
      this.stmtInsertTrade = this.db.prepare(`
        INSERT INTO trades (ts, market_slug, token_id, price, size, side)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
    }
    this.stmtInsertTrade.run(ts, marketSlug, tokenId, price, size, side || null);
  }

  private writeAlert(market: SportsMarket) {
    const fs = require("fs");
    const payload = {
      ts: Date.now(),
      market_slug: market.marketSlug,
      sport: market.sport,
      outcome1: market.outcomes[0],
      outcome2: market.outcomes[1],
    };
    fs.appendFileSync(this.alertFilePath, JSON.stringify(payload) + "\n");
  }
}
