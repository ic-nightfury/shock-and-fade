/**
 * Mock Dashboard Server - Standalone mock data server for the shock-fade dashboard
 *
 * Simulates 4 concurrent NBA games with different position states:
 * - Watching: Both sides held, prices drifting around 45-55c
 * - Pending Sells: One side approaching 20c sell threshold (22-25c)
 * - Holding Winners: Loser sold, winner held at ~85c
 * - Pending Settlement: Game ended, winner at 99c
 *
 * Usage: npx tsx src/tools/mock-dashboard.ts
 */

import {
  SportsDashboardServer,
  DashboardDataProvider,
  DashboardPosition,
  DashboardStats,
  DashboardTrade,
  DashboardUpcomingGame,
} from "../dashboard/SportsDashboardServer.js";

// ============================================================================
// HELPERS
// ============================================================================

/** Random float in range [min, max] */
function rand(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

/** Clamp value between min and max */
function clamp(val: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, val));
}

/** Round to N decimal places */
function round(val: number, decimals: number = 2): number {
  const f = Math.pow(10, decimals);
  return Math.round(val * f) / f;
}

/** Format cents as dollar string */
function fmt(cents: number): string {
  return `$${cents.toFixed(2)}`;
}

// ============================================================================
// MOCK POSITION STATE
// ============================================================================

interface MockGame {
  slug: string;
  question: string;
  team1: string;
  team2: string;
  state: string;
  entryTime: Date;

  // Prices (0-1 scale)
  bid1: number;
  ask1: number;
  bid2: number;
  ask2: number;

  // Position details
  shares1: number;
  shares2: number;
  sold1: boolean;
  sold2: boolean;
  soldPrice1?: number;
  soldRevenue1?: number;
  soldPrice2?: number;
  soldRevenue2?: number;
  splitCost: number;

  // Pending settlement extras
  gameEndedAt?: string;
  winningOutcome?: string;
}

const SELL_THRESHOLD = 0.20;

function createMockGames(): MockGame[] {
  const now = new Date();

  return [
    // ── Game 1: WATCHING ── Lakers vs Celtics, balanced ~50c each side
    {
      slug: "nba-lal-bos-2026-02-09",
      question: "Will the Los Angeles Lakers beat the Boston Celtics?",
      team1: "Lakers",
      team2: "Celtics",
      state: "holding",
      entryTime: new Date(now.getTime() - 45 * 60_000), // 45 min ago
      bid1: 0.48,
      ask1: 0.50,
      bid2: 0.50,
      ask2: 0.52,
      shares1: 100,
      shares2: 100,
      sold1: false,
      sold2: false,
      splitCost: 100.0,
    },
    // ── Game 2: PENDING SELLS ── Warriors vs Suns, one side dropping toward 20c
    {
      slug: "nba-gsw-phx-2026-02-09",
      question: "Will the Golden State Warriors beat the Phoenix Suns?",
      team1: "Warriors",
      team2: "Suns",
      state: "holding",
      entryTime: new Date(now.getTime() - 72 * 60_000), // 72 min ago
      bid1: 0.23,
      ask1: 0.25,
      bid2: 0.75,
      ask2: 0.77,
      shares1: 100,
      shares2: 100,
      sold1: false,
      sold2: false,
      splitCost: 100.0,
    },
    // ── Game 3: HOLDING WINNERS ── Bucks vs Heat, loser sold, winner held
    {
      slug: "nba-mil-mia-2026-02-09",
      question: "Will the Milwaukee Bucks beat the Miami Heat?",
      team1: "Bucks",
      team2: "Heat",
      state: "partial_sold",
      entryTime: new Date(now.getTime() - 110 * 60_000), // 110 min ago
      bid1: 0.84,
      ask1: 0.86,
      bid2: 0.14,
      ask2: 0.16,
      shares1: 100,
      shares2: 0,
      sold1: false,
      sold2: true,
      soldPrice2: 0.18,
      soldRevenue2: 18.0,
      splitCost: 100.0,
    },
    // ── Game 4: PENDING SETTLEMENT ── Nuggets vs Clippers, game over
    {
      slug: "nba-den-lac-2026-02-09",
      question: "Will the Denver Nuggets beat the LA Clippers?",
      team1: "Nuggets",
      team2: "Clippers",
      state: "pending_settlement",
      entryTime: new Date(now.getTime() - 180 * 60_000), // 3h ago
      bid1: 0.99,
      ask1: 1.0,
      bid2: 0.01,
      ask2: 0.02,
      shares1: 100,
      shares2: 0,
      sold1: false,
      sold2: true,
      soldPrice2: 0.15,
      soldRevenue2: 15.0,
      splitCost: 100.0,
      gameEndedAt: new Date(now.getTime() - 25 * 60_000).toISOString(),
      winningOutcome: "Nuggets",
    },
  ];
}

// ============================================================================
// PRICE DRIFT ENGINE
// ============================================================================

function driftPrices(games: MockGame[]): void {
  for (const g of games) {
    if (g.state === "pending_settlement") continue; // no drift for settled games

    // Drift bid1 with mean-reversion toward its "anchor"
    const anchor1 = g.state === "partial_sold" ? 0.85 : (g.slug.includes("gsw") ? 0.23 : 0.50);
    const anchor2 = g.state === "partial_sold" ? 0.15 : (g.slug.includes("gsw") ? 0.77 : 0.50);

    const drift1 = rand(-0.02, 0.02) + (anchor1 - g.bid1) * 0.1;
    const drift2 = rand(-0.02, 0.02) + (anchor2 - g.bid2) * 0.1;

    g.bid1 = round(clamp(g.bid1 + drift1, 0.01, 0.99), 2);
    g.ask1 = round(clamp(g.bid1 + rand(0.01, 0.03), g.bid1 + 0.01, 1.0), 2);
    g.bid2 = round(clamp(g.bid2 + drift2, 0.01, 0.99), 2);
    g.ask2 = round(clamp(g.bid2 + rand(0.01, 0.03), g.bid2 + 0.01, 1.0), 2);
  }
}

// ============================================================================
// MOCK DATA PROVIDER
// ============================================================================

function createMockProvider(): DashboardDataProvider {
  const games = createMockGames();
  const startedAt = new Date().toISOString();

  // Drift prices every 1.5 seconds
  setInterval(() => driftPrices(games), 1500);

  // ── Build trades history ──
  const trades: DashboardTrade[] = [
    {
      timestamp: new Date(Date.now() - 180 * 60_000).toISOString(),
      marketSlug: "nba-den-lac-2026-02-09",
      sport: "NBA",
      action: "SPLIT",
      shares: 100,
      cost: 100.0,
    },
    {
      timestamp: new Date(Date.now() - 150 * 60_000).toISOString(),
      marketSlug: "nba-den-lac-2026-02-09",
      sport: "NBA",
      action: "SELL",
      outcome: "Clippers",
      shares: 100,
      price: 0.15,
      revenue: 15.0,
    },
    {
      timestamp: new Date(Date.now() - 110 * 60_000).toISOString(),
      marketSlug: "nba-mil-mia-2026-02-09",
      sport: "NBA",
      action: "SPLIT",
      shares: 100,
      cost: 100.0,
    },
    {
      timestamp: new Date(Date.now() - 80 * 60_000).toISOString(),
      marketSlug: "nba-mil-mia-2026-02-09",
      sport: "NBA",
      action: "SELL",
      outcome: "Heat",
      shares: 100,
      price: 0.18,
      revenue: 18.0,
    },
    {
      timestamp: new Date(Date.now() - 72 * 60_000).toISOString(),
      marketSlug: "nba-gsw-phx-2026-02-09",
      sport: "NBA",
      action: "SPLIT",
      shares: 100,
      cost: 100.0,
    },
    {
      timestamp: new Date(Date.now() - 45 * 60_000).toISOString(),
      marketSlug: "nba-lal-bos-2026-02-09",
      sport: "NBA",
      action: "SPLIT",
      shares: 100,
      cost: 100.0,
    },
    {
      timestamp: new Date(Date.now() - 25 * 60_000).toISOString(),
      marketSlug: "nba-den-lac-2026-02-09",
      sport: "NBA",
      action: "GAME_ENDED",
      outcome: "Nuggets",
    },
  ];

  // ── Upcoming games ──
  const upcomingGames: DashboardUpcomingGame[] = [
    {
      marketSlug: "nba-bkn-tor-2026-02-10",
      sport: "NBA",
      teams: { home: "Toronto Raptors", away: "Brooklyn Nets" },
      gameStartTime: new Date(Date.now() + 3 * 3600_000).toISOString(),
      prices: { yes: 0.55, no: 0.45 },
      volume: 42_500,
      status: "entry_window",
      hasPosition: false,
      polymarketUrl: "https://polymarket.com/event/nba-bkn-tor-2026-02-10",
    },
    {
      marketSlug: "nba-chi-ind-2026-02-10",
      sport: "NBA",
      teams: { home: "Indiana Pacers", away: "Chicago Bulls" },
      gameStartTime: new Date(Date.now() + 5 * 3600_000).toISOString(),
      prices: { yes: 0.62, no: 0.38 },
      volume: 31_200,
      status: "scheduled",
      hasPosition: false,
      polymarketUrl: "https://polymarket.com/event/nba-chi-ind-2026-02-10",
    },
    {
      marketSlug: "nba-dal-hou-2026-02-10",
      sport: "NBA",
      teams: { home: "Houston Rockets", away: "Dallas Mavericks" },
      gameStartTime: new Date(Date.now() + 7 * 3600_000).toISOString(),
      prices: { yes: 0.48, no: 0.52 },
      volume: 55_800,
      status: "scheduled",
      hasPosition: false,
      polymarketUrl: "https://polymarket.com/event/nba-dal-hou-2026-02-10",
    },
    {
      marketSlug: "nba-por-sac-2026-02-10",
      sport: "NBA",
      teams: { home: "Sacramento Kings", away: "Portland Trail Blazers" },
      gameStartTime: new Date(Date.now() + 9 * 3600_000).toISOString(),
      prices: { yes: 0.58, no: 0.42 },
      volume: 18_900,
      status: "scheduled",
      hasPosition: false,
      polymarketUrl: "https://polymarket.com/event/nba-por-sac-2026-02-10",
    },
    {
      marketSlug: "nba-min-okc-2026-02-10",
      sport: "NBA",
      teams: { home: "Oklahoma City Thunder", away: "Minnesota Timberwolves" },
      gameStartTime: new Date(Date.now() + 11 * 3600_000).toISOString(),
      prices: { yes: 0.44, no: 0.56 },
      volume: 67_300,
      status: "scheduled",
      hasPosition: false,
      polymarketUrl: "https://polymarket.com/event/nba-min-okc-2026-02-10",
    },
    {
      marketSlug: "nba-nyk-phi-2026-02-10",
      sport: "NBA",
      teams: { home: "Philadelphia 76ers", away: "New York Knicks" },
      gameStartTime: new Date(Date.now() + 24 * 3600_000).toISOString(),
      prices: { yes: 0.51, no: 0.49 },
      volume: 89_100,
      status: "scheduled",
      hasPosition: false,
      polymarketUrl: "https://polymarket.com/event/nba-nyk-phi-2026-02-10",
    },
  ];

  // ── Helper to convert MockGame → DashboardPosition ──
  function toPosition(g: MockGame): DashboardPosition {
    const now = Date.now();
    const elapsedMinutes = Math.round((now - g.entryTime.getTime()) / 60_000);

    const totalSoldRevenue = (g.soldRevenue1 ?? 0) + (g.soldRevenue2 ?? 0);
    const currentValue1 = g.sold1 ? 0 : g.shares1 * g.bid1;
    const currentValue2 = g.sold2 ? 0 : g.shares2 * g.bid2;
    const unrealizedPnL = round(currentValue1 + currentValue2 + totalSoldRevenue - g.splitCost, 2);
    const realizedPnL = round(totalSoldRevenue - (g.sold1 || g.sold2 ? g.splitCost * (g.sold1 && g.sold2 ? 1 : 0) : 0), 2);

    // Distance to threshold
    const dist1 = g.sold1 ? Infinity : g.bid1 - SELL_THRESHOLD;
    const dist2 = g.sold2 ? Infinity : g.bid2 - SELL_THRESHOLD;
    const closestSide: "outcome1" | "outcome2" | null =
      dist1 === Infinity && dist2 === Infinity ? null :
        dist1 <= dist2 ? "outcome1" : "outcome2";
    const distanceToThreshold = round(Math.min(dist1, dist2), 2);

    const isPendingSell = distanceToThreshold <= 0.10 && distanceToThreshold >= 0 && g.state === "holding";
    const isPendingSettlement = g.state === "pending_settlement";

    // Winner tracking
    const isPartialSold = g.state === "partial_sold";
    const winnerBid = isPartialSold ? (g.sold2 ? g.bid1 : g.bid2) : 0;
    const winnerShares = isPartialSold ? (g.sold2 ? g.shares1 : g.shares2) : 0;
    const winnerValue = round(winnerShares * winnerBid, 2);
    const projectedPnL = isPartialSold
      ? round(totalSoldRevenue + winnerShares * 1.0 - g.splitCost, 2)
      : isPendingSettlement
        ? round(totalSoldRevenue + (g.sold2 ? g.shares1 : g.shares2) * 1.0 - g.splitCost, 2)
        : 0;

    const obTimestamp = new Date().toISOString();

    return {
      marketSlug: g.slug,
      sport: "NBA",
      question: g.question,
      state: g.state,
      entryTime: g.entryTime.toISOString(),
      elapsedMinutes,

      outcome1: {
        name: g.team1,
        shares: g.shares1,
        sold: g.sold1,
        currentBid: g.bid1,
        currentAsk: g.ask1,
        soldPrice: g.soldPrice1,
        soldRevenue: g.soldRevenue1,
      },
      outcome2: {
        name: g.team2,
        shares: g.shares2,
        sold: g.sold2,
        currentBid: g.bid2,
        currentAsk: g.ask2,
        soldPrice: g.soldPrice2,
        soldRevenue: g.soldRevenue2,
      },

      splitCost: g.splitCost,
      totalSoldRevenue: round(totalSoldRevenue, 2),
      unrealizedPnL,
      realizedPnL,

      sellThreshold: SELL_THRESHOLD,
      distanceToThreshold1: round(dist1, 2),
      distanceToThreshold2: round(dist2, 2),

      isPendingSell,
      closestToThreshold: closestSide,
      distanceToThreshold,
      projectedPnL,
      winnerValue,

      isPendingSettlement,
      gameEndedAt: g.gameEndedAt ?? null,
      winningOutcome: g.winningOutcome ?? null,
      hasUnsoldShares: false,
      unsoldOutcome: null,
      unsoldShares: 0,
      unsoldCurrentBid: 0,

      // Order book mock data
      outcome1BidDepth: round(rand(5000, 25000), 0),
      outcome1AskDepth: round(rand(5000, 25000), 0),
      outcome1Spread: round(g.ask1 - g.bid1, 2),
      outcome2BidDepth: round(rand(3000, 20000), 0),
      outcome2AskDepth: round(rand(3000, 20000), 0),
      outcome2Spread: round(g.ask2 - g.bid2, 2),
      orderBookLastUpdate: obTimestamp,
    };
  }

  // ── Provider implementation ──
  return {
    getPositions(): DashboardPosition[] {
      return games.map(toPosition);
    },

    getStats(): DashboardStats {
      const positions = games.map(toPosition);
      const watchingCount = positions.filter(
        (p) => p.state === "holding" && !p.isPendingSell
      ).length;
      const pendingSellCount = positions.filter((p) => p.isPendingSell).length;
      const holdingWinnersCount = positions.filter(
        (p) => p.state === "partial_sold"
      ).length;
      const pendingSettlementCount = positions.filter(
        (p) => p.isPendingSettlement
      ).length;

      const totalUnrealized = positions.reduce(
        (s, p) => s + p.unrealizedPnL,
        0
      );
      const totalRealized = positions.reduce((s, p) => s + p.realizedPnL, 0);
      const deployedCapital = positions.reduce((s, p) => s + p.splitCost, 0);
      const projectedTotalPnL = positions.reduce(
        (s, p) => s + p.projectedPnL,
        0
      );

      return {
        mode: "PAPER",
        running: true,
        startedAt,

        initialBalance: 1000,
        currentBalance: round(1000 - deployedCapital + totalRealized + totalUnrealized, 2),

        positionsActive: games.length,
        positionsSettled: 2,
        positionsPendingSell: pendingSellCount,

        realizedPnL: round(totalRealized, 2),
        unrealizedPnL: round(totalUnrealized, 2),
        totalPnL: round(totalRealized + totalUnrealized, 2),

        winCount: 2,
        lossCount: 0,
        winRate: 1.0,
        avgPnLPerPosition: round((totalRealized + totalUnrealized) / Math.max(games.length, 1), 2),

        bySport: {
          NBA: {
            positionsActive: games.length,
            positionsSettled: 2,
            realizedPnL: round(totalRealized, 2),
            unrealizedPnL: round(totalUnrealized, 2),
          },
        },

        splitsToday: 4,
        sellsToday: 2,
        mergesToday: 0,
        settlementsToday: 0,
        todayPnL: round(totalRealized + totalUnrealized, 2),

        pendingSellCount,
        watchingCount,
        holdingWinnersCount,
        deployedCapital: round(deployedCapital, 2),
        projectedTotalPnL: round(projectedTotalPnL, 2),
        pendingSettlementCount,

        walletAddress: "0x742d35Cc6634C0532925a3b844Bc9e7595f2bD18",
      };
    },

    getTrades(limit?: number): DashboardTrade[] {
      const sorted = [...trades].sort(
        (a, b) =>
          new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
      );
      return limit ? sorted.slice(0, limit) : sorted;
    },

    getUpcomingGames(hours?: number): DashboardUpcomingGame[] {
      const cutoff = Date.now() + (hours ?? 24) * 3600_000;
      return upcomingGames.filter(
        (g) => new Date(g.gameStartTime).getTime() <= cutoff
      );
    },
  };
}

// ============================================================================
// MAIN
// ============================================================================

async function main() {
  console.log("🏀 Starting Mock NBA Dashboard Server...\n");

  const server = new SportsDashboardServer({
    port: 3032,
    mode: "PAPER",
    updateIntervalMs: 1000,
  });

  const provider = createMockProvider();
  server.setDataProvider(provider);

  await server.start();

  console.log("\n📊 Mock positions:");
  const positions = provider.getPositions();
  for (const p of positions) {
    const state = p.isPendingSell
      ? "⚠️  PENDING SELL"
      : p.isPendingSettlement
        ? "🏁 PENDING SETTLEMENT"
        : p.state === "partial_sold"
          ? "🏆 HOLDING WINNER"
          : "👀 WATCHING";
    console.log(
      `  ${state}  ${p.outcome1.name} vs ${p.outcome2.name}  [${p.outcome1.currentBid.toFixed(2)}¢ / ${p.outcome2.currentBid.toFixed(2)}¢]`
    );
  }

  console.log(`\n📈 ${provider.getTrades().length} trades in history`);
  console.log(
    `🔮 ${provider.getUpcomingGames!().length} upcoming games loaded`
  );
  console.log("\n✅ Dashboard running at http://0.0.0.0:3032");
  console.log("   Press Ctrl+C to stop\n");

  // Graceful shutdown
  process.on("SIGINT", async () => {
    console.log("\nShutting down...");
    await server.stop();
    process.exit(0);
  });
  process.on("SIGTERM", async () => {
    await server.stop();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
