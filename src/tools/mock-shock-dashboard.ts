/**
 * Mock Shock-Fade Dashboard Server
 *
 * Creates a fully alive ShockFadeDashboardServer on port 3032 with:
 * - 3 live NBA games with drifting prices
 * - Periodic shock events (every 15-30s)
 * - Ladder order placement → fills → positions → take-profit exits
 * - Running stats (P&L, win rate, Sharpe, etc.)
 * - Score updates, game events, session log
 *
 * Usage: npx tsx src/tools/mock-shock-dashboard.ts
 */

import { ShockFadeDashboardServer } from "../dashboard/ShockFadeDashboard.js";

// ============================================================================
// HELPERS
// ============================================================================

function rand(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

function randInt(min: number, max: number): number {
  return Math.floor(rand(min, max + 1));
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function uuid(): string {
  return "mock-" + Math.random().toString(36).slice(2, 10) + "-" + Date.now().toString(36);
}

// ============================================================================
// INTERFACES (duck-typed to satisfy ShockFadeDashboard's getters)
// ============================================================================

interface ShockEvent {
  type: "shock";
  tokenId: string;
  marketSlug: string;
  direction: "up" | "down";
  magnitude: number;
  zScore: number;
  preShockPrice: number;
  currentPrice: number;
  timestamp: number;
  classification?: "single_event" | "scoring_run" | "structural" | "unclassified";
}

interface LadderOrder {
  id: string;
  tokenId: string;
  marketSlug: string;
  side: "SELL";
  leg: "ENTRY" | "EXIT";
  price: number;
  size: number;
  shares: number;
  level: number;
  status: "PENDING" | "FILLED" | "CANCELLED" | "EXPIRED";
  createdAt: number;
  filledAt: number | null;
  fillPrice: number | null;
  shockId: string;
  splitCost: number;
}

interface FadePosition {
  id: string;
  marketSlug: string;
  soldTokenId: string;
  soldPrice: number;
  soldShares: number;
  heldTokenId: string;
  heldShares: number;
  splitCost: number;
  entryTime: number;
  takeProfitPrice: number;
  status: "OPEN" | "TAKE_PROFIT" | "HEDGED" | "CLOSED";
  exitPrice: number | null;
  exitTime: number | null;
  pnl: number | null;
  shockId: string;
  orderId: string;
}

interface TradeRecord {
  id: string;
  marketSlug: string;
  soldTokenId: string;
  soldPrice: number;
  soldShares: number;
  heldTokenId: string;
  exitPrice: number;
  exitShares: number;
  pnl: number;
  splitCost: number;
  totalProceeds: number;
  entryTime: number;
  exitTime: number;
  shockMagnitude: number;
  shockZScore: number;
  fadeCapture: number;
  holdTimeMs: number;
}

interface ShockFadePaperStats {
  totalShocksDetected: number;
  totalOrdersPlaced: number;
  totalOrdersFilled: number;
  totalOrdersCancelled: number;
  totalOrdersExpired: number;
  totalPositionsOpened: number;
  totalPositionsClosed: number;
  totalPnL: number;
  totalSplitCost: number;
  totalProceeds: number;
  winCount: number;
  lossCount: number;
  winRate: number;
  avgFadeCaptureCents: number;
  avgHoldTimeMs: number;
  sharpeRatio: number;
  maxDrawdown: number;
  runningBalance: number;
  startedAt: number | null;
}

interface SportsMarket {
  marketSlug: string;
  sport: string;
  question: string;
  outcomes: string[];
  tokenIds: string[];
  volume: number;
  liquidity: number;
  state: "active" | "pending_entry" | "closed";
  gameStartTime: Date | null;
}

interface PriceData {
  bid: number;
  ask: number;
  mid: number;
}

// ============================================================================
// GAME DEFINITIONS
// ============================================================================

interface GameDef {
  slug: string;
  sport: string;
  question: string;
  team1: string;
  team2: string;
  tokenId1: string;
  tokenId2: string;
  initMid1: number; // initial mid price for team1
}

const GAMES: GameDef[] = [
  {
    slug: "nba-lal-bos-2026-02-10",
    sport: "NBA",
    question: "Will the Los Angeles Lakers beat the Boston Celtics?",
    team1: "Lakers",
    team2: "Celtics",
    tokenId1: "tok-lal-yes",
    tokenId2: "tok-lal-no",
    initMid1: 0.52,
  },
  {
    slug: "nba-gsw-phx-2026-02-10",
    sport: "NBA",
    question: "Will the Golden State Warriors beat the Phoenix Suns?",
    team1: "Warriors",
    team2: "Suns",
    tokenId1: "tok-gsw-yes",
    tokenId2: "tok-gsw-no",
    initMid1: 0.45,
  },
  {
    slug: "nba-mil-mia-2026-02-10",
    sport: "NBA",
    question: "Will the Milwaukee Bucks beat the Miami Heat?",
    team1: "Bucks",
    team2: "Heat",
    tokenId1: "tok-mil-yes",
    tokenId2: "tok-mil-no",
    initMid1: 0.60,
  },
];

// ============================================================================
// SIMULATION STATE
// ============================================================================

// Price map: tokenId → PriceData
const prices = new Map<string, PriceData>();

// Game scores
const scores = new Map<string, { home: number; away: number; period: number; clock: string }>();

// Data stores
const allShocks: ShockEvent[] = [];
const allOrders: LadderOrder[] = [];
const allPositions: FadePosition[] = [];
const tradeHistory: TradeRecord[] = [];

// Stats
const stats: ShockFadePaperStats = {
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

// Track PnLs for Sharpe calculation
const pnlHistory: number[] = [];

// ============================================================================
// INITIALIZATION
// ============================================================================

function initPrices(): void {
  for (const g of GAMES) {
    const mid1 = g.initMid1;
    const mid2 = 1.0 - mid1;
    const spread = rand(0.01, 0.02);
    prices.set(g.tokenId1, {
      bid: mid1 - spread / 2,
      ask: mid1 + spread / 2,
      mid: mid1,
    });
    prices.set(g.tokenId2, {
      bid: mid2 - spread / 2,
      ask: mid2 + spread / 2,
      mid: mid2,
    });
  }
}

function initScores(): void {
  for (const g of GAMES) {
    scores.set(g.slug, {
      home: randInt(15, 45),
      away: randInt(15, 45),
      period: randInt(1, 3),
      clock: `${randInt(0, 11)}:${String(randInt(0, 59)).padStart(2, "0")}`,
    });
  }
}

// ============================================================================
// PRICE DRIFT
// ============================================================================

function driftPrices(): void {
  for (const g of GAMES) {
    const p1 = prices.get(g.tokenId1)!;
    // Random walk with mean-reversion toward anchor
    const anchor = g.initMid1;
    const drift = rand(-0.008, 0.008) + (anchor - p1.mid) * 0.02;
    const newMid1 = clamp(p1.mid + drift, 0.10, 0.90);
    const newMid2 = clamp(1.0 - newMid1, 0.10, 0.90);
    const spread1 = rand(0.008, 0.020);
    const spread2 = rand(0.008, 0.020);

    prices.set(g.tokenId1, {
      bid: Math.max(0.01, newMid1 - spread1 / 2),
      ask: Math.min(0.99, newMid1 + spread1 / 2),
      mid: newMid1,
    });
    prices.set(g.tokenId2, {
      bid: Math.max(0.01, newMid2 - spread2 / 2),
      ask: Math.min(0.99, newMid2 + spread2 / 2),
      mid: newMid2,
    });
  }
}

// ============================================================================
// SCORE DRIFT
// ============================================================================

function driftScore(dashboard: ShockFadeDashboardServer): void {
  const game = pick(GAMES);
  const sc = scores.get(game.slug)!;

  const isHome = Math.random() > 0.5;
  const pts = pick([2, 2, 2, 3, 3, 1]); // weighted toward 2s and 3s
  if (isHome) {
    sc.home += pts;
  } else {
    sc.away += pts;
  }

  // Advance clock
  const clockMin = parseInt(sc.clock.split(":")[0]);
  const newMin = Math.max(0, clockMin - randInt(0, 2));
  const newSec = randInt(0, 59);
  sc.clock = `${newMin}:${String(newSec).padStart(2, "0")}`;

  // Occasionally advance period
  if (newMin === 0 && Math.random() > 0.7 && sc.period < 4) {
    sc.period++;
    sc.clock = `12:00`;
  }

  const scorer = isHome ? game.team1 : game.team2;
  const periodNames = ["", "1st Q", "2nd Q", "3rd Q", "4th Q", "OT"];

  dashboard.updateScore({
    marketSlug: game.slug,
    homeTeam: game.team1,
    awayTeam: game.team2,
    homeScore: sc.home,
    awayScore: sc.away,
    period: periodNames[sc.period] || `Q${sc.period}`,
    clock: sc.clock,
    sport: "NBA",
  });

  // Add game event
  const events = [
    `🏀 ${scorer} scores ${pts}pt${pts > 1 ? "s" : ""}`,
    `${scorer} ${pts === 3 ? "three-pointer" : pts === 2 ? "layup" : "free throw"}!`,
    `${scorer} ${pick(["jumper", "dunk", "floater", "pull-up", "fast break"])} for ${pts}`,
  ];
  dashboard.addGameEvent(game.slug, pick(events), "NBA");
}

// ============================================================================
// SHOCK SIMULATION
// ============================================================================

function simulateShock(dashboard: ShockFadeDashboardServer): void {
  const game = pick(GAMES);
  const direction: "up" | "down" = Math.random() > 0.5 ? "up" : "down";

  // Pick the token that gets shocked
  const shockedTokenId = direction === "up" ? game.tokenId1 : game.tokenId2;
  const prePrice = prices.get(shockedTokenId)!.mid;

  // Apply shock magnitude (2-8 cents)
  const magCents = rand(2, 8);
  const magnitude = magCents / 100;
  const zScore = rand(2.0, 4.0);

  // Move price
  const newMid = clamp(prePrice + magnitude, 0.15, 0.92);
  const spread = rand(0.008, 0.018);
  prices.set(shockedTokenId, {
    bid: newMid - spread / 2,
    ask: newMid + spread / 2,
    mid: newMid,
  });

  // Complement moves opposite
  const compTokenId = shockedTokenId === game.tokenId1 ? game.tokenId2 : game.tokenId1;
  const compMid = clamp(1.0 - newMid, 0.08, 0.85);
  const compSpread = rand(0.008, 0.018);
  prices.set(compTokenId, {
    bid: compMid - compSpread / 2,
    ask: compMid + compSpread / 2,
    mid: compMid,
  });

  const classification = pick(["single_event", "scoring_run", "structural", "unclassified"] as const);

  const shock: ShockEvent = {
    type: "shock",
    tokenId: shockedTokenId,
    marketSlug: game.slug,
    direction,
    magnitude,
    zScore: parseFloat(zScore.toFixed(1)),
    preShockPrice: parseFloat(prePrice.toFixed(4)),
    currentPrice: parseFloat(newMid.toFixed(4)),
    timestamp: Date.now(),
    classification,
  };

  allShocks.push(shock);
  stats.totalShocksDetected++;

  dashboard.notifyShockDetected(shock);
  dashboard.addLog("SHOCK", `Detected ${direction} shock on ${game.slug}: ${(magnitude * 100).toFixed(1)}¢ (${zScore.toFixed(1)}σ) [${classification}]`);

  // Create ladder orders for this shock
  createLadderOrders(dashboard, game, shock);
}

// ============================================================================
// LADDER ORDERS
// ============================================================================

function createLadderOrders(
  dashboard: ShockFadeDashboardServer,
  game: GameDef,
  shock: ShockEvent,
): void {
  const shockId = uuid();
  const levels = 3;
  const spacing = 0.01; // 1¢ between levels
  const basePrice = shock.currentPrice;
  const orders: LadderOrder[] = [];

  // We sell the shocked (spiked) token
  const soldTokenId = shock.tokenId;

  for (let level = 1; level <= levels; level++) {
    const sellPrice = parseFloat((basePrice + level * spacing).toFixed(4));
    const shares = parseFloat(rand(30, 60).toFixed(0));
    const splitCost = parseFloat((shares * 1.0).toFixed(2)); // $1 per share pair

    const order: LadderOrder = {
      id: uuid(),
      tokenId: soldTokenId,
      marketSlug: game.slug,
      side: "SELL",
      leg: "ENTRY",
      price: sellPrice,
      size: parseFloat((shares * sellPrice).toFixed(2)),
      shares,
      level,
      status: "PENDING",
      createdAt: Date.now(),
      filledAt: null,
      fillPrice: null,
      shockId,
      splitCost,
    };

    allOrders.push(order);
    orders.push(order);
    stats.totalOrdersPlaced++;
    dashboard.notifyOrderPlaced(order);
  }

  // Randomly fill orders over 3-5 seconds
  fillOrdersGradually(dashboard, game, orders, shock, shockId);
}

function fillOrdersGradually(
  dashboard: ShockFadeDashboardServer,
  game: GameDef,
  orders: LadderOrder[],
  shock: ShockEvent,
  shockId: string,
): void {
  let fillIndex = 0;

  function fillNext(): void {
    if (fillIndex >= orders.length) return;

    const order = orders[fillIndex];

    // 80% chance to fill, 15% cancel, 5% expire
    const roll = Math.random();
    if (roll < 0.80) {
      // FILL
      order.status = "FILLED";
      order.filledAt = Date.now();
      order.fillPrice = parseFloat((order.price + rand(-0.005, 0.005)).toFixed(4));
      stats.totalOrdersFilled++;
      dashboard.notifyOrderFilled(order);

      // Create position from this fill
      createPositionFromFill(dashboard, game, order, shock, shockId);
    } else if (roll < 0.95) {
      // CANCEL
      order.status = "CANCELLED";
      stats.totalOrdersCancelled++;
      dashboard.notifyOrderCancelled(order, "price moved away");
    } else {
      // EXPIRE
      order.status = "EXPIRED";
      stats.totalOrdersExpired++;
      dashboard.notifyOrderCancelled(order, "expired");
    }

    fillIndex++;
    if (fillIndex < orders.length) {
      setTimeout(fillNext, rand(800, 1800));
    }
  }

  // Start filling after 1-2s
  setTimeout(fillNext, rand(1000, 2000));
}

// ============================================================================
// POSITION MANAGEMENT
// ============================================================================

function createPositionFromFill(
  dashboard: ShockFadeDashboardServer,
  game: GameDef,
  order: LadderOrder,
  shock: ShockEvent,
  shockId: string,
): void {
  // Determine held token (complement of sold)
  const heldTokenId = order.tokenId === game.tokenId1 ? game.tokenId2 : game.tokenId1;

  const pos: FadePosition = {
    id: uuid(),
    marketSlug: game.slug,
    soldTokenId: order.tokenId,
    soldPrice: order.fillPrice || order.price,
    soldShares: order.shares,
    heldTokenId,
    heldShares: order.shares,
    splitCost: order.splitCost,
    entryTime: Date.now(),
    takeProfitPrice: parseFloat((1.0 - (order.fillPrice || order.price) + 0.03).toFixed(4)),
    status: "OPEN",
    exitPrice: null,
    exitTime: null,
    pnl: null,
    shockId,
    orderId: order.id,
  };

  allPositions.push(pos);
  stats.totalPositionsOpened++;

  dashboard.addLog("ORDER", `Position opened: SELL ${game.slug} @ ${((order.fillPrice || order.price) * 100).toFixed(1)}¢ × ${order.shares} shares`);

  // Schedule close after 10-45 seconds
  const closeDelay = rand(10000, 45000);
  setTimeout(() => closePosition(dashboard, game, pos, shock), closeDelay);
}

function closePosition(
  dashboard: ShockFadeDashboardServer,
  game: GameDef,
  pos: FadePosition,
  shock: ShockEvent,
): void {
  if (pos.status !== "OPEN") return;

  const heldPrice = prices.get(pos.heldTokenId)?.mid || 0.50;

  // Calculate exit
  const exitPrice = parseFloat((heldPrice + rand(-0.02, 0.02)).toFixed(4));
  const soldProceeds = pos.soldPrice * pos.soldShares;
  const exitProceeds = exitPrice * pos.heldShares;
  const totalProceeds = soldProceeds + exitProceeds;
  const pnl = parseFloat((totalProceeds - pos.splitCost).toFixed(4));

  // 60% take profit, 40% other exits
  pos.status = Math.random() > 0.4 ? "TAKE_PROFIT" : pick(["HEDGED", "CLOSED"]);
  pos.exitPrice = exitPrice;
  pos.exitTime = Date.now();
  pos.pnl = pnl;

  stats.totalPositionsClosed++;
  stats.totalSplitCost += pos.splitCost;
  stats.totalProceeds += totalProceeds;
  stats.totalPnL = parseFloat((stats.totalPnL + pnl).toFixed(4));

  if (pnl > 0) {
    stats.winCount++;
  } else {
    stats.lossCount++;
  }

  const totalTrades = stats.winCount + stats.lossCount;
  stats.winRate = totalTrades > 0 ? parseFloat((stats.winCount / totalTrades).toFixed(4)) : 0;

  // Track for Sharpe
  pnlHistory.push(pnl);
  if (pnlHistory.length >= 3) {
    const mean = pnlHistory.reduce((a, b) => a + b, 0) / pnlHistory.length;
    const variance = pnlHistory.reduce((a, b) => a + (b - mean) ** 2, 0) / pnlHistory.length;
    const stdDev = Math.sqrt(variance);
    stats.sharpeRatio = stdDev > 0 ? parseFloat((mean / stdDev).toFixed(2)) : 0;
  }

  // Max drawdown
  let peak = 0;
  let maxDD = 0;
  let running = 0;
  for (const p of pnlHistory) {
    running += p;
    if (running > peak) peak = running;
    const dd = peak - running;
    if (dd > maxDD) maxDD = dd;
  }
  stats.maxDrawdown = parseFloat(maxDD.toFixed(2));
  stats.runningBalance = parseFloat((1000 + stats.totalPnL).toFixed(2));

  // Avg fade capture and hold time
  const fadeCapture = parseFloat(((shock.currentPrice - exitPrice) * 100).toFixed(2));
  const holdTimeMs = (pos.exitTime || Date.now()) - pos.entryTime;

  const allClosedPos = allPositions.filter((p) => p.status !== "OPEN" && p.pnl !== null);
  stats.avgHoldTimeMs = allClosedPos.length > 0
    ? Math.round(allClosedPos.reduce((s, p) => s + ((p.exitTime || Date.now()) - p.entryTime), 0) / allClosedPos.length)
    : 0;

  // Build trade record
  const record: TradeRecord = {
    id: uuid(),
    marketSlug: game.slug,
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
    exitTime: pos.exitTime || Date.now(),
    shockMagnitude: shock.magnitude,
    shockZScore: shock.zScore,
    fadeCapture,
    holdTimeMs,
  };

  tradeHistory.push(record);

  // Compute avg fade capture across all trades
  stats.avgFadeCaptureCents = tradeHistory.length > 0
    ? parseFloat((tradeHistory.reduce((s, t) => s + t.fadeCapture, 0) / tradeHistory.length).toFixed(2))
    : 0;

  dashboard.notifyPositionClosed(pos as any, record as any);
  dashboard.addLog(
    "TRADE",
    `Position closed [${pos.status}]: ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)} on ${game.slug} (hold ${(holdTimeMs / 1000).toFixed(0)}s)`,
  );
}

// ============================================================================
// MOCK DETECTOR & TRADER OBJECTS
// ============================================================================

function createMockDetector() {
  return {
    getRecentShocks(windowMs: number): ShockEvent[] {
      const cutoff = Date.now() - windowMs;
      return allShocks.filter((s) => s.timestamp >= cutoff);
    },
    getConfig() {
      return {
        sigmaThreshold: 2.0,
        minAbsoluteMove: 0.02,
        rollingWindowMs: 300_000,
        ladderLevels: 3,
        ladderSpacing: 0.01,
        fadeTargetCents: 3,
        fadeWindowMs: 600_000,
        maxPositionSize: 100,
        cooldownMs: 30_000,
        targetPriceRange: [0.15, 0.85] as [number, number],
      };
    },
  };
}

function createMockTrader() {
  return {
    getStats(): ShockFadePaperStats {
      return { ...stats };
    },
    getActiveOrders(): LadderOrder[] {
      return allOrders.filter((o) => o.status === "PENDING");
    },
    getAllOrders(): LadderOrder[] {
      return [...allOrders];
    },
    getOpenPositions(): FadePosition[] {
      return allPositions.filter((p) => p.status === "OPEN");
    },
    getAllPositions(): FadePosition[] {
      return [...allPositions];
    },
    getTradeHistory(): TradeRecord[] {
      return [...tradeHistory];
    },
    getCumulativeTPs(): any[] {
      // Build cumulative TP info from open positions
      const openByMarket = new Map<string, FadePosition[]>();
      for (const p of allPositions.filter((p) => p.status === "OPEN")) {
        const existing = openByMarket.get(p.marketSlug) || [];
        existing.push(p);
        openByMarket.set(p.marketSlug, existing);
      }
      const tps: any[] = [];
      for (const [slug, posArr] of openByMarket) {
        const totalShares = posArr.reduce((s, p) => s + p.soldShares, 0);
        tps.push({
          marketSlug: slug,
          shockId: posArr[0].shockId,
          heldTokenId: posArr[0].heldTokenId,
          tpPrice: posArr[0].takeProfitPrice,
          totalEntryShares: totalShares,
          tpShares: totalShares,
          filledTPShares: 0,
          status: "WATCHING",
        });
      }
      return tps;
    },
    getLatestPrice(tokenId: string): PriceData | undefined {
      return prices.get(tokenId);
    },
  };
}

function createMarketsMap(): Map<string, SportsMarket> {
  const m = new Map<string, SportsMarket>();
  for (const g of GAMES) {
    m.set(g.slug, {
      marketSlug: g.slug,
      sport: g.sport,
      question: g.question,
      outcomes: [g.team1, g.team2],
      tokenIds: [g.tokenId1, g.tokenId2],
      volume: randInt(50_000, 250_000),
      liquidity: randInt(20_000, 100_000),
      state: "active",
      gameStartTime: new Date(Date.now() - 60 * 60_000), // started 1h ago
    });
  }
  return m;
}

// ============================================================================
// MAIN
// ============================================================================

async function main(): Promise<void> {
  console.log("⚡ Starting Mock Shock-Fade Dashboard Server...\n");

  // Initialize
  initPrices();
  initScores();

  // Create dashboard
  const dashboard = new ShockFadeDashboardServer({ port: 3032 });

  // Wire up mock objects
  dashboard.setDetector(createMockDetector() as any);
  dashboard.setTrader(createMockTrader() as any);
  dashboard.setMarkets(createMarketsMap());
  dashboard.setMode("paper");

  await dashboard.start();

  // Push initial scores
  for (const g of GAMES) {
    const sc = scores.get(g.slug)!;
    const periodNames = ["", "1st Q", "2nd Q", "3rd Q", "4th Q", "OT"];
    dashboard.updateScore({
      marketSlug: g.slug,
      homeTeam: g.team1,
      awayTeam: g.team2,
      homeScore: sc.home,
      awayScore: sc.away,
      period: periodNames[sc.period] || `Q${sc.period}`,
      clock: sc.clock,
      sport: "NBA",
    });
  }

  dashboard.addLog("SYS", "Mock shock-fade simulation started");
  dashboard.addLog("SYS", `Tracking ${GAMES.length} NBA games`);

  // ── Price drift: every 1-2s ──
  function schedulePriceDrift(): void {
    driftPrices();
    setTimeout(schedulePriceDrift, rand(1000, 2000));
  }
  schedulePriceDrift();

  // ── Score drift: every 20-40s ──
  function scheduleScoreDrift(): void {
    driftScore(dashboard);
    setTimeout(scheduleScoreDrift, rand(20_000, 40_000));
  }
  setTimeout(() => scheduleScoreDrift(), rand(5000, 15000));

  // ── Shock events: every 15-30s ──
  function scheduleShock(): void {
    simulateShock(dashboard);
    setTimeout(scheduleShock, rand(15_000, 30_000));
  }
  setTimeout(() => scheduleShock(), rand(3000, 8000));

  // ── Initial shock for immediate activity ──
  setTimeout(() => {
    simulateShock(dashboard);
    dashboard.addLog("SYS", "Initial shock fired for demo activity");
  }, 2000);

  console.log("\n📊 Games:");
  for (const g of GAMES) {
    const sc = scores.get(g.slug)!;
    const p1 = prices.get(g.tokenId1)!;
    console.log(`  🏀 ${g.team1} vs ${g.team2}  [${(p1.mid * 100).toFixed(0)}¢/${((1 - p1.mid) * 100).toFixed(0)}¢]  Score: ${sc.home}-${sc.away}`);
  }

  console.log("\n✅ Dashboard running at http://0.0.0.0:3032");
  console.log("   Shocks fire every 15-30s, scores update every 20-40s");
  console.log("   Press Ctrl+C to stop\n");

  // Graceful shutdown
  process.on("SIGINT", async () => {
    console.log("\nShutting down...");
    await dashboard.stop();
    process.exit(0);
  });
  process.on("SIGTERM", async () => {
    await dashboard.stop();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
