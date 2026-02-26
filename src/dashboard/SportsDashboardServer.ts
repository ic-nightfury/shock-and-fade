/**
 * SportsDashboardServer - US-500: Core Dashboard Server for Sports Split-Sell Strategy
 *
 * Web-based dashboard server to display real-time trading data for multiple
 * concurrent sports markets.
 *
 * Features:
 * - HTTP server on configurable port (default 3030)
 * - WebSocket endpoint for real-time updates to browser clients
 * - REST endpoints: GET /api/positions, GET /api/stats, GET /api/trades, GET /api/positions/pending-settlement
 * - Serve static HTML/JS dashboard UI
 * - Support CORS for local development
 * - Lightweight - uses native http + ws modules (no Express)
 * - Auto-refresh data every 1 second via WebSocket push
 *
 * Usage:
 *   const dashboard = new SportsDashboardServer({ port: 3030 });
 *   dashboard.setDataProvider(positionManager);
 *   dashboard.start();
 */

import * as http from "http";
import * as fs from "fs";
import * as path from "path";
import { WebSocketServer, WebSocket } from "ws";

// ============================================================================
// TYPES & INTERFACES
// ============================================================================

/**
 * Position data for display (from PositionManager or PaperEngine)
 */
export interface DashboardPosition {
  marketSlug: string;
  sport: string;
  question: string;
  state: string;
  entryTime: string;
  elapsedMinutes: number;

  // Outcomes
  outcome1: {
    name: string;
    shares: number;
    sold: boolean;
    currentBid: number;
    currentAsk: number; // US-823: Best ask price for bid/ask display
    soldPrice?: number;
    soldRevenue?: number;
  };
  outcome2: {
    name: string;
    shares: number;
    sold: boolean;
    currentBid: number;
    currentAsk: number; // US-823: Best ask price for bid/ask display
    soldPrice?: number;
    soldRevenue?: number;
  };

  // Financial
  splitCost: number;
  totalSoldRevenue: number;
  unrealizedPnL: number;
  realizedPnL: number;

  // Thresholds
  sellThreshold: number;
  distanceToThreshold1: number;
  distanceToThreshold2: number;

  // US-807: New fields for revamped dashboard
  /** True if position is within 10c of sell threshold */
  isPendingSell: boolean;
  /** Which outcome is closest to threshold: 'outcome1' | 'outcome2' | null */
  closestToThreshold: "outcome1" | "outcome2" | null;
  /** Distance to threshold for the closest side (in dollars, e.g., 0.05 = 5c) */
  distanceToThreshold: number;
  /** Projected P&L if winner wins (for partial_sold positions): soldRevenue + (shares * 1.00) - splitCost */
  projectedPnL: number;
  /** Current value of held winner shares: shares * currentBid (for partial_sold positions) */
  winnerValue: number;

  // US-818: Pending settlement fields
  /** True if position state is pending_settlement */
  isPendingSettlement: boolean;
  /** When game ended (99c+ detected), ISO timestamp or null */
  gameEndedAt: string | null;
  /** Name of the winning outcome (e.g., "Lakers") or null */
  winningOutcome: string | null;
  /** True if loser side was not sold (still has unsold shares) */
  hasUnsoldShares: boolean;
  /** Name of the unsold side (if any) */
  unsoldOutcome: string | null;
  /** Number of unsold shares on the losing side */
  unsoldShares: number;
  /** Current bid price for unsold shares (for Force Sell display) */
  unsoldCurrentBid: number;

  // US-820: Order book health info for game cards
  /** Bid depth for outcome1: sum of bid sizes in top 5 levels (USDC) */
  outcome1BidDepth: number | null;
  /** Ask depth for outcome1: sum of ask sizes in top 5 levels (USDC) */
  outcome1AskDepth: number | null;
  /** Spread for outcome1: best ask - best bid (dollars) */
  outcome1Spread: number | null;
  /** Bid depth for outcome2: sum of bid sizes in top 5 levels (USDC) */
  outcome2BidDepth: number | null;
  /** Ask depth for outcome2: sum of ask sizes in top 5 levels (USDC) */
  outcome2AskDepth: number | null;
  /** Spread for outcome2: best ask - best bid (dollars) */
  outcome2Spread: number | null;
  /** When order book data was last updated (ISO timestamp) */
  orderBookLastUpdate: string | null;
}

/**
 * Overall statistics for the dashboard
 */
export interface DashboardStats {
  // Status
  mode: "PAPER" | "LIVE";
  running: boolean;
  startedAt: string | null;

  // Balance
  initialBalance: number;
  currentBalance: number;

  // Positions
  positionsActive: number;
  positionsSettled: number;
  positionsPendingSell: number;

  // P&L
  realizedPnL: number;
  unrealizedPnL: number;
  totalPnL: number;

  // Performance
  winCount: number;
  lossCount: number;
  winRate: number;
  avgPnLPerPosition: number;

  // Per-sport breakdown
  bySport: Record<
    string,
    {
      positionsActive: number;
      positionsSettled: number;
      realizedPnL: number;
      unrealizedPnL: number;
    }
  >;

  // Activity
  splitsToday: number;
  sellsToday: number;
  mergesToday: number;
  settlementsToday: number;

  // Today's P&L
  todayPnL: number;

  // US-807: New fields for revamped dashboard section counts
  /** Count of positions within 10c of sell threshold (state=holding, near threshold) */
  pendingSellCount: number;
  /** Count of positions where both sides are still held (state=holding, not near threshold) */
  watchingCount: number;
  /** Count of positions where loser was sold (state=partial_sold) */
  holdingWinnersCount: number;
  /** Total capital deployed: sum of split costs for all open positions */
  deployedCapital: number;
  /** Sum of projected P&L from all holding winners positions */
  projectedTotalPnL: number;

  // US-818: Pending settlement count
  /** Count of positions in pending_settlement state (game ended, awaiting redemption) */
  pendingSettlementCount: number;

  // US-826: Wallet address display
  /** Connected wallet address (full address, truncation done in UI) */
  walletAddress: string | null;
}

/**
 * Trade history entry for display
 */
export interface DashboardTrade {
  timestamp: string;
  marketSlug: string;
  sport: string;
  action: "SPLIT" | "SELL" | "MERGE" | "REDEEM" | "GAME_ENDED"; // US-818: Added GAME_ENDED
  outcome?: string;
  shares?: number;
  price?: number;
  revenue?: number;
  cost?: number;
  slippage?: number;
}

/**
 * Market health data for a position
 */
export interface DashboardMarketHealth {
  marketSlug: string;
  sport: string;
  outcome1BidDepth: number;
  outcome2BidDepth: number;
  spread1: number;
  spread2: number;
  lastTradeTime1: string | null;
  lastTradeTime2: string | null;
  healthStatus: "HEALTHY" | "CAUTION" | "DANGER";
  warnings: string[];
}

/**
 * Upcoming game data for display (US-508)
 */
export interface DashboardUpcomingGame {
  marketSlug: string;
  sport: "NHL" | "NBA" | "NFL" | "SOCCER" | string;
  leaguePrefix?: string; // US-703: Soccer league prefix (EPL, UCL, etc.)
  teams: {
    home: string;
    away: string;
  };
  gameStartTime: string; // ISO timestamp
  prices: {
    yes: number;
    no: number;
  };
  volume: number; // in USD
  status: "scheduled" | "entry_window" | "live" | "ended";
  hasPosition: boolean;
  polymarketUrl: string;
}

/**
 * Force entry result (US-511)
 */
export interface ForceEntryResult {
  success: boolean;
  marketSlug: string;
  position?: {
    id: string;
    shares: number;
    cost: number;
  };
  error?: string;
}

/**
 * Force sell result (US-814)
 */
export interface ForceSellResult {
  success: boolean;
  marketSlug: string;
  outcome?: string;
  sharesSold?: number;
  revenue?: number;
  avgPrice?: number;
  error?: string;
}

/**
 * Data provider interface - implemented by PositionManager or PaperEngine
 */
export interface DashboardDataProvider {
  getPositions(): DashboardPosition[];
  getStats(): DashboardStats;
  getTrades(limit?: number): DashboardTrade[];
  getMarketHealth?(marketSlug: string): DashboardMarketHealth | null;
  getAllMarketHealth?(): DashboardMarketHealth[];
  getUpcomingGames?(hours?: number): DashboardUpcomingGame[];
  forceEntry?(marketSlug: string, betSize: number): Promise<ForceEntryResult>;
  forceSell?(marketSlug: string, outcomeIndex: 0 | 1): Promise<ForceSellResult>;
}

/**
 * WebSocket message types
 */
export type WSMessageType =
  | "FULL_UPDATE"
  | "POSITIONS_UPDATE"
  | "STATS_UPDATE"
  | "TRADE_UPDATE"
  | "HEALTH_UPDATE"
  | "UPCOMING_GAMES_UPDATE"
  | "POSITION_SECTION_CHANGE"; // US-807: Event when position moves between sections

/**
 * US-807: Payload for POSITION_SECTION_CHANGE WebSocket event
 */
export interface PositionSectionChangeEvent {
  marketSlug: string;
  fromSection: "watching" | "pending_sells" | "holding_winners";
  toSection: "watching" | "pending_sells" | "holding_winners";
}

export interface WSMessage {
  type: WSMessageType;
  data: unknown;
  timestamp: number;
}

/**
 * Server configuration
 */
export interface SportsDashboardConfig {
  port?: number;
  host?: string;
  mode?: "PAPER" | "LIVE";
  staticDir?: string;
  updateIntervalMs?: number;
  corsOrigins?: string[];
}

// ============================================================================
// SPORTS DASHBOARD SERVER
// ============================================================================

export class SportsDashboardServer {
  private config: Required<SportsDashboardConfig>;
  private server: http.Server | null = null;
  private wss: WebSocketServer | null = null;
  private clients: Set<WebSocket> = new Set();
  private dataProvider: DashboardDataProvider | null = null;
  private updateInterval: NodeJS.Timeout | null = null;
  private running = false;

  constructor(config: SportsDashboardConfig = {}) {
    this.config = {
      port: config.port ?? 3030,
      host: config.host ?? "0.0.0.0",
      mode: config.mode ?? "PAPER",
      staticDir:
        config.staticDir ??
        path.join(__dirname, "..", "..", "public", "sports-dashboard"),
      updateIntervalMs: config.updateIntervalMs ?? 1000,
      corsOrigins: config.corsOrigins ?? ["*"],
    };
  }

  /**
   * Set the data provider (PositionManager, PaperEngine, or adapter)
   */
  setDataProvider(provider: DashboardDataProvider): void {
    this.dataProvider = provider;
    this.log(`Data provider set`);
  }

  /**
   * Start the dashboard server
   */
  async start(): Promise<void> {
    if (this.running) {
      this.log("Already running");
      return;
    }

    this.running = true;

    // Create HTTP server
    this.server = http.createServer((req, res) => this.handleRequest(req, res));

    // Create WebSocket server
    this.wss = new WebSocketServer({ server: this.server });
    this.wss.on("connection", (ws) => this.handleWebSocketConnection(ws));

    // Start listening
    await new Promise<void>((resolve) => {
      this.server!.listen(this.config.port, this.config.host, () => {
        this.log(
          `Dashboard server started on http://${this.config.host}:${this.config.port}`,
        );
        this.log(`Mode: ${this.config.mode}`);
        resolve();
      });
    });

    // Start periodic updates
    this.startPeriodicUpdates();
  }

  /**
   * Stop the dashboard server
   */
  async stop(): Promise<void> {
    if (!this.running) return;

    this.running = false;

    // Stop periodic updates
    if (this.updateInterval) {
      clearInterval(this.updateInterval);
      this.updateInterval = null;
    }

    // Close all WebSocket clients
    Array.from(this.clients).forEach((client) => {
      client.close();
    });
    this.clients.clear();

    // Close WebSocket server
    if (this.wss) {
      this.wss.close();
      this.wss = null;
    }

    // Close HTTP server
    if (this.server) {
      await new Promise<void>((resolve) => {
        this.server!.close(() => resolve());
      });
      this.server = null;
    }

    this.log("Dashboard server stopped");
  }

  /**
   * Broadcast update to all connected clients
   */
  broadcast(message: WSMessage): void {
    const payload = JSON.stringify(message);
    Array.from(this.clients).forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(payload);
      }
    });
  }

  /**
   * Start periodic updates to connected clients
   */
  private startPeriodicUpdates(): void {
    this.updateInterval = setInterval(() => {
      if (this.clients.size === 0) return;
      if (!this.dataProvider) return;

      try {
        // Send positions update
        this.broadcast({
          type: "POSITIONS_UPDATE",
          data: this.dataProvider.getPositions(),
          timestamp: Date.now(),
        });

        // Send stats update
        this.broadcast({
          type: "STATS_UPDATE",
          data: this.dataProvider.getStats(),
          timestamp: Date.now(),
        });
      } catch (error) {
        this.log(`Error broadcasting update: ${error}`, "ERROR");
      }
    }, this.config.updateIntervalMs);
  }

  /**
   * Handle incoming HTTP requests
   */
  private handleRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): void {
    const url = new URL(req.url || "/", `http://${req.headers.host}`);
    const pathname = url.pathname;

    // Add CORS headers
    this.addCorsHeaders(res);

    // Handle preflight
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    // API routes
    if (pathname.startsWith("/api/")) {
      this.handleApiRequest(req, res, pathname);
      return;
    }

    // Static files
    this.serveStaticFile(res, pathname);
  }

  /**
   * Handle API requests
   */
  private handleApiRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    pathname: string,
  ): void {
    // Handle POST requests
    if (req.method === "POST") {
      this.handlePostRequest(req, res, pathname);
      return;
    }

    if (req.method !== "GET") {
      this.sendJson(res, 405, { error: "Method not allowed" });
      return;
    }

    if (!this.dataProvider) {
      this.sendJson(res, 503, { error: "Data provider not configured" });
      return;
    }

    try {
      switch (pathname) {
        case "/api/positions":
          this.sendJson(res, 200, {
            positions: this.dataProvider.getPositions(),
            timestamp: Date.now(),
          });
          break;

        case "/api/stats":
          this.sendJson(res, 200, {
            stats: this.dataProvider.getStats(),
            timestamp: Date.now(),
          });
          break;

        case "/api/trades": {
          const url = new URL(req.url || "/", `http://${req.headers.host}`);
          const limit = parseInt(url.searchParams.get("limit") || "100", 10);
          this.sendJson(res, 200, {
            trades: this.dataProvider.getTrades(limit),
            timestamp: Date.now(),
          });
          break;
        }

        case "/api/health":
          if (this.dataProvider.getAllMarketHealth) {
            this.sendJson(res, 200, {
              health: this.dataProvider.getAllMarketHealth(),
              timestamp: Date.now(),
            });
          } else {
            this.sendJson(res, 200, { health: [], timestamp: Date.now() });
          }
          break;

        case "/api/full":
          this.sendJson(res, 200, {
            positions: this.dataProvider.getPositions(),
            stats: this.dataProvider.getStats(),
            trades: this.dataProvider.getTrades(100),
            health: this.dataProvider.getAllMarketHealth?.() ?? [],
            upcomingGames: this.dataProvider.getUpcomingGames?.() ?? [],
            timestamp: Date.now(),
          });
          break;

        case "/api/upcoming-games": {
          // US-508: Upcoming Games API Endpoint
          // US-703: Added sport filter parameter
          const upcomingUrl = new URL(
            req.url || "/",
            `http://${req.headers.host}`,
          );
          const hoursParam = upcomingUrl.searchParams.get("hours");
          const sportParam = upcomingUrl.searchParams.get("sport"); // US-703

          // Default 24, accept 6, 12, 24, 48
          const validHours = [6, 12, 24, 48];
          let hours = 24;
          if (hoursParam) {
            const parsed = parseInt(hoursParam, 10);
            if (validHours.includes(parsed)) {
              hours = parsed;
            }
          }

          // US-703: Sport category filter mappings
          const sportCategoryMap: Record<string, string[]> = {
            nhl: ["NHL"],
            nfl: ["NFL"],
            nba: ["NBA", "CBB"],
            soccer: ["SOCCER", "EPL", "UCL", "LAL", "BUN", "SEA", "FL1", "UEL"],
          };

          if (this.dataProvider.getUpcomingGames) {
            let games = this.dataProvider.getUpcomingGames(hours);

            // US-703: Apply server-side sport filter if specified
            if (sportParam && sportCategoryMap[sportParam.toLowerCase()]) {
              const allowedSports = sportCategoryMap[sportParam.toLowerCase()];
              games = games.filter((g) =>
                allowedSports.includes((g.sport || "").toUpperCase()),
              );
            }

            this.sendJson(res, 200, {
              games,
              hours,
              sport: sportParam || "all",
              timestamp: Date.now(),
            });
          } else {
            this.sendJson(res, 200, {
              games: [],
              hours,
              sport: sportParam || "all",
              timestamp: Date.now(),
            });
          }
          break;
        }

        // US-807: Pending sells endpoint - returns positions within 10c of threshold
        case "/api/positions/pending-sells": {
          const positions = this.dataProvider.getPositions();
          // Filter for positions that are pending sell (isPendingSell = true)
          const pendingSells = positions
            .filter((p) => p.isPendingSell)
            // Sort by distance to threshold ascending (closest first)
            .sort((a, b) => a.distanceToThreshold - b.distanceToThreshold);

          this.sendJson(res, 200, {
            positions: pendingSells,
            count: pendingSells.length,
            timestamp: Date.now(),
          });
          break;
        }

        // US-817: Pending Settlement endpoint
        case "/api/positions/pending-settlement": {
          const positions = this.dataProvider.getPositions();
          // Filter for positions that are pending settlement (isPendingSettlement = true)
          const pendingSettlement = positions
            .filter((p) => p.isPendingSettlement)
            // Sort by gameEndedAt ascending (oldest first - longest waiting)
            .sort((a, b) => {
              const aTime = a.gameEndedAt
                ? new Date(a.gameEndedAt).getTime()
                : 0;
              const bTime = b.gameEndedAt
                ? new Date(b.gameEndedAt).getTime()
                : 0;
              return aTime - bTime;
            });

          this.sendJson(res, 200, {
            positions: pendingSettlement,
            count: pendingSettlement.length,
            timestamp: Date.now(),
          });
          break;
        }

        default:
          this.sendJson(res, 404, { error: "Endpoint not found" });
      }
    } catch (error) {
      this.log(`API error: ${error}`, "ERROR");
      this.sendJson(res, 500, { error: "Internal server error" });
    }
  }

  /**
   * Handle POST requests (US-511: Force Entry)
   */
  private handlePostRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    pathname: string,
  ): void {
    if (pathname === "/api/force-entry") {
      // US-511: Force Entry is only allowed in PAPER mode
      if (this.config.mode === "LIVE") {
        this.sendJson(res, 403, {
          error: "Force entry is only available in PAPER mode",
        });
        return;
      }

      if (!this.dataProvider) {
        this.sendJson(res, 503, { error: "Data provider not configured" });
        return;
      }

      if (!this.dataProvider.forceEntry) {
        this.sendJson(res, 501, {
          error: "Force entry not supported by data provider",
        });
        return;
      }

      // Read request body
      let body = "";
      req.on("data", (chunk) => {
        body += chunk.toString();
      });

      req.on("end", async () => {
        try {
          const { marketSlug, betSize } = JSON.parse(body);

          if (!marketSlug || typeof marketSlug !== "string") {
            this.sendJson(res, 400, { error: "marketSlug is required" });
            return;
          }

          if (!betSize || typeof betSize !== "number" || betSize <= 0) {
            this.sendJson(res, 400, {
              error: "betSize must be a positive number",
            });
            return;
          }

          this.log(`Force entry requested: ${marketSlug}, $${betSize}`);

          const result = await this.dataProvider!.forceEntry!(
            marketSlug,
            betSize,
          );

          if (result.success) {
            this.sendJson(res, 200, result);
          } else {
            this.sendJson(res, 400, result);
          }
        } catch (error) {
          this.log(`Force entry error: ${error}`, "ERROR");
          this.sendJson(res, 400, { error: "Invalid JSON body" });
        }
      });

      return;
    }

    // US-814: Force Sell endpoint for pending settlement positions
    if (pathname === "/api/force-sell") {
      if (!this.dataProvider) {
        this.sendJson(res, 503, { error: "Data provider not configured" });
        return;
      }

      if (!this.dataProvider.forceSell) {
        this.sendJson(res, 501, {
          error: "Force sell not supported by data provider",
        });
        return;
      }

      // Read request body
      let body = "";
      req.on("data", (chunk) => {
        body += chunk.toString();
      });

      req.on("end", async () => {
        try {
          const { marketSlug, outcomeIndex } = JSON.parse(body);

          if (!marketSlug || typeof marketSlug !== "string") {
            this.sendJson(res, 400, { error: "marketSlug is required" });
            return;
          }

          if (outcomeIndex !== 0 && outcomeIndex !== 1) {
            this.sendJson(res, 400, { error: "outcomeIndex must be 0 or 1" });
            return;
          }

          this.log(
            `Force sell requested: ${marketSlug}, outcome=${outcomeIndex}`,
          );

          const result = await this.dataProvider!.forceSell!(
            marketSlug,
            outcomeIndex,
          );

          if (result.success) {
            this.sendJson(res, 200, result);
          } else {
            this.sendJson(res, 400, result);
          }
        } catch (error) {
          this.log(`Force sell error: ${error}`, "ERROR");
          this.sendJson(res, 400, { error: "Invalid JSON body" });
        }
      });

      return;
    }

    // Unknown POST endpoint
    this.sendJson(res, 404, { error: "Endpoint not found" });
  }

  /**
   * Serve static files
   */
  private serveStaticFile(res: http.ServerResponse, pathname: string): void {
    // Default to index.html
    if (pathname === "/" || pathname === "") {
      pathname = "/index.html";
    }

    const filePath = path.join(this.config.staticDir, pathname);
    const ext = path.extname(filePath).toLowerCase();

    // Content types
    const contentTypes: Record<string, string> = {
      ".html": "text/html",
      ".css": "text/css",
      ".js": "text/javascript",
      ".json": "application/json",
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".svg": "image/svg+xml",
      ".ico": "image/x-icon",
    };

    const contentType = contentTypes[ext] || "application/octet-stream";

    fs.readFile(filePath, (err, data) => {
      if (err) {
        // If static file not found, serve the embedded dashboard
        if (pathname === "/index.html") {
          this.serveEmbeddedDashboard(res);
        } else {
          res.writeHead(404, { "Content-Type": "text/plain" });
          res.end("Not found");
        }
        return;
      }

      res.writeHead(200, { "Content-Type": contentType });
      res.end(data);
    });
  }

  /**
   * Serve embedded dashboard HTML (fallback if no static files)
   * US-800: Revamped with section-based layout separating positions by state
   */
  private serveEmbeddedDashboard(res: http.ServerResponse): void {
    const mode = this.config.mode;
    const themeColor = mode === "LIVE" ? "#22c55e" : "#3b82f6";
    const bannerText = mode === "LIVE" ? "LIVE TRADING" : "PAPER TRADING";
    const bannerClass = mode === "LIVE" ? "banner-live" : "banner-paper";

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Sports Split-Sell Dashboard - ${bannerText}</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #0f172a;
      color: #e2e8f0;
      line-height: 1.5;
    }
    .banner {
      padding: 8px 16px;
      text-align: center;
      font-weight: bold;
      font-size: 14px;
      text-transform: uppercase;
      letter-spacing: 1px;
    }
    .banner-paper { background: #1e40af; color: #fff; }
    .banner-live { background: #dc2626; color: #fff; }

    /* US-800 + US-805: Summary Stats Bar - Sticky at top, always visible */
    .stats-bar {
      background: #1e293b;
      padding: 12px 24px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      border-bottom: 1px solid #334155;
      flex-wrap: wrap;
      gap: 12px;
      position: sticky;
      top: 0;
      z-index: 100;
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
    }
    .stats-bar-left {
      display: flex;
      align-items: center;
      gap: 16px;
    }
    .stats-bar-left h1 {
      font-size: 20px;
      color: ${themeColor};
      white-space: nowrap;
    }
    .stats-bar-right {
      display: flex;
      gap: 16px;
      flex-wrap: wrap;
    }
    .stat-item {
      display: flex;
      flex-direction: column;
      align-items: center;
      padding: 4px 12px;
      background: #334155;
      border-radius: 6px;
      min-width: 80px;
      cursor: pointer;
      transition: background 0.2s;
    }
    .stat-item:hover { background: #475569; }
    .stat-item-label { font-size: 10px; color: #94a3b8; text-transform: uppercase; }
    .stat-item-value { font-size: 16px; font-weight: bold; }
    .stat-item-value.positive { color: #22c55e; }
    .stat-item-value.negative { color: #ef4444; }
    /* US-805: Section-specific stat colors for clickable counts */
    .stat-item-value.pending-color { color: #f97316; }
    .stat-item-value.watching-color { color: #3b82f6; }
    .stat-item-value.holding-color { color: #22c55e; }
    /* US-805: WebSocket connection indicator styling */
    #connection-status.connected::before {
      content: '●';
      margin-right: 4px;
      color: #22c55e;
    }
    #connection-status.disconnected::before {
      content: '●';
      margin-right: 4px;
      color: #ef4444;
    }
    .mode-badge {
      padding: 4px 8px;
      border-radius: 4px;
      font-size: 11px;
      font-weight: bold;
      text-transform: uppercase;
    }
    .mode-badge.paper { background: #1e40af; color: #fff; }
    .mode-badge.live { background: #dc2626; color: #fff; }
    #connection-status { font-size: 11px; margin-left: 8px; }
    .connected { color: #22c55e; }
    .disconnected { color: #ef4444; }
    /* US-826: Wallet address display */
    .wallet-display {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 11px;
      color: #94a3b8;
      margin-left: 12px;
      padding: 4px 8px;
      background: rgba(255, 255, 255, 0.05);
      border-radius: 4px;
    }
    .wallet-display:hover { background: rgba(255, 255, 255, 0.1); }
    .wallet-link {
      color: #94a3b8;
      text-decoration: none;
      font-family: monospace;
    }
    .wallet-link:hover { color: #60a5fa; }
    .wallet-icon { font-size: 12px; }

    .container {
      max-width: 1600px;
      margin: 0 auto;
      padding: 16px 24px;
    }

    /* US-800: Section-based layout */
    .sections-container {
      display: flex;
      flex-direction: column;
      gap: 16px;
    }

    /* US-800: Section styling with distinct visual treatment */
    .section {
      background: #1e293b;
      border-radius: 8px;
      overflow: hidden;
      border-left: 4px solid #475569;
    }
    .section.pending-sells { border-left-color: #f97316; }
    .section.watching { border-left-color: #3b82f6; }
    .section.holding-winners { border-left-color: #22c55e; }
    .section.pending-settlement { border-left-color: #6b7280; } /* US-813: Gray/neutral for pending settlement */

    .section-header {
      padding: 12px 16px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      cursor: pointer;
      user-select: none;
      transition: background 0.2s;
    }
    .section-header:hover { background: #334155; }
    .section-header-left {
      display: flex;
      align-items: center;
      gap: 12px;
    }
    .section-title {
      font-weight: 600;
      font-size: 14px;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .section-icon {
      font-size: 16px;
    }
    .section-count {
      background: #475569;
      padding: 2px 8px;
      border-radius: 10px;
      font-size: 12px;
      font-weight: 500;
    }
    .section.pending-sells .section-count { background: #f97316; color: #000; }
    .section.watching .section-count { background: #3b82f6; }
    .section.holding-winners .section-count { background: #22c55e; color: #000; }
    .section.pending-settlement .section-count { background: #6b7280; } /* US-813: Gray badge */
    .section-collapse-icon {
      color: #94a3b8;
      font-size: 12px;
      transition: transform 0.2s;
    }
    .section.collapsed .section-collapse-icon { transform: rotate(-90deg); }
    .section-body {
      padding: 0 16px 16px 16px;
      transition: max-height 0.3s ease, padding 0.3s ease;
      overflow: hidden;
    }
    .section.collapsed .section-body {
      max-height: 0;
      padding-top: 0;
      padding-bottom: 0;
    }

    /* US-803: Sort bar for Watching section */
    .section-sort-bar {
      padding: 8px 16px;
      background: #0f172a;
      border-bottom: 1px solid #334155;
      display: flex;
      align-items: center;
    }
    .sort-select {
      background: #334155;
      color: #e2e8f0;
      border: 1px solid #475569;
      padding: 4px 8px;
      border-radius: 4px;
      font-size: 11px;
      cursor: pointer;
    }
    .sort-select:hover { border-color: #60a5fa; }
    .sort-select:focus { outline: none; border-color: #3b82f6; }

    /* US-803: Price flash animations on change */
    @keyframes price-flash-up {
      0% { background-color: rgba(34, 197, 94, 0.4); }
      100% { background-color: transparent; }
    }
    @keyframes price-flash-down {
      0% { background-color: rgba(239, 68, 68, 0.4); }
      100% { background-color: transparent; }
    }
    .price-flash-up {
      animation: price-flash-up 0.5s ease-out;
    }
    .price-flash-down {
      animation: price-flash-down 0.5s ease-out;
    }

    /* US-806: Position card section transition animations */
    @keyframes card-enter {
      0% { opacity: 0; transform: translateY(-10px) scale(0.98); }
      100% { opacity: 1; transform: translateY(0) scale(1); }
    }
    @keyframes card-exit {
      0% { opacity: 1; transform: translateY(0) scale(1); }
      100% { opacity: 0; transform: translateY(10px) scale(0.98); }
    }
    .position-card.entering {
      animation: card-enter 0.4s ease-out forwards;
    }
    .position-card.exiting {
      animation: card-exit 0.3s ease-in forwards;
    }

    /* US-806: Last update timestamp styling */
    .last-update {
      display: flex;
      align-items: center;
      gap: 4px;
      font-size: 10px;
      color: #64748b;
      margin-top: 4px;
    }
    .last-update.recent {
      color: #94a3b8;
    }
    .last-update.stale {
      color: #f97316;
    }
    .last-update.very-stale {
      color: #ef4444;
    }
    .stale-indicator {
      display: inline-block;
      width: 6px;
      height: 6px;
      border-radius: 50%;
      margin-right: 2px;
    }
    .stale-indicator.fresh {
      background: #22c55e;
    }
    .stale-indicator.stale {
      background: #f97316;
      animation: pulse-orange 1s infinite;
    }
    .stale-indicator.very-stale {
      background: #ef4444;
      animation: pulse-red 1s infinite;
    }
    @keyframes pulse-orange {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.5; }
    }

    /* US-820: Order Book Info Row - compact display at bottom of cards */
    .order-book-info {
      display: flex;
      gap: 12px;
      padding: 8px;
      background: rgba(0, 0, 0, 0.15);
      border-radius: 4px;
      margin-top: 8px;
      font-size: 10px;
      color: #94a3b8;
    }
    .order-book-info-item {
      display: flex;
      flex-direction: column;
      align-items: center;
    }
    .order-book-info-label {
      font-size: 9px;
      text-transform: uppercase;
      color: #64748b;
      margin-bottom: 2px;
    }
    .order-book-info-value {
      font-weight: 600;
      font-size: 11px;
    }
    /* US-820: Depth color coding - Green: >$10K, Yellow: $1K-$10K, Red: <$1K */
    .depth-green { color: #22c55e; }
    .depth-yellow { color: #eab308; }
    .depth-red { color: #ef4444; }
    /* US-823: Spread color coding - Green: ≤2c, Yellow: ≤5c, Red: >5c */
    .spread-green { color: #22c55e; }
    .spread-yellow { color: #eab308; }
    .spread-red { color: #ef4444; }
    /* US-820: Stale data warning */
    .order-book-stale {
      display: flex;
      align-items: center;
      gap: 4px;
      font-size: 9px;
      color: #f97316;
    }
    .order-book-stale-icon {
      font-size: 10px;
    }

    /* US-836: Dual order book display for watching/pending-sell cards */
    .dual-order-book-info {
      padding: 8px;
      background: rgba(0, 0, 0, 0.15);
      border-radius: 4px;
      margin-top: 8px;
      font-size: 11px;
    }
    .dual-order-book-row {
      display: flex;
      align-items: center;
      gap: 6px;
      margin-bottom: 4px;
      color: #94a3b8;
    }
    .dual-order-book-row:last-of-type {
      margin-bottom: 6px;
    }
    .dual-order-book-name {
      min-width: 80px;
      font-weight: 500;
      color: #cbd5e1;
    }
    .dual-order-book-bid,
    .dual-order-book-ask,
    .dual-order-book-spread {
      font-weight: 600;
    }
    .dual-order-book-sep {
      color: #475569;
    }
    .dual-order-book-depth {
      display: flex;
      align-items: center;
      gap: 8px;
      padding-top: 6px;
      border-top: 1px solid rgba(255, 255, 255, 0.1);
      font-size: 10px;
      color: #64748b;
    }
    .dual-order-book-depth-label {
      text-transform: uppercase;
    }
    .dual-order-book-depth-value {
      font-weight: 600;
    }

    /* US-803: Enhanced outcome display with larger prices */
    .watching-outcome {
      padding: 10px;
      background: rgba(0, 0, 0, 0.2);
      border-radius: 6px;
      margin-bottom: 8px;
      transition: background 0.3s ease;
    }
    .watching-outcome:last-child {
      margin-bottom: 0;
    }
    .watching-outcome.closer-to-threshold {
      border-left: 3px solid;
    }
    .watching-outcome-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 8px;
    }
    .watching-outcome-name {
      font-size: 13px;
      font-weight: 500;
      color: #e2e8f0;
    }
    .watching-outcome-price {
      font-size: 22px;
      font-weight: 700;
      padding: 2px 8px;
      border-radius: 4px;
      transition: background 0.3s ease;
    }
    .watching-outcome-price.green { color: #22c55e; }
    .watching-outcome-price.yellow { color: #eab308; }
    .watching-outcome-price.red { color: #ef4444; }

    .section-empty {
      text-align: center;
      color: #64748b;
      padding: 24px;
      font-size: 13px;
    }

    /* US-800: Position cards within sections */
    .position-cards {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
      gap: 12px;
    }
    .position-card {
      background: #0f172a;
      border-radius: 6px;
      padding: 12px;
      border: 1px solid #334155;
      transition: border-color 0.3s ease, background 0.3s ease;
    }
    /* US-801: Position card urgency styling */
    .position-card.urgency-green {
      border-left: 3px solid #22c55e;
    }
    .position-card.urgency-yellow {
      border-left: 3px solid #eab308;
      background: rgba(234, 179, 8, 0.05);
    }
    .position-card.urgency-red {
      border-left: 3px solid #ef4444;
      background: rgba(239, 68, 68, 0.1);
    }
    .position-card-header {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      margin-bottom: 8px;
    }
    .position-card-title {
      font-weight: 500;
      font-size: 13px;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .position-card-meta {
      font-size: 11px;
      color: #94a3b8;
    }
    /* US-825: Polymarket link icon */
    .polymarket-link {
      text-decoration: none;
      color: #94a3b8;
      font-size: 12px;
      opacity: 0.7;
      transition: opacity 0.2s, color 0.2s;
      margin-left: 4px;
    }
    .polymarket-link:hover {
      opacity: 1;
      color: #60a5fa;
    }
    .position-card-body {
      font-size: 12px;
    }
    .position-outcome {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 6px 0;
      border-bottom: 1px solid #334155;
    }
    .position-outcome:last-child { border-bottom: none; }
    .outcome-name { color: #94a3b8; }
    .outcome-price { font-weight: 600; font-size: 14px; }
    .outcome-price.low { color: #f97316; }
    .outcome-price.high { color: #22c55e; }

    /* US-802: Enhanced Progress Bar styling for threshold distance */
    .threshold-progress-container {
      margin-top: 8px;
      padding: 8px;
      background: rgba(0, 0, 0, 0.2);
      border-radius: 6px;
    }
    .threshold-progress-row {
      margin-bottom: 12px;
    }
    .threshold-progress-row:last-child {
      margin-bottom: 0;
    }
    .threshold-progress-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 4px;
    }
    .threshold-progress-outcome {
      font-size: 11px;
      color: #94a3b8;
      font-weight: 500;
    }
    .threshold-progress-price {
      font-size: 14px;
      font-weight: 700;
    }
    .threshold-progress-price.green { color: #22c55e; }
    .threshold-progress-price.yellow { color: #eab308; }
    .threshold-progress-price.red { color: #ef4444; }
    .progress-bar {
      background: #334155;
      border-radius: 4px;
      height: 8px;
      overflow: visible;
      margin-top: 4px;
      position: relative;
    }
    .progress-fill {
      height: 100%;
      border-radius: 4px;
      transition: width 0.3s ease, background-color 0.3s ease;
    }
    /* US-802: Color transitions - green (0-60%) → yellow (60-80%) → red (80-100%) */
    .progress-fill.progress-green { background: linear-gradient(90deg, #22c55e, #4ade80); }
    .progress-fill.progress-yellow { background: linear-gradient(90deg, #eab308, #facc15); }
    .progress-fill.progress-red { background: linear-gradient(90deg, #ef4444, #f87171); animation: progress-pulse 1.5s ease-in-out infinite; }
    @keyframes progress-pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.8; }
    }
    /* US-802: Threshold marker - vertical line at 100% position */
    .threshold-marker {
      position: absolute;
      right: 0;
      top: -4px;
      bottom: -4px;
      width: 2px;
      background: #ef4444;
      border-radius: 1px;
    }
    .threshold-marker::after {
      content: '';
      position: absolute;
      top: -4px;
      left: -3px;
      width: 8px;
      height: 8px;
      background: #ef4444;
      border-radius: 50%;
    }
    /* US-802: Current price shown at end of filled portion */
    .progress-price-indicator {
      position: absolute;
      top: -18px;
      transform: translateX(-50%);
      font-size: 10px;
      font-weight: 700;
      white-space: nowrap;
      transition: left 0.3s ease;
    }
    .progress-price-indicator.green { color: #22c55e; }
    .progress-price-indicator.yellow { color: #eab308; }
    .progress-price-indicator.red { color: #ef4444; }
    /* US-802: Distance text below bar */
    .progress-text {
      font-size: 10px;
      color: #94a3b8;
      margin-top: 4px;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .progress-text-distance {
      font-weight: 600;
    }
    .progress-text-distance.green { color: #22c55e; }
    .progress-text-distance.yellow { color: #eab308; }
    .progress-text-distance.red { color: #ef4444; }
    .progress-text-threshold {
      color: #64748b;
    }
    /* US-802: AT THRESHOLD state */
    .progress-at-threshold {
      font-weight: 700;
      color: #ef4444;
      animation: flash-text 0.5s ease-in-out infinite;
    }
    @keyframes flash-text {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.5; }
    }
    /* US-802: BELOW THRESHOLD state */
    .progress-below-threshold {
      font-weight: 700;
      color: #ef4444;
      background: rgba(239, 68, 68, 0.2);
      padding: 2px 6px;
      border-radius: 4px;
    }
    /* Legacy compatibility */
    .progress-fill.close { background: #eab308; }
    .progress-fill.danger { background: #ef4444; }

    /* US-801: Urgency indicators and distance badge styling */
    .distance-badge {
      display: inline-block;
      padding: 4px 10px;
      border-radius: 4px;
      font-size: 12px;
      font-weight: 700;
      text-transform: uppercase;
      margin-top: 4px;
    }
    .distance-badge.green { background: #22c55e; color: #fff; }
    .distance-badge.yellow { background: #eab308; color: #000; }
    .distance-badge.red { background: #ef4444; color: #fff; animation: pulse-red 1s infinite; }
    @keyframes pulse-red {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.7; }
    }
    .threshold-label {
      font-size: 10px;
      color: #64748b;
      margin-top: 4px;
    }
    .approaching-side {
      margin-top: 8px;
      padding: 8px;
      background: rgba(0, 0, 0, 0.2);
      border-radius: 4px;
    }
    .approaching-side-header {
      font-size: 10px;
      color: #94a3b8;
      text-transform: uppercase;
      margin-bottom: 4px;
    }
    .approaching-side-price {
      font-size: 24px;
      font-weight: 700;
    }
    .approaching-side-price.green { color: #22c55e; }
    .approaching-side-price.yellow { color: #eab308; }
    .approaching-side-price.red { color: #ef4444; }

    /* P&L display */
    .pnl-display {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-top: 8px;
      padding-top: 8px;
      border-top: 1px solid #334155;
    }
    .pnl-label { font-size: 11px; color: #94a3b8; }
    .pnl-value { font-weight: 600; }
    .pnl-value.positive { color: #22c55e; }
    .pnl-value.negative { color: #ef4444; }

    /* US-804: Holding Winners Section Styling */
    .holding-winner-card {
      border-left: 3px solid #22c55e;
      background: rgba(34, 197, 94, 0.05);
    }
    .winner-game-name {
      color: #22c55e;
    }
    .winner-section {
      background: rgba(34, 197, 94, 0.1);
      border-radius: 6px;
      padding: 10px;
      margin-bottom: 10px;
      border: 1px solid rgba(34, 197, 94, 0.3);
    }
    .winner-section-header {
      display: flex;
      align-items: center;
      gap: 6px;
      margin-bottom: 8px;
    }
    .winner-section-icon {
      font-size: 14px;
    }
    .winner-section-label {
      font-size: 10px;
      font-weight: 600;
      color: #22c55e;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    .winner-details {
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    .winner-name {
      font-size: 14px;
      font-weight: 600;
      color: #e2e8f0;
    }
    .winner-stats {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .winner-price {
      font-size: 20px;
      font-weight: 700;
      color: #22c55e;
      padding: 2px 8px;
      border-radius: 4px;
      background: rgba(34, 197, 94, 0.2);
      transition: background 0.3s ease;
    }
    .winner-shares {
      font-size: 12px;
      color: #94a3b8;
    }
    .winner-value {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-top: 4px;
      padding-top: 4px;
      border-top: 1px dashed rgba(34, 197, 94, 0.3);
    }
    .winner-value-label {
      font-size: 11px;
      color: #94a3b8;
    }
    .winner-value-amount {
      font-size: 14px;
      font-weight: 600;
      color: #22c55e;
    }
    .loser-section {
      background: rgba(0, 0, 0, 0.2);
      border-radius: 6px;
      padding: 8px 10px;
      margin-bottom: 10px;
    }
    .loser-section-header {
      margin-bottom: 4px;
    }
    .loser-section-label {
      font-size: 10px;
      font-weight: 600;
      color: #64748b;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    .loser-details {
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .loser-name {
      font-size: 12px;
      color: #94a3b8;
    }
    .loser-sale-info {
      font-size: 12px;
      color: #64748b;
    }
    .pnl-summary {
      background: rgba(0, 0, 0, 0.3);
      border-radius: 6px;
      padding: 10px;
    }
    .pnl-summary-header {
      font-size: 11px;
      font-weight: 600;
      color: #94a3b8;
      text-transform: uppercase;
      margin-bottom: 8px;
      padding-bottom: 4px;
      border-bottom: 1px solid #334155;
    }
    .pnl-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 3px 0;
      font-size: 12px;
    }
    .pnl-row-label {
      color: #94a3b8;
    }
    .pnl-row-value {
      font-weight: 500;
    }
    .pnl-row-value.positive {
      color: #22c55e;
    }
    .pnl-row-value.negative {
      color: #ef4444;
    }
    .pnl-row-total {
      margin-top: 6px;
      padding-top: 6px;
      border-top: 1px solid #334155;
    }
    .pnl-row-total .pnl-row-label {
      font-weight: 600;
      color: #e2e8f0;
    }
    .pnl-row-total .pnl-row-value {
      font-weight: 700;
      font-size: 14px;
    }

    /* US-813: Pending Settlement Section Styling */
    .pending-settlement-card {
      border-left: 3px solid #6b7280;
      background: rgba(107, 114, 128, 0.05);
    }
    .pending-settlement-card.settlement-delayed {
      border-left-color: #f59e0b;
      background: rgba(245, 158, 11, 0.1);
    }
    .settlement-game-name {
      color: #9ca3af;
    }
    .settlement-status {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 11px;
      padding: 4px 8px;
      border-radius: 4px;
      background: rgba(107, 114, 128, 0.2);
    }
    .settlement-status.awaiting {
      color: #9ca3af;
    }
    .settlement-status.delayed {
      color: #f59e0b;
      background: rgba(245, 158, 11, 0.2);
    }
    .settlement-status-icon {
      font-size: 12px;
    }
    .settlement-time-since {
      font-size: 11px;
      color: #6b7280;
    }
    .settlement-time-since.delayed {
      color: #f59e0b;
    }

    /* Sport badges */
    .sport-badge {
      display: inline-block;
      padding: 2px 6px;
      border-radius: 4px;
      font-size: 10px;
      font-weight: 600;
      text-transform: uppercase;
    }
    .sport-nhl { background: #1e40af; color: #fff; }
    .sport-nba { background: #c2410c; color: #fff; }
    .sport-nfl { background: #166534; color: #fff; }
    .sport-mlb { background: #dc2626; color: #fff; }
    .sport-default { background: #475569; color: #fff; }
    .sport-soccer { background: #3b82f6; color: #fff; }

    /* Legacy panels (Upcoming Games, Trade History, etc.) */
    .panel {
      background: #1e293b;
      border-radius: 8px;
      overflow: hidden;
    }
    .panel-header {
      background: #334155;
      padding: 12px 16px;
      font-weight: 600;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .panel-body { padding: 16px; }
    table {
      width: 100%;
      border-collapse: collapse;
    }
    th, td {
      padding: 8px 10px;
      text-align: left;
      border-bottom: 1px solid #334155;
      font-size: 12px;
    }
    th { color: #94a3b8; font-weight: 500; font-size: 11px; text-transform: uppercase; }
    tr:hover { background: #334155; }

    .stat-row {
      display: flex;
      justify-content: space-between;
      padding: 6px 0;
      border-bottom: 1px solid #334155;
      font-size: 13px;
    }
    .stat-row:last-child { border-bottom: none; }
    .stat-label { color: #94a3b8; }
    .stat-value { font-weight: 500; }

    /* US-703: Sport Filter Tabs */
    .sport-filter-tabs {
      display: flex;
      gap: 4px;
      padding: 8px 16px;
      background: #1e293b;
      border-bottom: 1px solid #334155;
    }
    .sport-tab {
      background: transparent;
      border: none;
      color: #94a3b8;
      padding: 6px 12px;
      border-radius: 6px;
      cursor: pointer;
      font-size: 12px;
      font-weight: 500;
      display: flex;
      align-items: center;
      gap: 6px;
      transition: all 0.2s;
    }
    .sport-tab:hover {
      background: #334155;
      color: #e2e8f0;
    }
    .sport-tab.active {
      background: var(--tab-color, #475569);
      color: #fff;
    }
    .tab-count {
      background: rgba(255,255,255,0.2);
      padding: 2px 6px;
      border-radius: 10px;
      font-size: 10px;
      min-width: 16px;
      text-align: center;
    }
    .sport-tab:not(.active) .tab-count {
      background: #334155;
    }

    .status-badge {
      display: inline-block;
      padding: 2px 6px;
      border-radius: 4px;
      font-size: 10px;
      font-weight: 600;
      text-transform: uppercase;
    }
    .status-scheduled { background: #475569; color: #fff; }
    .status-entry-open { background: #22c55e; color: #fff; }
    .status-live { background: #ef4444; color: #fff; }
    .status-entered { background: #3b82f6; color: #fff; }
    .status-ended { background: #374151; color: #9ca3af; }
    .price-balanced { color: #22c55e; font-weight: 600; }
    .price-unbalanced { color: #94a3b8; }
    .timer-entry { color: #22c55e; font-weight: 600; }
    .timer-live { color: #ef4444; font-weight: 600; }
    .timer-countdown { color: #e2e8f0; }
    select.time-horizon {
      background: #334155;
      color: #e2e8f0;
      border: 1px solid #475569;
      padding: 4px 8px;
      border-radius: 4px;
      font-size: 11px;
      cursor: pointer;
    }
    select.time-horizon:hover { border-color: #60a5fa; }
    .external-link {
      color: #60a5fa;
      text-decoration: none;
      font-size: 12px;
    }
    .external-link:hover { color: #93c5fd; }
    .volume-badge {
      color: #94a3b8;
      font-size: 11px;
    }
    .force-entry-btn {
      background: #3b82f6;
      color: #fff;
      border: none;
      padding: 3px 6px;
      border-radius: 4px;
      font-size: 10px;
      cursor: pointer;
      margin-right: 6px;
    }
    .force-entry-btn:hover { background: #2563eb; }
    .force-entry-btn:disabled {
      background: #475569;
      cursor: not-allowed;
      opacity: 0.5;
    }
    /* US-814: Force Sell button in pending settlement cards */
    .force-sell-btn {
      background: #f59e0b;
      color: #000;
      border: none;
      padding: 4px 8px;
      border-radius: 4px;
      font-size: 11px;
      font-weight: 500;
      cursor: pointer;
      margin-top: 8px;
      display: block;
    }
    .force-sell-btn:hover { background: #d97706; }
    /* US-824: Winner Force Sell button - green/yellow instead of orange */
    .force-sell-winner-btn {
      background: linear-gradient(135deg, #22c55e 0%, #84cc16 100%);
      color: #000;
      border: none;
      padding: 6px 12px;
      border-radius: 4px;
      font-size: 11px;
      font-weight: 600;
      cursor: pointer;
      margin-top: 8px;
      display: inline-flex;
      align-items: center;
      gap: 4px;
    }
    .force-sell-winner-btn:hover { background: linear-gradient(135deg, #16a34a 0%, #65a30d 100%); }
    .force-sell-winner-btn:disabled {
      background: #4b5563;
      cursor: not-allowed;
      opacity: 0.5;
    }
    .modal-overlay {
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background: rgba(0, 0, 0, 0.7);
      display: none;
      justify-content: center;
      align-items: center;
      z-index: 1000;
    }
    .modal-overlay.active { display: flex; }
    .modal {
      background: #1e293b;
      border-radius: 8px;
      padding: 24px;
      min-width: 400px;
      max-width: 500px;
      border: 1px solid #334155;
    }
    .modal h3 {
      margin-bottom: 16px;
      color: #e2e8f0;
    }
    .modal-body { margin-bottom: 20px; }
    .modal label {
      display: block;
      margin-bottom: 8px;
      color: #94a3b8;
    }
    .modal input {
      width: 100%;
      padding: 8px 12px;
      background: #0f172a;
      border: 1px solid #334155;
      border-radius: 4px;
      color: #e2e8f0;
      font-size: 14px;
    }
    .modal input:focus {
      outline: none;
      border-color: #3b82f6;
    }
    .modal-actions {
      display: flex;
      justify-content: flex-end;
      gap: 12px;
    }
    .modal-btn {
      padding: 8px 16px;
      border-radius: 4px;
      font-size: 14px;
      cursor: pointer;
      border: none;
    }
    .modal-btn-cancel {
      background: #475569;
      color: #e2e8f0;
    }
    .modal-btn-cancel:hover { background: #64748b; }
    .modal-btn-confirm {
      background: #22c55e;
      color: #fff;
    }
    .modal-btn-confirm:hover { background: #16a34a; }
    .toast {
      position: fixed;
      bottom: 20px;
      right: 20px;
      padding: 12px 20px;
      border-radius: 4px;
      color: #fff;
      font-size: 14px;
      z-index: 1001;
      display: none;
    }
    .toast.success { background: #22c55e; display: block; }
    .toast.error { background: #ef4444; display: block; }
    .health-badge {
      display: inline-block;
      padding: 2px 6px;
      border-radius: 4px;
      font-size: 10px;
      font-weight: 600;
      text-transform: uppercase;
    }
    .health-healthy { background: #22c55e; color: #fff; }
    .health-caution { background: #eab308; color: #000; }
    .health-danger { background: #ef4444; color: #fff; }

    /* Grid layout for additional panels */
    .panels-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(400px, 1fr));
      gap: 16px;
      margin-top: 16px;
    }
    .full-width { grid-column: 1 / -1; }

    @media (max-width: 768px) {
      .stats-bar { flex-direction: column; align-items: stretch; }
      .stats-bar-right { justify-content: center; }
      .position-cards { grid-template-columns: 1fr; }
      .panels-grid { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <div class="banner ${bannerClass}">${bannerText}</div>

  <!-- US-800: Summary Stats Bar -->
  <div class="stats-bar">
    <div class="stats-bar-left">
      <h1>Sports Split-Sell</h1>
      <span class="mode-badge ${mode.toLowerCase()}">${mode}</span>
      <span id="connection-status" class="disconnected">Disconnected</span>
      <div class="wallet-display" id="wallet-display" style="display: none;">
        <span class="wallet-icon">💳</span>
        <a id="wallet-link" class="wallet-link" href="#" target="_blank" rel="noopener noreferrer" title="View on Polygonscan">
          <span id="wallet-address">Loading...</span>
        </a>
      </div>
    </div>
    <div class="stats-bar-right">
      <div class="stat-item" onclick="scrollToSection('section-pending-sells')" title="Click to view Pending Sells">
        <span class="stat-item-label">Pending Sell</span>
        <span class="stat-item-value pending-color" id="stat-pending-sell">0</span>
      </div>
      <div class="stat-item" onclick="scrollToSection('section-watching')" title="Click to view Watching">
        <span class="stat-item-label">Watching</span>
        <span class="stat-item-value watching-color" id="stat-watching">0</span>
      </div>
      <div class="stat-item" onclick="scrollToSection('section-holding-winners')" title="Click to view Holding Winners">
        <span class="stat-item-label">Holding</span>
        <span class="stat-item-value holding-color" id="stat-holding-winners">0</span>
      </div>
      <div class="stat-item">
        <span class="stat-item-label">Balance</span>
        <span class="stat-item-value" id="stat-balance">$0</span>
      </div>
      <div class="stat-item">
        <span class="stat-item-label">Deployed</span>
        <span class="stat-item-value" id="stat-deployed">$0</span>
      </div>
      <div class="stat-item">
        <span class="stat-item-label">Today P&L</span>
        <span class="stat-item-value" id="stat-today-pnl">$0</span>
      </div>
      <div class="stat-item">
        <span class="stat-item-label">Projected</span>
        <span class="stat-item-value" id="stat-projected-pnl">$0</span>
      </div>
    </div>
  </div>

  <div class="container">
    <!-- US-800: Section-based Position Layout -->
    <div class="sections-container">

      <!-- US-800: Pending Sells Section (URGENT - within 10c of threshold) -->
      <div class="section pending-sells" id="section-pending-sells">
        <div class="section-header" onclick="toggleSection('section-pending-sells')">
          <div class="section-header-left">
            <span class="section-title">
              <span class="section-icon">⚠️</span>
              Pending Sells
            </span>
            <span class="section-count" id="pending-sells-count">0</span>
          </div>
          <span class="section-collapse-icon">▼</span>
        </div>
        <div class="section-body">
          <div class="position-cards" id="pending-sells-cards">
            <div class="section-empty">No positions approaching sell threshold</div>
          </div>
        </div>
      </div>

      <!-- US-800 + US-803: Watching Section (HOLDING - both sides held) -->
      <div class="section watching" id="section-watching">
        <div class="section-header" onclick="toggleSection('section-watching')">
          <div class="section-header-left">
            <span class="section-title">
              <span class="section-icon">👁️</span>
              Watching
            </span>
            <span class="section-count" id="watching-count">0</span>
          </div>
          <span class="section-collapse-icon">▼</span>
        </div>
        <!-- US-803: Sort options for Watching section -->
        <div class="section-sort-bar" id="watching-sort-bar" style="display: none;">
          <span style="font-size: 11px; color: #94a3b8; margin-right: 8px;">Sort by:</span>
          <select id="watching-sort" class="sort-select">
            <option value="threshold">Closest to Threshold</option>
            <option value="time">Entry Time (newest)</option>
            <option value="sport">Sport</option>
          </select>
        </div>
        <div class="section-body">
          <div class="position-cards" id="watching-cards">
            <div class="section-empty">No positions being watched</div>
          </div>
        </div>
      </div>

      <!-- US-800: Holding Winners Section (PARTIAL_SOLD - loser sold) -->
      <div class="section holding-winners" id="section-holding-winners">
        <div class="section-header" onclick="toggleSection('section-holding-winners')">
          <div class="section-header-left">
            <span class="section-title">
              <span class="section-icon">✅</span>
              Holding Winners
            </span>
            <span class="section-count" id="holding-winners-count">0</span>
          </div>
          <span class="section-collapse-icon">▼</span>
        </div>
        <div class="section-body">
          <div class="position-cards" id="holding-winners-cards">
            <div class="section-empty">No winning positions held</div>
          </div>
        </div>
      </div>

      <!-- US-813: Pending Settlement Section -->
      <div class="section pending-settlement" id="section-pending-settlement">
        <div class="section-header" onclick="toggleSection('section-pending-settlement')">
          <div class="section-header-left">
            <span class="section-title">
              <span class="section-icon">⏳</span>
              Pending Settlement
            </span>
            <span class="section-count" id="pending-settlement-count">0</span>
          </div>
          <span class="section-collapse-icon">▼</span>
        </div>
        <div class="section-body">
          <div class="position-cards" id="pending-settlement-cards">
            <div class="section-empty">No positions awaiting settlement</div>
          </div>
        </div>
      </div>
    </div>

    <!-- Upcoming Games Panel (US-509) -->
    <div class="panels-grid" style="margin-top: 24px;">
      <div class="panel full-width">
        <div class="panel-header">
          <span>Upcoming Games</span>
          <div style="display: flex; align-items: center; gap: 12px;">
            <span id="upcoming-count">0 games</span>
            <select id="time-horizon" class="time-horizon">
              <option value="6">Next 6 hours</option>
              <option value="12">Next 12 hours</option>
              <option value="24" selected>Next 24 hours</option>
              <option value="48">Next 48 hours</option>
            </select>
          </div>
        </div>
        <!-- US-703: Sport Category Filter Tabs -->
        <div class="sport-filter-tabs" id="sport-filter-tabs">
          <button class="sport-tab active" data-sport="all">All <span class="tab-count" id="count-all">0</span></button>
          <button class="sport-tab" data-sport="nhl" style="--tab-color: #22c55e;">Hockey <span class="tab-count" id="count-nhl">0</span></button>
          <button class="sport-tab" data-sport="nfl" style="--tab-color: #ef4444;">Football <span class="tab-count" id="count-nfl">0</span></button>
          <button class="sport-tab" data-sport="nba" style="--tab-color: #f97316;">Basketball <span class="tab-count" id="count-nba">0</span></button>
          <button class="sport-tab" data-sport="soccer" style="--tab-color: #3b82f6;">Soccer <span class="tab-count" id="count-soccer">0</span></button>
        </div>
        <div class="panel-body">
          <table>
            <thead>
              <tr>
                <th>Sport</th>
                <th>Teams</th>
                <th>Prices</th>
                <th>Volume</th>
                <th>Status</th>
                <th>Timer</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody id="upcoming-games-table">
              <tr><td colspan="7" style="text-align: center; color: #94a3b8;">No upcoming games</td></tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>

    <!-- Additional Panels Grid -->
    <div class="panels-grid">
      <!-- P&L Summary Panel -->
      <div class="panel">
        <div class="panel-header">P&L Summary</div>
        <div class="panel-body">
          <div class="stat-row">
            <span class="stat-label">Realized P&L</span>
            <span class="stat-value" id="realized-pnl">$0.00</span>
          </div>
          <div class="stat-row">
            <span class="stat-label">Unrealized P&L</span>
            <span class="stat-value" id="unrealized-pnl">$0.00</span>
          </div>
          <div class="stat-row">
            <span class="stat-label">Total P&L</span>
            <span class="stat-value" id="total-pnl-detail">$0.00</span>
          </div>
          <div class="stat-row">
            <span class="stat-label">Today's P&L</span>
            <span class="stat-value" id="today-pnl">$0.00</span>
          </div>
          <div class="stat-row">
            <span class="stat-label">Positions Settled</span>
            <span class="stat-value" id="positions-settled">0</span>
          </div>
          <div class="stat-row">
            <span class="stat-label">Win/Loss</span>
            <span class="stat-value" id="win-loss">0 / 0</span>
          </div>
          <div class="stat-row">
            <span class="stat-label">Avg P&L Per Position</span>
            <span class="stat-value" id="avg-pnl">$0.00</span>
          </div>
        </div>
      </div>

      <!-- Per-Sport P&L Panel -->
      <div class="panel">
        <div class="panel-header">P&L by Sport</div>
        <div class="panel-body" id="sport-pnl">
          <div style="text-align: center; color: #94a3b8;">No data</div>
        </div>
      </div>

      <!-- US-820: Market Health panel removed - order book info now shown on each game card -->

      <!-- Trade History Panel -->
      <div class="panel full-width">
        <div class="panel-header">
          <span>Recent Trades</span>
          <span id="trades-count">0 trades</span>
        </div>
        <div class="panel-body">
          <table>
            <thead>
              <tr>
                <th>Time</th>
                <th>Sport</th>
                <th>Market</th>
                <th>Action</th>
                <th>Outcome</th>
                <th>Shares</th>
                <th>Price</th>
                <th>Revenue/Cost</th>
              </tr>
            </thead>
            <tbody id="trades-table">
              <tr><td colspan="8" style="text-align: center; color: #94a3b8;">No trades yet</td></tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  </div>

  <!-- Force Entry Modal (US-511) - Paper Trading Only -->
  <div id="force-entry-modal" class="modal-overlay">
    <div class="modal">
      <h3>Force Entry</h3>
      <div class="modal-body">
        <p style="margin-bottom: 12px; color: #94a3b8;" id="modal-market-info">Split $X on AWAY vs HOME?</p>
        <label for="bet-size-input">Bet Size (USDC):</label>
        <input type="number" id="bet-size-input" min="1" max="100" value="10" step="1">
      </div>
      <div class="modal-actions">
        <button class="modal-btn modal-btn-cancel" onclick="closeForceEntryModal()">Cancel</button>
        <button class="modal-btn modal-btn-confirm" onclick="confirmForceEntry()">Split</button>
      </div>
    </div>
  </div>

  <!-- Force Sell Modal (US-814) - For pending settlement positions with unsold shares -->
  <div id="force-sell-modal" class="modal-overlay">
    <div class="modal">
      <h3>Force Sell</h3>
      <div class="modal-body">
        <p style="margin-bottom: 12px; color: #f59e0b;" id="force-sell-warning">
          ⚠️ This position has unsold shares
        </p>
        <p style="margin-bottom: 8px; color: #94a3b8;" id="force-sell-info">
          Sell X shares at market price (~Yc)?
        </p>
        <p style="margin-bottom: 8px; color: #94a3b8;" id="force-sell-revenue">
          Expected revenue: $0.00
        </p>
        <p style="font-size: 11px; color: #6b7280;">
          This may result in minimal or zero revenue if the game has ended.
        </p>
      </div>
      <div class="modal-actions">
        <button class="modal-btn modal-btn-cancel" onclick="closeForceSellModal()">Cancel</button>
        <button class="modal-btn modal-btn-confirm" style="background: #f59e0b;" onclick="confirmForceSell()">Sell</button>
      </div>
    </div>
  </div>

  <!-- Force Sell Winner Modal (US-824) - For selling winning position before settlement -->
  <div id="force-sell-winner-modal" class="modal-overlay">
    <div class="modal">
      <h3 style="color: #22c55e;">⚡ Sell Winner Early</h3>
      <div class="modal-body">
        <p style="margin-bottom: 12px; color: #eab308;" id="force-sell-winner-warning">
          ⚠️ This will sell your winning position before settlement
        </p>
        <p style="margin-bottom: 8px; color: #94a3b8;" id="force-sell-winner-info">
          Sell X shares at market price (~Yc)?
        </p>
        <p style="margin-bottom: 8px; color: #94a3b8;" id="force-sell-winner-revenue">
          Expected revenue: $0.00
        </p>
        <p style="margin-bottom: 8px; color: #ef4444;" id="force-sell-winner-loss">
          Potential loss vs $1 settlement: $0.00
        </p>
        <p style="font-size: 11px; color: #6b7280;">
          You may receive less than $1.00 per share. Settlement typically pays $1.00 per winning share.
        </p>
      </div>
      <div class="modal-actions">
        <button class="modal-btn modal-btn-cancel" onclick="closeForceSellWinnerModal()">Cancel</button>
        <button class="modal-btn modal-btn-confirm" style="background: linear-gradient(135deg, #22c55e 0%, #84cc16 100%);" onclick="confirmForceSellWinner()">Sell Winner</button>
      </div>
    </div>
  </div>

  <!-- Toast Notification -->
  <div id="toast" class="toast"></div>

  <script>
    const wsUrl = 'ws://' + window.location.host;
    let ws = null;
    let reconnectTimeout = null;

    // US-800: Section collapse state
    const sectionCollapseState = {
      'section-pending-sells': false,
      'section-watching': false,
      'section-holding-winners': false,
      'section-pending-settlement': false  // US-813
    };

    function connect() {
      ws = new WebSocket(wsUrl);

      ws.onopen = () => {
        document.getElementById('connection-status').textContent = 'Connected';
        document.getElementById('connection-status').className = 'connected';
        console.log('WebSocket connected');
      };

      ws.onclose = () => {
        document.getElementById('connection-status').textContent = 'Disconnected';
        document.getElementById('connection-status').className = 'disconnected';
        console.log('WebSocket disconnected, reconnecting...');
        reconnectTimeout = setTimeout(connect, 3000);
      };

      ws.onerror = (err) => {
        console.error('WebSocket error:', err);
      };

      ws.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data);
          handleMessage(message);
        } catch (err) {
          console.error('Failed to parse message:', err);
        }
      };
    }

    function handleMessage(message) {
      switch (message.type) {
        case 'POSITIONS_UPDATE':
          updatePositions(message.data);
          break;
        case 'STATS_UPDATE':
          updateStats(message.data);
          break;
        case 'TRADE_UPDATE':
          addTrade(message.data);
          break;
        case 'HEALTH_UPDATE':
          updateHealth(message.data);
          break;
        case 'FULL_UPDATE':
          updatePositions(message.data.positions || []);
          updateStats(message.data.stats || {});
          updateTrades(message.data.trades || []);
          if (message.data.health) updateHealth(message.data.health);
          if (message.data.upcomingGames) updateUpcomingGames(message.data.upcomingGames);
          break;
        case 'UPCOMING_GAMES_UPDATE':
          updateUpcomingGames(message.data);
          break;
        case 'POSITION_SECTION_CHANGE':
          // US-806: Handle section transition event from server
          handleSectionChange(message.data);
          break;
      }
    }

    function formatCurrency(value) {
      const num = parseFloat(value) || 0;
      const formatted = '$' + Math.abs(num).toFixed(2);
      return num < 0 ? '-' + formatted : formatted;
    }

    function formatCurrencyCompact(value) {
      const num = parseFloat(value) || 0;
      const formatted = '$' + Math.abs(num).toFixed(0);
      return num < 0 ? '-' + formatted : formatted;
    }

    // US-820: Format depth value ($125K, $1.2M)
    function formatDepth(value) {
      if (value === null || value === undefined) return '-';
      const num = parseFloat(value) || 0;
      if (num >= 1000000) {
        return '$' + (num / 1000000).toFixed(1) + 'M';
      } else if (num >= 1000) {
        return '$' + (num / 1000).toFixed(0) + 'K';
      } else {
        return '$' + num.toFixed(0);
      }
    }

    // US-820: Get depth color class based on liquidity
    function getDepthColorClass(value) {
      if (value === null || value === undefined) return '';
      const num = parseFloat(value) || 0;
      if (num > 10000) return 'depth-green';
      if (num >= 1000) return 'depth-yellow';
      return 'depth-red';
    }

    // US-820: Check if order book data is stale (>60s old)
    function isOrderBookStale(lastUpdate) {
      if (!lastUpdate) return true;
      const updateTime = new Date(lastUpdate).getTime();
      const now = Date.now();
      return (now - updateTime) > 60000; // >60 seconds
    }

    // US-820: Create order book info HTML for position card
    // US-823: Added bid/ask price display alongside depth
    function createOrderBookInfoHtml(position, relevantOutcome) {
      // Skip for pending settlement (no active order books)
      if (position.isPendingSettlement) return '';

      // Determine which outcome to show based on section
      // For Pending Sells: show approaching side
      // For Watching: show both (handled separately)
      // For Holding Winners: show held side

      let bidDepth, askDepth, spread, currentBid, currentAsk;
      if (relevantOutcome === 'outcome1') {
        bidDepth = position.outcome1BidDepth;
        askDepth = position.outcome1AskDepth;
        spread = position.outcome1Spread;
        currentBid = position.outcome1.currentBid;
        currentAsk = position.outcome1.currentAsk;
      } else if (relevantOutcome === 'outcome2') {
        bidDepth = position.outcome2BidDepth;
        askDepth = position.outcome2AskDepth;
        spread = position.outcome2Spread;
        currentBid = position.outcome2.currentBid;
        currentAsk = position.outcome2.currentAsk;
      } else {
        // Default: use the side with lowest price (closest to threshold)
        if (position.outcome1.currentBid <= position.outcome2.currentBid) {
          bidDepth = position.outcome1BidDepth;
          askDepth = position.outcome1AskDepth;
          spread = position.outcome1Spread;
          currentBid = position.outcome1.currentBid;
          currentAsk = position.outcome1.currentAsk;
        } else {
          bidDepth = position.outcome2BidDepth;
          askDepth = position.outcome2AskDepth;
          spread = position.outcome2Spread;
          currentBid = position.outcome2.currentBid;
          currentAsk = position.outcome2.currentAsk;
        }
      }

      const isStale = isOrderBookStale(position.orderBookLastUpdate);
      const staleHtml = isStale ? '<span class="order-book-stale"><span class="order-book-stale-icon">⚠️</span>Stale</span>' : '';

      // Format spread in cents
      const spreadCents = spread !== null ? (spread * 100).toFixed(1) + 'c' : '--';

      // US-823: Format bid/ask prices in cents
      const bidPriceCents = currentBid ? Math.round(currentBid * 100) + 'c' : '--';
      const askPriceCents = currentAsk ? Math.round(currentAsk * 100) + 'c' : '--';

      // US-823: Get spread color class (green for tight spread, yellow/red for wide)
      const spreadColorClass = spread !== null
        ? spread <= 0.02 ? 'spread-green' : spread <= 0.05 ? 'spread-yellow' : 'spread-red'
        : '';

      return \`
        <div class="order-book-info">
          <div class="order-book-info-item">
            <span class="order-book-info-label">Bid</span>
            <span class="order-book-info-value \${spreadColorClass}">\${bidPriceCents}</span>
          </div>
          <div class="order-book-info-item">
            <span class="order-book-info-label">Ask</span>
            <span class="order-book-info-value \${spreadColorClass}">\${askPriceCents}</span>
          </div>
          <div class="order-book-info-item">
            <span class="order-book-info-label">Spread</span>
            <span class="order-book-info-value \${spreadColorClass}">\${spreadCents}</span>
          </div>
          <div class="order-book-info-item">
            <span class="order-book-info-label">Depth</span>
            <span class="order-book-info-value \${getDepthColorClass(bidDepth)}">\${formatDepth(bidDepth)}</span>
          </div>
          \${staleHtml}
        </div>
      \`;
    }

    // US-836: Create compact dual-outcome order book display for watching/pending-sell cards
    function createDualOrderBookInfoHtml(position) {
      // Skip for pending settlement (no active order books)
      if (position.isPendingSettlement) return '';

      const isStale = isOrderBookStale(position.orderBookLastUpdate);
      const staleHtml = isStale ? '<span class="order-book-stale"><span class="order-book-stale-icon">⚠️</span>Stale</span>' : '';

      // Outcome 1 data
      const bid1 = position.outcome1.currentBid;
      const ask1 = position.outcome1.currentAsk;
      const spread1 = position.outcome1Spread;
      const bid1Cents = bid1 ? Math.round(bid1 * 100) + 'c' : '--';
      const ask1Cents = ask1 ? Math.round(ask1 * 100) + 'c' : '--';
      const spread1Cents = spread1 !== null ? (spread1 * 100).toFixed(1) + 'c' : '--';
      const spread1Class = spread1 !== null
        ? spread1 <= 0.02 ? 'spread-green' : spread1 <= 0.05 ? 'spread-yellow' : 'spread-red'
        : '';

      // Outcome 2 data
      const bid2 = position.outcome2.currentBid;
      const ask2 = position.outcome2.currentAsk;
      const spread2 = position.outcome2Spread;
      const bid2Cents = bid2 ? Math.round(bid2 * 100) + 'c' : '--';
      const ask2Cents = ask2 ? Math.round(ask2 * 100) + 'c' : '--';
      const spread2Cents = spread2 !== null ? (spread2 * 100).toFixed(1) + 'c' : '--';
      const spread2Class = spread2 !== null
        ? spread2 <= 0.02 ? 'spread-green' : spread2 <= 0.05 ? 'spread-yellow' : 'spread-red'
        : '';

      // Market depth (use outcome1's bid depth as market-wide proxy)
      const marketDepth = position.outcome1BidDepth || position.outcome2BidDepth;

      // Truncate outcome names if too long
      const name1 = position.outcome1.name.length > 12 ? position.outcome1.name.substring(0, 10) + '..' : position.outcome1.name;
      const name2 = position.outcome2.name.length > 12 ? position.outcome2.name.substring(0, 10) + '..' : position.outcome2.name;

      return \`
        <div class="dual-order-book-info">
          <div class="dual-order-book-row">
            <span class="dual-order-book-name">\${name1}:</span>
            <span class="dual-order-book-bid \${spread1Class}">\${bid1Cents} bid</span>
            <span class="dual-order-book-sep">|</span>
            <span class="dual-order-book-ask \${spread1Class}">\${ask1Cents} ask</span>
            <span class="dual-order-book-sep">|</span>
            <span class="dual-order-book-spread \${spread1Class}">\${spread1Cents} spread</span>
          </div>
          <div class="dual-order-book-row">
            <span class="dual-order-book-name">\${name2}:</span>
            <span class="dual-order-book-bid \${spread2Class}">\${bid2Cents} bid</span>
            <span class="dual-order-book-sep">|</span>
            <span class="dual-order-book-ask \${spread2Class}">\${ask2Cents} ask</span>
            <span class="dual-order-book-sep">|</span>
            <span class="dual-order-book-spread \${spread2Class}">\${spread2Cents} spread</span>
          </div>
          <div class="dual-order-book-depth">
            <span class="dual-order-book-depth-label">Market Depth:</span>
            <span class="dual-order-book-depth-value \${getDepthColorClass(marketDepth)}">\${formatDepth(marketDepth)}</span>
            \${staleHtml}
          </div>
        </div>
      \`;
    }

    function formatPnL(value) {
      const num = parseFloat(value) || 0;
      const formatted = formatCurrency(value);
      return { text: formatted, class: num >= 0 ? 'positive' : 'negative' };
    }

    function getSportClass(sport) {
      const s = (sport || '').toLowerCase();
      if (s.includes('nhl')) return 'sport-nhl';
      if (s.includes('nba') || s.includes('basketball')) return 'sport-nba';
      if (s.includes('nfl')) return 'sport-nfl';
      if (s.includes('mlb')) return 'sport-mlb';
      return 'sport-default';
    }

    function getStatusClass(state) {
      const s = (state || '').toLowerCase();
      if (s.includes('holding')) return 'status-holding';
      if (s.includes('pending')) return 'status-pending';
      if (s.includes('sold')) return 'status-sold';
      if (s.includes('settled')) return 'status-settled';
      return '';
    }

    // US-800: Toggle section collapse
    function toggleSection(sectionId) {
      const section = document.getElementById(sectionId);
      if (section) {
        section.classList.toggle('collapsed');
        sectionCollapseState[sectionId] = section.classList.contains('collapsed');
      }
    }

    // US-800: Scroll to section when clicking stats bar item
    function scrollToSection(sectionId) {
      const section = document.getElementById(sectionId);
      if (section) {
        // Expand if collapsed
        if (section.classList.contains('collapsed')) {
          section.classList.remove('collapsed');
          sectionCollapseState[sectionId] = false;
        }
        section.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    }

    // US-800: Check if position is within 10c of sell threshold
    function isPendingSell(position) {
      const threshold = position.sellThreshold || 0.2;
      const price1 = position.outcome1.currentBid;
      const price2 = position.outcome2.currentBid;
      const lowerPrice = Math.min(price1, price2);
      // Within 10c (0.10) of threshold means lowerPrice - threshold <= 0.10
      // or lowerPrice <= threshold + 0.10
      return lowerPrice <= threshold + 0.10 && lowerPrice > 0;
    }

    // US-802: Calculate progress bar data for a single outcome
    // Progress: 0% at 50c, 100% at threshold
    // Color: green (0-60%) → yellow (60-80%) → red (80-100%)
    function calculateProgressBar(currentBid, threshold) {
      const startPrice = 0.50;
      const distanceFromStart = startPrice - currentBid;
      const totalRange = startPrice - threshold;

      // Calculate raw progress percentage
      let progressPct = (distanceFromStart / totalRange) * 100;

      // US-802: Edge case handling
      const isBelowThreshold = currentBid < threshold;
      const isAtThreshold = Math.abs(currentBid - threshold) < 0.005; // Within 0.5c

      // Cap progress at 100% but track if below threshold
      progressPct = Math.max(0, Math.min(100, progressPct));

      // US-802: Color transitions - green (0-60%) → yellow (60-80%) → red (80-100%)
      let colorClass = 'progress-green';
      let textColorClass = 'green';
      if (progressPct > 80 || isBelowThreshold || isAtThreshold) {
        colorClass = 'progress-red';
        textColorClass = 'red';
      } else if (progressPct > 60) {
        colorClass = 'progress-yellow';
        textColorClass = 'yellow';
      }

      // Calculate distance in cents
      const distanceCents = Math.round((currentBid - threshold) * 100);

      // US-802: Generate distance text with edge case handling
      let distanceText;
      if (isBelowThreshold) {
        distanceText = 'BELOW THRESHOLD';
      } else if (isAtThreshold) {
        distanceText = 'AT THRESHOLD!';
      } else {
        distanceText = distanceCents + 'c away from SELL';
      }

      return {
        progressPct,
        colorClass,
        textColorClass,
        distanceCents,
        distanceText,
        isBelowThreshold,
        isAtThreshold,
        currentPriceCents: Math.round(currentBid * 100)
      };
    }

    // US-802: Create enhanced progress bar HTML for an outcome
    function createThresholdProgressBar(outcome, currentBid, threshold, showHeader = true) {
      const pb = calculateProgressBar(currentBid, threshold);
      const thresholdCents = Math.round(threshold * 100);

      // Distance text styling based on state
      let distanceClass = 'progress-text-distance ' + pb.textColorClass;
      if (pb.isAtThreshold) {
        distanceClass = 'progress-at-threshold';
      } else if (pb.isBelowThreshold) {
        distanceClass = 'progress-below-threshold';
      }

      return \`
        <div class="threshold-progress-row">
          \${showHeader ? \`
            <div class="threshold-progress-header">
              <span class="threshold-progress-outcome">\${outcome.name}</span>
              <span class="threshold-progress-price \${pb.textColorClass}">\${pb.currentPriceCents}c</span>
            </div>
          \` : ''}
          <div class="progress-bar">
            <div class="progress-fill \${pb.colorClass}" style="width: \${pb.progressPct}%"></div>
            <div class="threshold-marker"></div>
            <div class="progress-price-indicator \${pb.textColorClass}" style="left: \${pb.progressPct}%">\${pb.currentPriceCents}c</div>
          </div>
          <div class="progress-text">
            <span class="\${distanceClass}">\${pb.distanceText}</span>
            <span class="progress-text-threshold">Threshold: \${thresholdCents}c</span>
          </div>
        </div>
      \`;
    }

    // US-800: Create position card HTML
    function createPositionCard(p, section) {
      const threshold = p.sellThreshold || 0.2;
      const price1 = p.outcome1.currentBid;
      const price2 = p.outcome2.currentBid;
      const lowerPrice = Math.min(price1, price2);
      const lowerSide = price1 <= price2 ? p.outcome1 : p.outcome2;
      const higherSide = price1 > price2 ? p.outcome1 : p.outcome2;

      // US-802: Calculate progress bar data for lower side
      const lowerPb = calculateProgressBar(lowerPrice, threshold);
      const distanceToCents = lowerPb.distanceCents.toString();

      // Calculate unrealized P&L
      const pnl = formatPnL(p.unrealizedPnL);

      // Format game name from slug
      const gameName = formatGameName(p.marketSlug);
      // US-825: Polymarket link
      const polymarketLink = createPolymarketLinkHtml(p.marketSlug);

      if (section === 'pending-sells') {
        // US-801: Urgency level calculation
        // Green: >5c from threshold, Yellow: ≤5c, Red: ≤2c
        const distanceCents = parseFloat(distanceToCents);
        let urgencyLevel = 'green';
        let urgencyText = distanceCents + 'c away';
        if (distanceCents <= 2) {
          urgencyLevel = 'red';
          urgencyText = 'ONLY ' + distanceCents + 'c AWAY!';
        } else if (distanceCents <= 5) {
          urgencyLevel = 'yellow';
          urgencyText = 'ONLY ' + distanceCents + 'c AWAY!';
        }
        // US-802: Handle at/below threshold edge cases
        if (lowerPb.isAtThreshold) {
          urgencyLevel = 'red';
          urgencyText = 'AT THRESHOLD!';
        } else if (lowerPb.isBelowThreshold) {
          urgencyLevel = 'red';
          urgencyText = 'BELOW THRESHOLD!';
        }

        // US-801 + US-802 + US-806: Enhanced pending sells card with urgency indicators, progress bar, and last update
        const lastUpdateHtml = getLastUpdateHtml(p.marketSlug);
        return \`
          <div class="position-card urgency-\${urgencyLevel}" data-market-slug="\${p.marketSlug}" data-section="pending-sells">
            <div class="position-card-header">
              <div class="position-card-title">
                <span class="sport-badge \${getSportClass(p.sport)}">\${p.sport}</span>
                <span>\${gameName}</span>
                \${polymarketLink}
              </div>
              <span class="position-card-meta">\${p.elapsedMinutes}m ago</span>
            </div>
            <div class="position-card-body">
              <div class="approaching-side">
                <div class="approaching-side-header">Side Approaching Threshold</div>
                <div style="display: flex; justify-content: space-between; align-items: center;">
                  <div>
                    <div class="outcome-name">\${lowerSide.name}</div>
                    <div class="approaching-side-price \${urgencyLevel}">\${(lowerPrice * 100).toFixed(0)}c</div>
                  </div>
                  <div style="text-align: right;">
                    <div class="distance-badge \${urgencyLevel}">\${urgencyText}</div>
                    <div class="threshold-label">Threshold: \${(threshold * 100).toFixed(0)}c</div>
                  </div>
                </div>
              </div>
              <div class="threshold-progress-container">
                \${createThresholdProgressBar(lowerSide, lowerPrice, threshold, false)}
              </div>
              \${createDualOrderBookInfoHtml(p)}
              \${lastUpdateHtml}
            </div>
          </div>
        \`;
      } else if (section === 'watching') {
        // US-803: Enhanced watching card with large prices, both outcomes, and progress bars
        // Highlight the side CLOSER to threshold (potential loser)
        const isOutcome1Closer = price1 <= price2;

        // Calculate progress bars for both outcomes
        const pb1 = calculateProgressBar(price1, threshold);
        const pb2 = calculateProgressBar(price2, threshold);

        // Get border color based on closer side's urgency
        const borderColor = lowerPb.textColorClass === 'red' ? '#ef4444' : lowerPb.textColorClass === 'yellow' ? '#eab308' : '#22c55e';

        // US-806: Add last update timestamp HTML
        const lastUpdateHtml = getLastUpdateHtml(p.marketSlug);
        return \`
          <div class="position-card" data-market-slug="\${p.marketSlug}" data-section="watching">
            <div class="position-card-header">
              <div class="position-card-title">
                <span class="sport-badge \${getSportClass(p.sport)}">\${p.sport}</span>
                <span>\${gameName}</span>
                \${polymarketLink}
              </div>
              <span class="position-card-meta">\${p.elapsedMinutes}m | \${formatCurrencyCompact(p.splitCost)}</span>
            </div>
            <div class="position-card-body">
              <!-- US-803: Outcome 1 with large price display -->
              <div class="watching-outcome\${isOutcome1Closer ? ' closer-to-threshold' : ''}" style="\${isOutcome1Closer ? 'border-left-color: ' + borderColor : ''}">
                <div class="watching-outcome-header">
                  <span class="watching-outcome-name">\${p.outcome1.name}</span>
                  <span class="watching-outcome-price \${pb1.textColorClass}" data-outcome="1" data-price="\${price1}">\${pb1.currentPriceCents}c</span>
                </div>
                <div class="progress-bar">
                  <div class="progress-fill \${pb1.colorClass}" style="width: \${pb1.progressPct}%"></div>
                  <div class="threshold-marker"></div>
                </div>
                <div class="progress-text">
                  <span class="progress-text-distance \${pb1.textColorClass}">\${pb1.distanceText}</span>
                  <span class="progress-text-threshold">Threshold: \${Math.round(threshold * 100)}c</span>
                </div>
              </div>

              <!-- US-803: Outcome 2 with large price display -->
              <div class="watching-outcome\${!isOutcome1Closer ? ' closer-to-threshold' : ''}" style="\${!isOutcome1Closer ? 'border-left-color: ' + borderColor : ''}">
                <div class="watching-outcome-header">
                  <span class="watching-outcome-name">\${p.outcome2.name}</span>
                  <span class="watching-outcome-price \${pb2.textColorClass}" data-outcome="2" data-price="\${price2}">\${pb2.currentPriceCents}c</span>
                </div>
                <div class="progress-bar">
                  <div class="progress-fill \${pb2.colorClass}" style="width: \${pb2.progressPct}%"></div>
                  <div class="threshold-marker"></div>
                </div>
                <div class="progress-text">
                  <span class="progress-text-distance \${pb2.textColorClass}">\${pb2.distanceText}</span>
                  <span class="progress-text-threshold">Threshold: \${Math.round(threshold * 100)}c</span>
                </div>
              </div>

              <div class="pnl-display">
                <span class="pnl-label">Sell at \${(threshold * 100).toFixed(0)}c | Unrealized</span>
                <span class="pnl-value \${pnl.class}">\${pnl.text}</span>
              </div>
              \${createDualOrderBookInfoHtml(p)}
              \${lastUpdateHtml}
            </div>
          </div>
        \`;
      } else if (section === 'holding-winners') {
        // US-804: Enhanced holding winners card with detailed P&L breakdown
        // Show winner side (held) and sold side info
        const heldSide = !p.outcome1.sold ? p.outcome1 : p.outcome2;
        const soldSide = p.outcome1.sold ? p.outcome1 : p.outcome2;
        const heldPrice = !p.outcome1.sold ? price1 : price2;
        const heldValue = heldSide.shares * heldPrice;
        // Projected P&L = soldRevenue + (shares * $1.00 settlement) - splitCost
        const projectedPnL = (soldSide.soldRevenue || 0) + heldSide.shares - p.splitCost;
        const projectedPnLFormatted = formatPnL(projectedPnL);

        // US-806: Add last update timestamp HTML
        const lastUpdateHtml = getLastUpdateHtml(p.marketSlug);
        return \`
          <div class="position-card holding-winner-card" data-market-slug="\${p.marketSlug}" data-projected-pnl="\${projectedPnL}" data-section="holding-winners">
            <div class="position-card-header">
              <div class="position-card-title">
                <span class="sport-badge \${getSportClass(p.sport)}">\${p.sport}</span>
                <span class="winner-game-name">✅ \${gameName}</span>
                \${polymarketLink}
              </div>
              <span class="position-card-meta">\${p.elapsedMinutes}m ago</span>
            </div>
            <div class="position-card-body">
              <!-- US-804: Winner info section - held side with real-time price -->
              <div class="winner-section">
                <div class="winner-section-header">
                  <span class="winner-section-icon">🏆</span>
                  <span class="winner-section-label">HOLDING (Winner)</span>
                </div>
                <div class="winner-details">
                  <div class="winner-name">\${heldSide.name}</div>
                  <div class="winner-stats">
                    <span class="winner-price" data-outcome="\${!p.outcome1.sold ? '1' : '2'}" data-price="\${heldPrice}">\${(heldPrice * 100).toFixed(0)}c</span>
                    <span class="winner-shares">×\${heldSide.shares} shares</span>
                  </div>
                  <div class="winner-value">
                    <span class="winner-value-label">Current Value:</span>
                    <span class="winner-value-amount">\${formatCurrency(heldValue)}</span>
                  </div>
                </div>
              </div>

              <!-- US-804: Loser info section - sold side with static price/revenue -->
              <div class="loser-section">
                <div class="loser-section-header">
                  <span class="loser-section-label">SOLD (Loser)</span>
                </div>
                <div class="loser-details">
                  <span class="loser-name">\${soldSide.name}</span>
                  <span class="loser-sale-info">@ \${((soldSide.soldPrice || 0) * 100).toFixed(0)}c → \${formatCurrency(soldSide.soldRevenue || 0)}</span>
                </div>
              </div>

              <!-- US-804: P&L Summary section -->
              <div class="pnl-summary">
                <div class="pnl-summary-header">P&L Breakdown</div>
                <div class="pnl-row">
                  <span class="pnl-row-label">Split Cost:</span>
                  <span class="pnl-row-value negative">-\${formatCurrency(p.splitCost)}</span>
                </div>
                <div class="pnl-row">
                  <span class="pnl-row-label">Sold Revenue:</span>
                  <span class="pnl-row-value positive">+\${formatCurrency(soldSide.soldRevenue || 0)}</span>
                </div>
                <div class="pnl-row">
                  <span class="pnl-row-label">Winner Value (if wins):</span>
                  <span class="pnl-row-value positive">+$\${heldSide.shares.toFixed(2)}</span>
                </div>
                <div class="pnl-row pnl-row-total">
                  <span class="pnl-row-label">Projected P&L:</span>
                  <span class="pnl-row-value \${projectedPnLFormatted.class}">\${projectedPnLFormatted.text}</span>
                </div>
              </div>
              \${createOrderBookInfoHtml(p, !p.outcome1.sold ? 'outcome1' : 'outcome2')}
              \${lastUpdateHtml}
            </div>
          </div>
        \`;
      } else if (section === 'pending-settlement') {
        // US-813: Pending Settlement card for positions awaiting redemption
        const heldSide = !p.outcome1.sold ? p.outcome1 : p.outcome2;
        const soldSide = p.outcome1.sold ? p.outcome1 : p.outcome2;
        const winningOutcomeName = p.winningOutcome || (heldSide.name);

        // Calculate time since game ended
        const gameEndedAt = p.gameEndedAt ? new Date(p.gameEndedAt).getTime() : Date.now();
        const timeSinceEndedMs = Date.now() - gameEndedAt;
        const timeSinceEndedMins = Math.floor(timeSinceEndedMs / 60000);
        const isDelayed = timeSinceEndedMs > 60 * 60 * 1000; // >1 hour

        // Format time since ended
        let timeSinceText = '';
        if (timeSinceEndedMins < 60) {
          timeSinceText = timeSinceEndedMins + 'm ago';
        } else {
          const hours = Math.floor(timeSinceEndedMins / 60);
          const mins = timeSinceEndedMins % 60;
          timeSinceText = hours + 'h ' + mins + 'm ago';
        }

        // P&L calculation
        const soldRevenue = soldSide.soldRevenue || 0;
        const expectedSettlement = heldSide.shares;  // $1 per share
        const projectedPnL = soldRevenue + expectedSettlement - p.splitCost;
        const projectedPnLFormatted = formatPnL(projectedPnL);

        // Check if loser side was NOT sold (unsold loser)
        const hasUnsoldLoser = p.hasUnsoldShares && p.unsoldOutcome;
        const unsoldInfo = hasUnsoldLoser
          ? 'Unsold: ' + p.unsoldOutcome + ' @ ' + ((p.unsoldCurrentBid || 0) * 100).toFixed(0) + 'c'
          : 'Sold: ' + soldSide.name + ' @ ' + ((soldSide.soldPrice || 0) * 100).toFixed(0) + 'c → ' + formatCurrency(soldRevenue);

        // US-814: Force Sell button data for LOSER
        // Determine which outcomeIndex corresponds to the unsold loser
        const unsoldOutcomeIndex = p.unsoldOutcome === p.outcome1.name ? 0 : 1;
        const unsoldShares = p.unsoldShares || 0;
        const unsoldBidCents = ((p.unsoldCurrentBid || 0) * 100).toFixed(0);
        const expectedRevenue = (unsoldShares * (p.unsoldCurrentBid || 0)).toFixed(2);
        const forceSellBtnHtml = hasUnsoldLoser ? \`
          <button class="force-sell-btn" onclick="openForceSellModal('\${p.marketSlug}', \${unsoldOutcomeIndex}, '\${p.unsoldOutcome}', \${unsoldShares}, \${p.unsoldCurrentBid || 0})">
            Sell \${p.unsoldOutcome} @ \${unsoldBidCents}c
          </button>
        \` : '';

        // US-824: Force Sell Winner button data
        const winnerOutcomeIndex = !p.outcome1.sold ? 0 : 1;
        const winnerShares = heldSide.shares || 0;
        const winnerBid = heldSide.currentBid || 0.99; // Default to 99c if no price (near settlement)
        const winnerBidCents = (winnerBid * 100).toFixed(0);
        const hasWinnerShares = winnerShares > 0;
        const forceSellWinnerBtnHtml = hasWinnerShares ? \`
          <button class="force-sell-winner-btn" onclick="openForceSellWinnerModal('\${p.marketSlug}', \${winnerOutcomeIndex}, '\${winningOutcomeName}', \${winnerShares}, \${winnerBid})">
            ⚡ Sell @ \${winnerBidCents}c
          </button>
        \` : '';

        // Status text
        const statusText = isDelayed ? 'Settlement Delayed' : 'Awaiting Settlement';
        const statusClass = isDelayed ? 'delayed' : 'awaiting';

        return \`
          <div class="position-card pending-settlement-card \${isDelayed ? 'settlement-delayed' : ''}" data-market-slug="\${p.marketSlug}" data-section="pending-settlement">
            <div class="position-card-header">
              <div class="position-card-title">
                <span class="sport-badge \${getSportClass(p.sport)}">\${p.sport}</span>
                <span class="settlement-game-name">⏳ \${gameName}</span>
                \${polymarketLink}
              </div>
              <div class="settlement-status \${statusClass}">
                <span class="settlement-status-icon">\${isDelayed ? '⚠️' : '⏳'}</span>
                <span>\${statusText}</span>
              </div>
            </div>
            <div class="position-card-body">
              <!-- Winner info section -->
              <div class="winner-section" style="border-color: #6b7280; background: rgba(107, 114, 128, 0.1);">
                <div class="winner-section-header">
                  <span class="winner-section-icon">🏆</span>
                  <span class="winner-section-label" style="color: #6b7280;">WINNER (Settled @ $1)</span>
                </div>
                <div class="winner-details">
                  <div class="winner-name">\${winningOutcomeName}</div>
                  <div class="winner-stats">
                    <span class="winner-price" style="background: rgba(107, 114, 128, 0.2); color: #9ca3af;">\${winnerBidCents}c</span>
                    <span class="winner-shares">×\${heldSide.shares} shares</span>
                  </div>
                  \${forceSellWinnerBtnHtml}
                </div>
              </div>

              <!-- Loser info section -->
              <div class="loser-section">
                <div class="loser-section-header">
                  <span class="loser-section-label">\${hasUnsoldLoser ? 'UNSOLD (Loser)' : 'SOLD (Loser)'}</span>
                </div>
                <div class="loser-details">
                  <span class="loser-sale-info">\${unsoldInfo}</span>
                  \${forceSellBtnHtml}
                </div>
              </div>

              <!-- Time since game ended -->
              <div style="font-size: 11px; color: \${isDelayed ? '#f59e0b' : '#6b7280'}; margin-bottom: 8px;">
                Game ended: \${timeSinceText}\${isDelayed ? ' ⚠️' : ''}
              </div>

              <!-- P&L Summary -->
              <div class="pnl-summary">
                <div class="pnl-summary-header">P&L Summary</div>
                <div class="pnl-row">
                  <span class="pnl-row-label">Split Cost:</span>
                  <span class="pnl-row-value negative">-\${formatCurrency(p.splitCost)}</span>
                </div>
                <div class="pnl-row">
                  <span class="pnl-row-label">\${hasUnsoldLoser ? 'Loser Value:' : 'Sold Revenue:'}</span>
                  <span class="pnl-row-value positive">+\${formatCurrency(hasUnsoldLoser ? 0 : soldRevenue)}</span>
                </div>
                <div class="pnl-row">
                  <span class="pnl-row-label">Expected Redemption:</span>
                  <span class="pnl-row-value positive">+$\${expectedSettlement.toFixed(2)}</span>
                </div>
                <div class="pnl-row pnl-row-total">
                  <span class="pnl-row-label">Projected P&L:</span>
                  <span class="pnl-row-value \${projectedPnLFormatted.class}">\${projectedPnLFormatted.text}</span>
                </div>
              </div>
            </div>
          </div>
        \`;
      }

      return '';
    }

    // Format game name from slug (e.g., "nhl-sea-ana-2026-02-03" -> "SEA vs ANA")
    function formatGameName(slug) {
      const parts = slug.split('-');
      if (parts.length >= 3) {
        return parts[1].toUpperCase() + ' vs ' + parts[2].toUpperCase();
      }
      return slug.substring(0, 20);
    }

    // US-825: Create Polymarket link HTML
    function createPolymarketLinkHtml(marketSlug) {
      if (!marketSlug) return '';
      // URL format: https://polymarket.com/event/{eventSlug}
      // The eventSlug is the same as marketSlug for sports markets
      const url = 'https://polymarket.com/event/' + encodeURIComponent(marketSlug);
      return '<a href="' + url + '" target="_blank" rel="noopener noreferrer" class="polymarket-link" title="View on Polymarket">🔗</a>';
    }

    // US-800: Update positions with section-based layout
    function updatePositions(positions) {
      // US-803: Check for price changes and apply flash animations
      checkPriceChanges(positions);

      const activePositions = positions.filter(p => !p.state.toLowerCase().includes('settled'));

      // Categorize positions into sections
      const holdingPositions = activePositions.filter(p => p.state.toLowerCase() === 'holding' && !p.outcome1.sold && !p.outcome2.sold);
      const partialSoldPositions = activePositions.filter(p => p.state.toLowerCase() === 'partial_sold' || (p.outcome1.sold !== p.outcome2.sold));
      // US-813: Pending settlement positions (game ended, awaiting redemption)
      const pendingSettlementPositions = positions.filter(p => p.isPendingSettlement);

      // Pending sells: within 10c of threshold (from holding positions)
      const pendingSells = holdingPositions.filter(p => isPendingSell(p));
      // Watching: holding positions NOT within 10c of threshold
      const watching = holdingPositions.filter(p => !isPendingSell(p));
      // Holding winners: partial_sold positions (excluding pending settlement)
      const holdingWinners = partialSoldPositions.filter(p => !p.isPendingSettlement);

      // Update stats bar
      document.getElementById('stat-pending-sell').textContent = pendingSells.length;
      document.getElementById('stat-watching').textContent = watching.length;
      document.getElementById('stat-holding-winners').textContent = holdingWinners.length;

      // Calculate deployed capital
      const deployedCapital = activePositions.reduce((sum, p) => sum + p.splitCost, 0);
      document.getElementById('stat-deployed').textContent = formatCurrencyCompact(deployedCapital);

      // Calculate projected P&L (from holding winners)
      const projectedPnL = holdingWinners.reduce((sum, p) => {
        const heldSide = !p.outcome1.sold ? p.outcome1 : p.outcome2;
        const soldSide = p.outcome1.sold ? p.outcome1 : p.outcome2;
        return sum + ((soldSide.soldRevenue || 0) + heldSide.shares - p.splitCost);
      }, 0);
      const projectedPnLEl = document.getElementById('stat-projected-pnl');
      projectedPnLEl.textContent = formatCurrencyCompact(projectedPnL);
      projectedPnLEl.className = 'stat-item-value ' + (projectedPnL >= 0 ? 'positive' : 'negative');

      // Update section counts
      document.getElementById('pending-sells-count').textContent = pendingSells.length;
      document.getElementById('watching-count').textContent = watching.length;
      document.getElementById('holding-winners-count').textContent = holdingWinners.length;
      document.getElementById('pending-settlement-count').textContent = pendingSettlementPositions.length;

      // Update Pending Sells section
      const pendingSellsCards = document.getElementById('pending-sells-cards');
      if (pendingSells.length === 0) {
        pendingSellsCards.innerHTML = '<div class="section-empty">No positions approaching sell threshold</div>';
      } else {
        // Sort by closest to threshold (most urgent first)
        pendingSells.sort((a, b) => {
          const aLower = Math.min(a.outcome1.currentBid, a.outcome2.currentBid);
          const bLower = Math.min(b.outcome1.currentBid, b.outcome2.currentBid);
          return aLower - bLower;
        });
        pendingSellsCards.innerHTML = pendingSells.map(p => createPositionCard(p, 'pending-sells')).join('');
      }

      // US-803: Update Watching section with sorting
      const watchingCards = document.getElementById('watching-cards');
      const watchingSortBar = document.getElementById('watching-sort-bar');

      if (watching.length === 0) {
        watchingCards.innerHTML = '<div class="section-empty">No positions being watched</div>';
        if (watchingSortBar) watchingSortBar.style.display = 'none';
      } else {
        // Show sort bar when there are positions
        if (watchingSortBar) watchingSortBar.style.display = 'flex';

        // US-803: Apply sorting based on selected sort option
        const sortSelect = document.getElementById('watching-sort');
        const sortBy = sortSelect ? sortSelect.value : 'threshold';

        watching.sort((a, b) => {
          if (sortBy === 'threshold') {
            // Sort by closest to threshold (most urgent first)
            const aLower = Math.min(a.outcome1.currentBid, a.outcome2.currentBid);
            const bLower = Math.min(b.outcome1.currentBid, b.outcome2.currentBid);
            return aLower - bLower;
          } else if (sortBy === 'time') {
            // Sort by entry time (newest first)
            return b.elapsedMinutes - a.elapsedMinutes;
          } else if (sortBy === 'sport') {
            // Sort by sport name alphabetically
            return (a.sport || '').localeCompare(b.sport || '');
          }
          return 0;
        });

        watchingCards.innerHTML = watching.map(p => createPositionCard(p, 'watching')).join('');
      }

      // US-804: Update Holding Winners section with sorting by projected P&L descending
      const holdingWinnersCards = document.getElementById('holding-winners-cards');
      if (holdingWinners.length === 0) {
        holdingWinnersCards.innerHTML = '<div class="section-empty">No winning positions held</div>';
      } else {
        // US-804: Sort by projected P&L descending (highest profit first)
        holdingWinners.sort((a, b) => {
          const aHeld = !a.outcome1.sold ? a.outcome1 : a.outcome2;
          const aSold = a.outcome1.sold ? a.outcome1 : a.outcome2;
          const aPnL = (aSold.soldRevenue || 0) + aHeld.shares - a.splitCost;

          const bHeld = !b.outcome1.sold ? b.outcome1 : b.outcome2;
          const bSold = b.outcome1.sold ? b.outcome1 : b.outcome2;
          const bPnL = (bSold.soldRevenue || 0) + bHeld.shares - b.splitCost;

          return bPnL - aPnL; // Descending order (highest first)
        });
        holdingWinnersCards.innerHTML = holdingWinners.map(p => createPositionCard(p, 'holding-winners')).join('');
      }

      // US-813: Update Pending Settlement section
      const pendingSettlementCards = document.getElementById('pending-settlement-cards');
      if (pendingSettlementPositions.length === 0) {
        pendingSettlementCards.innerHTML = '<div class="section-empty">No positions awaiting settlement</div>';
      } else {
        // Sort by gameEndedAt ascending (oldest/longest waiting first)
        pendingSettlementPositions.sort((a, b) => {
          const aTime = a.gameEndedAt ? new Date(a.gameEndedAt).getTime() : 0;
          const bTime = b.gameEndedAt ? new Date(b.gameEndedAt).getTime() : 0;
          return aTime - bTime;
        });
        pendingSettlementCards.innerHTML = pendingSettlementPositions.map(p => createPositionCard(p, 'pending-settlement')).join('');
      }
    }

    function updateStats(stats) {
      // US-800: Stats bar updates
      document.getElementById('stat-balance').textContent = formatCurrencyCompact(stats.currentBalance);
      const todayPnlEl = document.getElementById('stat-today-pnl');
      todayPnlEl.textContent = formatCurrencyCompact(stats.todayPnL);
      todayPnlEl.className = 'stat-item-value ' + ((stats.todayPnL || 0) >= 0 ? 'positive' : 'negative');

      // P&L summary
      const realized = formatPnL(stats.realizedPnL);
      const unrealized = formatPnL(stats.unrealizedPnL);
      const total = formatPnL(stats.totalPnL);
      const today = formatPnL(stats.todayPnL);
      const avg = formatPnL(stats.avgPnLPerPosition);

      document.getElementById('realized-pnl').textContent = realized.text;
      document.getElementById('realized-pnl').className = 'stat-value ' + realized.class;
      document.getElementById('unrealized-pnl').textContent = unrealized.text;
      document.getElementById('unrealized-pnl').className = 'stat-value ' + unrealized.class;
      document.getElementById('total-pnl-detail').textContent = total.text;
      document.getElementById('total-pnl-detail').className = 'stat-value ' + total.class;
      document.getElementById('today-pnl').textContent = today.text;
      document.getElementById('today-pnl').className = 'stat-value ' + today.class;
      document.getElementById('positions-settled').textContent = stats.positionsSettled || 0;
      document.getElementById('win-loss').textContent = (stats.winCount || 0) + ' / ' + (stats.lossCount || 0);
      document.getElementById('avg-pnl').textContent = avg.text;
      document.getElementById('avg-pnl').className = 'stat-value ' + avg.class;

      // Per-sport P&L
      const sportPnl = document.getElementById('sport-pnl');
      if (stats.bySport && Object.keys(stats.bySport).length > 0) {
        sportPnl.innerHTML = Object.entries(stats.bySport).map(([sport, data]) => {
          const pnl = formatPnL(data.realizedPnL + data.unrealizedPnL);
          return \`
            <div class="stat-row">
              <span><span class="sport-badge \${getSportClass(sport)}">\${sport}</span></span>
              <span class="stat-value \${pnl.class}">\${pnl.text} (\${data.positionsActive} active, \${data.positionsSettled} settled)</span>
            </div>
          \`;
        }).join('');
      } else {
        sportPnl.innerHTML = '<div style="text-align: center; color: #94a3b8;">No data</div>';
      }

      // US-826: Update wallet address display
      const walletDisplay = document.getElementById('wallet-display');
      const walletLink = document.getElementById('wallet-link');
      const walletAddressEl = document.getElementById('wallet-address');
      if (stats.walletAddress && walletDisplay && walletLink && walletAddressEl) {
        const addr = stats.walletAddress;
        // Truncate: first 6 + last 4 chars
        const truncated = addr.substring(0, 6) + '...' + addr.substring(addr.length - 4);
        walletAddressEl.textContent = truncated;
        walletLink.href = 'https://polygonscan.com/address/' + addr;
        walletLink.title = 'View on Polygonscan: ' + addr;
        walletDisplay.style.display = 'flex';
      }
    }

    function updateTrades(trades) {
      const table = document.getElementById('trades-table');
      document.getElementById('trades-count').textContent = trades.length + ' trades';

      if (trades.length === 0) {
        table.innerHTML = '<tr><td colspan="8" style="text-align: center; color: #94a3b8;">No trades yet</td></tr>';
        return;
      }

      table.innerHTML = trades.slice(0, 50).map(t => {
        const time = new Date(t.timestamp).toLocaleTimeString();
        const amount = t.action === 'SPLIT' ? '-' + formatCurrency(t.cost) : formatCurrency(t.revenue);
        return \`
          <tr>
            <td>\${time}</td>
            <td><span class="sport-badge \${getSportClass(t.sport)}">\${t.sport}</span></td>
            <td>\${(t.marketSlug || '').substring(0, 25)}...</td>
            <td>\${t.action}</td>
            <td>\${t.outcome || '-'}</td>
            <td>\${t.shares || '-'}</td>
            <td>\${t.price ? (t.price * 100).toFixed(1) + 'c' : '-'}</td>
            <td>\${amount}</td>
          </tr>
        \`;
      }).join('');
    }

    function addTrade(trade) {
      // For real-time trade updates, prepend to table
      const table = document.getElementById('trades-table');
      const firstRow = table.querySelector('tr');
      if (firstRow && firstRow.textContent.includes('No trades')) {
        table.innerHTML = '';
      }

      const time = new Date(trade.timestamp).toLocaleTimeString();
      const amount = trade.action === 'SPLIT' ? '-' + formatCurrency(trade.cost) : formatCurrency(trade.revenue);
      const row = document.createElement('tr');
      row.innerHTML = \`
        <td>\${time}</td>
        <td><span class="sport-badge \${getSportClass(trade.sport)}">\${trade.sport}</span></td>
        <td>\${(trade.marketSlug || '').substring(0, 25)}...</td>
        <td>\${trade.action}</td>
        <td>\${trade.outcome || '-'}</td>
        <td>\${trade.shares || '-'}</td>
        <td>\${trade.price ? (trade.price * 100).toFixed(1) + 'c' : '-'}</td>
        <td>\${amount}</td>
      \`;
      table.insertBefore(row, table.firstChild);

      // Keep only 50 rows
      while (table.children.length > 50) {
        table.removeChild(table.lastChild);
      }
    }

    // US-820: Market Health panel removed - order book info now shown on each game card
    // Keeping function as no-op to avoid breaking handleMessage
    function updateHealth(healthData) {
      // No-op: Market Health panel removed in US-820
    }

    // ============================================================================
    // UPCOMING GAMES (US-509)
    // ============================================================================

    let upcomingGamesData = [];
    let currentTimeHorizon = 24;
    let currentSportFilter = 'all'; // US-703: Sport filter state

    // US-703: Sport category mappings
    const sportCategories = {
      'nhl': ['NHL'],
      'nfl': ['NFL'],
      'nba': ['NBA', 'CBB'],
      'soccer': ['SOCCER', 'EPL', 'UCL', 'LAL', 'BUN', 'SEA', 'FL1', 'UEL']
    };

    // US-703: Initialize sport filter tabs from URL
    function initSportFilter() {
      const urlParams = new URLSearchParams(window.location.search);
      const sportParam = urlParams.get('sport');
      if (sportParam && ['all', 'nhl', 'nfl', 'nba', 'soccer'].includes(sportParam)) {
        currentSportFilter = sportParam;
      }

      // Set active tab
      document.querySelectorAll('.sport-tab').forEach(tab => {
        tab.classList.toggle('active', tab.dataset.sport === currentSportFilter);
      });

      // Add click listeners to tabs
      document.querySelectorAll('.sport-tab').forEach(tab => {
        tab.addEventListener('click', () => {
          currentSportFilter = tab.dataset.sport;
          // Update URL without reload
          const url = new URL(window.location);
          if (currentSportFilter === 'all') {
            url.searchParams.delete('sport');
          } else {
            url.searchParams.set('sport', currentSportFilter);
          }
          window.history.replaceState({}, '', url);
          // Update active state
          document.querySelectorAll('.sport-tab').forEach(t => {
            t.classList.toggle('active', t.dataset.sport === currentSportFilter);
          });
          // Re-render filtered games
          renderFilteredGames();
        });
      });
    }

    // US-703: Filter games by sport category
    function filterGamesBySport(games, filter) {
      if (filter === 'all') return games;
      const allowedSports = sportCategories[filter] || [];
      return games.filter(g => {
        const sportUpper = (g.sport || '').toUpperCase();
        return allowedSports.includes(sportUpper);
      });
    }

    // US-703: Update tab counts
    function updateTabCounts(games) {
      const counts = { all: games.length, nhl: 0, nfl: 0, nba: 0, soccer: 0 };
      games.forEach(g => {
        const sportUpper = (g.sport || '').toUpperCase();
        if (sportCategories.nhl.includes(sportUpper)) counts.nhl++;
        else if (sportCategories.nfl.includes(sportUpper)) counts.nfl++;
        else if (sportCategories.nba.includes(sportUpper)) counts.nba++;
        else if (sportCategories.soccer.includes(sportUpper)) counts.soccer++;
      });
      document.getElementById('count-all').textContent = counts.all;
      document.getElementById('count-nhl').textContent = counts.nhl;
      document.getElementById('count-nfl').textContent = counts.nfl;
      document.getElementById('count-nba').textContent = counts.nba;
      document.getElementById('count-soccer').textContent = counts.soccer;
    }

    // US-703: Render filtered games
    function renderFilteredGames() {
      const filtered = filterGamesBySport(upcomingGamesData, currentSportFilter);
      renderUpcomingGamesTable(filtered);
      document.getElementById('upcoming-count').textContent = filtered.length + ' games';
    }

    function getStatusBadge(status, hasPosition) {
      if (hasPosition) {
        return '<span class="status-badge status-entered">ENTERED</span>';
      }
      switch (status) {
        case 'scheduled':
          return '<span class="status-badge status-scheduled">SCHEDULED</span>';
        case 'entry_window':
          return '<span class="status-badge status-entry-open">ENTRY OPEN</span>';
        case 'live':
          return '<span class="status-badge status-live">LIVE</span>';
        case 'ended':
          return '<span class="status-badge status-ended">ENDED</span>';
        default:
          return '<span class="status-badge status-scheduled">' + status.toUpperCase() + '</span>';
      }
    }

    function formatVolume(volume) {
      if (volume >= 1000000) {
        return '$' + (volume / 1000000).toFixed(1) + 'M';
      } else if (volume >= 1000) {
        return '$' + (volume / 1000).toFixed(0) + 'K';
      } else {
        return '$' + volume.toFixed(0);
      }
    }

    function formatPrice(yes, no) {
      const yesCents = (yes * 100).toFixed(0);
      const noCents = (no * 100).toFixed(0);
      const isBalanced = yes >= 0.45 && yes <= 0.55 && no >= 0.45 && no <= 0.55;
      const priceClass = isBalanced ? 'price-balanced' : 'price-unbalanced';
      return '<span class="' + priceClass + '">YES: ' + yesCents + 'c | NO: ' + noCents + 'c</span>';
    }

    function formatTimer(gameStartTime, status) {
      const now = new Date();
      const start = new Date(gameStartTime);
      const diffMs = start - now;
      const diffMins = diffMs / (1000 * 60);

      if (status === 'ended') {
        return '<span class="timer-countdown">Ended</span>';
      }

      if (diffMs > 0) {
        // Before game start
        if (diffMins > 60) {
          const hours = Math.floor(diffMins / 60);
          const mins = Math.floor(diffMins % 60);
          return '<span class="timer-countdown">Starts in ' + hours + 'h ' + mins + 'm</span>';
        } else {
          const mins = Math.floor(diffMins);
          const secs = Math.floor((diffMs / 1000) % 60);
          return '<span class="timer-countdown">' + mins + 'm ' + secs + 's</span>';
        }
      } else {
        // After game start
        const elapsedMins = Math.abs(diffMins);
        if (elapsedMins <= 10) {
          // Entry window (first 10 minutes)
          const remaining = 10 - elapsedMins;
          const mins = Math.floor(remaining);
          const secs = Math.floor((remaining - mins) * 60);
          return '<span class="timer-entry">Entry closes in ' + mins + 'm ' + secs + 's</span>';
        } else {
          // Live game
          const hours = Math.floor(elapsedMins / 60);
          const mins = Math.floor(elapsedMins % 60);
          if (hours > 0) {
            return '<span class="timer-live">LIVE ' + hours + 'h ' + mins + 'm</span>';
          }
          return '<span class="timer-live">LIVE ' + mins + 'm</span>';
        }
      }
    }

    function updateUpcomingGames(games) {
      upcomingGamesData = games || [];
      // US-703: Update tab counts with ALL games, then render filtered
      updateTabCounts(upcomingGamesData);
      renderFilteredGames();
    }

    // US-703: Render table with given games (may be filtered)
    function renderUpcomingGamesTable(games) {
      const table = document.getElementById('upcoming-games-table');

      if (games.length === 0) {
        // US-703: Sport-specific empty message
        const sportName = currentSportFilter === 'all' ? '' : currentSportFilter.toUpperCase() + ' ';
        table.innerHTML = '<tr><td colspan="7" style="text-align: center; color: #94a3b8;">No upcoming ' + sportName + 'games in next ' + currentTimeHorizon + 'h</td></tr>';
        return;
      }

      table.innerHTML = games.map(g => {
        const teams = g.teams.away + ' vs ' + g.teams.home;
        const priceHtml = formatPrice(g.prices.yes, g.prices.no);
        const volumeHtml = '<span class="volume-badge">' + formatVolume(g.volume) + '</span>';
        // Calculate initial status based on current time (may differ from API status)
        const currentStatus = calculateStatus(g.gameStartTime, g.status);
        const statusHtml = getStatusBadge(currentStatus, g.hasPosition);
        const timerHtml = formatTimer(g.gameStartTime, currentStatus);
        const linkHtml = '<a href="' + g.polymarketUrl + '" target="_blank" class="external-link" title="View on Polymarket">🔗</a>';

        // Force Entry button (US-511) - Paper mode only, hidden if already have position
        let forceEntryBtn = '';
        if (isPaperMode && !g.hasPosition) {
          forceEntryBtn = '<button class="force-entry-btn" onclick="openForceEntryModal(\\'' + g.marketSlug + '\\', \\'' + teams.replace(/'/g, "\\\\'") + '\\')">Split</button>';
        } else if (isPaperMode && g.hasPosition) {
          forceEntryBtn = '<button class="force-entry-btn" disabled title="Position exists">Split</button>';
        }

        // US-703: Show league badge for soccer markets
        const sportBadge = g.leaguePrefix
          ? '<span class="sport-badge ' + getSportClass(g.sport) + '" title="' + g.sport + '">' + g.leaguePrefix + '</span>'
          : '<span class="sport-badge ' + getSportClass(g.sport) + '">' + g.sport + '</span>';

        return \`
          <tr data-market-slug="\${g.marketSlug}" data-has-position="\${g.hasPosition}" data-sport="\${g.sport}">
            <td>\${sportBadge}</td>
            <td>\${teams}</td>
            <td>\${priceHtml}</td>
            <td>\${volumeHtml}</td>
            <td data-status-cell>\${statusHtml}</td>
            <td data-start-time="\${g.gameStartTime}" data-status="\${currentStatus}">\${timerHtml}</td>
            <td>\${forceEntryBtn}\${linkHtml}</td>
          </tr>
        \`;
      }).join('');
    }

    // Calculate current status based on game start time (client-side)
    function calculateStatus(gameStartTime, originalStatus) {
      if (originalStatus === 'ended') return 'ended';

      const now = new Date();
      const start = new Date(gameStartTime);
      const diffMs = start - now;
      const diffMins = diffMs / (1000 * 60);

      if (diffMs > 0) {
        return 'scheduled';
      } else {
        const elapsedMins = Math.abs(diffMins);
        if (elapsedMins <= 10) {
          return 'entry_window';
        } else {
          return 'live';
        }
      }
    }

    // Update timers and status badges every second (client-side for responsiveness)
    function updateTimers() {
      const rows = document.querySelectorAll('#upcoming-games-table tr[data-market-slug]');
      rows.forEach(row => {
        const timerCell = row.querySelector('td[data-start-time]');
        const statusCell = row.querySelector('td[data-status-cell]');
        const startTime = timerCell ? timerCell.getAttribute('data-start-time') : null;
        const originalStatus = timerCell ? timerCell.getAttribute('data-status') : null;
        const hasPosition = row.getAttribute('data-has-position') === 'true';

        if (startTime && timerCell) {
          // Calculate new status based on current time
          const newStatus = calculateStatus(startTime, originalStatus);

          // Update timer display
          timerCell.innerHTML = formatTimer(startTime, newStatus);
          timerCell.setAttribute('data-status', newStatus);

          // Update status badge if status changed
          if (statusCell && originalStatus !== newStatus) {
            statusCell.innerHTML = getStatusBadge(newStatus, hasPosition);
          }
        }
      });
    }

    // Fetch upcoming games from API
    async function fetchUpcomingGames() {
      try {
        const res = await fetch('/api/upcoming-games?hours=' + currentTimeHorizon);
        const data = await res.json();
        updateUpcomingGames(data.games || []);
      } catch (err) {
        console.error('Failed to fetch upcoming games:', err);
      }
    }

    // Handle time horizon change
    function setupTimeHorizonSelector() {
      const selector = document.getElementById('time-horizon');
      if (selector) {
        selector.addEventListener('change', (e) => {
          currentTimeHorizon = parseInt(e.target.value, 10);
          fetchUpcomingGames();
        });
      }
    }

    // Refresh upcoming games every 5 minutes (300000 ms)
    let upcomingGamesInterval = null;
    function startUpcomingGamesRefresh() {
      fetchUpcomingGames();
      upcomingGamesInterval = setInterval(fetchUpcomingGames, 300000);
    }

    // ============================================================================
    // FORCE ENTRY (US-511) - Paper Trading Only
    // ============================================================================

    const isPaperMode = ${this.config.mode === "PAPER"};
    let pendingForceEntrySlug = null;
    let pendingForceEntryTeams = null;

    function openForceEntryModal(marketSlug, teams) {
      if (!isPaperMode) return;
      pendingForceEntrySlug = marketSlug;
      pendingForceEntryTeams = teams;
      document.getElementById('modal-market-info').textContent = 'Split on ' + teams + '?';
      document.getElementById('bet-size-input').value = '10';
      document.getElementById('force-entry-modal').classList.add('active');
    }

    function closeForceEntryModal() {
      document.getElementById('force-entry-modal').classList.remove('active');
      pendingForceEntrySlug = null;
      pendingForceEntryTeams = null;
    }

    async function confirmForceEntry() {
      if (!pendingForceEntrySlug) return;

      const betSize = parseFloat(document.getElementById('bet-size-input').value);
      if (isNaN(betSize) || betSize <= 0) {
        showToast('Invalid bet size', 'error');
        return;
      }

      try {
        const res = await fetch('/api/force-entry', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ marketSlug: pendingForceEntrySlug, betSize })
        });
        const result = await res.json();

        if (result.success) {
          showToast('Entry successful: $' + result.position.cost + ' split', 'success');
          // Refresh upcoming games to update hasPosition
          fetchUpcomingGames();
        } else {
          showToast('Entry failed: ' + (result.error || 'Unknown error'), 'error');
        }
      } catch (err) {
        showToast('Entry failed: ' + err.message, 'error');
      }

      closeForceEntryModal();
    }

    // US-814: Force Sell modal functions
    let pendingForceSellSlug = null;
    let pendingForceSellOutcomeIndex = null;
    let pendingForceSellOutcome = null;
    let pendingForceSellShares = null;
    let pendingForceSellBid = null;

    function openForceSellModal(marketSlug, outcomeIndex, outcomeName, shares, bidPrice) {
      pendingForceSellSlug = marketSlug;
      pendingForceSellOutcomeIndex = outcomeIndex;
      pendingForceSellOutcome = outcomeName;
      pendingForceSellShares = shares;
      pendingForceSellBid = bidPrice;

      const bidCents = (bidPrice * 100).toFixed(0);
      const expectedRevenue = (shares * bidPrice).toFixed(2);

      document.getElementById('force-sell-info').textContent =
        'Sell ' + shares + ' ' + outcomeName + ' shares at market price (~' + bidCents + 'c)?';
      document.getElementById('force-sell-revenue').textContent =
        'Expected revenue: $' + expectedRevenue;
      document.getElementById('force-sell-modal').classList.add('active');
    }

    function closeForceSellModal() {
      document.getElementById('force-sell-modal').classList.remove('active');
      pendingForceSellSlug = null;
      pendingForceSellOutcomeIndex = null;
      pendingForceSellOutcome = null;
      pendingForceSellShares = null;
      pendingForceSellBid = null;
    }

    async function confirmForceSell() {
      if (!pendingForceSellSlug || pendingForceSellOutcomeIndex === null) return;

      try {
        const res = await fetch('/api/force-sell', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            marketSlug: pendingForceSellSlug,
            outcomeIndex: pendingForceSellOutcomeIndex
          })
        });
        const result = await res.json();

        if (result.success) {
          showToast('Sold ' + result.sharesSold + ' shares for $' + (result.revenue || 0).toFixed(2), 'success');
        } else {
          showToast('Sell failed: ' + (result.error || 'Unknown error'), 'error');
        }
      } catch (err) {
        showToast('Sell failed: ' + err.message, 'error');
      }

      closeForceSellModal();
    }

    function showToast(message, type) {
      const toast = document.getElementById('toast');
      toast.textContent = message;
      toast.className = 'toast ' + type;
      setTimeout(() => {
        toast.className = 'toast';
      }, 3000);
    }

    // US-824: Force Sell Winner modal functions
    let pendingForceSellWinnerSlug = null;
    let pendingForceSellWinnerOutcomeIndex = null;
    let pendingForceSellWinnerOutcome = null;
    let pendingForceSellWinnerShares = null;
    let pendingForceSellWinnerBid = null;

    function openForceSellWinnerModal(marketSlug, outcomeIndex, outcomeName, shares, bidPrice) {
      pendingForceSellWinnerSlug = marketSlug;
      pendingForceSellWinnerOutcomeIndex = outcomeIndex;
      pendingForceSellWinnerOutcome = outcomeName;
      pendingForceSellWinnerShares = shares;
      pendingForceSellWinnerBid = bidPrice;

      const bidCents = (bidPrice * 100).toFixed(0);
      const expectedRevenue = (shares * bidPrice).toFixed(2);
      const settlementValue = shares * 1.00;
      const potentialLoss = (settlementValue - (shares * bidPrice)).toFixed(2);

      document.getElementById('force-sell-winner-info').textContent =
        'Sell ' + shares + ' ' + outcomeName + ' shares at market price (~' + bidCents + 'c)?';
      document.getElementById('force-sell-winner-revenue').textContent =
        'Expected revenue: $' + expectedRevenue;
      document.getElementById('force-sell-winner-loss').textContent =
        'Potential loss vs $1 settlement: -$' + potentialLoss;
      document.getElementById('force-sell-winner-modal').classList.add('active');
    }

    function closeForceSellWinnerModal() {
      document.getElementById('force-sell-winner-modal').classList.remove('active');
      pendingForceSellWinnerSlug = null;
      pendingForceSellWinnerOutcomeIndex = null;
      pendingForceSellWinnerOutcome = null;
      pendingForceSellWinnerShares = null;
      pendingForceSellWinnerBid = null;
    }

    async function confirmForceSellWinner() {
      if (!pendingForceSellWinnerSlug || pendingForceSellWinnerOutcomeIndex === null) return;

      try {
        const res = await fetch('/api/force-sell', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            marketSlug: pendingForceSellWinnerSlug,
            outcomeIndex: pendingForceSellWinnerOutcomeIndex
          })
        });
        const result = await res.json();

        if (result.success) {
          showToast('Sold winner: ' + result.sharesSold + ' shares for $' + (result.revenue || 0).toFixed(2), 'success');
        } else {
          showToast('Sell winner failed: ' + (result.error || 'Unknown error'), 'error');
        }
      } catch (err) {
        showToast('Sell winner failed: ' + err.message, 'error');
      }

      closeForceSellWinnerModal();
    }

    // Fetch initial data via REST API
    async function fetchInitialData() {
      try {
        const res = await fetch('/api/full');
        const data = await res.json();
        updatePositions(data.positions || []);
        updateStats(data.stats || {});
        updateTrades(data.trades || []);
        if (data.health) updateHealth(data.health);
      } catch (err) {
        console.error('Failed to fetch initial data:', err);
      }
    }

    // Initialize
    // US-803: Price tracking for flash animations
    let previousPrices = {};

    // US-803: Store prices for comparison
    function storePrices(positions) {
      positions.forEach(p => {
        previousPrices[p.marketSlug] = {
          outcome1: p.outcome1.currentBid,
          outcome2: p.outcome2.currentBid
        };
      });
    }

    // US-803 + US-804: Apply flash animation to price elements
    function applyPriceFlash(marketSlug, outcome, newPrice, oldPrice) {
      if (Math.abs(newPrice - oldPrice) < 0.01) return; // Ignore sub-cent changes

      const card = document.querySelector('.position-card[data-market-slug="' + marketSlug + '"]');
      if (!card) return;

      // US-803: Check for watching section price element
      let priceEl = card.querySelector('.watching-outcome-price[data-outcome="' + outcome + '"]');

      // US-804: Also check for holding winner section price element
      if (!priceEl) {
        priceEl = card.querySelector('.winner-price[data-outcome="' + outcome + '"]');
      }

      if (!priceEl) return;

      // Remove existing animation class
      priceEl.classList.remove('price-flash-up', 'price-flash-down');

      // Force reflow to restart animation
      void priceEl.offsetWidth;

      // Apply appropriate flash class
      if (newPrice > oldPrice) {
        priceEl.classList.add('price-flash-up');
      } else {
        priceEl.classList.add('price-flash-down');
      }
    }

    // US-803: Check for price changes and apply flash animations
    function checkPriceChanges(positions) {
      positions.forEach(p => {
        const prev = previousPrices[p.marketSlug];
        if (prev) {
          if (prev.outcome1 !== p.outcome1.currentBid) {
            applyPriceFlash(p.marketSlug, '1', p.outcome1.currentBid, prev.outcome1);
          }
          if (prev.outcome2 !== p.outcome2.currentBid) {
            applyPriceFlash(p.marketSlug, '2', p.outcome2.currentBid, prev.outcome2);
          }
        }
      });
      // Update stored prices after checking
      storePrices(positions);
      // US-806: Update last update times
      updateLastUpdateTimes(positions);
      // US-806: Check for section transitions
      checkSectionTransitions(positions);
    }

    // ============================================================================
    // US-806: Last Update Timestamps and Stale Data Indicator
    // ============================================================================

    // Track last update time per market
    const lastUpdateTimes = {};
    // Track which section each position is in
    const positionSections = {};

    // US-806: Update last update timestamps
    function updateLastUpdateTimes(positions) {
      const now = Date.now();
      positions.forEach(p => {
        lastUpdateTimes[p.marketSlug] = now;
      });
    }

    // US-806: Get last update HTML for a position
    function getLastUpdateHtml(marketSlug) {
      const lastUpdate = lastUpdateTimes[marketSlug];
      if (!lastUpdate) {
        return '<div class="last-update recent"><span class="stale-indicator fresh"></span>Just updated</div>';
      }

      const now = Date.now();
      const ageSeconds = Math.floor((now - lastUpdate) / 1000);

      let staleClass = 'recent';
      let indicatorClass = 'fresh';
      let text = 'Updated ' + ageSeconds + 's ago';

      if (ageSeconds >= 60) {
        staleClass = 'very-stale';
        indicatorClass = 'very-stale';
        text = '⚠️ No update for ' + Math.floor(ageSeconds / 60) + 'm - data may be stale';
      } else if (ageSeconds >= 30) {
        staleClass = 'stale';
        indicatorClass = 'stale';
        text = 'Updated ' + ageSeconds + 's ago';
      } else if (ageSeconds < 5) {
        text = 'Just updated';
      }

      return '<div class="last-update ' + staleClass + '"><span class="stale-indicator ' + indicatorClass + '"></span>' + text + '</div>';
    }

    // US-806: Determine which section a position belongs to
    function getPositionSection(position) {
      if (position.state.toLowerCase().includes('settled')) {
        return 'settled';
      }
      // US-813: Pending settlement comes before holding-winners check
      if (position.isPendingSettlement) {
        return 'pending-settlement';
      }
      if (position.state.toLowerCase() === 'partial_sold' || (position.outcome1.sold !== position.outcome2.sold)) {
        return 'holding-winners';
      }
      if (position.state.toLowerCase() === 'holding' && !position.outcome1.sold && !position.outcome2.sold) {
        // Check if within 10c of threshold
        if (isPendingSell(position)) {
          return 'pending-sells';
        }
        return 'watching';
      }
      return 'unknown';
    }

    // US-806: Check for section transitions and apply animations
    function checkSectionTransitions(positions) {
      const transitions = [];

      positions.forEach(p => {
        const newSection = getPositionSection(p);
        const oldSection = positionSections[p.marketSlug];

        if (oldSection && oldSection !== newSection && newSection !== 'settled') {
          transitions.push({
            marketSlug: p.marketSlug,
            fromSection: oldSection,
            toSection: newSection
          });
        }

        // Update tracked section
        positionSections[p.marketSlug] = newSection;
      });

      // Apply transition animations
      transitions.forEach(t => {
        applyTransitionAnimation(t.marketSlug, t.fromSection, t.toSection);
      });
    }

    // US-806: Apply entering animation to a card in new section
    function applyTransitionAnimation(marketSlug, fromSection, toSection) {
      // Find the card in the new section
      setTimeout(() => {
        const card = document.querySelector('.position-card[data-market-slug="' + marketSlug + '"][data-section="' + toSection + '"]');
        if (card) {
          card.classList.add('entering');
          // Remove class after animation completes
          setTimeout(() => {
            card.classList.remove('entering');
          }, 400);
        }
      }, 50); // Small delay to ensure DOM is updated
    }

    // US-806: Handle POSITION_SECTION_CHANGE WebSocket event
    function handleSectionChange(event) {
      const { marketSlug, fromSection, toSection } = event;
      // Update tracked section
      positionSections[marketSlug] = toSection;
      // Apply animation
      applyTransitionAnimation(marketSlug, fromSection, toSection);
    }

    // US-806: Periodically update last update displays (every 5 seconds)
    function updateLastUpdateDisplays() {
      document.querySelectorAll('.position-card[data-market-slug]').forEach(card => {
        const marketSlug = card.getAttribute('data-market-slug');
        const lastUpdateEl = card.querySelector('.last-update');
        if (lastUpdateEl && marketSlug) {
          const newHtml = getLastUpdateHtml(marketSlug);
          // Only update if different to avoid flicker
          const tempDiv = document.createElement('div');
          tempDiv.innerHTML = newHtml;
          const newText = tempDiv.textContent;
          if (lastUpdateEl.textContent !== newText) {
            lastUpdateEl.outerHTML = newHtml;
          }
        }
      });
    }

    // US-803: Setup watching sort selector
    function setupWatchingSort() {
      const sortSelect = document.getElementById('watching-sort');
      if (sortSelect) {
        sortSelect.addEventListener('change', () => {
          // Trigger re-render by fetching fresh data
          fetchInitialData();
        });
      }
    }

    // Initialize
    fetchInitialData();
    connect();
    setupTimeHorizonSelector();
    initSportFilter(); // US-703: Initialize sport filter tabs
    startUpcomingGamesRefresh();
    setupWatchingSort(); // US-803: Initialize watching sort
    // Update timers every second
    setInterval(updateTimers, 1000);
    // US-806: Update last update displays every 5 seconds
    setInterval(updateLastUpdateDisplays, 5000);
  </script>
</body>
</html>`;

    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(html);
  }

  /**
   * Handle WebSocket connection
   */
  private handleWebSocketConnection(ws: WebSocket): void {
    this.clients.add(ws);
    this.log(`Client connected (${this.clients.size} total)`);

    // Send initial full update
    if (this.dataProvider) {
      ws.send(
        JSON.stringify({
          type: "FULL_UPDATE",
          data: {
            positions: this.dataProvider.getPositions(),
            stats: this.dataProvider.getStats(),
            trades: this.dataProvider.getTrades(100),
            health: this.dataProvider.getAllMarketHealth?.() ?? [],
          },
          timestamp: Date.now(),
        }),
      );
    }

    ws.on("close", () => {
      this.clients.delete(ws);
      this.log(`Client disconnected (${this.clients.size} remaining)`);
    });

    ws.on("error", (error) => {
      this.log(`WebSocket client error: ${error}`, "ERROR");
      this.clients.delete(ws);
    });
  }

  /**
   * Add CORS headers to response
   */
  private addCorsHeaders(res: http.ServerResponse): void {
    const origins = this.config.corsOrigins;
    res.setHeader(
      "Access-Control-Allow-Origin",
      origins.includes("*") ? "*" : origins.join(", "),
    );
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  }

  /**
   * Send JSON response
   */
  private sendJson(
    res: http.ServerResponse,
    status: number,
    data: unknown,
  ): void {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(data));
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
    console.log(
      `${timestamp} [${level}] ${prefix} [SportsDashboard] ${message}`,
    );
  }

  // ============================================================================
  // GETTERS
  // ============================================================================

  getPort(): number {
    return this.config.port;
  }

  getMode(): "PAPER" | "LIVE" {
    return this.config.mode;
  }

  isRunning(): boolean {
    return this.running;
  }

  getClientCount(): number {
    return this.clients.size;
  }
}
