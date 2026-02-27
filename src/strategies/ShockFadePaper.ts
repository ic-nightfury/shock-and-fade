/**
 * ShockFadePaperTrader - Paper trading engine for shock-fade strategy.
 *
 * SPLIT-AND-SELL MODEL (Polymarket CTF):
 * In a 2-outcome market, splitting $1 USDC gives 1 YES-A + 1 YES-B token.
 * We ALWAYS sell — never buy on the book.
 *
 * CYCLE: One complete shock → entry → exit lifecycle.
 *   1 cycle = 3 ladder orders = $50 + $100 + $150 = $300 notional
 *   Pre-split $300 → 300 shares of each token as dry powder
 *   When shares < 300, auto-replenish with another split
 *
 * ENTRY: Event-filtered — only trade when API confirms single event (1s polling).
 * EXIT: Event-driven — close on next goal event, with take-profit as early exit.
 *       Fallback timeout at 600s if no next event detected.
 *
 * Net effect: always selling the overpriced side, closing by selling the other
 * side when it becomes overpriced (the fade). Never placing buy orders.
 */

import { EventEmitter } from "events";
import * as fs from "fs";
import * as path from "path";
import {
  OrderBookWebSocket,
  PriceUpdateEvent,
  TradeEvent,
} from "../services/OrderBookWS";
import {
  ShockEvent,
  ShockClassification,
  ShockFadeConfig,
  DEFAULT_SHOCK_FADE_CONFIG,
} from "./ShockFadeDetector";

// ============================================================================
// TYPES
// ============================================================================

export type OrderSide = "SELL"; // Always sell in split-and-sell model
export type OrderStatus = "PENDING" | "FILLED" | "CANCELLED" | "EXPIRED";
export type PositionStatus = "OPEN" | "TAKE_PROFIT" | "HEDGED" | "CLOSED";

/** Which leg of the trade this order represents */
export type OrderLeg = "ENTRY" | "EXIT";

export interface LadderOrder {
  id: string;
  tokenId: string; // token being sold
  marketSlug: string;
  side: "SELL"; // always SELL
  leg: OrderLeg; // ENTRY = sell the spiked side; EXIT = sell the other side to close
  price: number; // limit price
  size: number; // USDC notional
  shares: number; // shares = size / price
  level: number; // 1, 2, or 3
  status: OrderStatus;
  createdAt: number;
  filledAt: number | null;
  fillPrice: number | null;
  shockId: string; // reference to originating shock
  splitCost: number; // USDC spent on split to get these shares
}

export interface FadePosition {
  id: string;
  marketSlug: string;

  // The token we sold (entry)
  soldTokenId: string;
  soldPrice: number;
  soldShares: number;

  // The token we're holding (complement) — to be sold on exit
  heldTokenId: string;
  heldShares: number; // same as soldShares (from the split)

  // Cost basis
  splitCost: number; // USDC we spent splitting

  entryTime: number;
  takeProfitPrice: number; // target sell price for the held token
  status: PositionStatus;

  // Exit details (selling the held token)
  exitPrice: number | null;
  exitTime: number | null;
  pnl: number | null;

  shockId: string;
  orderId: string; // the entry order that created this position
}

export interface TradeRecord {
  id: string;
  marketSlug: string;

  // Entry: selling spiked token
  soldTokenId: string;
  soldPrice: number;
  soldShares: number;

  // Exit: selling held (complement) token
  heldTokenId: string;
  exitPrice: number;
  exitShares: number;

  // P&L: (sold_price + exit_price - 1.00) * shares
  // In CTF: selling both sides should total ~$1. Profit = total proceeds - split cost
  pnl: number;
  splitCost: number;
  totalProceeds: number;

  entryTime: number;
  exitTime: number;
  shockMagnitude: number;
  shockZScore: number;
  fadeCapture: number; // cents captured on the fade
  holdTimeMs: number;
}

export interface ShockFadePaperStats {
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

// ============================================================================
// CYCLE & DRY POWDER
// ============================================================================

/** One cycle = one complete shock → entry → exit lifecycle */
const CYCLE_SIZE_USD = 300; // $50 + $100 + $150

interface TokenPair {
  marketSlug: string;
  tokenA: string; // outcomes[0] token
  tokenB: string; // outcomes[1] token
}

/**
 * Dry powder inventory per market — pre-split shares ready to sell.
 * In real trading, split takes 10-11s on-chain, so we pre-split.
 * When inventory drops below 1 cycle, auto-replenish.
 */
interface DryPowder {
  marketSlug: string;
  tokenA: string;
  tokenB: string;
  sharesA: number;       // shares of token A available to sell
  sharesB: number;       // shares of token B available to sell
  totalSplitCost: number; // total USDC spent on splits
  splitCount: number;     // number of splits performed
  mergeCount: number;     // number of merges performed (unused shares recovered)
}

/** Tracks a complete cycle from shock to exit */
export interface CycleRecord {
  id: string;
  marketSlug: string;
  shockTs: number;
  classificationTs: number;
  classification: string;
  entryTs: number | null;    // when orders placed
  firstFillTs: number | null; // when first ladder filled
  exitTs: number | null;      // when position closed
  exitReason: string | null;  // "take_profit" | "event_exit" | "timeout" | "scoring_run_bail"
  ordersPlaced: number;
  ordersFilled: number;
  totalPnl: number;
  holdTimeMs: number;
}

// ============================================================================
// PAPER TRADER
// ============================================================================

export class ShockFadePaperTrader extends EventEmitter {
  private config: ShockFadeConfig;
  private ws: OrderBookWebSocket;

  // State
  private orders: Map<string, LadderOrder> = new Map();
  private positions: Map<string, FadePosition> = new Map();
  private tradeHistory: TradeRecord[] = [];
  private stats: ShockFadePaperStats;

  // Shock tracking
  private processedShocks: Set<string> = new Set();

  // Token pair mapping: tokenId → TokenPair
  private tokenPairs: Map<string, TokenPair> = new Map();
  // Token → market slug
  private tokenToMarket: Map<string, string> = new Map();

  // Dry powder inventory per market
  private dryPowder: Map<string, DryPowder> = new Map();

  // Cycle tracking
  private cycles: CycleRecord[] = [];

  // Price tracking for fill simulation
  private latestPrices: Map<string, { bid: number; ask: number; mid: number }> =
    new Map();

  // Persistence
  private snapshotPath: string;
  private snapshotTimer: NodeJS.Timeout | null = null;

  // Running P&L history for Sharpe calculation
  private pnlHistory: number[] = [];
  private peakBalance: number;

  constructor(
    ws: OrderBookWebSocket,
    config: Partial<ShockFadeConfig> = {},
    snapshotPath: string = "./data/shock-fade-state.json",
  ) {
    super();
    this.ws = ws;
    this.config = { ...DEFAULT_SHOCK_FADE_CONFIG, ...config };
    this.snapshotPath = snapshotPath;

    const initialBalance = this.config.maxPositionSize * this.config.ladderLevels * 10;
    this.peakBalance = initialBalance;

    this.stats = {
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
      runningBalance: initialBalance,
      startedAt: null,
    };
  }

  // ============================================================================
  // LIFECYCLE
  // ============================================================================

  start(): void {
    this.stats.startedAt = Date.now();

    // Listen for price updates to simulate fills
    this.ws.on("priceUpdate", (event: PriceUpdateEvent) =>
      this.handlePriceUpdate(event),
    );

    // Listen for trades (more granular fill detection)
    this.ws.on("trade", (event: TradeEvent) => this.handleTrade(event));

    // Load persisted state
    this.loadState();

    // Start periodic snapshot
    this.snapshotTimer = setInterval(() => this.saveState(), 30000);

    // Start order expiry checker
    setInterval(() => this.checkOrderExpiry(), 5000);

    this.log("ShockFadePaperTrader started (split-and-sell model)");
    this.log(
      `  ladder: ${this.config.ladderLevels} levels, ${(this.config.ladderSpacing * 100).toFixed(0)}¢ spacing`,
    );
    this.log(
      `  fade target: ${this.config.fadeTargetCents}¢, window: ${this.config.fadeWindowMs / 1000}s`,
    );
    this.log(
      `  max position: $${this.config.maxPositionSize}/level`,
    );
  }

  stop(): void {
    if (this.snapshotTimer) {
      clearInterval(this.snapshotTimer);
      this.snapshotTimer = null;
    }
    this.saveState();
    this.log("ShockFadePaperTrader stopped");
  }

  /**
   * Register a token pair for a market and initialize dry powder.
   * tokenIds[0] and tokenIds[1] are the two complementary outcomes.
   */
  registerTokenPair(tokenIds: string[], marketSlug: string): void {
    if (tokenIds.length < 2) {
      this.log(`⚠️ Market ${marketSlug} has <2 tokens, skipping`);
      return;
    }

    const pair: TokenPair = {
      marketSlug,
      tokenA: tokenIds[0],
      tokenB: tokenIds[1],
    };

    this.tokenPairs.set(tokenIds[0], pair);
    this.tokenPairs.set(tokenIds[1], pair);
    this.tokenToMarket.set(tokenIds[0], marketSlug);
    this.tokenToMarket.set(tokenIds[1], marketSlug);

    // Initialize dry powder for this market (pre-split 1 cycle)
    if (!this.dryPowder.has(marketSlug)) {
      this.splitForMarket(marketSlug, tokenIds[0], tokenIds[1]);
    }
  }

  // ============================================================================
  // DRY POWDER MANAGEMENT
  // ============================================================================

  /**
   * Split USDC to create dry powder for a market.
   * 1 cycle = $300 → 300 shares of each token.
   */
  private splitForMarket(marketSlug: string, tokenA: string, tokenB: string): void {
    const existing = this.dryPowder.get(marketSlug);
    const shares = CYCLE_SIZE_USD; // $300 split → 300 shares of each (at $1/split)

    if (existing) {
      existing.sharesA += shares;
      existing.sharesB += shares;
      existing.totalSplitCost += CYCLE_SIZE_USD;
      existing.splitCount++;
    } else {
      this.dryPowder.set(marketSlug, {
        marketSlug,
        tokenA,
        tokenB,
        sharesA: shares,
        sharesB: shares,
        totalSplitCost: CYCLE_SIZE_USD,
        splitCount: 1,
        mergeCount: 0,
      });
    }

    this.stats.totalSplitCost += CYCLE_SIZE_USD;
    this.log(
      `💧 SPLIT $${CYCLE_SIZE_USD} → ${shares} shares each for ${marketSlug} ` +
        `(total: ${existing ? existing.sharesA : shares}A / ${existing ? existing.sharesB : shares}B)`,
    );
  }

  /**
   * Check if a market needs a replenish (< 1 cycle of shares on either side).
   * Called after each order fill.
   */
  private checkReplenish(marketSlug: string): void {
    const dp = this.dryPowder.get(marketSlug);
    if (!dp) return;

    const minShares = CYCLE_SIZE_USD; // need at least 300 shares to cover a full cycle
    if (dp.sharesA < minShares || dp.sharesB < minShares) {
      this.log(
        `💧 Dry powder low for ${marketSlug}: ${dp.sharesA.toFixed(0)}A / ${dp.sharesB.toFixed(0)}B — replenishing`,
      );
      this.splitForMarket(marketSlug, dp.tokenA, dp.tokenB);
    }
  }

  /**
   * Consume shares from dry powder when placing an order.
   * Returns true if enough shares available, false if insufficient.
   */
  private consumeShares(marketSlug: string, tokenId: string, shares: number): boolean {
    const dp = this.dryPowder.get(marketSlug);
    if (!dp) return false;

    if (tokenId === dp.tokenA) {
      if (dp.sharesA < shares) return false;
      dp.sharesA -= shares;
    } else if (tokenId === dp.tokenB) {
      if (dp.sharesB < shares) return false;
      dp.sharesB -= shares;
    } else {
      return false;
    }
    return true;
  }

  /**
   * Return shares to dry powder (unfilled order cancelled, or merge).
   */
  private returnShares(marketSlug: string, tokenId: string, shares: number): void {
    const dp = this.dryPowder.get(marketSlug);
    if (!dp) return;

    if (tokenId === dp.tokenA) {
      dp.sharesA += shares;
    } else if (tokenId === dp.tokenB) {
      dp.sharesB += shares;
    }
  }

  /**
   * Get dry powder status for a market.
   */
  getDryPowder(marketSlug: string): DryPowder | undefined {
    return this.dryPowder.get(marketSlug);
  }

  /**
   * Get all dry powder inventories.
   */
  getAllDryPowder(): DryPowder[] {
    return Array.from(this.dryPowder.values());
  }

  /**
   * @deprecated Use registerTokenPair instead
   */
  registerToken(tokenId: string, marketSlug: string): void {
    this.tokenToMarket.set(tokenId, marketSlug);
  }

  /**
   * Get the complement token for a given token in the same market.
   */
  private getComplementToken(tokenId: string): string | null {
    const pair = this.tokenPairs.get(tokenId);
    if (!pair) return null;
    return pair.tokenA === tokenId ? pair.tokenB : pair.tokenA;
  }

  // ============================================================================
  // SHOCK HANDLER
  // ============================================================================

  handleShock(shock: ShockEvent): void {
    // Dedup
    const shockId = `${shock.tokenId}_${shock.timestamp}`;
    if (this.processedShocks.has(shockId)) return;
    this.processedShocks.add(shockId);

    this.stats.totalShocksDetected++;

    // Find complement token
    const complementToken = this.getComplementToken(shock.tokenId);
    if (!complementToken) {
      this.log(`⚠️ No complement token found for ${shock.tokenId} — cannot trade`);
      return;
    }

    // Place laddered SELL orders on the spiked side
    this.placeLadderOrders(shock, shockId, complementToken);
  }

  /**
   * Called when shock is classified (after API confirmation).
   * If scoring_run or structural, cancel unfilled orders and hedge positions.
   */
  handleShockClassification(
    shock: ShockEvent,
    classification: ShockClassification,
  ): void {
    const shockId = `${shock.tokenId}_${shock.timestamp}`;

    if (classification === "scoring_run" || classification === "structural") {
      this.log(
        `🚫 Shock ${shockId} classified as ${classification} — cancelling/hedging`,
      );

      // Cancel unfilled entry orders for this shock — return shares to dry powder
      for (const order of this.orders.values()) {
        if (order.shockId === shockId && order.status === "PENDING") {
          order.status = "CANCELLED";
          this.stats.totalOrdersCancelled++;
          this.returnShares(order.marketSlug, order.tokenId, order.shares);
          const complement = this.getComplementToken(order.tokenId);
          if (complement) this.returnShares(order.marketSlug, complement, order.shares);
          this.log(`  ❌ Cancelled order ${order.id} (level ${order.level}) — shares returned`);
        }
      }

      // Hedge open positions: sell the held token at market
      for (const pos of this.positions.values()) {
        if (pos.shockId === shockId && pos.status === "OPEN") {
          this.closePosition(pos, "HEDGED");
        }
      }
    }
  }

  // ============================================================================
  // LADDER ORDER PLACEMENT (always SELL)
  // ============================================================================

  private placeLadderOrders(
    shock: ShockEvent,
    shockId: string,
    complementTokenId: string,
  ): void {
    const { tokenId, marketSlug, direction, currentPrice } = shock;

    // Determine which token to sell:
    // If price spiked UP on this token → sell THIS token (it's overpriced)
    // If price dipped DOWN on this token → sell the COMPLEMENT (it spiked)
    const sellTokenId = direction === "up" ? tokenId : complementTokenId;
    const heldTokenId = direction === "up" ? complementTokenId : tokenId;

    // Get current price of the token we're selling
    const sellTokenPrice =
      direction === "up"
        ? currentPrice
        : 1.0 - currentPrice; // complement price ≈ 1 - this price

    // Size allocation: smallest at level 1, largest at level 3
    const sizeMultipliers = [0.5, 1.0, 1.5];
    const totalMultiplier = sizeMultipliers
      .slice(0, this.config.ladderLevels)
      .reduce((a, b) => a + b, 0);

    this.log(
      `⚡ Placing ${this.config.ladderLevels}-level SELL ladder on ${direction === "up" ? "spiked" : "complement"} token`,
    );
    this.log(
      `  Sell: ${sellTokenId.slice(0, 10)}... | Hold: ${heldTokenId.slice(0, 10)}... | Base: ${(sellTokenPrice * 100).toFixed(1)}¢`,
    );

    for (let level = 1; level <= this.config.ladderLevels; level++) {
      // Place SELL orders further INTO the overshoot (above current price of the spiked token)
      const offset = level * this.config.ladderSpacing;
      let limitPrice = sellTokenPrice + offset;

      // Clamp price to valid range [0.01, 0.99]
      limitPrice = Math.max(0.01, Math.min(0.99, limitPrice));

      // Shares = the unit. L1=50, L2=100, L3=150 shares.
      // Each share costs $1 to split (gives 1 of each token).
      // Selling N shares at price P → receive N×P USDC back.
      const sizeWeight = sizeMultipliers[level - 1] / totalMultiplier;
      const shares = this.config.maxPositionSize * sizeWeight * this.config.ladderLevels;
      const splitCost = shares; // $1 per share split
      const proceedsIfFilled = shares * limitPrice; // what we get back from selling

      // Consume shares from dry powder (both sides from the split)
      if (!this.consumeShares(marketSlug, sellTokenId, shares)) {
        this.log(`⚠️ Insufficient dry powder for L${level} on ${marketSlug} — skipping`);
        continue;
      }
      this.consumeShares(marketSlug, heldTokenId, shares);

      const orderId = `ord_${Date.now()}_${level}_${Math.random().toString(36).slice(2, 6)}`;

      const order: LadderOrder = {
        id: orderId,
        tokenId: sellTokenId,
        marketSlug,
        side: "SELL",
        leg: "ENTRY",
        price: limitPrice,
        size: splitCost, // cost basis = shares (split cost)
        shares,
        level,
        status: "PENDING",
        createdAt: Date.now(),
        filledAt: null,
        fillPrice: null,
        shockId,
        splitCost,
      };

      this.orders.set(orderId, order);
      this.stats.totalOrdersPlaced++;

      this.log(
        `📝 SELL L${level}: ${shares.toFixed(0)} shares @ ${(limitPrice * 100).toFixed(1)}¢ ` +
          `(split cost: $${splitCost.toFixed(0)}, proceeds: $${proceedsIfFilled.toFixed(0)}) [${marketSlug}]`,
      );
    }

    // Store the held token ID in the shock for position creation later
    (shock as any)._heldTokenId = heldTokenId;
    (shock as any)._sellTokenId = sellTokenId;

    this.emit("ordersPlaced", {
      shockId,
      marketSlug,
      orderCount: this.config.ladderLevels,
      sellTokenId,
      heldTokenId,
    });
  }

  // ============================================================================
  // FILL SIMULATION
  // ============================================================================

  private handlePriceUpdate(event: PriceUpdateEvent): void {
    const { tokenId, bid, ask } = event;
    const mid = (bid + ask) / 2;

    this.latestPrices.set(tokenId, { bid, ask, mid });

    // DON'T auto-fill on bid/ask updates - only on actual trades
    // This is more realistic: orders fill when there's a transaction at that price
  }

  private handleTrade(event: TradeEvent): void {
    const { tokenId, tradePrice } = event;
    // Only fill when there's an actual trade at our price level
    this.checkOrderFillsAtPrice(tokenId, tradePrice);
    this.checkTakeProfitsAtPrice(tokenId, tradePrice);
  }

  /**
   * SELL orders fill when market bid reaches our limit price.
   * (Someone is willing to buy at our price.)
   */
  private checkOrderFills(tokenId: string, bid: number, _ask: number): void {
    for (const order of this.orders.values()) {
      if (order.tokenId !== tokenId || order.status !== "PENDING") continue;

      // SELL fills when bid >= our limit price
      if (bid >= order.price) {
        this.fillOrder(order, order.price);
      }
    }
  }

  private checkOrderFillsAtPrice(tokenId: string, tradePrice: number): void {
    for (const order of this.orders.values()) {
      if (order.tokenId !== tokenId || order.status !== "PENDING") continue;

      // SELL fills when trade price >= our limit
      if (tradePrice >= order.price) {
        this.fillOrder(order, order.price);
      }
    }
  }

  private fillOrder(order: LadderOrder, fillPrice: number): void {
    order.status = "FILLED";
    order.filledAt = Date.now();
    order.fillPrice = fillPrice;
    this.stats.totalOrdersFilled++;

    const proceeds = order.shares * fillPrice;
    this.log(
      `✅ FILLED: SELL L${order.level} ${order.shares.toFixed(0)} shares @ ${(fillPrice * 100).toFixed(1)}¢ ` +
        `(proceeds: $${proceeds.toFixed(0)}, split cost: $${order.splitCost.toFixed(0)}) [${order.marketSlug}]`,
    );

    // Create a position — we sold one side, now holding the complement
    const heldTokenId = this.getComplementToken(order.tokenId);
    if (!heldTokenId) {
      this.log(`⚠️ Can't find complement for ${order.tokenId} — position not created`);
      return;
    }

    // Take-profit: sell the held token when its price reaches a target
    // Profit comes from: sell_price + exit_price > 1.00 (the split cost)
    // If we sold at, say, 0.62¢, we need to sell the complement at > 0.38¢ to profit
    // Target: sell complement at (1.00 - fillPrice + fadeTarget)
    const fadeTarget = this.config.fadeTargetCents / 100;
    const breakEvenExitPrice = 1.0 - fillPrice; // what complement needs to sell at to break even
    const takeProfitPrice = Math.min(0.99, breakEvenExitPrice + fadeTarget);

    const posId = `pos_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

    const position: FadePosition = {
      id: posId,
      marketSlug: order.marketSlug,
      soldTokenId: order.tokenId,
      soldPrice: fillPrice,
      soldShares: order.shares,
      heldTokenId,
      heldShares: order.shares, // from the split, we get equal shares of both
      splitCost: order.splitCost,
      entryTime: Date.now(),
      takeProfitPrice,
      status: "OPEN",
      exitPrice: null,
      exitTime: null,
      pnl: null,
      shockId: order.shockId,
      orderId: order.id,
    };

    this.positions.set(posId, position);
    this.stats.totalPositionsOpened++;
    this.stats.totalSplitCost += order.splitCost;

    const capitalAtRisk = order.shares * (1.0 - fillPrice);
    this.log(
      `📈 Position opened: ${posId} — ${order.shares.toFixed(0)} shares`,
    );
    this.log(
      `  Sold @ ${(fillPrice * 100).toFixed(1)}¢ → proceeds $${(order.shares * fillPrice).toFixed(0)} | Holding complement: $${capitalAtRisk.toFixed(0)} at risk`,
    );
    this.log(
      `  Break-even exit: sell complement @ ${(breakEvenExitPrice * 100).toFixed(1)}¢ | TP: ${(takeProfitPrice * 100).toFixed(1)}¢ (+${this.config.fadeTargetCents}¢ profit)`,
    );

    this.emit("positionOpened", position);
  }

  // ============================================================================
  // TAKE PROFIT — sell the held (complement) token
  // ============================================================================

  /**
   * Check if the held token's market bid has reached our take-profit price.
   * If so, we sell the complement to close the position.
   */
  /**
   * Take profit AND stop loss on actual trades.
   * TP: Trade at or above TP price → profit
   * SL: Trade below break-even price → cut loss
   */
  private checkTakeProfitsAtPrice(tokenId: string, tradePrice: number): void {
    const FILL_TOLERANCE = 0.005; // 0.5¢ tolerance
    
    for (const pos of this.positions.values()) {
      if (pos.heldTokenId !== tokenId || pos.status !== "OPEN") continue;

      // TAKE PROFIT: price faded back favorably
      if (Math.abs(tradePrice - pos.takeProfitPrice) <= FILL_TOLERANCE) {
        this.closePosition(pos, "TAKE_PROFIT");
        continue;
      }

      // STOP LOSS: price moved against us (shock didn't fade, continued trending)
      // Break-even price = 1.00 - soldPrice (complement must be >= this to break even)
      // If shock continues, complement price drops below break-even → stop out
      const breakEvenPrice = 1.0 - pos.soldPrice;
      const stopLossPrice = breakEvenPrice - 0.03; // Stop 3¢ below break-even
      
      if (tradePrice <= stopLossPrice) {
        this.log(`🛑 STOP LOSS: ${pos.id} — price moved against us (held token: ${(tradePrice * 100).toFixed(1)}¢ < SL ${(stopLossPrice * 100).toFixed(1)}¢)`);
        this.closePosition(pos, "STOP_LOSS");
      }
    }
  }

  // ============================================================================
  // CLOSE POSITION — always by selling the held token
  // ============================================================================

  private closePosition(pos: FadePosition, reason: PositionStatus): void {
    let exitPrice: number;

    if (reason === "TAKE_PROFIT") {
      exitPrice = pos.takeProfitPrice;
    } else {
      // Hedging or expiry: sell at current market bid for the held token
      const prices = this.latestPrices.get(pos.heldTokenId);
      if (prices) {
        exitPrice = prices.bid; // selling at bid
      } else {
        // Fallback: estimate from sold token price
        const soldPrices = this.latestPrices.get(pos.soldTokenId);
        exitPrice = soldPrices ? 1.0 - soldPrices.mid : 1.0 - pos.soldPrice;
      }
    }

    // P&L calculation for split-and-sell:
    // We spent `splitCost` USDC to split into both tokens
    // We sold token A at `soldPrice` per share
    // We sold token B (complement) at `exitPrice` per share
    // Total proceeds = (soldPrice + exitPrice) * shares
    // P&L = proceeds - splitCost
    //
    // Since splitCost = shares * 1.00 (each split costs $1),
    // P&L = (soldPrice + exitPrice - 1.00) * shares
    const totalProceedsPerShare = pos.soldPrice + exitPrice;
    const pnlPerShare = totalProceedsPerShare - 1.0; // profit above the $1 split cost
    const pnl = pnlPerShare * pos.soldShares;
    const totalProceeds = totalProceedsPerShare * pos.soldShares;

    pos.status = reason;
    pos.exitPrice = exitPrice;
    pos.exitTime = Date.now();
    pos.pnl = pnl;

    this.stats.totalPositionsClosed++;
    this.stats.totalPnL += pnl;
    this.stats.totalProceeds += totalProceeds;
    this.stats.runningBalance += pnl;

    if (pnl > 0) {
      this.stats.winCount++;
    } else {
      this.stats.lossCount++;
    }

    // Track P&L history for Sharpe
    this.pnlHistory.push(pnl);

    // Update max drawdown
    if (this.stats.runningBalance > this.peakBalance) {
      this.peakBalance = this.stats.runningBalance;
    }
    const drawdown = this.peakBalance - this.stats.runningBalance;
    if (drawdown > this.stats.maxDrawdown) {
      this.stats.maxDrawdown = drawdown;
    }

    // Recalculate aggregate stats
    this.recalcStats();

    // Create trade record
    const fadeCapture = Math.abs(pnlPerShare) * 100; // in cents
    const holdTimeMs = (pos.exitTime || Date.now()) - pos.entryTime;

    const record: TradeRecord = {
      id: `trade_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
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
      exitTime: pos.exitTime || Date.now(),
      shockMagnitude: 0,
      shockZScore: 0,
      fadeCapture,
      holdTimeMs,
    };

    this.tradeHistory.push(record);

    // Keep last 1000 trades
    if (this.tradeHistory.length > 1000) {
      this.tradeHistory = this.tradeHistory.slice(-500);
    }

    const emoji = pnl >= 0 ? "💰" : "💸";
    this.log(
      `${emoji} Position closed (${reason}): ${pos.id}`,
    );
    this.log(
      `  Sold side: ${(pos.soldPrice * 100).toFixed(1)}¢ | Exit (complement sell): ${(exitPrice * 100).toFixed(1)}¢`,
    );
    this.log(
      `  Combined: ${(totalProceedsPerShare * 100).toFixed(1)}¢/share (${totalProceedsPerShare > 1.0 ? "profit" : "loss"})`,
    );
    this.log(
      `  P&L: ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)} (${pos.soldShares.toFixed(1)} shares, ${(holdTimeMs / 1000).toFixed(0)}s hold)`,
    );

    // Check if we need to replenish dry powder after closing
    this.checkReplenish(pos.marketSlug);

    this.emit("positionClosed", { position: pos, record });
  }

  // ============================================================================
  // EVENT-DRIVEN EXIT — close all positions for a market on next goal event
  // ============================================================================

  /**
   * Called when a new goal event is detected for a market.
   * Closes all open positions for that market (the fade is over, next event disrupts it).
   * Also cancels any unfilled pending orders for that market.
   */
  handleGameEvent(marketSlug: string): void {
    let closedCount = 0;
    let cancelledCount = 0;

    // Close all open positions for this market
    for (const pos of this.positions.values()) {
      if (pos.marketSlug !== marketSlug || pos.status !== "OPEN") continue;
      this.closePosition(pos, "CLOSED"); // "CLOSED" = event-driven exit
      closedCount++;
    }

    // Cancel unfilled orders for this market — return shares to dry powder
    for (const order of this.orders.values()) {
      if (order.marketSlug !== marketSlug || order.status !== "PENDING") continue;
      order.status = "CANCELLED";
      this.stats.totalOrdersCancelled++;
      this.returnShares(order.marketSlug, order.tokenId, order.shares);
      const complement = this.getComplementToken(order.tokenId);
      if (complement) this.returnShares(order.marketSlug, complement, order.shares);
      cancelledCount++;
    }

    if (closedCount > 0 || cancelledCount > 0) {
      this.log(
        `🏟️ Event exit: ${marketSlug} — closed ${closedCount} positions, cancelled ${cancelledCount} orders`,
      );
    }
  }

  // ============================================================================
  // ORDER EXPIRY (fallback timeout — 600s)
  // ============================================================================

  private checkOrderExpiry(): void {
    const now = Date.now();

    for (const order of this.orders.values()) {
      if (order.status !== "PENDING") continue;

      const elapsed = now - order.createdAt;
      if (elapsed >= this.config.fadeWindowMs) {
        order.status = "EXPIRED";
        this.stats.totalOrdersExpired++;

        // Return shares to dry powder (both sell token and held complement)
        this.returnShares(order.marketSlug, order.tokenId, order.shares);
        const complement = this.getComplementToken(order.tokenId);
        if (complement) this.returnShares(order.marketSlug, complement, order.shares);

        this.log(
          `⏰ Order expired: ${order.id} L${order.level} @ ${(order.price * 100).toFixed(1)}¢ [${order.marketSlug}] — shares returned to dry powder`,
        );

        // Check if we need to replenish
        this.checkReplenish(order.marketSlug);
      }
    }

    // Fallback timeout: close positions older than 600s (event-driven exit should catch most)
    const maxPositionAge = 600_000; // 600s hard fallback
    for (const pos of this.positions.values()) {
      if (pos.status !== "OPEN") continue;

      const elapsed = now - pos.entryTime;
      if (elapsed >= maxPositionAge) {
        this.log(`⏰ Position timeout (600s fallback): ${pos.id} — selling held token at market`);
        this.closePosition(pos, "CLOSED");
      }
    }
  }

  // ============================================================================
  // STATS
  // ============================================================================

  private recalcStats(): void {
    const totalTrades = this.stats.winCount + this.stats.lossCount;
    this.stats.winRate =
      totalTrades > 0 ? this.stats.winCount / totalTrades : 0;

    if (this.tradeHistory.length > 0) {
      this.stats.avgFadeCaptureCents =
        this.tradeHistory.reduce((s, t) => s + t.fadeCapture, 0) /
        this.tradeHistory.length;
      this.stats.avgHoldTimeMs =
        this.tradeHistory.reduce((s, t) => s + t.holdTimeMs, 0) /
        this.tradeHistory.length;
    }

    // Sharpe ratio (annualized, assuming 8 trades/day)
    if (this.pnlHistory.length >= 2) {
      const mean =
        this.pnlHistory.reduce((a, b) => a + b, 0) / this.pnlHistory.length;
      const variance =
        this.pnlHistory.reduce((s, v) => s + (v - mean) ** 2, 0) /
        this.pnlHistory.length;
      const stddev = Math.sqrt(variance);
      this.stats.sharpeRatio =
        stddev > 0 ? (mean / stddev) * Math.sqrt(252 * 8) : 0;
    }
  }

  getStats(): ShockFadePaperStats {
    return { ...this.stats };
  }

  getActiveOrders(): LadderOrder[] {
    return Array.from(this.orders.values()).filter(
      (o) => o.status === "PENDING",
    );
  }

  getAllOrders(): LadderOrder[] {
    return Array.from(this.orders.values());
  }

  getOpenPositions(): FadePosition[] {
    return Array.from(this.positions.values()).filter(
      (p) => p.status === "OPEN",
    );
  }

  getAllPositions(): FadePosition[] {
    return Array.from(this.positions.values());
  }

  getTradeHistory(): TradeRecord[] {
    return [...this.tradeHistory];
  }

  getCumulativeTPs(): any[] {
    return []; // Paper trader doesn't use cumulative TPs
  }

  getLatestPrice(
    tokenId: string,
  ): { bid: number; ask: number; mid: number } | undefined {
    return this.latestPrices.get(tokenId);
  }

  // ============================================================================
  // PERSISTENCE (JSON snapshots)
  // ============================================================================

  private saveState(): void {
    try {
      const dir = path.dirname(this.snapshotPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      const state = {
        timestamp: Date.now(),
        model: "split-and-sell",
        orders: Array.from(this.orders.values()),
        positions: Array.from(this.positions.values()),
        tradeHistory: this.tradeHistory.slice(-200),
        stats: this.stats,
        pnlHistory: this.pnlHistory.slice(-500),
        peakBalance: this.peakBalance,
      };

      fs.writeFileSync(this.snapshotPath, JSON.stringify(state, null, 2));
    } catch (err) {
      this.log(`Failed to save state: ${err}`);
    }
  }

  private loadState(): void {
    try {
      if (!fs.existsSync(this.snapshotPath)) {
        this.log("No persisted state found, starting fresh");
        return;
      }

      const data = JSON.parse(fs.readFileSync(this.snapshotPath, "utf-8"));

      // If old model (not split-and-sell), discard
      if (data.model !== "split-and-sell") {
        this.log("Old model state found, starting fresh with split-and-sell model");
        return;
      }

      // Restore orders (skip PENDING — they're stale after restart)
      for (const order of data.orders || []) {
        if (order.status !== "PENDING") {
          this.orders.set(order.id, order);
        }
      }

      // Restore positions (skip OPEN — they're stale)
      for (const pos of data.positions || []) {
        if (pos.status !== "OPEN") {
          this.positions.set(pos.id, pos);
        }
      }

      this.tradeHistory = data.tradeHistory || [];
      this.pnlHistory = data.pnlHistory || [];
      this.peakBalance = data.peakBalance || this.peakBalance;

      if (data.stats) {
        this.stats = { ...this.stats, ...data.stats };
      }

      this.log(
        `Loaded state: ${this.tradeHistory.length} trades, ${this.stats.totalPnL >= 0 ? "+" : ""}$${this.stats.totalPnL.toFixed(2)} P&L`,
      );
    } catch (err) {
      this.log(`Failed to load state: ${err}`);
    }
  }

  // ============================================================================
  // LOGGING
  // ============================================================================

  private log(message: string): void {
    const ts = new Date().toISOString();
    console.log(`${ts} [INFO] 📊 [ShockFadePaper] ${message}`);
  }
}
