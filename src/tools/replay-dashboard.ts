/**
 * replay-dashboard.ts — Replays real NBA trade data from SQLite at 4x speed
 * through the ShockFadeDashboard for realistic testing.
 * 
 * Uses the trades table (much denser than snapshots) and aggregates into
 * 1-second OHLC bars to derive bid/ask/mid for the detector.
 */

import { EventEmitter } from "events";
import Database from "better-sqlite3";
import path from "path";

import { ShockFadeDashboardServer } from "../dashboard/ShockFadeDashboard";
import { ShockFadeDetector, ShockEvent, ShockFadeConfig } from "../strategies/ShockFadeDetector";
import { OrderBookWebSocket, PriceUpdateEvent } from "../services/OrderBookWS";
import type { SportsMarket } from "../services/SportsMarketDiscovery";
import type {
  ShockFadePaperStats,
  LadderOrder,
  FadePosition,
  TradeRecord,
} from "../strategies/ShockFadePaper";

// ============================================================================
// CONFIG
// ============================================================================

const DB_PATH = path.join(__dirname, "..", "..", "data", "nhl_shock.db");
const REPLAY_SPEED = 4; // 4x speed
const PORT = 3032;
const OHLC_INTERVAL_MS = 1000; // Aggregate trades into 1-second bars
const MAX_GAP_MS = 300_000; // Skip gaps longer than 5 min of real time (skips between-game dead time but not halftime)

// Games to replay — Feb 7 games with full event data
const GAME_SLUGS = [
  "nba-hou-okc-2026-02-07",  // Rockets vs Thunder - 817K trades, 10K events
  "nba-den-chi-2026-02-07",  // Nuggets vs Bulls - 12K events
  "nba-gsw-lal-2026-02-07",  // Warriors vs Lakers - 10K events
];

const SHOCK_CONFIG: Partial<ShockFadeConfig> = {
  sigmaThreshold: 2.0,
  minAbsoluteMove: 0.02,
  ladderSpacing: 0.03,
  fadeTargetCents: 4,
  ladderLevels: 3,
  cooldownMs: 30000,
  targetPriceRange: [0.07, 0.91],
  rollingWindowMs: 60000, // 1 min window — trades are dense enough
};

const LADDER_SHARES = [5, 10, 20]; // shares per level (same as live bot)
const MAX_CYCLES_PER_MARKET = 2; // same as live bot
const FADE_WINDOW_MS = 120000; // 2 min order expiry
const POSITION_TIMEOUT_MS = 600000; // 10 min hard timeout

// ============================================================================
// NBA TEAM MAPS (module scope — used by MockTrader and main function)
// ============================================================================

const NBA_ABBREV: Record<string, string> = {
  ATL: "Hawks", BOS: "Celtics", BKN: "Nets", CHA: "Hornets", CHI: "Bulls",
  CLE: "Cavaliers", DAL: "Mavericks", DEN: "Nuggets", DET: "Pistons", GS: "Warriors",
  GSW: "Warriors", HOU: "Rockets", IND: "Pacers", LAC: "Clippers", LAL: "Lakers",
  MEM: "Grizzlies", MIA: "Heat", MIL: "Bucks", MIN: "Timberwolves", NO: "Pelicans",
  NOP: "Pelicans", NY: "Knicks", NYK: "Knicks", OKC: "Thunder", ORL: "Magic",
  PHI: "76ers", PHX: "Suns", POR: "Trail Blazers", SAC: "Kings", SA: "Spurs",
  SAS: "Spurs", TOR: "Raptors", UTA: "Jazz", WAS: "Wizards",
};

const NAME_TO_ABBREV: Record<string, string> = {};
for (const [abbrev, name] of Object.entries(NBA_ABBREV)) {
  NAME_TO_ABBREV[name.toLowerCase()] = abbrev;
}

// ============================================================================
// FAKE WEBSOCKET (EventEmitter that ShockFadeDetector can listen to)
// ============================================================================

class FakeOrderBookWS extends EventEmitter {
  connect() {}
  disconnect() {}
  subscribe(_tokenId: string) {}
  unsubscribe(_tokenId: string) {}
  getOrderBook(_tokenId: string) { return null; }
}

// ============================================================================
// OHLC BAR — aggregate trades into 1-second bars
// ============================================================================

interface OHLCBar {
  tokenId: string;
  marketSlug: string;
  ts: number;        // bar start timestamp
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  trades: number;
  lastBuy: number;   // last buy price → approximates ask
  lastSell: number;  // last sell price → approximates bid
}

// ============================================================================
// MOCK TRADER — manages orders, positions, trades, stats
// ============================================================================

interface CumulativeTP {
  marketSlug: string;
  shockId: string;
  heldTokenId: string;
  spikedTokenId: string;
  shockTeam: string | null; // team tricode that caused the shock (e.g., "HOU")
  tpPrice: number;
  totalEntryShares: number;
  filledTPShares: number;
  tpShares: number;
  status: string;
}

class MockTrader {
  private orders: LadderOrder[] = [];
  private positions: FadePosition[] = [];
  private trades: TradeRecord[] = [];
  private cumulativeTPs: CumulativeTP[] = [];
  private latestPrices: Map<string, { bid: number; ask: number; mid: number }> = new Map();
  private stats: ShockFadePaperStats = {
    totalShocksDetected: 0,
    totalOrdersPlaced: 0,
    totalOrdersFilled: 0,
    totalOrdersCancelled: 0,
    totalOrdersExpired: 0,
    totalPositionsOpened: 0,
    totalPositionsClosed: 0,
    totalPnL: 0,
    totalSplitCost: 0,
    totalProceeds: 0,
    winCount: 0,
    lossCount: 0,
    winRate: 0,
    avgFadeCaptureCents: 0,
    avgHoldTimeMs: 0,
    sharpeRatio: 0,
    maxDrawdown: 0,
    runningBalance: 1000,
    startedAt: Date.now(),
  };

  private marketTokens: Map<string, { token1: string; token2: string; outcome1: string; outcome2: string }> = new Map();

  setMarketTokens(slug: string, token1: string, token2: string, outcome1: string, outcome2: string) {
    this.marketTokens.set(slug, { token1, token2, outcome1, outcome2 });
  }

  updatePrice(tokenId: string, bid: number, ask: number, mid: number) {
    this.latestPrices.set(tokenId, { bid, ask, mid });
  }

  getLatestPrice(tokenId: string): { bid: number; ask: number; mid: number } | undefined {
    return this.latestPrices.get(tokenId);
  }

  getStats(): ShockFadePaperStats { return this.stats; }
  getTrades(): TradeRecord[] { return this.trades; }
  getActiveOrders(): LadderOrder[] { return this.orders.filter(o => o.status === "PENDING"); }
  getAllOrders(): LadderOrder[] { return this.orders.slice(-50); }
  getOpenPositions(): FadePosition[] { return this.positions.filter(p => p.status === "OPEN"); }
  getAllPositions(): FadePosition[] { return this.positions.slice(-50); }
  getTradeHistory(): TradeRecord[] { return this.trades.slice(-50); }
  getCumulativeTPs(): CumulativeTP[] { return this.cumulativeTPs; }

  handleShock(shock: ShockEvent, dashboard: ShockFadeDashboardServer): void {
    this.stats.totalShocksDetected++;
    const mkt = this.marketTokens.get(shock.marketSlug);
    if (!mkt) return;

    // Check CONCURRENT cycle limit — count cycles with pending orders or open positions
    const activeCycleIds = new Set<string>();
    for (const o of this.orders) {
      if (o.marketSlug === shock.marketSlug && o.status === "PENDING") {
        activeCycleIds.add(o.shockId);
      }
    }
    for (const p of this.positions) {
      if (p.marketSlug === shock.marketSlug && p.status === "OPEN") {
        if (p.shockId) activeCycleIds.add(p.shockId);
      }
    }
    if (activeCycleIds.size >= MAX_CYCLES_PER_MARKET) {
      dashboard.addLog("SHOCK", `⚠️ ${activeCycleIds.size} concurrent cycles active for ${shock.marketSlug} — skipping`);
      return;
    }

    const spikedTokenId = shock.tokenId;
    const heldTokenId = spikedTokenId === mkt.token1 ? mkt.token2 : mkt.token1;
    const basePrice = shock.currentPrice;

    // Resolve shockTeam: which team's scoring caused this shock?
    // shock.direction = "up" means this token's price went up = this team scored
    // shock.direction = "down" means this token's price dropped = OTHER team scored
    // We sell the spiked token, so shockTeam = team whose event caused the move
    let shockTeamOutcome: string;
    if (shock.direction === "up") {
      // Token went up → this team scored
      shockTeamOutcome = spikedTokenId === mkt.token1 ? mkt.outcome1 : mkt.outcome2;
    } else {
      // Token went down → other team scored
      shockTeamOutcome = spikedTokenId === mkt.token1 ? mkt.outcome2 : mkt.outcome1;
    }
    const shockTeam = NAME_TO_ABBREV[shockTeamOutcome.toLowerCase()] || null;

    for (let level = 1; level <= 3; level++) {
      const price = basePrice + (level - 1) * SHOCK_CONFIG.ladderSpacing!;
      const shares = LADDER_SHARES[level - 1]; // 5/10/20 shares directly
      const size = shares * price; // USD value of sell side
      const order: LadderOrder = {
        id: `replay-${Date.now().toString(36)}-L${level}`,
        tokenId: spikedTokenId,
        marketSlug: shock.marketSlug,
        side: "SELL",
        leg: "ENTRY",
        price,
        size,
        shares,
        level,
        status: "PENDING",
        createdAt: Date.now(),
        filledAt: null,
        fillPrice: null,
        shockId: shock.timestamp.toString(),
        splitCost: shares * 1.0, // Split cost = $1 per share pair (split $1 → 1 YES + 1 NO)
      };
      this.orders.push(order);
      this.stats.totalOrdersPlaced++;
      dashboard.notifyOrderPlaced(order);
    }

    const totalShares = LADDER_SHARES.reduce((s, sh) => s + sh, 0); // 35
    const estimatedTP = 1.0 - basePrice + SHOCK_CONFIG.fadeTargetCents! / 100;
    const tp: CumulativeTP = {
      marketSlug: shock.marketSlug,
      shockId: shock.timestamp.toString(),
      heldTokenId,
      spikedTokenId,
      shockTeam,
      tpPrice: estimatedTP,
      totalEntryShares: totalShares,
      filledTPShares: 0,
      tpShares: 0,
      status: "WATCHING",
    };
    this.cumulativeTPs.push(tp);
    dashboard.notifyTPUpdate(tp);
  }

  tickOrders(now: number, dashboard: ShockFadeDashboardServer): void {
    const pendingOrders = this.orders.filter(o => o.status === "PENDING");

    for (const order of pendingOrders) {
      const price = this.latestPrices.get(order.tokenId);
      if (!price) continue;

      if (price.bid >= order.price) {
        order.status = "FILLED";
        order.filledAt = now;
        order.fillPrice = price.bid;
        this.stats.totalOrdersFilled++;
        dashboard.notifyOrderFilled(order);

        const mkt = this.marketTokens.get(order.marketSlug);
        if (!mkt) continue;

        const heldTokenId = order.tokenId === mkt.token1 ? mkt.token2 : mkt.token1;
        const breakEvenExitPrice = 1.0 - price.bid;
        const fadeTarget = SHOCK_CONFIG.fadeTargetCents! / 100;
        const tpPrice = Math.min(0.99, breakEvenExitPrice + fadeTarget);

        const pos: FadePosition = {
          id: `pos-${order.id}`,
          marketSlug: order.marketSlug,
          soldTokenId: order.tokenId,
          soldPrice: price.bid,
          soldShares: order.shares,
          heldTokenId,
          heldShares: order.shares,
          splitCost: order.splitCost,
          entryTime: now,
          takeProfitPrice: tpPrice,
          status: "OPEN",
          exitPrice: null,
          exitTime: null,
          pnl: null,
          shockId: order.shockId,
          orderId: order.id,
        };
        this.positions.push(pos);
        this.stats.totalPositionsOpened++;

        const tpEntry = this.cumulativeTPs.find(tp => tp.shockId === order.shockId && tp.marketSlug === order.marketSlug);
        if (tpEntry) {
          const oldShares = tpEntry.tpShares;
          const newShares = order.shares;
          const totalShares = oldShares + newShares;
          if (totalShares > 0) {
            tpEntry.tpPrice = (tpEntry.tpPrice * oldShares + tpPrice * newShares) / totalShares;
          }
          tpEntry.tpShares += order.shares;
          tpEntry.heldTokenId = heldTokenId;
          dashboard.notifyTPUpdate(tpEntry);
        }

        dashboard.addLog("ORDER", `L${order.level} filled: SELL @ ${(price.bid * 100).toFixed(1)}¢ × ${order.shares} shares → TP @ ${(tpPrice * 100).toFixed(1)}¢ [${order.marketSlug}]`);
      }

      // Order expiry — use WALL time (already scaled by replay speed in the wait loop)
      if (now - order.createdAt > FADE_WINDOW_MS / REPLAY_SPEED && order.status === "PENDING") {
        order.status = "EXPIRED";
        this.stats.totalOrdersExpired++;
        dashboard.notifyOrderCancelled(order, "expired");
        this.checkCycleDone(order.shockId, order.marketSlug);
      }
    }

    const openPositions = this.positions.filter(p => p.status === "OPEN");
    for (const pos of openPositions) {
      const heldPrice = this.latestPrices.get(pos.heldTokenId);
      if (!heldPrice) continue;

      let exitReason: string | null = null;
      let exitPrice = heldPrice.bid;

      if (heldPrice.bid >= pos.takeProfitPrice) {
        exitReason = "TAKE_PROFIT";
        exitPrice = pos.takeProfitPrice;
      }

      if (now - pos.entryTime > POSITION_TIMEOUT_MS / REPLAY_SPEED) {
        exitReason = exitReason || "HEDGED";
        exitPrice = heldPrice.bid;
      }

      if (exitReason) {
        pos.status = exitReason as any;
        pos.exitPrice = exitPrice;
        pos.exitTime = now;

        const totalProceeds = pos.soldPrice * pos.soldShares + exitPrice * pos.heldShares;
        const pnl = totalProceeds - pos.splitCost;
        pos.pnl = pnl;

        const record: TradeRecord = {
          id: `trade-${pos.id}`,
          marketSlug: pos.marketSlug,
          soldTokenId: pos.soldTokenId,
          soldPrice: pos.soldPrice,
          soldShares: pos.soldShares,
          heldTokenId: pos.heldTokenId,
          exitPrice,
          exitShares: pos.heldShares,
          pnl,
          splitCost: pos.splitCost,
          totalProceeds,
          entryTime: pos.entryTime,
          exitTime: now,
          shockMagnitude: 0.03,
          shockZScore: 2.5,
          fadeCapture: Math.abs(pos.soldPrice - (1.0 - exitPrice)) * 100,
          holdTimeMs: now - pos.entryTime,
        };
        this.trades.push(record);

        this.stats.totalPositionsClosed++;
        this.stats.totalPnL += pnl;
        this.stats.totalSplitCost += pos.splitCost;
        this.stats.totalProceeds += totalProceeds;
        if (pnl >= 0) this.stats.winCount++;
        else this.stats.lossCount++;
        const total = this.stats.winCount + this.stats.lossCount;
        this.stats.winRate = total > 0 ? this.stats.winCount / total : 0;
        this.stats.runningBalance += pnl;

        if (this.trades.length > 1) {
          const pnls = this.trades.map(t => t.pnl);
          const avgPnl = pnls.reduce((a, b) => a + b, 0) / pnls.length;
          const variance = pnls.reduce((a, b) => a + (b - avgPnl) ** 2, 0) / pnls.length;
          this.stats.sharpeRatio = variance > 0 ? avgPnl / Math.sqrt(variance) : 0;
          this.stats.avgFadeCaptureCents = this.trades.reduce((a, t) => a + t.fadeCapture, 0) / this.trades.length;
          this.stats.avgHoldTimeMs = this.trades.reduce((a, t) => a + t.holdTimeMs, 0) / this.trades.length;
        }

        const tp = this.cumulativeTPs.find(t => t.shockId === pos.shockId && t.marketSlug === pos.marketSlug);
        if (tp) {
          tp.filledTPShares += pos.heldShares;
        }
        this.checkCycleDone(pos.shockId!, pos.marketSlug);

        dashboard.notifyPositionClosed(pos, record);
        const emoji = pnl >= 0 ? "+" : "";
        dashboard.addLog("TRADE", `Closed ${exitReason}: ${emoji}$${pnl.toFixed(2)} (${((now - pos.entryTime) / 1000).toFixed(0)}s hold) [${pos.marketSlug}]`);
      }
    }

    // Sweep stale WATCHING TPs
    for (const tp of this.cumulativeTPs) {
      if (tp.status !== "WATCHING") continue;
      const hasPending = this.orders.some(o => o.shockId === tp.shockId && o.marketSlug === tp.marketSlug && o.status === "PENDING");
      const hasOpen = this.positions.some(p => p.shockId === tp.shockId && p.marketSlug === tp.marketSlug && p.status === "OPEN");
      if (!hasPending && !hasOpen) {
        const cycleOrders = this.orders.filter(o => o.shockId === tp.shockId && o.marketSlug === tp.marketSlug);
        if (cycleOrders.length > 0) {
          const anyFilled = cycleOrders.some(o => o.status === "FILLED");
          tp.status = anyFilled ? "EVENT_EXIT" : "TIMEOUT";
        }
      }
    }

    if (this.orders.length > 200) this.orders = this.orders.slice(-100);
    if (this.positions.length > 200) this.positions = this.positions.slice(-100);
    if (this.trades.length > 200) this.trades = this.trades.slice(-100);
    const closedStatuses = ["HIT", "EVENT_EXIT", "TIMEOUT"];
    const activeTPs = this.cumulativeTPs.filter(tp => !closedStatuses.includes(tp.status));
    const closedTPs = this.cumulativeTPs.filter(tp => closedStatuses.includes(tp.status)).slice(-20);
    this.cumulativeTPs = [...closedTPs, ...activeTPs];
  }

  cancelAndHedge(shockId: string, marketSlug: string, dashboard: ShockFadeDashboardServer): void {
    for (const order of this.orders) {
      if (order.shockId === shockId && order.marketSlug === marketSlug && order.status === "PENDING") {
        order.status = "CANCELLED";
        this.stats.totalOrdersCancelled++;
        dashboard.notifyOrderCancelled(order, "classification");
      }
    }
    for (const pos of this.positions) {
      if (pos.shockId === shockId && pos.marketSlug === marketSlug && pos.status === "OPEN") {
        const heldPrice = this.latestPrices.get(pos.heldTokenId);
        const exitPrice = heldPrice?.bid ?? (1.0 - pos.soldPrice);
        pos.status = "HEDGED";
        pos.exitPrice = exitPrice;
        pos.exitTime = Date.now();
        const pnl = (pos.soldPrice + exitPrice - 1.0) * pos.soldShares;
        pos.pnl = pnl;
        this.stats.totalPositionsClosed++;
        this.stats.totalPnL += pnl;
        if (pnl >= 0) this.stats.winCount++;
        else this.stats.lossCount++;
        const total = this.stats.winCount + this.stats.lossCount;
        this.stats.winRate = total > 0 ? this.stats.winCount / total : 0;
        this.stats.runningBalance += pnl;

        const record: TradeRecord = {
          id: `trade-${pos.id}`, marketSlug, soldTokenId: pos.soldTokenId,
          soldPrice: pos.soldPrice, soldShares: pos.soldShares,
          heldTokenId: pos.heldTokenId, exitPrice, exitShares: pos.heldShares,
          pnl, splitCost: pos.splitCost, totalProceeds: (pos.soldPrice + exitPrice) * pos.soldShares,
          entryTime: pos.entryTime, exitTime: Date.now(),
          shockMagnitude: 0, shockZScore: 0,
          fadeCapture: Math.abs(pos.soldPrice + exitPrice - 1.0) * 100,
          holdTimeMs: Date.now() - pos.entryTime,
        };
        this.trades.push(record);
        dashboard.notifyPositionClosed(pos, record);
        dashboard.addLog("TRADE", `Hedged (bad classification): ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)} [${marketSlug}]`);
      }
    }
    this.checkCycleDone(shockId, marketSlug);
  }

  /**
   * Smart event exit — matches live bot logic.
   * On scoring event: check each active cycle for this market.
   * - ADVERSE (same team scored again) → exit the cycle
   * - FAVORABLE (other team scored) → hold
   * - Unknown team → conservative exit
   */
  handleGameEvent(marketSlug: string, eventTeam: string, dashboard: ShockFadeDashboardServer): void {
    const activeTPs = this.cumulativeTPs.filter(
      tp => tp.marketSlug === marketSlug && (tp.status === "WATCHING" || tp.status === "PARTIAL")
    );

    for (const tp of activeTPs) {
      // Check if this cycle has any open positions (filled orders)
      const cyclePositions = this.positions.filter(
        p => p.shockId === tp.shockId && p.marketSlug === marketSlug && p.status === "OPEN"
      );
      if (cyclePositions.length === 0) continue; // No open positions in this cycle

      if (eventTeam && tp.shockTeam) {
        if (eventTeam === tp.shockTeam) {
          // ADVERSE — shock team scored again → exit this cycle
          dashboard.addLog("EVENT", `🏟️ ADVERSE: ${eventTeam} scored again (shock team: ${tp.shockTeam}) → EXIT cycle [${marketSlug}]`);

          for (const pos of cyclePositions) {
            const heldPrice = this.latestPrices.get(pos.heldTokenId);
            const exitPrice = heldPrice?.bid ?? (1.0 - pos.soldPrice);
            pos.status = "EVENT_EXIT" as any;
            pos.exitPrice = exitPrice;
            pos.exitTime = Date.now();
            const pnl = (pos.soldPrice + exitPrice - 1.0) * pos.soldShares;
            pos.pnl = pnl;

            const record: TradeRecord = {
              id: `trade-${pos.id}`, marketSlug, soldTokenId: pos.soldTokenId,
              soldPrice: pos.soldPrice, soldShares: pos.soldShares,
              heldTokenId: pos.heldTokenId, exitPrice, exitShares: pos.heldShares,
              pnl, splitCost: pos.splitCost, totalProceeds: (pos.soldPrice + exitPrice) * pos.soldShares,
              entryTime: pos.entryTime, exitTime: Date.now(),
              shockMagnitude: 0, shockZScore: 0,
              fadeCapture: Math.abs(pos.soldPrice + exitPrice - 1.0) * 100,
              holdTimeMs: Date.now() - pos.entryTime,
            };
            this.trades.push(record);
            this.stats.totalPositionsClosed++;
            this.stats.totalPnL += pnl;
            if (pnl >= 0) this.stats.winCount++;
            else this.stats.lossCount++;
            const total = this.stats.winCount + this.stats.lossCount;
            this.stats.winRate = total > 0 ? this.stats.winCount / total : 0;
            this.stats.runningBalance += pnl;
            dashboard.notifyPositionClosed(pos, record);
            dashboard.addLog("TRADE", `Event exit (ADVERSE): ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)} [${marketSlug}]`);
          }

          // Cancel pending orders for this cycle
          for (const order of this.orders) {
            if (order.shockId === tp.shockId && order.marketSlug === marketSlug && order.status === "PENDING") {
              order.status = "CANCELLED";
              this.stats.totalOrdersCancelled++;
              dashboard.notifyOrderCancelled(order, "event_exit");
            }
          }

          tp.status = "EVENT_EXIT";
          dashboard.notifyTPUpdate(tp);

        } else {
          // FAVORABLE — other team scored → hold
          dashboard.addLog("EVENT", `✅ FAVORABLE: ${eventTeam} scored (shock team: ${tp.shockTeam}) → HOLD cycle [${marketSlug}]`);
        }
      } else {
        // Unknown team — conservative exit
        dashboard.addLog("EVENT", `🏟️ Unknown team (${eventTeam}) → conservative EXIT [${marketSlug}]`);

        for (const pos of cyclePositions) {
          const heldPrice = this.latestPrices.get(pos.heldTokenId);
          const exitPrice = heldPrice?.bid ?? (1.0 - pos.soldPrice);
          pos.status = "EVENT_EXIT" as any;
          pos.exitPrice = exitPrice;
          pos.exitTime = Date.now();
          const pnl = (pos.soldPrice + exitPrice - 1.0) * pos.soldShares;
          pos.pnl = pnl;

          const record: TradeRecord = {
            id: `trade-${pos.id}`, marketSlug, soldTokenId: pos.soldTokenId,
            soldPrice: pos.soldPrice, soldShares: pos.soldShares,
            heldTokenId: pos.heldTokenId, exitPrice, exitShares: pos.heldShares,
            pnl, splitCost: pos.splitCost, totalProceeds: (pos.soldPrice + exitPrice) * pos.soldShares,
            entryTime: pos.entryTime, exitTime: Date.now(),
            shockMagnitude: 0, shockZScore: 0,
            fadeCapture: Math.abs(pos.soldPrice + exitPrice - 1.0) * 100,
            holdTimeMs: Date.now() - pos.entryTime,
          };
          this.trades.push(record);
          this.stats.totalPositionsClosed++;
          this.stats.totalPnL += pnl;
          if (pnl >= 0) this.stats.winCount++;
          else this.stats.lossCount++;
          const total = this.stats.winCount + this.stats.lossCount;
          this.stats.winRate = total > 0 ? this.stats.winCount / total : 0;
          this.stats.runningBalance += pnl;
          dashboard.notifyPositionClosed(pos, record);
        }

        for (const order of this.orders) {
          if (order.shockId === tp.shockId && order.marketSlug === marketSlug && order.status === "PENDING") {
            order.status = "CANCELLED";
            this.stats.totalOrdersCancelled++;
            dashboard.notifyOrderCancelled(order, "event_exit");
          }
        }

        tp.status = "EVENT_EXIT";
        dashboard.notifyTPUpdate(tp);
      }
    }
  }

  private checkCycleDone(shockId: string, marketSlug: string): void {
    const hasPending = this.orders.some(o => o.shockId === shockId && o.marketSlug === marketSlug && o.status === "PENDING");
    const hasOpen = this.positions.some(p => p.shockId === shockId && p.marketSlug === marketSlug && p.status === "OPEN");
    if (!hasPending && !hasOpen) {
      const tp = this.cumulativeTPs.find(t => t.shockId === shockId && t.marketSlug === marketSlug);
      if (tp && tp.status === "WATCHING") {
        const anyFilled = this.orders.some(o => o.shockId === shockId && o.status === "FILLED");
        tp.status = anyFilled ? "EVENT_EXIT" : "TIMEOUT";
      }
    }
  }

  reset(): void {
    this.orders = [];
    this.positions = [];
    this.trades = [];
    this.cumulativeTPs = [];
    this.stats.totalShocksDetected = 0;
    this.stats.totalOrdersPlaced = 0;
    this.stats.totalOrdersFilled = 0;
    this.stats.totalOrdersCancelled = 0;
    this.stats.totalOrdersExpired = 0;
    this.stats.totalPositionsOpened = 0;
    this.stats.totalPositionsClosed = 0;
    this.stats.totalPnL = 0;
    this.stats.totalSplitCost = 0;
    this.stats.totalProceeds = 0;
    this.stats.winCount = 0;
    this.stats.lossCount = 0;
    this.stats.winRate = 0;
    this.stats.runningBalance = 1000;
    this.stats.startedAt = Date.now();
  }
}

// ============================================================================
// TRADE AGGREGATION — build OHLC bars from raw trades
// ============================================================================

interface RawTrade {
  ts: number;
  market_slug: string;
  token_id: string;
  price: number;
  size: number;
  side: string; // "buy" or "sell"
}

// Token pair mapping: tokenId → { complementId, marketSlug }
const tokenPairs = new Map<string, { complementId: string; marketSlug: string }>();

function registerTokenPair(token1: string, token2: string, marketSlug: string) {
  tokenPairs.set(token1, { complementId: token2, marketSlug });
  tokenPairs.set(token2, { complementId: token1, marketSlug });
}

/**
 * Aggregate raw trades into OHLC bars per market (not per token).
 * For each bar, compute both tokens' prices using complement constraint:
 * tokenA + tokenB = $1.00
 */
function aggregateTrades(trades: RawTrade[], intervalMs: number): OHLCBar[] {
  // Group by market + time bucket
  const buckets = new Map<string, RawTrade[]>();

  for (const t of trades) {
    const bucketTs = Math.floor(t.ts / intervalMs) * intervalMs;
    const key = `${t.market_slug}:${bucketTs}`;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key)!.push(t);
  }

  const bars: OHLCBar[] = [];

  for (const [key, bucket] of buckets) {
    const [marketSlug, tsStr] = key.split(":");
    const ts = parseInt(tsStr);

    // Group trades by tokenId within this bucket
    const byToken = new Map<string, RawTrade[]>();
    for (const t of bucket) {
      if (!byToken.has(t.token_id)) byToken.set(t.token_id, []);
      byToken.get(t.token_id)!.push(t);
    }

    // Create a bar for each token, using its trades for primary price
    // and complement constraint for the other side
    for (const [tokenId, tokenTrades] of byToken) {
      const prices = tokenTrades.map(t => t.price);
      const buys = tokenTrades.filter(t => t.side === "buy");
      const sells = tokenTrades.filter(t => t.side === "sell");
      const close = prices[prices.length - 1];

      // Bid = last sell price (someone sold at this price = bid was here)
      // Ask = last buy price (someone bought at this price = ask was here)
      const lastSell = sells.length > 0 ? sells[sells.length - 1].price : close;
      const lastBuy = buys.length > 0 ? buys[buys.length - 1].price : close;

      bars.push({
        tokenId,
        marketSlug,
        ts,
        open: prices[0],
        high: Math.max(...prices),
        low: Math.min(...prices),
        close,
        volume: tokenTrades.reduce((s, t) => s + t.size, 0),
        trades: tokenTrades.length,
        lastBuy,
        lastSell,
      });
    }
  }

  bars.sort((a, b) => a.ts - b.ts || a.tokenId.localeCompare(b.tokenId));
  return bars;
}

// ============================================================================
// MAIN — REPLAY LOOP
// ============================================================================

async function main() {
  console.log("🏀 Replay Dashboard — Loading real NBA trade data...\n");

  const db = new Database(DB_PATH, { readonly: true });

  // Load markets
  const markets = db.prepare(
    `SELECT * FROM markets WHERE market_slug IN (${GAME_SLUGS.map(() => "?").join(",")})`
  ).all(...GAME_SLUGS) as any[];

  if (markets.length === 0) {
    console.error("No markets found!");
    process.exit(1);
  }

  console.log(`Loaded ${markets.length} markets:`);
  markets.forEach((m: any) => console.log(`  ${m.market_slug}: ${m.outcome1} vs ${m.outcome2}`));

  // Find when games get hot — start from when ALL games have dense trading
  const tradeStats = db.prepare(`
    SELECT market_slug, COUNT(*) as cnt, 
      MIN(ts) as first_ts, MAX(ts) as last_ts,
      ROUND((MAX(ts)-MIN(ts))/60000.0, 1) as duration_min
    FROM trades WHERE market_slug IN (${GAME_SLUGS.map(() => "?").join(",")})
    GROUP BY market_slug
  `).all(...GAME_SLUGS) as any[];

  console.log(`\nTrade data:`);
  let globalFirstTs = Infinity;
  let globalLastTs = 0;
  for (const s of tradeStats) {
    console.log(`  ${s.market_slug}: ${s.cnt.toLocaleString()} trades, ${s.duration_min} min`);
    if (s.first_ts < globalFirstTs) globalFirstTs = s.first_ts;
    if (s.last_ts > globalLastTs) globalLastTs = s.last_ts;
  }

  // Use game events to find actual game windows (first goal - 5 min to last goal + 5 min)
  const gameWindows = db.prepare(`
    SELECT market_slug, MIN(ts) as first_event, MAX(ts) as last_event
    FROM game_events 
    WHERE event_type = 'goal' AND market_slug IN (${GAME_SLUGS.map(() => "?").join(",")})
    GROUP BY market_slug
  `).all(...GAME_SLUGS) as any[];

  if (gameWindows.length > 0) {
    console.log(`\nGame event windows:`);
    for (const w of gameWindows) {
      const dur = ((w.last_event - w.first_event) / 60000).toFixed(0);
      console.log(`  ${w.market_slug}: ${new Date(w.first_event).toISOString()} → ${new Date(w.last_event).toISOString()} (${dur} min)`);
    }
  }

  // Start 5 min before earliest first event (warmup + pre-game trading)
  const earliestEvent = Math.min(...gameWindows.map((w: any) => w.first_event));
  const latestEvent = Math.max(...gameWindows.map((w: any) => w.last_event));
  let replayFrom = earliestEvent - 5 * 60 * 1000; // 5 min warmup
  const replayUntil = latestEvent + 5 * 60 * 1000; // 5 min post-game
  
  console.log(`\nReplay window: ${new Date(replayFrom).toISOString()} → ${new Date(replayUntil).toISOString()}`);

  const totalDurationMin = (replayUntil - replayFrom) / 60000;
  // Estimate effective duration (subtract gaps that will be skipped)
  let gapMinutes = 0;
  if (gameWindows.length > 1) {
    const sortedWindows = [...gameWindows].sort((a: any, b: any) => a.first_event - b.first_event);
    for (let i = 1; i < sortedWindows.length; i++) {
      const gap = sortedWindows[i].first_event - sortedWindows[i - 1].last_event;
      if (gap > MAX_GAP_MS) gapMinutes += (gap - MAX_GAP_MS) / 60000;
    }
  }
  const effectiveDurationMin = totalDurationMin - gapMinutes;
  const replayDurationMin = effectiveDurationMin / REPLAY_SPEED;
  console.log(`Real duration: ${totalDurationMin.toFixed(0)} min (${gapMinutes.toFixed(0)} min gaps skipped) → effective: ${effectiveDurationMin.toFixed(0)} min`);
  console.log(`At ${REPLAY_SPEED}x speed: ~${replayDurationMin.toFixed(0)} min\n`);

  // Create fake WS and detector
  const fakeWS = new FakeOrderBookWS() as unknown as OrderBookWebSocket;
  const detector = new ShockFadeDetector(fakeWS, SHOCK_CONFIG);

  for (const m of markets) {
    detector.registerMarketTokens([m.token1, m.token2], m.market_slug);
  }
  detector.start();

  const trader = new MockTrader();
  for (const m of markets) {
    trader.setMarketTokens(m.market_slug, m.token1, m.token2, m.outcome1, m.outcome2);
    registerTokenPair(m.token1, m.token2, m.market_slug);
  }

  // Create dashboard
  const dashboard = new ShockFadeDashboardServer({ port: PORT });
  dashboard.setDetector(detector);
  dashboard.setTrader(trader as any);
  dashboard.setMode("paper");

  const marketsMap = new Map<string, SportsMarket>();
  for (const m of markets) {
    marketsMap.set(m.market_slug, {
      eventSlug: m.market_slug,
      marketSlug: m.market_slug,
      conditionId: m.condition_id,
      sport: "NBA",
      question: `${m.outcome1} vs ${m.outcome2}`,
      outcomes: [m.outcome1, m.outcome2],
      tokenIds: [m.token1, m.token2],
      outcomePrices: [0.5, 0.5],
      gameStartTime: new Date(globalFirstTs),
      discoveredAt: new Date(),
      volume: 100000,
      liquidity: 50000,
      state: "active" as any,
      stateChangedAt: new Date(),
      sportConfig: null,
      negRisk: true,
    });
  }
  dashboard.setMarkets(marketsMap);

  // Wire shock events — two-phase classification using REAL game events
  // Track recent shocks per market for scoring run detection
  const recentShocksPerMarket = new Map<string, number[]>(); // market → timestamps

  detector.on("shock", (shock: ShockEvent) => {
    shock.classification = "unclassified";
    dashboard.notifyShockDetected(shock);
    // DON'T place orders yet — wait for classification (matches live bot flow)

    const classifyDelay = Math.floor(Math.random() * 2000 + 1000); // 1-3s

    setTimeout(() => {
      // Real classification: check if a scoring event happened near this shock
      const shockSec = Math.floor(shock.timestamp / 1000);
      const marketScoring = scoringSeconds.get(shock.marketSlug);
      const hadScoringEvent = marketScoring?.has(shockSec) ?? false;

      // Track recent shocks for scoring run detection
      if (!recentShocksPerMarket.has(shock.marketSlug)) recentShocksPerMarket.set(shock.marketSlug, []);
      const recent = recentShocksPerMarket.get(shock.marketSlug)!;
      recent.push(shock.timestamp);
      // Keep only last 60s of shocks
      while (recent.length > 0 && shock.timestamp - recent[0] > 60000) recent.shift();

      let classification: string;
      if (!hadScoringEvent) {
        classification = "noise"; // No game event → noise/structural
      } else if (recent.length >= 3) {
        classification = "scoring_run"; // 3+ shocks in 60s with events = scoring run
      } else {
        classification = "single_event";
      }

      shock.classification = classification as any;
      dashboard.notifyShockClassified(shock.marketSlug, classification, classifyDelay);

      if (classification === "single_event") {
        dashboard.addLog("SHOCK", `✅ single_event confirmed → placing orders [${shock.marketSlug}]`);
        trader.handleShock(shock, dashboard); // NOW place orders
      } else {
        dashboard.addLog("SHOCK", `❌ ${classification} → skip [${shock.marketSlug}]`);
        // No orders were placed, nothing to cancel
      }
    }, classifyDelay);
  });

  await dashboard.start();
  dashboard.addLog("SYS", `Replay started — ${REPLAY_SPEED}x speed, ${markets.length} games, trade-based OHLC`);
  console.log(`✅ Dashboard running at http://0.0.0.0:${PORT}`);
  console.log(`   Replaying at ${REPLAY_SPEED}x speed (trade-based OHLC bars)\n`);

  // Pre-seed detector with 2 min of bars before replay start
  console.log("Pre-seeding detector...");
  const seedTrades = db.prepare(`
    SELECT ts, market_slug, token_id, price, size, side FROM trades
    WHERE market_slug IN (${GAME_SLUGS.map(() => "?").join(",")})
    AND ts >= ? AND ts < ?
    ORDER BY ts
  `).all(...GAME_SLUGS, replayFrom - 120000, replayFrom) as RawTrade[];

  const seedBars = aggregateTrades(seedTrades, OHLC_INTERVAL_MS);
  for (const bar of seedBars) {
    const bid = bar.lastSell;
    const ask = bar.lastBuy;
    const mid = bar.close;
    fakeWS.emit("priceUpdate", { tokenId: bar.tokenId, bid, ask, timestamp: bar.ts });
    trader.updatePrice(bar.tokenId, bid, ask, mid);

    // Complement pricing
    const pair = tokenPairs.get(bar.tokenId);
    if (pair) {
      const compBid = Math.max(0.01, 1.0 - ask);
      const compAsk = Math.min(0.99, 1.0 - bid);
      const compMid = 1.0 - mid;
      fakeWS.emit("priceUpdate", { tokenId: pair.complementId, bid: compBid, ask: compAsk, timestamp: bar.ts });
      trader.updatePrice(pair.complementId, compBid, compAsk, compMid);
    }

    const mkt = marketsMap.get(bar.marketSlug);
    if (mkt) {
      const idx = mkt.tokenIds.indexOf(bar.tokenId);
      if (idx >= 0) mkt.outcomePrices[idx] = mid;
      if (pair) {
        const idx2 = mkt.tokenIds.indexOf(pair.complementId);
        if (idx2 >= 0) mkt.outcomePrices[idx2] = 1.0 - mid;
      }
    }
  }
  console.log(`Pre-seeded with ${seedBars.length} bars. Starting replay...\n`);

  // Load game events (deduplicated)
  const gameEvents = db.prepare(
    `SELECT * FROM game_events WHERE market_slug IN (${GAME_SLUGS.map(() => "?").join(",")}) ORDER BY ts`
  ).all(...GAME_SLUGS) as any[];
  let eventIdx = 0;
  const seenGameEvents = new Set<string>();

  // Build a lookup: for each second, which markets had a scoring event?
  // Used for real classification instead of random
  const scoringSeconds = new Map<string, Set<number>>(); // market_slug → set of seconds
  const dedupedGoals = new Set<string>();
  for (const evt of gameEvents) {
    if (evt.event_type !== "goal") continue;
    const dedupKey = `${evt.market_slug}:${evt.team}:${evt.period}:${evt.clock}:${evt.description}`;
    if (dedupedGoals.has(dedupKey)) continue;
    dedupedGoals.add(dedupKey);
    const sec = Math.floor(evt.ts / 1000);
    if (!scoringSeconds.has(evt.market_slug)) scoringSeconds.set(evt.market_slug, new Set());
    // Mark a 30-second window around the event
    for (let s = sec - 15; s <= sec + 15; s++) {
      scoringSeconds.get(evt.market_slug)!.add(s);
    }
  }
  console.log(`Loaded ${gameEvents.length} game events (${dedupedGoals.size} unique goals)`);

  // Running score tracker for score_update display
  const runningScores = new Map<string, { home: string; away: string; homeScore: number; awayScore: number }>();
  for (const m of markets) {
    runningScores.set(m.market_slug, {
      home: m.outcome1,
      away: m.outcome2,
      homeScore: 0,
      awayScore: 0,
    });
  }

  // REPLAY LOOP — read trades in batches, aggregate into OHLC bars, replay at speed
  const TRADE_BATCH_SIZE = 50000;
  let tradeOffset = 0;
  let replayStartWall = Date.now();
  let replayStartData = replayFrom;
  let totalBarsEmitted = 0;
  let lastBarTs = replayFrom; // Track across batches for gap detection

  async function replayLoop() {
    while (true) {
      const rawTrades = db.prepare(`
        SELECT ts, market_slug, token_id, price, size, side FROM trades
        WHERE market_slug IN (${GAME_SLUGS.map(() => "?").join(",")})
        AND ts >= ?
        ORDER BY ts
        LIMIT ? OFFSET ?
      `).all(...GAME_SLUGS, replayFrom, TRADE_BATCH_SIZE, tradeOffset) as RawTrade[];

      // Check if we've passed the end of game data
      if (rawTrades.length === 0 || (rawTrades.length > 0 && rawTrades[0].ts > replayUntil)) {
        console.log("\n✅ Replay complete!\n");
        const finalStats = trader.getStats();
        console.log("═══════════════════════════════════════════");
        console.log("  FINAL REPLAY RESULTS");
        console.log("═══════════════════════════════════════════");
        console.log(`  Shocks detected:  ${finalStats.totalShocksDetected}`);
        console.log(`  Orders placed:    ${finalStats.totalOrdersPlaced}`);
        console.log(`  Orders filled:    ${finalStats.totalOrdersFilled}`);
        console.log(`  Orders expired:   ${finalStats.totalOrdersExpired}`);
        console.log(`  Orders cancelled: ${finalStats.totalOrdersCancelled}`);
        console.log(`  Positions opened: ${finalStats.totalPositionsOpened}`);
        console.log(`  Positions closed: ${finalStats.totalPositionsClosed}`);
        console.log(`  Win/Loss:         ${finalStats.winCount}W / ${finalStats.lossCount}L (${(finalStats.winRate * 100).toFixed(1)}%)`);
        console.log(`  Total P&L:        $${finalStats.totalPnL.toFixed(2)}`);
        console.log(`  Sharpe:           ${finalStats.sharpeRatio.toFixed(3)}`);
        console.log(`  Avg fade capture: ${finalStats.avgFadeCaptureCents.toFixed(1)}¢`);
        console.log(`  Avg hold time:    ${((finalStats.avgHoldTimeMs || 0) / 1000).toFixed(0)}s`);
        console.log("═══════════════════════════════════════════");
        console.log("\nTrades:");
        for (const t of trader.getTrades()) {
          console.log(`  ${t.marketSlug} | ${t.exitReason} | P&L: ${t.pnl >= 0 ? '+' : ''}${t.pnl.toFixed(2)}¢ | fade: ${t.fadeCapture.toFixed(1)}¢ | hold: ${(t.holdTimeMs/1000).toFixed(0)}s`);
        }
        console.log("═══════════════════════════════════════════");
        dashboard.addLog("SYS", `Replay finished — P&L: $${finalStats.totalPnL.toFixed(2)}, ${finalStats.winCount}W/${finalStats.lossCount}L (${(finalStats.winRate*100).toFixed(1)}%), Sharpe: ${finalStats.sharpeRatio.toFixed(3)}`);
        // Keep dashboard alive so Andy can see final state
        console.log("\nDashboard still running at http://0.0.0.0:3032 — Ctrl+C to stop");
        break;
      }
      
      // Filter out trades past replayUntil
      const trimmedTrades = rawTrades.filter(t => t.ts <= replayUntil);
      if (trimmedTrades.length < rawTrades.length) {
        // We've hit the end — process remaining and loop next iteration
      }

      // Aggregate trades into OHLC bars
      const bars = aggregateTrades(trimmedTrades, OHLC_INTERVAL_MS);

      // Deduplicate bars: if same token+ts appears multiple times (from batch overlap), keep last
      const seenBarKeys = new Set<string>();
      const dedupedBars = [];
      for (let i = bars.length - 1; i >= 0; i--) {
        const key = `${bars[i].tokenId}:${bars[i].ts}`;
        if (!seenBarKeys.has(key)) {
          seenBarKeys.add(key);
          dedupedBars.unshift(bars[i]);
        }
      }

      for (const bar of dedupedBars) {
        // Gap-skip: if there's a long gap in the data (e.g., between games),
        // fast-forward the replay clock instead of sleeping through it
        const dataGap = bar.ts - lastBarTs;
        if (dataGap > MAX_GAP_MS) {
          const skippedMin = (dataGap - MAX_GAP_MS) / 60000;
          console.log(`⏩ Skipping ${skippedMin.toFixed(1)} min gap (${new Date(lastBarTs).toISOString()} → ${new Date(bar.ts).toISOString()})`);
          dashboard.addLog("SYS", `⏩ Skipped ${skippedMin.toFixed(0)} min gap between games`);
          // Advance the wall clock reference to absorb the gap
          replayStartWall -= (dataGap - MAX_GAP_MS) / REPLAY_SPEED;
        }
        lastBarTs = bar.ts;

        // Calculate wait time at replay speed
        const dataElapsed = bar.ts - replayStartData;
        const wallTarget = replayStartWall + dataElapsed / REPLAY_SPEED;
        const waitMs = wallTarget - Date.now();

        if (waitMs > 0) {
          await sleep(Math.min(waitMs, 2000));
        }

        // Primary token: use trade-derived prices
        const bid = bar.lastSell;
        const ask = bar.lastBuy;
        const mid = bar.close;

        // Feed primary token to detector
        fakeWS.emit("priceUpdate", {
          tokenId: bar.tokenId,
          bid,
          ask,
          timestamp: bar.ts,
        });
        trader.updatePrice(bar.tokenId, bid, ask, mid);

        // Complement token: enforce tokenA + tokenB = $1
        const pair = tokenPairs.get(bar.tokenId);
        if (pair) {
          const compBid = Math.max(0.01, 1.0 - ask);  // complement bid = 1 - primary ask
          const compAsk = Math.min(0.99, 1.0 - bid);   // complement ask = 1 - primary bid
          const compMid = 1.0 - mid;

          fakeWS.emit("priceUpdate", {
            tokenId: pair.complementId,
            bid: compBid,
            ask: compAsk,
            timestamp: bar.ts,
          });
          trader.updatePrice(pair.complementId, compBid, compAsk, compMid);

          // Update both token prices in market
          const mkt = marketsMap.get(bar.marketSlug);
          if (mkt) {
            const idx1 = mkt.tokenIds.indexOf(bar.tokenId);
            const idx2 = mkt.tokenIds.indexOf(pair.complementId);
            if (idx1 >= 0) mkt.outcomePrices[idx1] = mid;
            if (idx2 >= 0) mkt.outcomePrices[idx2] = compMid;
            dashboard.updateMarket(mkt);
          }
        }

        // Check orders/positions
        trader.tickOrders(Date.now(), dashboard);

        // Emit game events (deduplicated by description+period+clock)
        while (eventIdx < gameEvents.length && gameEvents[eventIdx].ts <= bar.ts) {
          const evt = gameEvents[eventIdx];
          const evtKey = `${evt.market_slug}:${evt.event_type}:${evt.team}:${evt.period}:${evt.clock}:${evt.description}`;
          if (!seenGameEvents.has(evtKey)) {
            seenGameEvents.add(evtKey);
            if (evt.event_type === "goal") {
              dashboard.addGameEvent(evt.market_slug, `🏀 ${evt.team} — ${evt.description} (${evt.period} ${evt.clock || ""})`, "NBA");

              // Smart event exit — check if any active cycles should exit
              const eventTeamAbbrev = (evt.team || "").toUpperCase().trim();
              trader.handleGameEvent(evt.market_slug, eventTeamAbbrev, dashboard);

              // Update running score
              const scoreState = runningScores.get(evt.market_slug);
              if (scoreState) {
                // Figure out how many points this basket was worth from description
                let points = 2; // default
                const desc = (evt.description || "").toLowerCase();
                if (desc.includes("three point") || desc.includes("3-pt") || desc.includes("3pt") || desc.includes("three-point")) points = 3;
                else if (desc.includes("free throw") || desc.includes("ft")) points = 1;
                
                // Match team to home/away using abbreviation map
                const teamAbbrev = (evt.team || "").toUpperCase().trim();
                const resolvedName = NBA_ABBREV[teamAbbrev] || teamAbbrev;
                const homeLower = scoreState.home.toLowerCase();
                const awayLower = scoreState.away.toLowerCase();
                const resolvedLower = resolvedName.toLowerCase();
                
                if (resolvedLower === homeLower || homeLower.includes(resolvedLower) || resolvedLower.includes(homeLower)) {
                  scoreState.homeScore += points;
                } else if (resolvedLower === awayLower || awayLower.includes(resolvedLower) || resolvedLower.includes(awayLower)) {
                  scoreState.awayScore += points;
                } else {
                  // Last resort: check if abbrev directly matches slug
                  const slugLower = evt.market_slug.toLowerCase();
                  const parts = slugLower.replace("nba-", "").split("-");
                  if (parts[0] === teamAbbrev.toLowerCase()) {
                    scoreState.homeScore += points; // first team in slug = away in "away@home" format... but Polymarket uses home-away
                  } else {
                    scoreState.awayScore += points;
                  }
                }

                dashboard.updateScore({
                  marketSlug: evt.market_slug,
                  homeTeam: scoreState.home,
                  awayTeam: scoreState.away,
                  homeScore: scoreState.homeScore,
                  awayScore: scoreState.awayScore,
                  period: evt.period || "",
                  clock: evt.clock || "",
                  sport: "NBA",
                });
              }
            }
          }
          eventIdx++;
        }

        totalBarsEmitted++;
        if (totalBarsEmitted % 2000 === 0) {
          const elapsed = (Date.now() - replayStartWall) / 1000;
          const dataMin = (bar.ts - replayStartData) / 60000;
          console.log(`  📊 ${totalBarsEmitted} bars (${dataMin.toFixed(0)} min game time in ${elapsed.toFixed(0)}s wall)`);
        }
      }

      tradeOffset += TRADE_BATCH_SIZE;
    }
  }

  replayLoop().catch(err => {
    console.error("Replay error:", err);
    process.exit(1);
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

main().catch(err => {
  console.error("Fatal:", err);
  process.exit(1);
});
