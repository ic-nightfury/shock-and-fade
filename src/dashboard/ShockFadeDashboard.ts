/**
 * ShockFadeDashboard — Real-time web dashboard for the shock-fade paper trading engine.
 *
 * Port 3032 (don't conflict with SSS dashboard on 3030/3031).
 * WebSocket push: granular event messages + periodic stats.
 * On connect: sends full_state snapshot so dashboard survives refresh.
 * Self-contained HTML served via embedded template.
 *
 * v2: Redesigned with expanded live game cards, session log, and
 *     event-based messaging (market_update, shock_detected, etc.)
 */

import * as http from "http";
import * as fs from "fs";
import * as path from "path";
import { WebSocketServer, WebSocket } from "ws";
import {
  ShockFadeDetector,
  ShockEvent,
} from "../strategies/ShockFadeDetector";
import {
  ShockFadePaperTrader,
  ShockFadePaperStats,
  LadderOrder,
  FadePosition,
  TradeRecord,
} from "../strategies/ShockFadePaper";
import { SportsMarket } from "../services/SportsMarketDiscovery";
import { WalletBalanceService, WalletBalanceData } from "../services/WalletBalanceService";

// ============================================================================
// TYPES
// ============================================================================

export interface ShockFadeDashboardConfig {
  port?: number;
  host?: string;
  updateIntervalMs?: number;
}

/** All WS message types the dashboard can receive */
export type DashboardMessageType =
  | "full_state"
  | "stats"
  | "market_update"
  | "score_update"
  | "shock_detected"
  | "order_placed"
  | "order_filled"
  | "order_cancelled"
  | "position_closed"
  | "tp_update"
  | "game_event"
  | "game_state"
  | "system"
  | "log"
  | "wallet_update";

export interface DashboardWSMessage {
  type: DashboardMessageType;
  data: unknown;
  timestamp: number;
}

/** Market info for dashboard — enriched with book data */
export interface DashboardMarketInfo {
  slug: string;
  sport: string;
  question: string;
  outcomes: string[];
  tokenIds: string[];
  currentPrices: { bid: number; ask: number; mid: number; spread: number }[];
  volume: number;
  liquidity: number;
  state: string; // upcoming | live | settled
  gameStartTime: number | null;
}

/** Log entry stored in server for full_state replay */
export interface LogEntry {
  timestamp: number;
  category: "SYS" | "SHOCK" | "ORDER" | "TRADE" | "EVENT" | "ERROR" | "POLL";
  message: string;
}

/** Score info per game (from league APIs) */
export interface GameScoreInfo {
  marketSlug: string;
  homeTeam: string;
  awayTeam: string;
  homeScore: number;
  awayScore: number;
  period: string;
  clock: string;
  sport: string;
}

// ============================================================================
// DASHBOARD SERVER
// ============================================================================

export class ShockFadeDashboardServer {
  private config: Required<ShockFadeDashboardConfig>;
  private server: http.Server | null = null;
  private wss: WebSocketServer | null = null;
  private clients: Set<WebSocket> = new Set();
  private updateInterval: NodeJS.Timeout | null = null;
  private running = false;
  private startedAt: number = Date.now();

  // Data sources — set after construction
  private detector: ShockFadeDetector | null = null;
  private trader: ShockFadePaperTrader | null = null;
  private markets: Map<string, SportsMarket> = new Map();

  // Session log (ring buffer, last 500 entries)
  private sessionLog: LogEntry[] = [];
  private static readonly MAX_LOG_ENTRIES = 500;

  // Score tracking
  private gameScores: Map<string, GameScoreInfo> = new Map();

  // Trading mode (paper or live) — set by the entry point
  private tradingMode: "paper" | "live" = "paper";

  // Game events per market (last 10 per game)
  private gameEvents: Map<string, Array<{ timestamp: number; description: string; sport: string }>> = new Map();

  // WS latency tracking (ping/pong)
  private clientLatencies: Map<WebSocket, number> = new Map();

  // Wallet balance service
  private walletService: WalletBalanceService | null = null;
  private lastWalletData: WalletBalanceData | null = null;

  constructor(config: ShockFadeDashboardConfig = {}) {
    this.config = {
      port: config.port ?? 3032,
      host: config.host ?? "0.0.0.0",
      updateIntervalMs: config.updateIntervalMs ?? 1000,
    };
  }

  setDetector(detector: ShockFadeDetector): void {
    this.detector = detector;
  }

  setTrader(trader: ShockFadePaperTrader): void {
    this.trader = trader;
  }

  setMarkets(markets: Map<string, SportsMarket>): void {
    this.markets = markets;
  }

  setMode(mode: "paper" | "live"): void {
    this.tradingMode = mode;
  }

  setWalletService(service: WalletBalanceService): void {
    this.walletService = service;
    // Wire callback to broadcast wallet updates
    service.setOnUpdate((data: WalletBalanceData) => {
      this.lastWalletData = data;
      this.broadcast({
        type: "wallet_update",
        data,
        timestamp: Date.now(),
      });
    });
  }

  updateMarket(market: SportsMarket): void {
    this.markets.set(market.marketSlug, market);
  }

  // ============================================================================
  // SESSION LOG
  // ============================================================================

  /** Add a log entry and broadcast to clients */
  addLog(category: LogEntry["category"], message: string): void {
    const entry: LogEntry = {
      timestamp: Date.now(),
      category,
      message,
    };
    this.sessionLog.push(entry);
    if (this.sessionLog.length > ShockFadeDashboardServer.MAX_LOG_ENTRIES) {
      this.sessionLog = this.sessionLog.slice(-ShockFadeDashboardServer.MAX_LOG_ENTRIES);
    }
    this.broadcast({ type: "log", data: entry, timestamp: Date.now() });
  }

  // ============================================================================
  // SCORE & GAME EVENT TRACKING
  // ============================================================================

  updateScore(info: GameScoreInfo): void {
    this.gameScores.set(info.marketSlug, info);
    this.broadcast({
      type: "score_update",
      data: info,
      timestamp: Date.now(),
    });
  }

  addGameEvent(marketSlug: string, description: string, sport: string): void {
    let events = this.gameEvents.get(marketSlug);
    if (!events) {
      events = [];
      this.gameEvents.set(marketSlug, events);
    }
    const entry = { timestamp: Date.now(), description, sport };
    events.push(entry);
    // Keep last 10 per game
    if (events.length > 10) {
      events.splice(0, events.length - 10);
    }
    this.broadcast({
      type: "game_event",
      data: { marketSlug, ...entry },
      timestamp: Date.now(),
    });
    this.addLog("EVENT", `[${marketSlug}] ${description}`);
  }

  // ============================================================================
  // EVENT EMITTERS (called from paper trader / entry point wiring)
  // ============================================================================

  notifyShockDetected(shock: ShockEvent): void {
    this.broadcast({
      type: "shock_detected",
      data: shock,
      timestamp: Date.now(),
    });
    const magCents = (shock.magnitude * 100).toFixed(1);
    this.addLog(
      "SHOCK",
      `${shock.marketSlug}: ${shock.direction === "up" ? "↑" : "↓"}${magCents}¢ (${shock.zScore.toFixed(1)}σ) → ${shock.classification || "unclassified"}`,
    );
  }

  notifyShockClassified(marketSlug: string, classification: string, latencyMs: number): void {
    this.broadcast({
      type: "shock_classified",
      data: { marketSlug, classification, latencyMs },
      timestamp: Date.now(),
    });
  }

  notifyOrderPlaced(order: LadderOrder): void {
    this.broadcast({
      type: "order_placed",
      data: order,
      timestamp: Date.now(),
    });
    this.addLog(
      "ORDER",
      `Placed L${order.level}: SELL @ ${(order.price * 100).toFixed(1)}¢ × ${order.shares.toFixed(0)} [${order.marketSlug}]`,
    );
  }

  notifyOrderFilled(order: LadderOrder): void {
    this.broadcast({
      type: "order_filled",
      data: order,
      timestamp: Date.now(),
    });
    this.addLog(
      "ORDER",
      `Filled L${order.level}: SELL @ ${((order.fillPrice ?? order.price) * 100).toFixed(1)}¢ × ${order.shares.toFixed(0)} [${order.marketSlug}]`,
    );
  }

  notifyOrderCancelled(order: LadderOrder, reason?: string): void {
    this.broadcast({
      type: "order_cancelled",
      data: { ...order, cancelReason: reason },
      timestamp: Date.now(),
    });
    this.addLog(
      "ORDER",
      `Cancelled L${order.level} @ ${(order.price * 100).toFixed(1)}¢ [${order.marketSlug}]${reason ? ` — ${reason}` : ""}`,
    );
  }

  notifyTPUpdate(tp: any): void {
    this.broadcast({
      type: "tp_update",
      data: tp,
      timestamp: Date.now(),
    });
  }

  notifyPositionClosed(position: FadePosition, record: TradeRecord): void {
    this.broadcast({
      type: "position_closed",
      data: { position, record },
      timestamp: Date.now(),
    });
    const emoji = (record.pnl ?? 0) >= 0 ? "+" : "";
    this.addLog(
      "TRADE",
      `Closed ${position.status}: ${emoji}$${(record.pnl ?? 0).toFixed(2)} (${(record.holdTimeMs / 1000).toFixed(0)}s hold) [${record.marketSlug}]`,
    );
  }

  notifyGameState(marketSlug: string, state: "upcoming" | "live" | "settled"): void {
    this.broadcast({
      type: "game_state",
      data: { marketSlug, state },
      timestamp: Date.now(),
    });
    this.addLog("SYS", `${marketSlug} → ${state}`);
  }

  notifySystem(message: string, level: "info" | "warn" | "error" = "info"): void {
    this.broadcast({
      type: "system",
      data: { message, level },
      timestamp: Date.now(),
    });
    this.addLog(level === "error" ? "ERROR" : "SYS", message);
  }

  // ============================================================================
  // LIFECYCLE
  // ============================================================================

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.startedAt = Date.now();

    this.addLog("SYS", "Dashboard server starting");

    this.server = http.createServer((req, res) =>
      this.handleRequest(req, res),
    );

    this.wss = new WebSocketServer({ server: this.server });
    this.wss.on("connection", (ws) => this.handleWSConnection(ws));

    await new Promise<void>((resolve) => {
      this.server!.listen(this.config.port, this.config.host, () => {
        this.log(
          `Dashboard started on http://${this.config.host}:${this.config.port}`,
        );
        resolve();
      });
    });

    // Periodic stats push (1s)
    this.updateInterval = setInterval(() => {
      if (this.clients.size === 0) return;
      this.broadcastStats();
    }, this.config.updateIntervalMs);

    const modeLabel = this.tradingMode === "live" ? "⚠️ LIVE MODE" : "Paper Mode";
    this.addLog("SYS", `Session started — ${modeLabel} — port ${this.config.port}`);
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;

    if (this.updateInterval) {
      clearInterval(this.updateInterval);
      this.updateInterval = null;
    }

    for (const client of this.clients) client.close();
    this.clients.clear();

    if (this.wss) {
      this.wss.close();
      this.wss = null;
    }

    if (this.server) {
      await new Promise<void>((r) => this.server!.close(() => r()));
      this.server = null;
    }

    this.log("Dashboard stopped");
  }

  // ============================================================================
  // DATA GATHERING
  // ============================================================================

  private gatherFullState(): Record<string, unknown> {
    return {
      mode: this.tradingMode,
      stats: this.trader?.getStats() ?? {},
      shocks: this.detector?.getRecentShocks(600000) ?? [], // last 10min
      activeOrders: this.trader?.getActiveOrders() ?? [],
      allOrders: this.trader?.getAllOrders().slice(-100) ?? [],
      openPositions: this.trader?.getOpenPositions() ?? [],
      allPositions: this.trader?.getAllPositions().slice(-100) ?? [],
      tradeHistory: this.trader?.getTradeHistory().slice(-100) ?? [],
      cumulativeTPs: (this.trader as any)?.getCumulativeTPs?.() ?? [],
      markets: this.gatherMarketInfo(),
      config: this.detector?.getConfig() ?? {},
      sessionLog: this.sessionLog.slice(-200),
      gameScores: Object.fromEntries(this.gameScores),
      gameEvents: Object.fromEntries(this.gameEvents),
      startedAt: this.startedAt,
      wallet: this.lastWalletData ?? this.walletService?.getData() ?? null,
    };
  }

  private gatherMarketInfo(): DashboardMarketInfo[] {
    const result: DashboardMarketInfo[] = [];

    for (const market of this.markets.values()) {
      const prices = market.tokenIds.map((tokenId) => {
        const p = this.trader?.getLatestPrice(tokenId);
        let bid = p?.bid ?? 0;
        let ask = p?.ask ?? 0;
        let mid = p?.mid ?? 0;
        
        // Fallback: if trader doesn't have price yet, check WebSocket orderbook
        if (bid === 0 && ask === 0 && (this.trader as any)?.ws) {
          const book = (this.trader as any).ws.getOrderBook?.(tokenId);
          if (book && book.bids.length > 0 && book.asks.length > 0) {
            bid = book.bids[0][0];
            ask = book.asks[0][0];
            mid = (bid + ask) / 2;
          }
        }
        
        return {
          bid,
          ask,
          mid,
          spread: ask > 0 && bid > 0 ? ask - bid : 0,
        };
      });

      // Determine game state
      let state = "upcoming";
      if (market.state === "active" || market.state === "pending_entry") {
        state = "live";
      } else if (market.state === "closed") {
        state = "settled";
      }

      result.push({
        slug: market.marketSlug,
        sport: market.sport,
        question: market.question,
        outcomes: market.outcomes,
        tokenIds: market.tokenIds,
        currentPrices: prices,
        volume: market.volume,
        liquidity: market.liquidity,
        state,
        gameStartTime: market.gameStartTime ? market.gameStartTime.getTime() : null,
      });
    }

    return result;
  }

  // ============================================================================
  // BROADCAST
  // ============================================================================

  private broadcast(msg: DashboardWSMessage): void {
    if (this.clients.size === 0) return;
    try {
      const payload = JSON.stringify(msg);
      for (const client of this.clients) {
        if (client.readyState === WebSocket.OPEN) {
          client.send(payload);
        }
      }
    } catch (err) {
      this.log(`Broadcast error: ${err}`);
    }
  }

  /** Periodic stats + market update broadcast */
  private broadcastStats(): void {
    try {
      const stats = this.trader?.getStats() ?? {};
      this.broadcast({
        type: "stats",
        data: {
          ...stats,
          startedAt: this.startedAt,
          clientCount: this.clients.size,
        },
        timestamp: Date.now(),
      });

      // Also broadcast market updates for live price data
      const markets = this.gatherMarketInfo();
      this.broadcast({
        type: "market_update",
        data: markets,
        timestamp: Date.now(),
      });
    } catch (err) {
      this.log(`Stats broadcast error: ${err}`);
    }
  }

  // ============================================================================
  // HTTP HANDLER
  // ============================================================================

  private handleRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): void {
    const url = new URL(req.url || "/", `http://${req.headers.host}`);
    const pathname = url.pathname;

    // CORS
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    // API
    if (pathname.startsWith("/api/")) {
      this.handleApi(req, res, pathname);
      return;
    }

    // Serve UI
    this.serveUI(res);
  }

  private handleApi(
    _req: http.IncomingMessage,
    res: http.ServerResponse,
    pathname: string,
  ): void {
    try {
      switch (pathname) {
        case "/api/full":
          this.sendJson(res, 200, this.gatherFullState());
          break;
        case "/api/stats":
          this.sendJson(res, 200, this.trader?.getStats() ?? {});
          break;
        case "/api/shocks":
          this.sendJson(
            res,
            200,
            this.detector?.getRecentShocks(600000) ?? [],
          );
          break;
        case "/api/orders":
          this.sendJson(res, 200, this.trader?.getAllOrders() ?? []);
          break;
        case "/api/positions":
          this.sendJson(res, 200, this.trader?.getAllPositions() ?? []);
          break;
        case "/api/trades":
          this.sendJson(res, 200, this.trader?.getTradeHistory() ?? []);
          break;
        case "/api/markets":
          this.sendJson(res, 200, this.gatherMarketInfo());
          break;
        case "/api/log":
          this.sendJson(res, 200, this.sessionLog.slice(-200));
          break;
        default:
          this.sendJson(res, 404, { error: "Not found" });
      }
    } catch (err) {
      this.sendJson(res, 500, { error: String(err) });
    }
  }

  private sendJson(
    res: http.ServerResponse,
    status: number,
    data: unknown,
  ): void {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(data));
  }

  // ============================================================================
  // WEBSOCKET
  // ============================================================================

  private handleWSConnection(ws: WebSocket): void {
    this.clients.add(ws);
    this.log(`Client connected (${this.clients.size} total)`);

    // Send full state on connect
    const data = this.gatherFullState();
    ws.send(
      JSON.stringify({
        type: "full_state",
        data,
        timestamp: Date.now(),
      }),
    );

    ws.on("close", () => {
      this.clients.delete(ws);
      this.clientLatencies.delete(ws);
    });

    ws.on("error", () => {
      this.clients.delete(ws);
      this.clientLatencies.delete(ws);
    });

    // Handle pong for latency measurement
    ws.on("pong", () => {
      const sent = (ws as any)._pingSentAt;
      if (sent) {
        this.clientLatencies.set(ws, Date.now() - sent);
      }
    });

    // Ping clients every 10s for latency
    const pingInterval = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        (ws as any)._pingSentAt = Date.now();
        ws.ping();
      } else {
        clearInterval(pingInterval);
      }
    }, 10000);
  }

  // ============================================================================
  // SERVE UI
  // ============================================================================

  private serveUI(res: http.ServerResponse): void {
    // Try to serve from file first
    const htmlPath = path.join(__dirname, "shock-fade-ui.html");
    if (fs.existsSync(htmlPath)) {
      const html = fs.readFileSync(htmlPath, "utf-8");
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(html);
    } else {
      // Fallback: minimal embedded
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(
        `<html><body style="background:#0f172a;color:#e2e8f0;font-family:monospace;">
         <h1>Shock-Fade Dashboard</h1>
         <p>shock-fade-ui.html not found. Place it in src/dashboard/.</p>
         </body></html>`,
      );
    }
  }

  // ============================================================================
  // LOG
  // ============================================================================

  private log(msg: string): void {
    const ts = new Date().toISOString();
    console.log(`${ts} [INFO] 📊 [ShockFadeDash] ${msg}`);
  }

  getPort(): number {
    return this.config.port;
  }

  isRunning(): boolean {
    return this.running;
  }

  getClientCount(): number {
    return this.clients.size;
  }
}
