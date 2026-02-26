/**
 * LiveDashboardAdapter - US-507: Adapter connecting SportsPositionManager to SportsDashboard
 *
 * Implements DashboardDataProvider interface to bridge SportsPositionManager data
 * to the SportsDashboardServer format for live trading.
 *
 * Usage:
 *   const adapter = new LiveDashboardAdapter(positionManager, priceMonitor);
 *   dashboard.setDataProvider(adapter);
 */

import {
  SportsPositionManager,
  SportsPosition,
  PositionState,
  PnLSummary,
  PositionManagerStats,
} from "../services/SportsPositionManager";
import {
  SportsPriceMonitor,
  MonitoredMarket,
} from "../services/SportsPriceMonitor";
import { OrderBookData } from "../services/OrderBookWS";
import {
  SportsMarketDiscovery,
  SportsMarket,
  MarketState,
} from "../services/SportsMarketDiscovery";
import {
  DashboardDataProvider,
  DashboardPosition,
  DashboardStats,
  DashboardTrade,
  DashboardMarketHealth,
  DashboardUpcomingGame,
  ForceSellResult,
} from "./SportsDashboardServer";
import { PolymarketClient } from "../services/PolymarketClient";
import * as fs from "fs";
import * as path from "path";

// Load sport config for sell thresholds
const CONFIG_PATH = path.join(
  __dirname,
  "..",
  "config",
  "sss_sport_params.json",
);

interface SportParams {
  sell_threshold: number;
  min_bet_size: number;
  max_bet_size: number;
  enabled: boolean;
  priority: number;
}

// Trade log entry for live trading
export interface LiveTradeLog {
  timestamp: Date;
  action: "SPLIT" | "SELL" | "MERGE" | "REDEEM";
  marketSlug: string;
  sport: string;
  outcome?: string;
  shares?: number;
  price?: number;
  revenue?: number;
  cost?: number;
  slippage?: number;
}

/**
 * Adapter that converts SportsPositionManager data to DashboardDataProvider format
 */
export class LiveDashboardAdapter implements DashboardDataProvider {
  private positionManager: SportsPositionManager;
  private priceMonitor: SportsPriceMonitor | null;
  private marketDiscovery: SportsMarketDiscovery | null;
  private polymarketClient: PolymarketClient | null;
  private sportConfig: Record<string, SportParams> = {};
  private initialBalance: number;
  private cachedBalance: number; // US-832: Cached on-chain balance
  private lastBalanceFetch: number = 0; // Timestamp of last balance fetch
  private balanceCacheDurationMs: number = 60000; // Cache balance for 60 seconds
  private startedAt: Date | null = null;
  private tradeLogs: LiveTradeLog[] = [];
  private maxTradeLogs: number = 1000;

  constructor(
    positionManager: SportsPositionManager,
    priceMonitor: SportsPriceMonitor | null = null,
    initialBalance: number = 1000,
    marketDiscovery: SportsMarketDiscovery | null = null,
    polymarketClient: PolymarketClient | null = null,
  ) {
    this.positionManager = positionManager;
    this.priceMonitor = priceMonitor;
    this.marketDiscovery = marketDiscovery;
    this.polymarketClient = polymarketClient;
    this.initialBalance = initialBalance;
    this.cachedBalance = initialBalance; // US-832: Initialize with initial balance
    this.startedAt = new Date();
    this.loadSportConfig();
  }

  /**
   * US-832: Get current balance (returns cached value, triggers background refresh if stale)
   * This is synchronous to work with getStats(), but triggers async refresh
   */
  private getCurrentBalance(): number {
    const now = Date.now();

    // Trigger background refresh if cache is stale
    if (now - this.lastBalanceFetch >= this.balanceCacheDurationMs) {
      this.refreshBalanceInBackground();
    }

    return this.cachedBalance;
  }

  /**
   * US-832: Refresh balance in background (non-blocking)
   */
  private refreshBalanceInBackground(): void {
    if (!this.polymarketClient) return;

    // Mark as fetching to prevent multiple concurrent fetches
    this.lastBalanceFetch = Date.now();

    this.polymarketClient
      .getBalance()
      .then((balance) => {
        this.cachedBalance = balance;
      })
      .catch((error) => {
        console.warn(
          `[LiveDashboardAdapter] Failed to fetch balance: ${error}`,
        );
        // Reset lastBalanceFetch to allow retry on next call
        this.lastBalanceFetch = 0;
      });
  }

  /**
   * Load sport configuration for sell thresholds
   */
  private loadSportConfig(): void {
    try {
      if (fs.existsSync(CONFIG_PATH)) {
        const config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
        this.sportConfig = config.sports || {};
      }
    } catch (error) {
      console.warn(
        `[LiveDashboardAdapter] Failed to load sport config: ${error}`,
      );
    }
  }

  /**
   * Get sell threshold for a sport
   */
  private getSellThreshold(sport: string): number {
    const normalizedSport = sport.toUpperCase();
    return this.sportConfig[normalizedSport]?.sell_threshold ?? 0.2;
  }

  /**
   * US-820: Calculate order book metrics for a token
   * Returns bid depth (sum of top 5 bids in USDC), ask depth, spread, and best prices
   * US-823: Added bestBid and bestAsk for bid/ask price display
   */
  private getOrderBookMetrics(tokenId: string): {
    bidDepth: number | null;
    askDepth: number | null;
    spread: number | null;
    bestBid: number | null;
    bestAsk: number | null;
    lastUpdate: string | null;
  } {
    if (!this.priceMonitor) {
      return {
        bidDepth: null,
        askDepth: null,
        spread: null,
        bestBid: null,
        bestAsk: null,
        lastUpdate: null,
      };
    }

    const orderBook = this.priceMonitor.getOrderBook(tokenId);
    if (!orderBook) {
      return {
        bidDepth: null,
        askDepth: null,
        spread: null,
        bestBid: null,
        bestAsk: null,
        lastUpdate: null,
      };
    }

    // Calculate bid depth: sum of top 5 bid levels (size is in USDC)
    // Note: bids are sorted ASCENDING, so best bid is LAST
    const bids = orderBook.bids || [];
    const top5Bids = bids.slice(-5).reverse(); // Take last 5, reverse to get best first
    const bidDepth = top5Bids.reduce(
      (sum, level) => sum + parseFloat(level.size),
      0,
    );

    // Calculate ask depth: sum of top 5 ask levels
    // Asks are sorted ASCENDING, so best ask is FIRST
    const asks = orderBook.asks || [];
    const top5Asks = asks.slice(0, 5);
    const askDepth = top5Asks.reduce(
      (sum, level) => sum + parseFloat(level.size),
      0,
    );

    // US-823: Extract best bid and best ask prices
    const bestBid =
      bids.length > 0 ? parseFloat(bids[bids.length - 1].price) : null;
    const bestAsk = asks.length > 0 ? parseFloat(asks[0].price) : null;

    // Calculate spread: best ask - best bid
    let spread: number | null = null;
    if (bestBid !== null && bestAsk !== null) {
      spread = bestAsk - bestBid;
    }

    // Last update timestamp
    const lastUpdate = orderBook.timestamp
      ? new Date(orderBook.timestamp).toISOString()
      : null;

    return { bidDepth, askDepth, spread, bestBid, bestAsk, lastUpdate };
  }

  /**
   * Log a trade for the trade history panel
   */
  logTrade(trade: LiveTradeLog): void {
    this.tradeLogs.unshift(trade);
    if (this.tradeLogs.length > this.maxTradeLogs) {
      this.tradeLogs.pop();
    }
  }

  /**
   * Convert SportsPosition to DashboardPosition
   */
  private convertPosition(position: SportsPosition): DashboardPosition {
    const sellThreshold = this.getSellThreshold(position.sport);

    // Calculate distance to threshold for each outcome
    const distanceToThreshold1 = Math.max(
      0,
      position.currentPrice1 - sellThreshold,
    );
    const distanceToThreshold2 = Math.max(
      0,
      position.currentPrice2 - sellThreshold,
    );

    // Calculate unrealized P&L
    const remainingShares1 =
      position.outcome1.shares - position.outcome1.soldShares;
    const remainingShares2 =
      position.outcome2.shares - position.outcome2.soldShares;
    const currentValue =
      remainingShares1 * position.currentPrice1 +
      remainingShares2 * position.currentPrice2 +
      position.totalSoldRevenue;
    const unrealizedPnL = currentValue - position.splitCost;

    // Calculate elapsed time
    const entryTime = new Date(position.entryTime);
    const elapsedMs = Date.now() - entryTime.getTime();
    const elapsedMinutes = Math.floor(elapsedMs / 60000);

    // US-807: Calculate new fields for revamped dashboard
    const lowerPrice = Math.min(position.currentPrice1, position.currentPrice2);
    // isPendingSell: within 10c of threshold (state must be HOLDING)
    const isPendingSell =
      position.state === PositionState.HOLDING &&
      lowerPrice <= sellThreshold + 0.1 &&
      lowerPrice > 0;

    // closestToThreshold: which outcome is closer to threshold
    let closestToThreshold: "outcome1" | "outcome2" | null = null;
    if (!position.outcome1.sold && !position.outcome2.sold) {
      // Both sides still held
      closestToThreshold =
        position.currentPrice1 <= position.currentPrice2
          ? "outcome1"
          : "outcome2";
    } else if (!position.outcome1.sold && position.outcome2.sold) {
      closestToThreshold = "outcome1"; // Only outcome1 remains
    } else if (position.outcome1.sold && !position.outcome2.sold) {
      closestToThreshold = "outcome2"; // Only outcome2 remains
    }

    // distanceToThreshold: for the closest side
    const distanceToThreshold = Math.min(
      distanceToThreshold1,
      distanceToThreshold2,
    );

    // projectedPnL: for partial_sold positions (soldRevenue + shares*1.00 - splitCost)
    let projectedPnL = 0;
    if (position.state === PositionState.PARTIAL_SOLD) {
      // Winner side is the one NOT sold
      const winnerShares = position.outcome1.sold
        ? remainingShares2
        : remainingShares1;
      projectedPnL =
        position.totalSoldRevenue + winnerShares * 1.0 - position.splitCost;
    }

    // winnerValue: current value of held winner shares (for partial_sold)
    let winnerValue = 0;
    if (position.state === PositionState.PARTIAL_SOLD) {
      if (position.outcome1.sold && !position.outcome2.sold) {
        // Outcome2 is winner
        winnerValue = remainingShares2 * position.currentPrice2;
      } else if (!position.outcome1.sold && position.outcome2.sold) {
        // Outcome1 is winner
        winnerValue = remainingShares1 * position.currentPrice1;
      }
    }

    // US-818: Pending settlement fields
    const isPendingSettlement =
      position.state === PositionState.PENDING_SETTLEMENT;

    // Determine unsold shares info (for positions where loser wasn't sold)
    let hasUnsoldShares = false;
    let unsoldOutcome: string | null = null;
    let unsoldShares = 0;
    let unsoldCurrentBid = 0;

    if (isPendingSettlement || position.state === PositionState.HOLDING) {
      // Check if there are unsold shares on what should be the losing side
      if (
        !position.outcome1.sold &&
        position.winningOutcome !== position.outcome1.outcome
      ) {
        hasUnsoldShares = true;
        unsoldOutcome = position.outcome1.outcome;
        unsoldShares = remainingShares1;
        unsoldCurrentBid = position.currentPrice1;
      } else if (
        !position.outcome2.sold &&
        position.winningOutcome !== position.outcome2.outcome
      ) {
        hasUnsoldShares = true;
        unsoldOutcome = position.outcome2.outcome;
        unsoldShares = remainingShares2;
        unsoldCurrentBid = position.currentPrice2;
      }
    }

    // US-820: Get order book metrics for both outcomes
    const ob1 = this.getOrderBookMetrics(position.outcome1.tokenId);
    const ob2 = this.getOrderBookMetrics(position.outcome2.tokenId);
    // Use the most recent timestamp from either outcome
    const orderBookLastUpdate =
      ob1.lastUpdate && ob2.lastUpdate
        ? ob1.lastUpdate > ob2.lastUpdate
          ? ob1.lastUpdate
          : ob2.lastUpdate
        : ob1.lastUpdate || ob2.lastUpdate;

    return {
      marketSlug: position.marketSlug,
      sport: position.sport,
      question: position.question,
      state: position.state,
      entryTime: entryTime.toISOString(),
      elapsedMinutes,

      outcome1: {
        name: position.outcome1.outcome,
        shares: position.outcome1.shares,
        sold: position.outcome1.sold,
        currentBid: position.currentPrice1,
        currentAsk: ob1.bestAsk ?? 0, // US-823: Best ask for bid/ask display
        soldPrice: position.outcome1.soldPrice,
        soldRevenue: position.outcome1.soldRevenue,
      },
      outcome2: {
        name: position.outcome2.outcome,
        shares: position.outcome2.shares,
        sold: position.outcome2.sold,
        currentBid: position.currentPrice2,
        currentAsk: ob2.bestAsk ?? 0, // US-823: Best ask for bid/ask display
        soldPrice: position.outcome2.soldPrice,
        soldRevenue: position.outcome2.soldRevenue,
      },

      splitCost: position.splitCost,
      totalSoldRevenue: position.totalSoldRevenue,
      unrealizedPnL,
      realizedPnL: position.realizedPnL,

      sellThreshold,
      distanceToThreshold1,
      distanceToThreshold2,

      // US-807: New fields
      isPendingSell,
      closestToThreshold,
      distanceToThreshold,
      projectedPnL,
      winnerValue,

      // US-818: Pending settlement fields
      isPendingSettlement,
      gameEndedAt: position.gameEndedAt
        ? position.gameEndedAt instanceof Date
          ? position.gameEndedAt.toISOString()
          : String(position.gameEndedAt)
        : null,
      winningOutcome: position.winningOutcome,
      hasUnsoldShares,
      unsoldOutcome,
      unsoldShares,
      unsoldCurrentBid,

      // US-820: Order book health info
      outcome1BidDepth: ob1.bidDepth,
      outcome1AskDepth: ob1.askDepth,
      outcome1Spread: ob1.spread,
      outcome2BidDepth: ob2.bidDepth,
      outcome2AskDepth: ob2.askDepth,
      outcome2Spread: ob2.spread,
      orderBookLastUpdate,
    };
  }

  /**
   * Convert LiveTradeLog to DashboardTrade
   */
  private convertTrade(log: LiveTradeLog): DashboardTrade {
    return {
      timestamp: new Date(log.timestamp).toISOString(),
      marketSlug: log.marketSlug,
      sport: log.sport,
      action: log.action,
      outcome: log.outcome,
      shares: log.shares,
      price: log.price,
      revenue: log.revenue,
      cost: log.cost,
      slippage: log.slippage,
    };
  }

  // ============================================================================
  // DashboardDataProvider Implementation
  // ============================================================================

  getPositions(): DashboardPosition[] {
    const positions = this.positionManager.getOpenPositions();
    return positions.map((p) => this.convertPosition(p));
  }

  getStats(): DashboardStats {
    const pnlSummary = this.positionManager.getPnLSummary();
    const managerStats = this.positionManager.getStats();

    // Calculate today's P&L
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const settledPositions = this.positionManager.getSettledPositions();
    const todaySettled = settledPositions.filter(
      (p) => p.settledAt && new Date(p.settledAt) >= today,
    );
    const todayPnL = todaySettled.reduce((sum, p) => sum + p.realizedPnL, 0);

    // Get trade logs for today's activity counts
    const todayLogs = this.tradeLogs.filter(
      (t) => new Date(t.timestamp) >= today,
    );
    const splitsToday = todayLogs.filter((t) => t.action === "SPLIT").length;
    const sellsToday = todayLogs.filter((t) => t.action === "SELL").length;
    const mergesToday = todayLogs.filter((t) => t.action === "MERGE").length;
    const settlementsToday = todayLogs.filter(
      (t) => t.action === "REDEEM",
    ).length;

    // Calculate positions pending sell (holding state)
    const openPositions = this.positionManager.getOpenPositions();
    const positionsPendingSell = openPositions.filter(
      (p) => p.state === PositionState.HOLDING,
    ).length;

    // US-807: Calculate new stats for section counts
    const sellThresholdCache: Record<string, number> = {};
    const getSellThresholdCached = (sport: string): number => {
      if (!sellThresholdCache[sport]) {
        sellThresholdCache[sport] = this.getSellThreshold(sport);
      }
      return sellThresholdCache[sport];
    };

    // US-807: pendingSellCount - HOLDING positions within 10c of threshold
    const holdingPositions = openPositions.filter(
      (p) => p.state === PositionState.HOLDING,
    );
    const pendingSellCount = holdingPositions.filter((p) => {
      const threshold = getSellThresholdCached(p.sport);
      const lowerPrice = Math.min(p.currentPrice1, p.currentPrice2);
      return lowerPrice <= threshold + 0.1 && lowerPrice > 0;
    }).length;

    // US-807: watchingCount - HOLDING positions NOT within 10c of threshold
    const watchingCount = holdingPositions.length - pendingSellCount;

    // US-807: holdingWinnersCount - PARTIAL_SOLD positions (loser sold)
    const holdingWinnersCount = openPositions.filter(
      (p) => p.state === PositionState.PARTIAL_SOLD,
    ).length;

    // US-807: deployedCapital - sum of split costs for all open positions
    const deployedCapital = openPositions.reduce(
      (sum, p) => sum + p.splitCost,
      0,
    );

    // US-807: projectedTotalPnL - sum of projected P&L from all partial_sold positions
    const projectedTotalPnL = openPositions
      .filter((p) => p.state === PositionState.PARTIAL_SOLD)
      .reduce((sum, p) => {
        const remainingShares1 = p.outcome1.shares - p.outcome1.soldShares;
        const remainingShares2 = p.outcome2.shares - p.outcome2.soldShares;
        const winnerShares = p.outcome1.sold
          ? remainingShares2
          : remainingShares1;
        const projectedPnL =
          p.totalSoldRevenue + winnerShares * 1.0 - p.splitCost;
        return sum + projectedPnL;
      }, 0);

    return {
      mode: "LIVE",
      running: managerStats.positionsOpen > 0,
      startedAt: this.startedAt?.toISOString() ?? null,

      initialBalance: this.initialBalance,
      currentBalance: this.getCurrentBalance(), // US-832: Use actual on-chain balance

      positionsActive: pnlSummary.positionsOpen,
      positionsSettled: pnlSummary.positionsSettled,
      positionsPendingSell,

      realizedPnL: pnlSummary.realizedPnL,
      unrealizedPnL: pnlSummary.unrealizedPnL,
      totalPnL: pnlSummary.totalPnL,

      winCount: pnlSummary.winCount,
      lossCount: pnlSummary.lossCount,
      winRate: pnlSummary.winRate,
      avgPnLPerPosition: pnlSummary.avgPnLPerPosition,

      // Transform bySport: positionsOpen -> positionsActive
      bySport: Object.fromEntries(
        Object.entries(pnlSummary.bySport).map(([sport, data]) => [
          sport,
          {
            positionsActive: data.positionsOpen,
            positionsSettled: data.positionsSettled,
            realizedPnL: data.realizedPnL,
            unrealizedPnL: data.unrealizedPnL,
          },
        ]),
      ),

      splitsToday,
      sellsToday,
      mergesToday,
      settlementsToday,

      todayPnL,

      // US-807: New fields for revamped dashboard
      pendingSellCount,
      watchingCount,
      holdingWinnersCount,
      deployedCapital,
      projectedTotalPnL,

      // US-818: Pending settlement count
      pendingSettlementCount: openPositions.filter(
        (p) => p.state === PositionState.PENDING_SETTLEMENT,
      ).length,

      // US-826: Wallet address (funder for PROXY mode, signer for EOA mode)
      walletAddress: this.polymarketClient
        ? this.polymarketClient.getApiQueryAddress()
        : null,
    };
  }

  getTrades(limit: number = 100): DashboardTrade[] {
    return this.tradeLogs.slice(0, limit).map((t) => this.convertTrade(t));
  }

  getMarketHealth(marketSlug: string): DashboardMarketHealth | null {
    if (!this.priceMonitor) return null;

    const market = this.priceMonitor.getMarketPrices(marketSlug);
    if (!market) return null;

    const position = this.positionManager.getPosition(marketSlug);
    const sport = market.sport || position?.sport || "UNKNOWN";

    // Calculate health metrics from MonitoredMarket.outcome1/outcome2
    // Get bid depth from order book via priceMonitor.getOrderBook()
    const orderBook1 = this.priceMonitor.getOrderBook(market.outcome1.tokenId);
    const orderBook2 = this.priceMonitor.getOrderBook(market.outcome2.tokenId);

    // Calculate total bid depth (sum of all bid sizes in USDC)
    const bidDepth1 =
      orderBook1?.bids?.reduce((sum, bid) => sum + parseFloat(bid.size), 0) ??
      0;
    const bidDepth2 =
      orderBook2?.bids?.reduce((sum, bid) => sum + parseFloat(bid.size), 0) ??
      0;

    const spread1 = (market.outcome1.ask ?? 0) - (market.outcome1.bid ?? 0);
    const spread2 = (market.outcome2.ask ?? 0) - (market.outcome2.bid ?? 0);

    // Determine health status
    const warnings: string[] = [];
    let healthStatus: "HEALTHY" | "CAUTION" | "DANGER" = "HEALTHY";

    // Check spread (> 5c is wide)
    if (spread1 > 0.05 || spread2 > 0.05) {
      warnings.push("Wide spread");
      healthStatus = "CAUTION";
    }

    // Check last trade time (> 5 minutes is stale)
    const lastTradeTime1 = market.outcome1.lastTradeTime;
    const lastTradeTime2 = market.outcome2.lastTradeTime;
    const fiveMinutesAgo = Date.now() - 5 * 60 * 1000;
    if (
      (!lastTradeTime1 || lastTradeTime1 < fiveMinutesAgo) &&
      (!lastTradeTime2 || lastTradeTime2 < fiveMinutesAgo)
    ) {
      warnings.push("Stale market");
      healthStatus = warnings.length > 1 ? "DANGER" : "CAUTION";
    }

    return {
      marketSlug,
      sport,
      outcome1BidDepth: bidDepth1,
      outcome2BidDepth: bidDepth2,
      spread1,
      spread2,
      lastTradeTime1: lastTradeTime1
        ? new Date(lastTradeTime1).toISOString()
        : null,
      lastTradeTime2: lastTradeTime2
        ? new Date(lastTradeTime2).toISOString()
        : null,
      healthStatus,
      warnings,
    };
  }

  getAllMarketHealth(): DashboardMarketHealth[] {
    const positions = this.positionManager.getOpenPositions();
    const healthData: DashboardMarketHealth[] = [];

    for (const position of positions) {
      const health = this.getMarketHealth(position.marketSlug);
      if (health) {
        healthData.push(health);
      }
    }

    return healthData;
  }

  /**
   * Get upcoming games within specified hours (US-508)
   * @param hours Time horizon - default 24, accepts 6, 12, 24, 48
   */
  getUpcomingGames(hours: number = 24): DashboardUpcomingGame[] {
    if (!this.marketDiscovery) return [];

    const now = Date.now();
    const horizonMs = hours * 60 * 60 * 1000;
    const cutoffTime = now + horizonMs;

    // Get all markets from discovery
    const allMarkets = this.marketDiscovery.getMarkets();

    // Filter to games within time horizon that haven't ended
    const upcomingMarkets = allMarkets.filter((market) => {
      // Skip closed/settled markets
      if (market.state === MarketState.CLOSED) return false;

      // Must have a game start time
      if (!market.gameStartTime) return false;

      const gameStart = market.gameStartTime.getTime();

      // Include games starting in the future within horizon
      // Also include games that started recently (for entry_window/live status)
      // But exclude games that started more than 3 hours ago (likely ended)
      const threeHoursAgo = now - 3 * 60 * 60 * 1000;
      return gameStart < cutoffTime && gameStart > threeHoursAgo;
    });

    // Convert to DashboardUpcomingGame format
    const games: DashboardUpcomingGame[] = upcomingMarkets.map((market) => {
      // Parse team names from slug (format: sport-team1-team2-date)
      const { home, away } = this.parseTeamsFromSlug(market.marketSlug);

      // Determine status
      const gameStart = market.gameStartTime!.getTime();
      const entryWindowEnd = gameStart + 10 * 60 * 1000; // 10 minutes after start
      let status: DashboardUpcomingGame["status"];

      if (now < gameStart) {
        status = "scheduled";
      } else if (now < entryWindowEnd) {
        status = "entry_window";
      } else {
        status = "live";
      }

      // Check if we have a position
      const hasPosition =
        this.positionManager.getPosition(market.marketSlug) !== null;

      // Get prices (outcomes[0] is typically home/yes, outcomes[1] is away/no)
      const prices = {
        yes: market.outcomePrices[0] ?? 0.5,
        no: market.outcomePrices[1] ?? 0.5,
      };

      return {
        marketSlug: market.marketSlug,
        sport: market.sport as "NHL" | "NBA" | "NFL" | "SOCCER" | string,
        leaguePrefix: market.leaguePrefix, // US-703: Soccer league prefix
        teams: { home, away },
        gameStartTime: market.gameStartTime!.toISOString(),
        prices,
        volume: market.volume,
        status,
        hasPosition,
        polymarketUrl: `https://polymarket.com/event/${market.eventSlug}`,
      };
    });

    // Sort by game start time ascending
    games.sort(
      (a, b) =>
        new Date(a.gameStartTime).getTime() -
        new Date(b.gameStartTime).getTime(),
    );

    return games;
  }

  /**
   * Parse team names from market slug
   * Format: sport-team1-team2-YYYY-MM-DD
   */
  private parseTeamsFromSlug(slug: string): { home: string; away: string } {
    // Example: nhl-sea-ana-2026-02-03
    const parts = slug.split("-");
    if (parts.length >= 4) {
      // Team abbreviations are typically indices 1 and 2
      const away = parts[1]?.toUpperCase() || "AWAY";
      const home = parts[2]?.toUpperCase() || "HOME";
      return { home, away };
    }
    return { home: "HOME", away: "AWAY" };
  }

  /**
   * US-821: Force sell on a pending settlement position
   * Sells the unsold shares at market price (IOC order)
   */
  async forceSell(
    marketSlug: string,
    outcomeIndex: 0 | 1,
  ): Promise<ForceSellResult> {
    // Check if PolymarketClient is configured
    if (!this.polymarketClient) {
      return {
        success: false,
        marketSlug,
        error:
          "PolymarketClient not configured. Force sell requires live trading client.",
      };
    }

    // Get the position
    const position = this.positionManager.getPosition(marketSlug);
    if (!position) {
      return {
        success: false,
        marketSlug,
        error: "Position not found for this market",
      };
    }

    // Check if position is in pending_settlement or holding state
    if (
      position.state !== PositionState.PENDING_SETTLEMENT &&
      position.state !== PositionState.HOLDING
    ) {
      return {
        success: false,
        marketSlug,
        error: `Position state is ${position.state}, expected PENDING_SETTLEMENT or HOLDING`,
      };
    }

    // Get the outcome data for the specified index
    const outcomeData =
      outcomeIndex === 0 ? position.outcome1 : position.outcome2;

    if (outcomeData.sold) {
      return {
        success: false,
        marketSlug,
        error: `${outcomeData.outcome} is already sold`,
      };
    }

    // Calculate shares to sell (remaining shares)
    const shares = outcomeData.shares - (outcomeData.soldShares || 0);
    if (shares <= 0) {
      return {
        success: false,
        marketSlug,
        error: `No shares to sell for ${outcomeData.outcome}`,
      };
    }

    // Get current bid price for market sell
    const currentBid =
      outcomeIndex === 0 ? position.currentPrice1 : position.currentPrice2;

    // Execute IOC (Immediate-or-Cancel) sell at market price
    try {
      const result = await this.polymarketClient.sellSharesIOC(
        outcomeData.tokenId,
        shares,
        currentBid, // Sell at current bid (market price)
      );

      const filledShares = result.filledShares ?? 0;
      const filledPrice = result.filledPrice ?? currentBid;

      if (result.success && filledShares > 0) {
        // Convert outcomeIndex from 0|1 to 1|2 for SportsPositionManager
        const managerOutcomeIndex: 1 | 2 = outcomeIndex === 0 ? 1 : 2;

        // Record the sale in position manager
        this.positionManager.recordSale(
          marketSlug,
          managerOutcomeIndex,
          filledShares,
          filledPrice,
          filledShares * filledPrice,
        );

        // Log the trade
        this.logTrade({
          timestamp: new Date(),
          action: "SELL",
          marketSlug,
          sport: position.sport,
          outcome: outcomeData.outcome,
          shares: filledShares,
          price: filledPrice,
          revenue: filledShares * filledPrice,
          slippage: currentBid - filledPrice,
        });

        return {
          success: true,
          marketSlug,
          outcome: outcomeData.outcome,
          sharesSold: filledShares,
          revenue: filledShares * filledPrice,
          avgPrice: filledPrice,
        };
      } else {
        return {
          success: false,
          marketSlug,
          error: result.error || "No shares filled - order may have expired",
        };
      }
    } catch (error: any) {
      return {
        success: false,
        marketSlug,
        error: `Sell execution failed: ${error.message}`,
      };
    }
  }
}
