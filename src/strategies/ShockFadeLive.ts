/**
 * ShockFadeLive.ts — LIVE trading bot for the shock-fade strategy.
 *
 * SPLIT-AND-SELL MODEL on Polymarket CTF sports moneyline markets:
 *   1. Pre-split USDC into CTF shares at game start (dry powder)
 *   2. Detect mid-game price shocks via z-score (3σ on 60s window)
 *   3. Event-filter: burst-poll free league API, only trade single_event shocks
 *   4. Place laddered GTC SELL limit orders on the spiked token (+3¢, +6¢, +9¢)
 *   5. Exit on next scoring event (market sell complement) or take-profit
 *   6. Scoring run protection: bail if 2+ same-team events detected
 *
 * Uses real infrastructure: SplitClient, MergeClient, PolymarketClient.
 * Uses market.negRisk from SportsMarketDiscovery:
 *   - NBA/NHL/NFL/MLB moneylines (2-outcome): negRisk=false (regular CTF)
 *   - Soccer 3-way (Home/Draw/Away): negRisk=true (NegRisk adapter)
 *   - Futures/outrights: negRisk=true
 */

import { EventEmitter } from "events";
import * as fs from "fs";
import * as path from "path";
import {
  OrderBookWebSocket,
  PriceUpdateEvent,
} from "../services/OrderBookWS";
import {
  ShockEvent,
  ShockClassification,
  ShockFadeConfig,
  DEFAULT_SHOCK_FADE_CONFIG,
} from "./ShockFadeDetector";
import { SplitClient } from "../services/SplitClient";
import { MergeClient } from "../services/MergeClient";
import { PolymarketClient } from "../services/PolymarketClient";
import { SportsMarket } from "../services/SportsMarketDiscovery";
import { UserChannelWS, OrderFillEvent, OrderUpdateEvent } from "../services/UserChannelWS";

// ============================================================================
// TYPES
// ============================================================================

/**
 * Cumulative TP — ONE resting SELL limit order per market cycle.
 * Tracks the blended entry price from all filled ladder orders and
 * manages a single TP order that gets replaced (cancel+new) as more
 * ladders fill or partial TP fills occur.
 */
export interface CumulativeTP {
  marketSlug: string;
  conditionId: string;
  negRisk: boolean;

  /** Token we sold into shock (HOME/spiked side) */
  soldTokenId: string;
  /** Token we're holding and will TP-sell (AWAY/complement) */
  heldTokenId: string;

  /** Total shares across all filled entry ladders */
  totalEntryShares: number;
  /** Shares already sold via TP fills */
  filledTPShares: number;
  /** Blended entry price across all filled entry ladders (weighted avg of sell prices) */
  blendedEntryPrice: number;

  /** Current TP price = 1.00 - blendedEntryPrice + fadeTarget */
  tpPrice: number;
  /** Shares in the current TP order = totalEntryShares - filledTPShares */
  tpShares: number;
  /** Polymarket order ID for the current resting TP order (or dry-run ID) */
  tpOrderId: string | null;

  /** Partial P&L already booked from partial TP fills */
  partialPnL: number;

  /** Shock ID that started this cycle */
  shockId: string;

  /** When this cycle started */
  createdAt: number;

  /** Status */
  status: "WATCHING" | "PARTIAL" | "HIT" | "EVENT_EXIT" | "SCORING_RUN_BAIL" | "TIMEOUT" | "CLOSED";

  /** Weighted sum of entry: sum(shares_i * price_i) for blended calc */
  _weightedEntrySum: number;

  /** Team tricode that caused the shock (for per-cycle event exit) */
  shockTeam: string | null;
}

export interface LivePosition {
  id: string;
  marketSlug: string;
  conditionId: string;
  negRisk: boolean;  // from market discovery — controls split/sell/merge contract

  /** Token we sold (the spiked side) */
  soldTokenId: string;
  soldPrice: number;
  soldShares: number;

  /** Token we're holding (complement) — to be sold on exit */
  heldTokenId: string;
  heldShares: number;

  /** Cost basis — USDC spent on splits for these shares */
  splitCost: number;

  /** Entry / exit timing */
  entryTime: number;
  exitTime: number | null;

  /** Target sell price for the held token (take-profit) */
  takeProfitPrice: number;

  /** Exit price actually achieved */
  exitPrice: number | null;

  /** P&L = (soldPrice + exitPrice - 1.00) × shares */
  pnl: number | null;

  /** Originating shock */
  shockId: string;

  /** Status */
  status: "OPEN" | "TAKE_PROFIT" | "EVENT_EXIT" | "SCORING_RUN_BAIL" | "TIMEOUT" | "CLOSED";
}

export interface LiveLadderOrder {
  id: string;
  orderId: string | null;  // Polymarket order ID after placement
  tokenId: string;
  marketSlug: string;
  conditionId: string;
  price: number;
  shares: number;
  level: number;           // 1, 2, or 3
  status: "PENDING_PLACE" | "RESTING" | "FILLED" | "CANCELLED" | "FAILED";
  createdAt: number;
  filledAt: number | null;
  fillPrice: number | null;
  shockId: string;
}

export interface MarketInventory {
  marketSlug: string;
  conditionId: string;
  tokenA: string;
  tokenB: string;
  sharesA: number;  // shares of token A from splits
  sharesB: number;  // shares of token B from splits
  totalSplitCost: number;
  splitCount: number;
  negRisk: boolean; // false for 2-outcome moneylines, true for soccer 3-way / futures
}

export interface LiveTradeRecord {
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
  exitReason: string;
  holdTimeMs: number;
}

export interface LiveStats {
  totalShocksProcessed: number;
  totalOrdersPlaced: number;
  totalOrdersFilled: number;
  totalOrdersCancelled: number;
  totalPositionsOpened: number;
  totalPositionsClosed: number;
  totalPnL: number;
  totalSplitCost: number;
  totalProceeds: number;
  winCount: number;
  lossCount: number;
  winRate: number;
  startedAt: number | null;
}

export interface ShockFadeLiveConfig extends ShockFadeConfig {
  dryRun: boolean;
  maxPerGame: number;          // max USDC per game (default $35)
  maxConcurrentGames: number;  // max games with pre-split inventory (capital-limited)
  maxCyclesPerGame: number;    // max concurrent active cycles per game (default 1)
  maxConsecutiveLosses: number; // auto-stop after N losses (default 3)
  maxSessionLoss: number;       // circuit breaker: stop if total loss > N (default $30)
  ladderSizes: number[];        // shares per level (default [5, 10, 15])
  sellPriceMax: number;         // max sell price for ladders (default 0.85) — won't sell above this
  /** @deprecated Use maxConcurrentGames + maxCyclesPerGame instead */
  maxConcurrentMarkets?: number;
}

// Default ladder sizing: 5 + 10 + 15 = 30 shares per cycle
const DEFAULT_LADDER_SIZES = [5, 10, 15];
const DEFAULT_CYCLE_SIZE = DEFAULT_LADDER_SIZES.reduce((a, b) => a + b, 0); // 30

// ============================================================================
// SHOCK FADE LIVE TRADER
// ============================================================================

export class ShockFadeLive extends EventEmitter {
  private config: ShockFadeLiveConfig;
  private ws: OrderBookWebSocket;

  // Real clients
  private splitClient: SplitClient;
  private mergeClient: MergeClient;
  private polyClient: PolymarketClient;

  // State
  private inventory: Map<string, MarketInventory> = new Map();
  private orders: Map<string, LiveLadderOrder> = new Map();
  private positions: Map<string, LivePosition> = new Map();
  private tradeHistory: LiveTradeRecord[] = [];
  private cumulativeTPs: Map<string, CumulativeTP> = new Map();  // keyed by shockId (was marketSlug pre-refactor)
  private shockTeams: Map<string, string | null> = new Map();   // shockId → team tricode
  private stats: LiveStats;

  // Shock tracking
  private processedShocks: Set<string> = new Set();

  // Token pair mapping: tokenId → { marketSlug, tokenA, tokenB }
  private tokenPairs: Map<string, { marketSlug: string; tokenA: string; tokenB: string }> = new Map();
  private tokenToMarket: Map<string, string> = new Map();

  // Market metadata: marketSlug → SportsMarket
  private marketMeta: Map<string, SportsMarket> = new Map();

  // Price tracking
  private latestPrices: Map<string, { bid: number; ask: number; mid: number }> = new Map();

  // P&L history for stats
  private pnlHistory: number[] = [];

  // Safety state
  private consecutiveLosses: number = 0;
  private halted: boolean = false;
  private haltReason: string | null = null;

  // Per-market mutex for shock processing (prevents concurrent cycle creation)
  private marketLocks: Map<string, Promise<void>> = new Map();
  private activeMarketCount: number = 0;

  // Ladder sizes
  private ladderSizes: number[];
  private cycleSize: number;
  private preSplitSize: number; // (maxCyclesPerGame × cycleSize) + L1 + L2 buffer
  private refillThreshold: number; // trigger refill when min(A,B) ≤ cycleSize
  private refillAmount: number;    // split 1 cycleSize at a time
  private refillInProgress: Set<string> = new Set(); // markets currently refilling

  // Persistence
  private statePath: string;
  private saveTimer: NodeJS.Timeout | null = null;

  // Timeouts for position fallback
  private positionTimeouts: Map<string, NodeJS.Timeout> = new Map();

  // Order fill polling
  private fillPollTimer: NodeJS.Timeout | null = null;

  // User channel WebSocket for real-time fill detection
  private userChannelWS: UserChannelWS | null = null;
  private wsHandledOrderIds: Set<string> = new Set();  // orderId → already handled by WS (skip in polling)

  // Game event tracker for late-game filtering
  private gameEvents: any = null;  // GameEventConfirmation instance (from run script)

  constructor(
    ws: OrderBookWebSocket,
    splitClient: SplitClient,
    mergeClient: MergeClient,
    polyClient: PolymarketClient,
    config: Partial<ShockFadeLiveConfig> = {},
    statePath: string = "./data/shock-fade-live-state.json",
    userChannelWS?: UserChannelWS,
  ) {
    super();
    this.ws = ws;
    this.splitClient = splitClient;
    this.mergeClient = mergeClient;
    this.polyClient = polyClient;
    this.statePath = statePath;

    this.config = {
      ...DEFAULT_SHOCK_FADE_CONFIG,
      dryRun: true,  // *** DRY-RUN BY DEFAULT — CRITICALLY IMPORTANT ***
      maxPerGame: 50,
      maxConcurrentGames: 3,
      maxCyclesPerGame: 1,
      maxConsecutiveLosses: 3,
      maxSessionLoss: 30,
      ladderSizes: DEFAULT_LADDER_SIZES,
      sellPriceMax: 0.85,  // Default: won't place ladders selling above 85¢
      ...config,
    };

    // Migrate deprecated maxConcurrentMarkets → maxConcurrentGames
    if (config.maxConcurrentMarkets !== undefined && config.maxConcurrentGames === undefined) {
      this.config.maxConcurrentGames = config.maxConcurrentMarkets;
    }

    // Store optional user channel WS for real-time fills
    if (userChannelWS) {
      this.userChannelWS = userChannelWS;
    }

    this.ladderSizes = this.config.ladderSizes;
    this.cycleSize = this.ladderSizes.reduce((a, b) => a + b, 0);
    // Pre-split: (maxCycles × cycleSize) + L1 cushion
    this.preSplitSize = (this.cycleSize * this.config.maxCyclesPerGame) + (this.ladderSizes[0] || 0);
    // Auto-refill: when either side ≤ cycleSize, split another cycleSize
    this.refillThreshold = this.cycleSize;
    this.refillAmount = this.cycleSize;

    this.stats = {
      totalShocksProcessed: 0,
      totalOrdersPlaced: 0,
      totalOrdersFilled: 0,
      totalOrdersCancelled: 0,
      totalPositionsOpened: 0,
      totalPositionsClosed: 0,
      totalPnL: 0,
      totalSplitCost: 0,
      totalProceeds: 0,
      winCount: 0,
      lossCount: 0,
      winRate: 0,
      startedAt: null,
    };
  }

  // ============================================================================
  // LIFECYCLE
  // ============================================================================

  start(): void {
    this.stats.startedAt = Date.now();

    // Listen for price updates for TP detection
    this.ws.on("priceUpdate", (event: PriceUpdateEvent) =>
      this.handlePriceUpdate(event),
    );

    // Load persisted state
    this.loadState();

    // Periodic save
    this.saveTimer = setInterval(() => this.saveState(), 30000);

    // Cancel stale resting entry orders every 10s (60s expiry — overshoot window is gone)
    setInterval(() => this.cancelStaleOrders(), 10000);

    // Poll resting orders for fills every 5s (live mode only — kept as fallback safety net)
    if (!this.config.dryRun) {
      this.fillPollTimer = setInterval(() => {
        this.pollRestingOrderFills();
        this.checkStalePositions();
      }, 5000);
    }

    // Wire UserChannelWS for real-time fill detection (live mode only)
    if (this.userChannelWS && !this.config.dryRun) {
      this.userChannelWS.on("orderFill", (fill: OrderFillEvent) => {
        this.handleUserChannelFill(fill.orderId, fill.price, fill.size, fill.status).catch(err => {
          this.log(`⚠️ [WS] Fill handler error: ${err?.message || err}`);
        });
      });

      this.userChannelWS.on("orderUpdate", (update: OrderUpdateEvent) => {
        if (update.type === "CANCELLATION") {
          this.handleUserChannelCancellation(update.orderId);
        }
      });

      this.log("📡 UserChannelWS wired for real-time fill detection");
    }

    const modeTag = this.config.dryRun ? "[DRY-RUN]" : "⚠️  [LIVE — REAL MONEY] ⚠️";
    this.log(`ShockFadeLive started ${modeTag}`);
    this.log(`  ladder: ${this.config.ladderLevels} levels, ${(this.config.ladderSpacing * 100).toFixed(0)}¢ spacing`);
    this.log(`  sizes: ${this.ladderSizes.join("/")} shares = ${this.cycleSize}/cycle (pre-split: ${this.preSplitSize}/game)`);
    this.log(`  TP: ${this.config.fadeTargetCents}¢, timeout: event-driven (600s emergency)`);
    this.log(`  max/game: $${this.config.maxPerGame}`);
    this.log(`  max concurrent games: ${this.config.maxConcurrentGames} (pre-split budget: $${this.config.maxConcurrentGames * this.preSplitSize})`);
    this.log(`  max cycles/game: ${this.config.maxCyclesPerGame}`);
    this.log(`  sell price max: ${(this.config.sellPriceMax * 100).toFixed(0)}¢ (won't place ladders above this)`);
    this.log(`  auto-refill: split $${this.refillAmount} when either side ≤ ${this.refillThreshold} shares`);
    this.log(`  circuit breaker: stop after ${this.config.maxConsecutiveLosses} consecutive losses or $${this.config.maxSessionLoss} total loss`);
  }

  stop(): void {
    if (this.saveTimer) {
      clearInterval(this.saveTimer);
      this.saveTimer = null;
    }
    if (this.fillPollTimer) {
      clearInterval(this.fillPollTimer);
      this.fillPollTimer = null;
    }
    // Clear position timeouts
    for (const timer of this.positionTimeouts.values()) {
      clearTimeout(timer);
    }
    this.positionTimeouts.clear();
    this.saveState();
    this.log("ShockFadeLive stopped");
  }

  // ============================================================================
  // MARKET REGISTRATION & PRE-SPLITTING
  // ============================================================================

  /**
   * Register a token pair for a market.
   * Does NOT auto-split — call preSplitForMarket() when game starts.
   */
  registerTokenPair(market: SportsMarket): void {
    if (market.tokenIds.length < 2) {
      this.log(`⚠️ Market ${market.marketSlug} has <2 tokens, skipping`);
      return;
    }

    const tokenA = market.tokenIds[0];
    const tokenB = market.tokenIds[1];

    const pair = { marketSlug: market.marketSlug, tokenA, tokenB };
    this.tokenPairs.set(tokenA, pair);
    this.tokenPairs.set(tokenB, pair);
    this.tokenToMarket.set(tokenA, market.marketSlug);
    this.tokenToMarket.set(tokenB, market.marketSlug);
    this.marketMeta.set(market.marketSlug, market);

    this.log(`📋 Registered ${market.marketSlug} (${tokenA.slice(0, 8)}… / ${tokenB.slice(0, 8)}…)`);
  }

  /**
   * Set GameEventConfirmation instance for late-game filtering.
   * Called from run script after gameEvents is initialized.
   */
  setGameEvents(gameEvents: any): void {
    this.gameEvents = gameEvents;
  }

  /**
   * Get the number of games currently with pre-split inventory.
   */
  getPreSplitGameCount(): number {
    return this.inventory.size;
  }

  /**
   * Check if we can pre-split for another game (respects maxConcurrentGames).
   */
  canPreSplitForGame(marketSlug: string): boolean {
    // Already have inventory for this market — always allow (refresh/top-up)
    if (this.inventory.has(marketSlug)) return true;
    // Check game limit
    return this.inventory.size < this.config.maxConcurrentGames;
  }

  /**
   * Pre-split USDC into CTF shares for a market.
   * Call this when game starts (or shortly before). Takes 10-11s on-chain.
   */
  async preSplitForMarket(marketSlug: string): Promise<boolean> {
    const market = this.marketMeta.get(marketSlug);
    if (!market || !market.conditionId) {
      this.log(`❌ Cannot pre-split: no market/conditionId for ${marketSlug}`);
      return false;
    }

    // Skip if extreme price already triggered for this market (game decided)
    if (this.extremePriceTriggered.has(marketSlug)) {
      this.log(`⏭️ Skipping pre-split for ${marketSlug} — extreme price already triggered (game decided)`);
      return false;
    }

    // Skip if game is already decided — check LIVE WS prices first, then discovery prices
    if (market.tokenIds?.length >= 2) {
      const priceA = this.latestPrices.get(market.tokenIds[0]);
      const priceB = this.latestPrices.get(market.tokenIds[1]);
      const liveBidA = priceA?.bid;
      const liveBidB = priceB?.bid;
      if ((liveBidA !== undefined && (liveBidA >= 0.95 || liveBidA <= 0.05)) ||
          (liveBidB !== undefined && (liveBidB >= 0.95 || liveBidB <= 0.05))) {
        this.log(`⏭️ Skipping pre-split for ${marketSlug} — game decided (live prices: ${liveBidA !== undefined ? (liveBidA * 100).toFixed(1) + '¢' : '?'} / ${liveBidB !== undefined ? (liveBidB * 100).toFixed(1) + '¢' : '?'})`);
        this.extremePriceTriggered.add(marketSlug); // prevent future splits too
        return false;
      }
    }
    // Fallback: check discovery prices (Gamma API cache)
    if (market.outcomePrices && market.outcomePrices.length >= 2) {
      const maxPrice = Math.max(...market.outcomePrices);
      const minPrice = Math.min(...market.outcomePrices);
      if (maxPrice > 0.95 || minPrice < 0.05) {
        this.log(`⏭️ Skipping pre-split for ${marketSlug} — game already decided (prices: ${market.outcomePrices.map(p => (p * 100).toFixed(1) + '¢').join(' / ')})`);
        return false;
      }
    }

    // Check on-chain token balance first (prevents duplicate splits on restart)
    let onChainShares = 0;
    if (!this.config.dryRun && market.tokenIds[0]) {
      try {
        const balA = await this.polyClient.getTokenBalance(market.tokenIds[0]);
        const balB = await this.polyClient.getTokenBalance(market.tokenIds[1]);
        onChainShares = Math.min(balA, balB);
        if (onChainShares >= this.preSplitSize) {
          this.log(`💧 On-chain balance: ${balA}A/${balB}B for ${marketSlug} (need ${this.preSplitSize}), skipping split`);
          // Sync internal inventory to match on-chain
          this.recordInventory(marketSlug, market.conditionId, market.tokenIds[0], market.tokenIds[1], 0, market.negRisk);
          const inv = this.inventory.get(marketSlug);
          if (inv) { inv.sharesA = balA; inv.sharesB = balB; }
          return true;
        } else if (onChainShares > 0) {
          this.log(`💧 On-chain balance: ${balA}A/${balB}B for ${marketSlug} — syncing inventory`);
          this.recordInventory(marketSlug, market.conditionId, market.tokenIds[0], market.tokenIds[1], 0, market.negRisk);
          const inv = this.inventory.get(marketSlug);
          if (inv) { inv.sharesA = balA; inv.sharesB = balB; }
        }
      } catch (err: any) {
        this.log(`⚠️ On-chain balance check failed: ${err?.message} — falling back to internal inventory`);
      }
    }

    // Check internal inventory (dry-run or on-chain check failed)
    const existing = this.inventory.get(marketSlug);
    const existingBalanced = existing ? Math.min(existing.sharesA, existing.sharesB) : onChainShares;
    if (existingBalanced >= this.preSplitSize) {
      this.log(`💧 Already have ${existingBalanced} shares for ${marketSlug} (need ${this.preSplitSize}), skipping split`);
      return true;
    }

    // Respect max-per-game; split enough to reach preSplitSize
    const alreadySplit = existing?.totalSplitCost ?? 0;
    const existingShares = existingBalanced;
    const needed = this.preSplitSize - existingShares;
    const splitAmount = Math.min(needed, this.config.maxPerGame - alreadySplit);
    if (splitAmount <= 0) {
      this.log(`⚠️ Max per-game budget reached for ${marketSlug} ($${alreadySplit}/$${this.config.maxPerGame})`);
      return false;
    }

    const negRisk = market.negRisk;
    this.log(`💧 Pre-splitting $${splitAmount} for ${marketSlug} (conditionId: ${market.conditionId.slice(0, 10)}…, negRisk=${negRisk})`);

    // Verify USDC balance before splitting (live mode)
    if (!this.config.dryRun) {
      const hasBalance = await this.verifyUSDCBalance(splitAmount);
      if (!hasBalance) {
        this.log(`❌ Cannot split — insufficient USDC balance`);
        return false;
      }
    }

    if (this.config.dryRun) {
      this.log(`  [DRY-RUN] Would split $${splitAmount}`);
      this.recordInventory(marketSlug, market.conditionId, market.tokenIds[0], market.tokenIds[1], splitAmount, negRisk);
      return true;
    }

    try {
      const result = await this.splitClient.split(market.conditionId, splitAmount, negRisk);

      if (!result.success) {
        this.log(`❌ Split failed for ${marketSlug}: ${result.error}`);
        return false;
      }

      this.log(`✅ Split $${splitAmount} → ${splitAmount} shares each side (tx: ${result.transactionHash?.slice(0, 10)}…)`);
      this.recordInventory(marketSlug, market.conditionId, market.tokenIds[0], market.tokenIds[1], splitAmount, negRisk);
      return true;
    } catch (err: any) {
      this.log(`❌ Split error for ${marketSlug}: ${err?.message || err}`);
      return false;
    }
  }

  private recordInventory(
    marketSlug: string,
    conditionId: string,
    tokenA: string,
    tokenB: string,
    amount: number,
    negRisk: boolean,
  ): void {
    const existing = this.inventory.get(marketSlug);
    if (existing) {
      const beforeA = existing.sharesA;
      const beforeB = existing.sharesB;
      existing.sharesA += amount;
      existing.sharesB += amount;
      existing.totalSplitCost += amount;
      existing.splitCount++;
      this.log(`  📦 [INVENTORY] Split ${existing.splitCount}: ${beforeA}A → ${existing.sharesA}A, ${beforeB}B → ${existing.sharesB}B (+${amount} each) | Total: ${existing.sharesA}A / ${existing.sharesB}B`);
    } else {
      this.inventory.set(marketSlug, {
        marketSlug,
        conditionId,
        tokenA,
        tokenB,
        sharesA: amount,
        sharesB: amount,
        totalSplitCost: amount,
        splitCount: 1,
        negRisk,
      });
      this.log(`  📦 [INVENTORY] Initial split: created ${amount}A / ${amount}B for ${marketSlug}`);
    }
    this.stats.totalSplitCost += amount;
  }

  // ============================================================================
  // AUTO-REFILL — split more shares when inventory runs low
  // ============================================================================

  /**
   * Check if a market needs a refill split and trigger one if so.
   * Called after order fills and cycle closes.
   * 
   * Logic: when min(sharesA, sharesB) ≤ refillThreshold (cycleSize=35),
   * trigger a background split of refillAmount ($35) to top up.
   * Guard prevents concurrent refills for the same market.
   */
  private async checkAndRefill(marketSlug: string): Promise<void> {
    // Don't refill if already in progress for this market
    if (this.refillInProgress.has(marketSlug)) return;

    const inv = this.inventory.get(marketSlug);
    if (!inv) return;

    const balanced = Math.min(inv.sharesA, inv.sharesB);
    if (balanced > this.refillThreshold) return;

    // Don't refill decided games
    const market = this.marketMeta.get(marketSlug);
    if (market?.outcomePrices && market.outcomePrices.length >= 2) {
      const maxPrice = Math.max(...market.outcomePrices);
      const minPrice = Math.min(...market.outcomePrices);
      if (maxPrice > 0.95 || minPrice < 0.05) return;
    }

    // Don't refill if halted
    if (this.halted) return;

    this.refillInProgress.add(marketSlug);
    this.log(`🔄 Auto-refill triggered for ${marketSlug}: ${balanced} shares ≤ ${this.refillThreshold} threshold → splitting $${this.refillAmount}`);

    try {
      if (this.config.dryRun) {
        this.log(`  [DRY-RUN] Would auto-refill split $${this.refillAmount}`);
        this.recordInventory(marketSlug, inv.conditionId, inv.tokenA, inv.tokenB, this.refillAmount, inv.negRisk);
        this.emit("refill", { marketSlug, amount: this.refillAmount });
      } else {
        // Verify USDC balance
        const hasBalance = await this.verifyUSDCBalance(this.refillAmount);
        if (!hasBalance) {
          this.log(`⚠️ Auto-refill skipped — insufficient USDC balance`);
          return;
        }

        const result = await this.splitClient.split(inv.conditionId, this.refillAmount, inv.negRisk);
        if (result.success) {
          this.log(`✅ Auto-refill: split $${this.refillAmount} → +${this.refillAmount} shares each side (tx: ${result.transactionHash?.slice(0, 10)}…)`);
          this.recordInventory(marketSlug, inv.conditionId, inv.tokenA, inv.tokenB, this.refillAmount, inv.negRisk);
          this.emit("refill", { marketSlug, amount: this.refillAmount });
        } else {
          this.log(`❌ Auto-refill failed: ${result.error}`);
        }
      }
    } catch (err: any) {
      this.log(`❌ Auto-refill error: ${err?.message || err}`);
    } finally {
      this.refillInProgress.delete(marketSlug);
    }
  }

  // ============================================================================
  // SHOCK HANDLER (called after event-filtered classification)
  // ============================================================================

  /**
   * Handle a classified shock — place laddered sell orders.
   * Only call this AFTER event classification confirms single_event.
   */
  async handleShock(shock: ShockEvent & { shockTeam?: string | null }): Promise<void> {
    // Per-market mutex: ensure only one shock is processed at a time per market
    // This prevents race conditions where multiple shocks check cycle count
    // before any orders/positions are created
    const marketSlug = shock.marketSlug;
    
    // Wait for any existing lock on this market
    while (this.marketLocks.has(marketSlug)) {
      await this.marketLocks.get(marketSlug);
    }
    
    // Acquire lock
    let releaseLock: () => void;
    const lockPromise = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    this.marketLocks.set(marketSlug, lockPromise);
    
    try {
      // Process shock within lock
      await this._handleShockInternal(shock);
    } finally {
      // Release lock
      this.marketLocks.delete(marketSlug);
      releaseLock!();
    }
  }

  private async _handleShockInternal(shock: ShockEvent & { shockTeam?: string | null }): Promise<void> {
    const shockId = `${shock.tokenId}_${shock.timestamp}`;
    // Store shock team for per-cycle event exit
    if (shock.shockTeam !== undefined) {
      this.shockTeams.set(shockId, shock.shockTeam);
    }
    if (this.processedShocks.has(shockId)) return;
    this.processedShocks.add(shockId);
    this.stats.totalShocksProcessed++;

    // ── SAFETY CHECKS ──

    // Check if halted
    if (this.halted) {
      this.log(`🛑 HALTED (${this.haltReason}) — ignoring shock on ${shock.marketSlug}`);
      return;
    }

    // Circuit breaker: total session loss
    if (this.stats.totalPnL < -this.config.maxSessionLoss) {
      this.halted = true;
      this.haltReason = `session loss $${Math.abs(this.stats.totalPnL).toFixed(2)} exceeds max $${this.config.maxSessionLoss}`;
      this.log(`🛑 CIRCUIT BREAKER: ${this.haltReason} — HALTING`);
      return;
    }

    // Circuit breaker: consecutive losses
    if (this.consecutiveLosses >= this.config.maxConsecutiveLosses) {
      this.halted = true;
      this.haltReason = `${this.consecutiveLosses} consecutive losses`;
      this.log(`🛑 CIRCUIT BREAKER: ${this.haltReason} — HALTING`);
      return;
    }

    // Per-game cycle limit: max active cycles (orders + positions) per game
    const gameOpenPositions = this.getOpenPositions().filter(p => p.marketSlug === shock.marketSlug);
    const gameRestingOrders = this.getActiveOrders().filter(o => o.marketSlug === shock.marketSlug);
    const gameActiveCycles = new Set([
      ...gameOpenPositions.map(p => p.shockId || 'pos'),
      ...gameRestingOrders.map(o => o.shockId || 'order'),
    ]).size;
    
    // Debug logging for cycle count
    if (gameActiveCycles > 0) {
      const cycleDetails = Array.from(new Set([
        ...gameOpenPositions.map(p => p.shockId),
        ...gameRestingOrders.map(o => o.shockId),
      ])).filter(Boolean).map(sid => sid!.split('_')[1]?.slice(-4) || 'unknown').join(', ');
      this.log(`  🔍 ${shock.marketSlug}: ${gameActiveCycles} active cycles (@${cycleDetails})`);
    }
    
    if (gameActiveCycles >= this.config.maxCyclesPerGame) {
      this.log(`⚠️ Max cycles per game (${this.config.maxCyclesPerGame}) reached for ${shock.marketSlug} — skipping`);
      this.log(`  Currently active: ${gameOpenPositions.length} positions, ${gameRestingOrders.length} orders`);
      const uniqueShockIds = Array.from(new Set([
        ...gameOpenPositions.map(p => p.shockId),
        ...gameRestingOrders.map(o => o.shockId),
      ])).filter(Boolean);
      this.log(`  Shock IDs: ${uniqueShockIds.map(s => s?.slice(-8)).join(', ')}`);
      return;
    }

    // Complement token for later use
    const complementToken = this.getComplementToken(shock.tokenId);
    if (!complementToken) {
      this.log(`⚠️ No complement token for ${shock.tokenId}`);
      return;
    }
    const sellTokenId = shock.direction === "up" ? shock.tokenId : complementToken;

    const market = this.marketMeta.get(shock.marketSlug);
    if (!market?.conditionId) {
      this.log(`⚠️ No conditionId for ${shock.marketSlug}`);
      return;
    }

    const heldTokenId = shock.direction === "up" ? complementToken : shock.tokenId;

    // Sell token price (this is the base for our ladder — L1 = base + spacing)
    const sellTokenPrice =
      shock.direction === "up"
        ? shock.currentPrice
        : 1.0 - shock.currentPrice;

    // Filter: don't sell at high prices (>sellPriceMax). When the winning team scores
    // and price is >85¢, TP on the losing side won't hit — game is nearly decided.
    // Low-price sells are fine (sell losing team at 11¢, TP on winning side is safe).
    // In LATE GAME (last 3 min Q4/OT), tighten high-end to 70¢ to avoid imbalance risk.
    const isLateGame = this.gameEvents?.isLateGame?.(shock.marketSlug) ?? false;
    const effectiveSellPriceMax = isLateGame ? 0.70 : this.config.sellPriceMax;
    
    if (sellTokenPrice > effectiveSellPriceMax) {
      const reason = isLateGame ? "late game (Q4/OT <3min)" : "TP on losing side won't hit";
      this.log(`⏭️ SKIP: sell price ${(sellTokenPrice * 100).toFixed(1)}¢ > ${(effectiveSellPriceMax * 100).toFixed(0)}¢ max (${reason})`);
      return;
    }

    // Check inventory
    const inv = this.inventory.get(shock.marketSlug);
    if (!inv) {
      this.log(`⚠️ No inventory for ${shock.marketSlug} — need to pre-split first`);
      return;
    }

    this.log(`⚡ Processing shock on ${shock.marketSlug}: ${shock.direction.toUpperCase()} ` +
      `${(shock.magnitude * 100).toFixed(1)}¢ (z=${shock.zScore.toFixed(1)}σ)`);

    // Place laddered SELL orders
    await this.placeLadderOrders(
      shockId,
      shock,
      sellTokenId,
      heldTokenId,
      sellTokenPrice,
      market.conditionId,
      inv,
    );
  }

  // ============================================================================
  // LADDER ORDER PLACEMENT
  // ============================================================================

  private async placeLadderOrders(
    shockId: string,
    shock: ShockEvent,
    sellTokenId: string,
    heldTokenId: string,
    basePrice: number,
    conditionId: string,
    inv: MarketInventory,
  ): Promise<void> {
    this.log(`📝 Placing ${this.config.ladderLevels}-level SELL ladder on ${shock.marketSlug}`);
    this.log(`  Sell: ${sellTokenId.slice(0, 10)}… | Hold: ${heldTokenId.slice(0, 10)}… | Base: ${(basePrice * 100).toFixed(1)}¢`);

    let totalFilledShares = 0;
    let totalFilledProceeds = 0;

    for (let level = 1; level <= this.config.ladderLevels && level <= this.ladderSizes.length; level++) {
      const shares = this.ladderSizes[level - 1]; // 5, 10, 15 shares
      const offset = level * this.config.ladderSpacing;
      const limitPrice = Math.max(0.01, Math.min(0.99, basePrice + offset));

      // Check inventory
      const sellAvail = sellTokenId === inv.tokenA ? inv.sharesA : inv.sharesB;
      const heldAvail = heldTokenId === inv.tokenA ? inv.sharesA : inv.sharesB;

      if (sellAvail < shares) {
        this.log(`  ⚠️ Insufficient sell-side inventory for L${level} (need ${shares}, have ${sellAvail.toFixed(0)})`);
        continue;
      }

      // Deduct from inventory (entry ladder placement)
      if (sellTokenId === inv.tokenA) {
        const before = inv.sharesA;
        inv.sharesA -= shares;
        this.log(`  📦 [INVENTORY] Ladder L${level} placed: tokenA ${before} → ${inv.sharesA} (-${shares}) | Market: ${inv.marketSlug} | Total: ${inv.sharesA}A / ${inv.sharesB}B`);
      } else {
        const before = inv.sharesB;
        inv.sharesB -= shares;
        this.log(`  📦 [INVENTORY] Ladder L${level} placed: tokenB ${before} → ${inv.sharesB} (-${shares}) | Market: ${inv.marketSlug} | Total: ${inv.sharesA}A / ${inv.sharesB}B`);
      }

      const orderId = `live_${Date.now()}_L${level}_${Math.random().toString(36).slice(2, 6)}`;

      const order: LiveLadderOrder = {
        id: orderId,
        orderId: null,
        tokenId: sellTokenId,
        marketSlug: shock.marketSlug,
        conditionId,
        price: limitPrice,
        shares,
        level,
        status: "PENDING_PLACE",
        createdAt: Date.now(),
        filledAt: null,
        fillPrice: null,
        shockId,
      };

      this.orders.set(orderId, order);

      this.log(`  📝 SELL L${level}: ${shares} shares @ ${(limitPrice * 100).toFixed(1)}¢`);

      if (this.config.dryRun) {
        this.log(`    [DRY-RUN] Would place GTC sell order: ${shares} shares @ ${(limitPrice * 100).toFixed(1)}¢`);
        order.status = "RESTING";
        order.orderId = `dry_${orderId}`;
        this.stats.totalOrdersPlaced++;
        continue;
      }

      // Verify token balance before selling (live mode safety)
      const hasTokens = await this.verifyTokenBalance(sellTokenId, shares);
      if (!hasTokens) {
        this.log(`  ⚠️ Token balance verification failed for L${level} — skipping`);
        order.status = "FAILED";
        if (sellTokenId === inv.tokenA) { inv.sharesA += shares; } else { inv.sharesB += shares; }
        continue;
      }

      // Place real GTC sell order
      try {
        const result = await this.polyClient.sellSharesGTC(
          sellTokenId,
          shares,
          limitPrice,
          inv.negRisk,
        );

        if (result.success && result.orderID) {
          order.orderId = result.orderID;
          order.status = "RESTING";
          this.stats.totalOrdersPlaced++;

          // Check if immediately filled
          if (result.filledShares && result.filledShares > 0) {
            order.status = "FILLED";
            order.filledAt = Date.now();
            order.fillPrice = result.filledPrice ?? limitPrice;
            this.stats.totalOrdersFilled++;
            totalFilledShares += result.filledShares;
            totalFilledProceeds += result.filledShares * (result.filledPrice ?? limitPrice);

            this.log(`  ✅ L${level} IMMEDIATELY FILLED: ${result.filledShares} shares @ ${((result.filledPrice ?? limitPrice) * 100).toFixed(1)}¢`);

            // Create position for the filled portion
            await this.createPosition(
              shock,
              shockId,
              orderId,
              sellTokenId,
              heldTokenId,
              result.filledShares,
              result.filledPrice ?? limitPrice,
              shares, // split cost = shares (at $1 each)
              inv.negRisk,
            );
          } else {
            this.log(`  📋 L${level} resting on book (orderID: ${result.orderID.slice(0, 10)}…)`);
          }
        } else {
          order.status = "FAILED";
          this.log(`  ❌ L${level} failed: ${result.error}`);
          // Return shares to inventory
          if (sellTokenId === inv.tokenA) {
            inv.sharesA += shares;
          } else {
            inv.sharesB += shares;
          }
        }
      } catch (err: any) {
        order.status = "FAILED";
        this.log(`  ❌ L${level} error: ${err?.message || err}`);
        if (sellTokenId === inv.tokenA) {
          inv.sharesA += shares;
        } else {
          inv.sharesB += shares;
        }
      }
    }

    this.emit("ordersPlaced", {
      shockId,
      marketSlug: shock.marketSlug,
      sellTokenId,
      heldTokenId,
    });
  }

  // ============================================================================
  // POSITION CREATION
  // ============================================================================

  private async createPosition(
    shock: ShockEvent,
    shockId: string,
    orderId: string,
    soldTokenId: string,
    heldTokenId: string,
    shares: number,
    soldPrice: number,
    splitCost: number,
    negRisk: boolean,
  ): Promise<void> {
    // Take-profit: complement needs to sell at > (1.0 - soldPrice) for profit
    const fadeTarget = this.config.fadeTargetCents / 100;
    const breakEvenExitPrice = 1.0 - soldPrice;
    const takeProfitPrice = Math.min(0.99, breakEvenExitPrice + fadeTarget);

    const posId = `lpos_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

    const position: LivePosition = {
      id: posId,
      marketSlug: shock.marketSlug,
      conditionId: this.marketMeta.get(shock.marketSlug)?.conditionId ?? "",
      negRisk,
      soldTokenId,
      soldPrice,
      soldShares: shares,
      heldTokenId,
      heldShares: shares,
      splitCost,
      entryTime: Date.now(),
      exitTime: null,
      takeProfitPrice,
      exitPrice: null,
      pnl: null,
      shockId,
      status: "OPEN",
    };

    this.positions.set(posId, position);
    this.stats.totalPositionsOpened++;

    this.log(`📈 Position opened: ${posId} — ${shares} shares`);
    this.log(`  Sold @ ${(soldPrice * 100).toFixed(1)}¢ | TP: sell complement @ ${(takeProfitPrice * 100).toFixed(1)}¢`);

    // No timeout fallback — event-driven exit only (matches backtest winning config).
    // Safety net: 600s emergency timeout to avoid stuck positions (e.g. API outage).
    // Was 3600s but too long — if league API fails, 10+ scoring events pass in 1hr.
    const EMERGENCY_TIMEOUT_MS = 600_000; // 10 minutes
    const timeout = setTimeout(() => {
      if (position.status === "OPEN") {
        this.log(`🚨 Emergency timeout (${EMERGENCY_TIMEOUT_MS / 1000}s): ${posId} — check league API health`);
        this.closePosition(position, "TIMEOUT");
      }
    }, EMERGENCY_TIMEOUT_MS);
    this.positionTimeouts.set(posId, timeout);

    this.emit("positionOpened", position);
  }

  // ============================================================================
  // PRICE UPDATES — TAKE PROFIT MONITORING
  // ============================================================================

  private handlePriceUpdate(event: PriceUpdateEvent): void {
    const { tokenId, bid, ask } = event;
    const mid = (bid + ask) / 2;
    this.latestPrices.set(tokenId, { bid, ask, mid });

    // ── Extreme price exit: game is decided (>99¢ or <1¢) ──
    if (mid >= 0.99 || mid <= 0.01) {
      const marketSlug = this.tokenToMarket.get(tokenId);
      if (marketSlug) {
        this.handleExtremePrice(marketSlug, tokenId, mid);
      }
    }

    // ── Check cumulative TP fills ──
    // In LIVE mode: TP fills are detected via UserChannelWS (handleUserChannelFill).
    // Bid-based detection is ONLY used in dry-run mode (no real orders on book).
    if (this.config.dryRun) {
      for (const tp of Array.from(this.cumulativeTPs.values())) {
        if (tp.heldTokenId !== tokenId) continue;
        if (tp.status !== "WATCHING" && tp.status !== "PARTIAL") continue;
        if (tp.tpShares <= 0) continue;

        if (bid >= tp.tpPrice) {
          this.log(`💰 [DRY-RUN] Cumulative TP HIT for ${tp.marketSlug}: complement bid ${(bid * 100).toFixed(1)}¢ >= TP ${(tp.tpPrice * 100).toFixed(1)}¢`);
          this.completeCumulativeTP(tp);
        }
      }
    }

    // In dry-run mode, simulate entry order fills when bid reaches our price
    if (this.config.dryRun) {
      for (const order of Array.from(this.orders.values())) {
        if (order.tokenId !== tokenId || order.status !== "RESTING") continue;
        if (bid >= order.price) {
          this.log(`[DRY-RUN] Simulated fill: L${order.level} @ ${(order.price * 100).toFixed(1)}¢ [${order.marketSlug}]`);
          order.status = "FILLED";
          order.filledAt = Date.now();
          order.fillPrice = order.price;
          this.stats.totalOrdersFilled++;

          // Update cumulative TP for this market
          const complement = this.getComplementToken(order.tokenId);
          if (complement) {
            const inv = this.inventory.get(order.marketSlug);
            // Create position for P&L accounting (kept for trade records)
            this.createPosition(
              { tokenId: order.tokenId, marketSlug: order.marketSlug, direction: "up", magnitude: 0, zScore: 0, preShockPrice: 0, currentPrice: order.price, timestamp: Date.now(), type: "shock" },
              order.shockId,
              order.id,
              order.tokenId,
              complement,
              order.shares,
              order.price,
              order.shares,
              inv?.negRisk ?? false,
            ).catch(err => this.log(`⚠️ Dry-run position creation error: ${err}`));

            // Update/create cumulative TP
            this.updateCumulativeTP(
              order.marketSlug,
              order.shockId,
              order.tokenId,
              complement,
              order.shares,
              order.price,
              inv?.conditionId ?? "",
              inv?.negRisk ?? false,
            );

            // Check if inventory needs refill after fill
            this.checkAndRefill(order.marketSlug).catch(err =>
              this.log(`⚠️ Refill check error: ${err?.message || err}`));
          }
        }
      }
    }
    // In live mode, fill detection is via pollRestingOrderFills()
  }

  // ============================================================================
  // USER CHANNEL WS FILL HANDLING (real-time, sub-second)
  // ============================================================================

  /**
   * Handle a fill event from the UserChannelWS.
   * Finds the matching resting order, marks it as FILLED, creates position + updates TP.
   * Skips non-MATCHED/MINED/CONFIRMED statuses (RETRYING/FAILED are not real fills).
   */
  private async handleUserChannelFill(orderId: string, fillPrice: number, fillSize: number, status: string): Promise<void> {
    // Only process real fills (not RETRYING or FAILED)
    if (status === "FAILED") {
      this.log(`[WS] Ignoring FAILED trade for orderId=${orderId.slice(0, 10)}…`);
      return;
    }

    // Skip if already processed (e.g., immediate fill detected at placement time,
    // or WS sends MATCHED → MINED → CONFIRMED for same orderId)
    if (this.wsHandledOrderIds.has(orderId)) return;

    // Find matching order by Polymarket orderId
    // Accept RESTING or CANCELLED — a cancel-fill race means the CLOB filled before our cancel arrived
    let matchedOrder: LiveLadderOrder | null = null;
    for (const order of this.orders.values()) {
      if (order.orderId === orderId && (order.status === "RESTING" || order.status === "CANCELLED")) {
        matchedOrder = order;
        break;
      }
    }

    if (!matchedOrder) {
      // Check if this is a TP order fill (complement sell resting on book)
      for (const tp of this.cumulativeTPs.values()) {
        if (tp.tpOrderId === orderId && (tp.status === "WATCHING" || tp.status === "PARTIAL")) {
          this.wsHandledOrderIds.add(orderId);
          this.log(`💰 [WS] TP FILL: ${fillSize} shares @ ${(fillPrice * 100).toFixed(1)}¢ [${tp.marketSlug}] (status=${status})`);

          // NOTE: No inventory deduction here!
          // Held shares came from the same split pairs as entry shares.
          // Entry ladder placement already deducted from inventory.
          // Selling complement (exit) should NOT deduct again.
          this.log(`  📦 [INVENTORY] TP exit: NO deduction (held shares from position, not inventory pool)`);

          if (fillSize >= tp.tpShares) {
            // Full TP fill
            this.completeCumulativeTP(tp);
          } else {
            // Partial TP fill
            this.partialFillCumulativeTP(tp, fillSize, fillPrice);
          }
          return;
        }
      }

      // Order we don't track (other account activity) — ignore
      return;
    }

    // If order was already "CANCELLED", this is a cancel-fill race — CLOB filled before cancel
    if (matchedOrder.status === "CANCELLED") {
      this.log(`⚠️ [WS] CANCEL-FILL RACE: L${matchedOrder.level} was marked CANCELLED but CLOB filled it! Reversing cancel inventory return.`);
      // Undo the inventory return from cancelOrder() since shares were actually sold
      const inv = this.inventory.get(matchedOrder.marketSlug);
      if (inv) {
        if (matchedOrder.tokenId === inv.tokenA) {
          inv.sharesA = Math.max(0, inv.sharesA - matchedOrder.shares);
        } else {
          inv.sharesB = Math.max(0, inv.sharesB - matchedOrder.shares);
        }
      }
    }

    // Mark as handled so polling doesn't double-process
    this.wsHandledOrderIds.add(orderId);

    // Mark order as filled
    matchedOrder.status = "FILLED";
    matchedOrder.filledAt = Date.now();
    matchedOrder.fillPrice = fillPrice;
    this.stats.totalOrdersFilled++;

    this.log(`✅ [WS] FILLED: L${matchedOrder.level} @ ${(fillPrice * 100).toFixed(1)}¢ [${matchedOrder.marketSlug}] (${fillSize} shares, status=${status})`);

    // Create position for the filled order
    const complement = this.getComplementToken(matchedOrder.tokenId);
    if (complement) {
      const inv = this.inventory.get(matchedOrder.marketSlug);
      await this.createPosition(
        {
          tokenId: matchedOrder.tokenId,
          marketSlug: matchedOrder.marketSlug,
          direction: "up",
          magnitude: 0,
          zScore: 0,
          preShockPrice: 0,
          currentPrice: fillPrice,
          timestamp: Date.now(),
          type: "shock",
        },
        matchedOrder.shockId,
        matchedOrder.id,
        matchedOrder.tokenId,
        complement,
        matchedOrder.shares,
        fillPrice,
        matchedOrder.shares,
        inv?.negRisk ?? false,
      );

      // Update cumulative TP with actual fill price from WS
      await this.updateCumulativeTP(
        matchedOrder.marketSlug,
        matchedOrder.shockId,
        matchedOrder.tokenId,
        complement,
        matchedOrder.shares,
        fillPrice,
        inv?.conditionId ?? "",
        inv?.negRisk ?? false,
      );
    }

    this.emit("orderFilled", matchedOrder);

    // Check if inventory needs refill after fill
    this.checkAndRefill(matchedOrder.marketSlug).catch(err =>
      this.log(`⚠️ Refill check error: ${err?.message || err}`));
  }

  /**
   * Handle a server-side cancellation from UserChannelWS.
   * Prevents phantom fills: if CLOB cancels our order, we mark it CANCELLED
   * and return shares to inventory (instead of assuming it was filled).
   */
  private handleUserChannelCancellation(orderId: string): void {
    for (const order of this.orders.values()) {
      if (order.orderId === orderId && order.status === "RESTING") {
        this.log(`🚫 [WS] Server-side CANCELLATION: L${order.level} ${order.shares}sh @ ${(order.price * 100).toFixed(1)}¢ [${order.marketSlug}]`);

        order.status = "CANCELLED";
        this.stats.totalOrdersCancelled++;

        // Mark as handled so polling doesn't misinterpret as fill
        this.wsHandledOrderIds.add(orderId);

        // Return shares to inventory
        this.log(`  🔍 [DEBUG-WS] Looking for inventory: order.marketSlug="${order.marketSlug}"`);
        const inv = this.inventory.get(order.marketSlug);
        if (inv) {
          this.log(`  🔍 [DEBUG-WS] Found inventory: inv.marketSlug="${inv.marketSlug}" | tokenA=${inv.tokenA.slice(0,8)}… tokenB=${inv.tokenB.slice(0,8)}…`);
          this.log(`  🔍 [DEBUG-WS] Order tokenId=${order.tokenId.slice(0,8)}… | Returning ${order.shares} shares`);
          
          if (order.tokenId === inv.tokenA) {
            const before = inv.sharesA;
            inv.sharesA += order.shares;
            this.log(`  📦 [INVENTORY-WS] Cancelled: tokenA ${before} → ${inv.sharesA} (+${order.shares}) | Market: ${inv.marketSlug} | Total: ${inv.sharesA}A / ${inv.sharesB}B`);
          } else {
            const before = inv.sharesB;
            inv.sharesB += order.shares;
            this.log(`  📦 [INVENTORY-WS] Cancelled: tokenB ${before} → ${inv.sharesB} (+${order.shares}) | Market: ${inv.marketSlug} | Total: ${inv.sharesA}A / ${inv.sharesB}B`);
          }
        } else {
          this.log(`  ⚠️ [DEBUG-WS] No inventory found for marketSlug="${order.marketSlug}"!`);
        }

        this.emit("orderCancelled", order);
        return;
      }
    }
  }

  // ============================================================================
  // RESTING ORDER FILL POLLING (live mode only, every 5s — fallback safety net)
  // ============================================================================

  private async pollRestingOrderFills(): Promise<void> {
    const restingOrders = Array.from(this.orders.values()).filter(o => o.status === "RESTING" && o.orderId);
    if (restingOrders.length === 0) return;

    // Group by conditionId to minimize API calls
    const byCondition = new Map<string, LiveLadderOrder[]>();
    for (const order of restingOrders) {
      const existing = byCondition.get(order.conditionId) || [];
      existing.push(order);
      byCondition.set(order.conditionId, existing);
    }

    for (const [conditionId, orders] of byCondition.entries()) {
      try {
        const result = await this.polyClient.getOpenOrders(conditionId);
        if (!result.success || !result.orders) continue;

        const openOrderIds = new Set(result.orders.map((o: any) => o.id));

        for (const order of orders) {
          if (!order.orderId) continue;

          // Skip orders already handled by UserChannelWS (prevents double-processing)
          if (this.wsHandledOrderIds.has(order.orderId)) continue;

          // If order is no longer in open orders, it was either filled or cancelled
          if (!openOrderIds.has(order.orderId)) {
            // Check if WE cancelled this order (cancel may not have updated status yet due to async)
            // Also check wsHandledOrderIds again in case WS cancel arrived between filter and here
            if (this.wsHandledOrderIds.has(order.orderId!)) continue;

            // Log as potential fill but verify we didn't just cancel it
            this.log(`🔍 Order ${order.orderId!.slice(0, 10)}… missing from CLOB — assuming FILLED (L${order.level} @ ${(order.price * 100).toFixed(1)}¢)`);
            order.status = "FILLED";
            order.filledAt = Date.now();
            order.fillPrice = order.price; // Use limit price as fill price
            this.stats.totalOrdersFilled++;

            this.log(`✅ FILLED (poll): L${order.level} @ ${(order.price * 100).toFixed(1)}¢ [${order.marketSlug}]`);

            // Create position for the filled order (P&L accounting)
            const complement = this.getComplementToken(order.tokenId);
            if (complement) {
              const inv = this.inventory.get(order.marketSlug);
              await this.createPosition(
                { tokenId: order.tokenId, marketSlug: order.marketSlug, direction: "up", magnitude: 0, zScore: 0, preShockPrice: 0, currentPrice: order.price, timestamp: Date.now(), type: "shock" },
                order.shockId,
                order.id,
                order.tokenId,
                complement,
                order.shares,
                order.price,
                order.shares,
                inv?.negRisk ?? false,
              );

              // Update cumulative TP
              await this.updateCumulativeTP(
                order.marketSlug,
                order.shockId,
                order.tokenId,
                complement,
                order.shares,
                order.price,
                inv?.conditionId ?? "",
                inv?.negRisk ?? false,
              );
            }

            this.emit("orderFilled", order);

            // Check if inventory needs refill after fill
            this.checkAndRefill(order.marketSlug).catch(err =>
              this.log(`⚠️ Refill check error: ${err?.message || err}`));
          }
        }
      } catch (err: any) {
        this.log(`⚠️ Fill poll error for conditionId ${conditionId.slice(0, 10)}…: ${err?.message || err}`);
      }
    }
  }

  // ============================================================================
  // STALE POSITION CHECK (replaces in-memory setTimeout which doesn't survive restarts)
  // ============================================================================

  private async checkStalePositions(): Promise<void> {
    const EMERGENCY_TIMEOUT_MS = 600_000; // 10 minutes
    const now = Date.now();

    for (const pos of this.positions.values()) {
      if (pos.status !== "OPEN") continue;
      const age = now - pos.entryTime;
      if (age < EMERGENCY_TIMEOUT_MS) continue;

      // Skip if already has a timeout timer (set during this session)
      if (this.positionTimeouts.has(pos.id)) continue;

      // Check if game is decided — if so, force-close at $0 instead of trying to sell
      const heldPrice = this.latestPrices.get(pos.heldTokenId);
      const soldPrice = this.latestPrices.get(pos.soldTokenId);
      const isDecided = (heldPrice?.bid !== undefined && heldPrice.bid <= 0.01) ||
                        (soldPrice?.bid !== undefined && soldPrice.bid >= 0.99);

      if (isDecided) {
        // Determine if held token is winner or loser
        const heldIsWinner = heldPrice?.bid !== undefined && heldPrice.bid > 0.5;
        const exitPrice = heldIsWinner ? 1.0 : 0;
        this.log(`🚨 Stale position ${pos.id} (${(age / 1000).toFixed(0)}s) — game decided, held token ${heldIsWinner ? 'WINNER ($1)' : 'LOSER ($0)'}`);
        this.finalizePositionClose(pos, "CLOSED", exitPrice);
        const inv = this.inventory.get(pos.marketSlug);
        if (inv) {
          if (pos.heldTokenId === inv.tokenA) {
            inv.sharesA = Math.max(0, inv.sharesA - pos.heldShares);
          } else {
            inv.sharesB = Math.max(0, inv.sharesB - pos.heldShares);
          }
        }
        continue;
      }

      this.log(`🚨 Stale position detected: ${pos.id} (${(age / 1000).toFixed(0)}s old) — emergency closing`);
      try {
        await this.closePosition(pos, "TIMEOUT");
      } catch (err: any) {
        this.log(`⚠️ Stale position close error: ${err?.message || err}`);
      }
    }
  }

  // ============================================================================
  // BALANCE VERIFICATION (live mode only)
  // ============================================================================

  async verifyUSDCBalance(amount: number): Promise<boolean> {
    if (this.config.dryRun) return true;
    try {
      const balance = await this.polyClient.getBalance();
      if (balance < amount) {
        this.log(`❌ Insufficient USDC balance: have $${balance.toFixed(2)}, need $${amount.toFixed(2)}`);
        return false;
      }
      return true;
    } catch (err: any) {
      this.log(`⚠️ Balance check failed: ${err?.message || err}`);
      return false; // Fail safe
    }
  }

  async verifyTokenBalance(tokenId: string, requiredShares: number): Promise<boolean> {
    if (this.config.dryRun) return true;
    try {
      const balance = await this.polyClient.getTokenBalance(tokenId);
      if (balance < requiredShares) {
        this.log(`❌ Insufficient token balance: have ${balance}, need ${requiredShares}`);
        return false;
      }
      return true;
    } catch (err: any) {
      this.log(`⚠️ Token balance check failed: ${err?.message || err}`);
      return false; // Fail safe
    }
  }

  // ============================================================================
  // EXTREME PRICE EXIT — game is decided, exit and free capital
  // ============================================================================

  private extremePriceTriggered = new Set<string>(); // prevent duplicate triggers

  /**
   * When any token hits >99¢ or <1¢, the game is effectively decided.
   * Close all positions, cancel all orders, merge remaining shares back to USDC.
   */
  private async handleExtremePrice(marketSlug: string, tokenId: string, price: number): Promise<void> {
    if (this.extremePriceTriggered.has(marketSlug)) return;
    this.extremePriceTriggered.add(marketSlug);

    this.log(`🏁 EXTREME PRICE on ${marketSlug}: ${(price * 100).toFixed(1)}¢ — game decided, exiting + merging`);

    // 1. Cancel all resting orders for this market
    const marketOrders = this.getActiveOrders().filter(o => o.marketSlug === marketSlug);
    for (const order of marketOrders) {
      await this.cancelOrder(order);
    }
    if (marketOrders.length > 0) {
      this.log(`  🚫 Cancelled ${marketOrders.length} resting orders`);
    }

    // 2. Force-close all open positions for this market.
    //    Game is decided — determine if held token is WINNER ($1) or LOSER ($0).
    //    Winner shares are redeemable at $1 after market resolves.
    const marketPositions = this.getOpenPositions().filter(p => p.marketSlug === marketSlug);
    for (const pos of marketPositions) {
      // Determine if the held token is the winner or loser.
      // The triggering token's price tells us: if it's <1¢, that token LOST.
      // Our held token is the winner if it's NOT the losing token.
      const heldIsWinner = pos.heldTokenId !== tokenId
        ? price < 0.01  // triggering token dropped to ~0 → held token is the winner
        : price > 0.99; // triggering token spiked to ~1 → held token is the winner (it IS the spiking token)
      const exitPrice = heldIsWinner ? 1.0 : 0;

      this.log(`  🏁 Force-closing ${pos.id}: held token ${heldIsWinner ? 'WINNER' : 'LOSER'} @ ${(exitPrice * 100).toFixed(1)}¢ (${heldIsWinner ? 'redeemable at $1' : 'skipping sell'} — game decided)`);
      this.finalizePositionClose(pos, "CLOSED", exitPrice);

      // NOTE: No inventory deduction! Held shares came from split pairs.
      // Already deducted on entry. Game-decided positions are redeemable,
      // not sold on-chain, so no further inventory impact.
      this.log(`  📦 [INVENTORY] Game-decided exit: NO deduction (held shares from position, redeemable on-chain)`);
    }
    if (marketPositions.length > 0) {
      this.log(`  📤 Force-closed ${marketPositions.length} positions (game decided, no sell needed)`);
    }

    // 3. Cancel ALL cumulative TPs for this market (all cycles)
    const tps = this.getCumulativeTPsForMarket(marketSlug);
    for (const tp of tps) {
      if (tp.status === "WATCHING" || tp.status === "PARTIAL") {
        if (tp.tpOrderId && !this.config.dryRun) {
          try {
            await this.polyClient.cancelSingleOrder(tp.tpOrderId);
          } catch (err: any) {
            this.log(`  ⚠️ TP cancel error: ${err?.message || err}`);
          }
        }
        tp.status = "CLOSED";
        this.emit("tpUpdate", tp);  // Notify dashboard before deleting
        this.log(`  🚫 Cancelled cumulative TP for cycle ${tp.shockId.slice(0, 16)}…`);
      }
      // Remove TP from map
      this.cumulativeTPs.delete(tp.shockId);
    }

    // 4. Merge remaining balanced shares back to USDC
    await this.mergeRemainingShares(marketSlug);

    // 5. Handle unbalanced leftover shares (from sold ladder orders)
    // After merge, one side may have excess shares. For a decided game,
    // the winning side is worth ~$1 (redeemable) and the losing side ~$0.
    // We can't merge unbalanced shares, so just clear inventory and let
    // Polymarket auto-redeem when the market resolves (or user claims via UI).
    const invAfterMerge = this.inventory.get(marketSlug);
    if (invAfterMerge) {
      const excessA = invAfterMerge.sharesA;
      const excessB = invAfterMerge.sharesB;
      if (excessA > 0 || excessB > 0) {
        this.log(`  💎 Unbalanced shares remaining: ${excessA}A / ${excessB}B — redeemable after market resolves`);
      }
      // Free the game slot regardless — capital is effectively recovered via redemption
      this.inventory.delete(marketSlug);
      this.log(`🎰 Game slot freed: ${marketSlug} (${this.inventory.size}/${this.config.maxConcurrentGames} games active)`);
    }
  }

  // ============================================================================
  // EVENT-DRIVEN EXIT — sell complement on next scoring event
  // ============================================================================

  /**
   * Called when a new scoring event is detected for a market.
   * Closes all open positions by selling the complement at market.
   * Cancels resting ladder orders.
   */
  async handleGameEvent(marketSlug: string, eventTeam?: string | null): Promise<void> {
    let closedCount = 0;
    let cancelledCount = 0;

    // Per-cycle event exit logic
    const tps = this.getCumulativeTPsForMarket(marketSlug);

    for (const tp of tps) {
      if (tp.status !== "WATCHING" && tp.status !== "PARTIAL") continue;

      if (eventTeam && tp.shockTeam) {
        if (eventTeam === tp.shockTeam) {
          // ADVERSE — shock team scored again → exit this cycle
          this.log(`🏟️ ADVERSE for cycle ${tp.shockId.slice(0, 16)}…: ${eventTeam} scored (shock team: ${tp.shockTeam}) → EXIT`);
          await this.eventExitCumulativeTP(tp, "EVENT_EXIT");

          // Batch-close positions for THIS cycle (one GTC sell for all shares)
          const cyclePosns: LivePosition[] = [];
          for (const pos of this.positions.values()) {
            if (pos.shockId !== tp.shockId || pos.status !== "OPEN") continue;
            cyclePosns.push(pos);
          }
          if (cyclePosns.length > 0) {
            await this.batchClosePositions(cyclePosns, "EVENT_EXIT");
            closedCount += cyclePosns.length;
          }
          // Cancel resting orders for THIS cycle only
          for (const order of this.orders.values()) {
            if (order.shockId !== tp.shockId || order.status !== "RESTING") continue;
            await this.cancelOrder(order);
            cancelledCount++;
          }
        } else {
          // FAVORABLE — opposite team scored → hold this cycle
          this.log(`✅ FAVORABLE for cycle ${tp.shockId.slice(0, 16)}…: ${eventTeam} scored (shock team: ${tp.shockTeam}) → HOLDING`);
        }
      } else {
        // Unknown team — exit conservatively (all cycles with unknown info)
        this.log(`🏟️ Unknown team event for cycle ${tp.shockId.slice(0, 16)}… → conservative EXIT`);
        await this.eventExitCumulativeTP(tp, "EVENT_EXIT");

        const cyclePosns: LivePosition[] = [];
        for (const pos of this.positions.values()) {
          if (pos.shockId !== tp.shockId || pos.status !== "OPEN") continue;
          cyclePosns.push(pos);
        }
        if (cyclePosns.length > 0) {
          await this.batchClosePositions(cyclePosns, "EVENT_EXIT");
          closedCount += cyclePosns.length;
        }
        for (const order of this.orders.values()) {
          if (order.shockId !== tp.shockId || order.status !== "RESTING") continue;
          await this.cancelOrder(order);
          cancelledCount++;
        }
      }
    }

    // Fallback: handle orphaned positions/orders with no matching TP
    // (edge case: positions exist but TP was already removed)
    if (tps.length === 0) {
      const orphanPosns: LivePosition[] = [];
      for (const pos of this.positions.values()) {
        if (pos.marketSlug !== marketSlug || pos.status !== "OPEN") continue;
        orphanPosns.push(pos);
      }
      if (orphanPosns.length > 0) {
        await this.batchClosePositions(orphanPosns, "EVENT_EXIT");
        closedCount += orphanPosns.length;
      }
      for (const order of this.orders.values()) {
        if (order.marketSlug !== marketSlug || order.status !== "RESTING") continue;
        await this.cancelOrder(order);
        cancelledCount++;
      }
    }

    if (closedCount > 0 || cancelledCount > 0) {
      this.log(`🏟️ Event exit: ${marketSlug} — closed ${closedCount} positions, cancelled ${cancelledCount} orders`);
    }
  }

  // ============================================================================
  // SCORING RUN PROTECTION
  // ============================================================================

  /**
   * Called when 2+ same-team events detected while holding.
   * Emergency: market-sell complement and cancel all resting orders.
   */
  async handleScoringRun(marketSlug: string): Promise<void> {
    let closedCount = 0;
    let cancelledCount = 0;

    // Close ALL cumulative TPs for this market (all cycles)
    const tps = this.getCumulativeTPsForMarket(marketSlug);
    for (const tp of tps) {
      if (tp.status !== "WATCHING" && tp.status !== "PARTIAL") continue;
      await this.eventExitCumulativeTP(tp, "SCORING_RUN_BAIL");
    }

    // Batch-close ALL open positions for market (all cycles, one order)
    const bailPosns: LivePosition[] = [];
    for (const pos of this.positions.values()) {
      if (pos.marketSlug !== marketSlug || pos.status !== "OPEN") continue;
      bailPosns.push(pos);
    }
    if (bailPosns.length > 0) {
      this.log(`🚨 Scoring run bail: ${bailPosns.length} positions (${bailPosns.reduce((s, p) => s + p.heldShares, 0)} shares) — batch selling complement`);
      await this.batchClosePositions(bailPosns, "SCORING_RUN_BAIL");
      closedCount = bailPosns.length;
    }

    // Cancel ALL resting orders for market (all cycles)
    for (const order of this.orders.values()) {
      if (order.marketSlug !== marketSlug || order.status !== "RESTING") continue;
      await this.cancelOrder(order);
      cancelledCount++;
    }

    if (closedCount > 0 || cancelledCount > 0) {
      this.log(`🚨 Scoring run protection: ${marketSlug} — bailed ${closedCount} positions, cancelled ${cancelledCount} orders`);
    }
  }

  // ============================================================================
  // BATCH CLOSE — sell all complement shares in ONE order (event exits)
  // ============================================================================

  /**
   * Batch-close multiple positions with a single GTC sell order.
   * Used for event exits and scoring run bails where multiple positions
   * need to sell the same held token. One order = less latency + better fill.
   */
  private async batchClosePositions(
    positions: LivePosition[],
    reason: LivePosition["status"],
  ): Promise<void> {
    if (positions.length === 0) return;

    // All positions should hold the same token — verify
    const heldTokenId = positions[0].heldTokenId;
    const marketSlug = positions[0].marketSlug;
    const negRisk = positions[0].negRisk;
    const totalShares = positions.reduce((sum, p) => sum + p.heldShares, 0);

    if (totalShares <= 0) {
      // Nothing to sell — just close the positions with estimated price
      for (const pos of positions) {
        const exitPrice = 1.0 - pos.soldPrice;
        this.finalizePositionClose(pos, reason, exitPrice);
      }
      return;
    }

    this.log(`📦 Batch exit: ${totalShares} total shares across ${positions.length} positions (${marketSlug})`);

    // Get exit price estimate
    let exitPrice: number;
    const prices = this.latestPrices.get(heldTokenId);
    if (prices?.bid) {
      exitPrice = prices.bid;
    } else {
      const soldPrices = this.latestPrices.get(positions[0].soldTokenId);
      exitPrice = soldPrices?.ask ? (1.0 - soldPrices.ask) : (1.0 - positions[0].soldPrice);
      this.log(`  ⚠️ No live price for held token, using derived: ${(exitPrice * 100).toFixed(1)}¢`);
    }

    // Execute single GTC sell for ALL shares
    let sellFailed = false;

    if (!this.config.dryRun) {
      const GTC_FILL_TIMEOUT_MS = 4000;
      const GTC_MAX_ATTEMPTS = 3;

      for (let attempt = 0; attempt < GTC_MAX_ATTEMPTS; attempt++) {
        if (attempt > 0) {
          try {
            const bal = await this.polyClient.getTokenBalance(heldTokenId);
            if (bal < totalShares * 0.5) {
              this.log(`  ✅ On-chain balance ${bal} << ${totalShares} — previous sell likely worked!`);
              sellFailed = false;
              break;
            }
          } catch (err: any) {
            this.log(`  ⚠️ Balance check failed: ${err?.message}`);
          }
        }

        let bidPrice = this.ws.getBestBid(heldTokenId);
        if (!bidPrice || bidPrice <= 0) {
          bidPrice = prices?.bid ?? exitPrice;
          this.log(`  ⚠️ No WS orderbook bid, using fallback: ${(bidPrice * 100).toFixed(1)}¢`);
        }

        const tick = (bidPrice > 0.04 && bidPrice < 0.96) ? 0.01 : 0.001;
        const priceReduction = attempt * 0.02;
        const sellPrice = Math.max(0.01, Math.round((bidPrice + tick - priceReduction) * 100) / 100);

        try {
          this.log(`  📤 ${attempt > 0 ? `RETRY #${attempt}: ` : ''}GTC SELL ${totalShares} shares @ ${(sellPrice * 100).toFixed(1)}¢ (bid: ${(bidPrice * 100).toFixed(1)}¢, +${(tick*100).toFixed(1)}¢ tick${attempt > 0 ? `, -${(priceReduction * 100).toFixed(0)}¢` : ''})`);

          const result = await this.polyClient.sellSharesGTC(heldTokenId, totalShares, sellPrice, negRisk);

          if (!result.success || !result.orderID) {
            this.log(`  ⚠️ GTC place failed: ${result.error || 'no orderID'}`);
            sellFailed = true;
            continue;
          }

          if (result.filledShares && result.filledShares >= totalShares * 0.95) {
            exitPrice = result.filledPrice ?? sellPrice;
            this.log(`  ✅ GTC immediate fill: ${result.filledShares} shares @ ${(exitPrice * 100).toFixed(1)}¢`);
            sellFailed = false;
            break;
          }

          this.log(`  ⏳ GTC resting (orderID: ${result.orderID.slice(0, 10)}…) — waiting up to ${GTC_FILL_TIMEOUT_MS / 1000}s for fill...`);

          const fillResult = await this.waitForGTCFill(result.orderID, heldTokenId, totalShares, GTC_FILL_TIMEOUT_MS);

          if (fillResult.filled) {
            exitPrice = fillResult.price ?? sellPrice;
            this.log(`  ✅ GTC filled: ${fillResult.shares ?? totalShares} shares @ ${(exitPrice * 100).toFixed(1)}¢`);
            sellFailed = false;
            break;
          }

          this.log(`  ⏰ GTC not filled in ${GTC_FILL_TIMEOUT_MS / 1000}s — cancelling...`);
          await this.polyClient.cancelSingleOrder(result.orderID);
          sellFailed = true;
        } catch (err: any) {
          this.log(`  ⚠️ GTC attempt ${attempt + 1}/${GTC_MAX_ATTEMPTS} error: ${err?.message || err}`);
          sellFailed = true;
        }
      }

      // FAK fallback
      if (sellFailed) {
        this.log(`  🔄 GTC attempts exhausted — falling back to FAK at 1¢ floor`);
        try {
          const bal = await this.polyClient.getTokenBalance(heldTokenId);
          if (bal >= totalShares * 0.5) {
            const result = await this.polyClient.sellShares(heldTokenId, totalShares, 0.01, negRisk);
            if (result.success && result.filledShares && result.filledShares > 0) {
              exitPrice = result.filledPrice ?? 0.01;
              this.log(`  ✅ FAK fallback sold: ${result.filledShares} shares @ ${(exitPrice * 100).toFixed(1)}¢`);
              sellFailed = false;
            } else {
              this.log(`  ❌ FAK fallback also failed: ${result.error || 'no fills'}`);
            }
          } else {
            this.log(`  ✅ On-chain balance ${bal} < expected ${totalShares} — previous GTC likely filled`);
            sellFailed = false;
          }
        } catch (err: any) {
          this.log(`  ❌ FAK fallback error: ${err?.message || err}`);
        }
      }

      if (sellFailed) {
        this.log(`  ❌ All sell attempts FAILED — ${positions.length} positions remain OPEN`);
        for (const pos of positions) {
          this.log(`  ⚠️ Position ${pos.id} remains OPEN — complement sell failed`);
        }
        return;
      }
    } else {
      this.log(`  [DRY-RUN] Would sell ${totalShares} complement shares in one order`);
    }

    // NOTE: No inventory deduction on batch exit!
    // Held shares came from the same split pairs as entry shares.
    // Entry ladder placement already deducted from inventory.
    // Selling complement (exit) should NOT deduct again — that would double-count.
    this.log(`  📦 [INVENTORY] Batch exit complete: NO deduction (held shares from positions, not inventory pool)`);

    for (const pos of positions) {
      this.finalizePositionClose(pos, reason, exitPrice);
    }
  }

  /**
   * Finalize a position close: record P&L, update stats, emit events.
   * Called after shares are sold (or dry-run).
   */
  private finalizePositionClose(pos: LivePosition, reason: LivePosition["status"], exitPrice: number): void {
    const totalProceedsPerShare = pos.soldPrice + exitPrice;
    const pnlPerShare = totalProceedsPerShare - 1.0;
    const pnl = pnlPerShare * pos.soldShares;
    const totalProceeds = totalProceedsPerShare * pos.soldShares;

    pos.status = reason;
    pos.exitPrice = exitPrice;
    pos.exitTime = Date.now();
    pos.pnl = pnl;

    this.stats.totalPositionsClosed++;
    this.stats.totalPnL += pnl;
    this.stats.totalProceeds += totalProceeds;

    if (pnl > 0) {
      this.stats.winCount++;
      this.consecutiveLosses = 0;
    } else {
      this.stats.lossCount++;
      this.consecutiveLosses++;
      if (this.consecutiveLosses >= this.config.maxConsecutiveLosses) {
        this.log(`🛑 CIRCUIT BREAKER: ${this.consecutiveLosses} consecutive losses — will halt on next shock`);
      }
    }

    const totalTrades = this.stats.winCount + this.stats.lossCount;
    this.stats.winRate = totalTrades > 0 ? this.stats.winCount / totalTrades : 0;
    this.pnlHistory.push(pnl);

    if (this.stats.totalPnL < -this.config.maxSessionLoss) {
      this.halted = true;
      this.haltReason = `session loss $${Math.abs(this.stats.totalPnL).toFixed(2)} exceeds max $${this.config.maxSessionLoss}`;
      this.log(`🛑 CIRCUIT BREAKER TRIGGERED: ${this.haltReason}`);
    }

    const timer = this.positionTimeouts.get(pos.id);
    if (timer) {
      clearTimeout(timer);
      this.positionTimeouts.delete(pos.id);
    }

    const holdTimeMs = (pos.exitTime || Date.now()) - pos.entryTime;
    // Create trade record
    const record: LiveTradeRecord = {
      id: `ltrade_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
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
      exitReason: reason,
      holdTimeMs,
    };
    this.tradeHistory.push(record);
    if (this.tradeHistory.length > 1000) {
      this.tradeHistory = this.tradeHistory.slice(-500);
    }

    this.log(`${pnl >= 0 ? '💰' : '💸'} Position closed (${reason}): ${pos.id}`);
    this.log(`  Sold: ${(pos.soldPrice * 100).toFixed(1)}¢ | Exit: ${(exitPrice * 100).toFixed(1)}¢ | Combined: ${(totalProceedsPerShare * 100).toFixed(1)}¢/share`);
    this.log(`  P&L: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)} (${pos.soldShares} shares, ${Math.round(holdTimeMs / 1000)}s hold)`);

    this.emit("positionClosed", { position: pos, record });
    this.saveState();
  }

  // ============================================================================
  // CLOSE POSITION — sell the held (complement) token (single position)
  // ============================================================================

  private async closePosition(
    pos: LivePosition,
    reason: LivePosition["status"],
  ): Promise<void> {
    // Determine exit price — MUST use the held token's current market price
    let exitPrice: number;
    let sellFailed = false;

    if (reason === "TAKE_PROFIT") {
      exitPrice = pos.takeProfitPrice;
    } else {
      // Market sell — use current bid of the HELD token (complement)
      const prices = this.latestPrices.get(pos.heldTokenId);
      if (prices?.bid) {
        exitPrice = prices.bid;
      } else {
        // Fallback: use sold token's current ask to derive complement price
        const soldPrices = this.latestPrices.get(pos.soldTokenId);
        exitPrice = soldPrices?.ask ? (1.0 - soldPrices.ask) : (1.0 - pos.soldPrice);
        this.log(`  ⚠️ No live price for held token, using derived: ${(exitPrice * 100).toFixed(1)}¢`);
      }
    }

    // Execute the sell — GTC-at-bid strategy to avoid 3s sports market delay
    // Polymarket delays "marketable" orders (FAK/FOK that cross the spread) by 3s on sports.
    // Instead, place a GTC SELL at the best bid price — it rests on the book as a maker
    // order and gets filled by incoming market buys with NO delay.
    if (!this.config.dryRun && pos.heldShares > 0) {
      const GTC_FILL_TIMEOUT_MS = 4000;  // Wait up to 4s for GTC fill
      const GTC_MAX_ATTEMPTS = 3;        // Re-place up to 3 times with lower prices
      const GTC_FALLBACK_TO_FAK = true;  // Final fallback: FAK at floor price

      for (let attempt = 0; attempt < GTC_MAX_ATTEMPTS; attempt++) {
        // Safety: verify we still hold shares before each attempt
        if (attempt > 0 && !this.config.dryRun) {
          try {
            const bal = await this.polyClient.getTokenBalance(pos.heldTokenId);
            if (bal < pos.heldShares) {
              this.log(`  ✅ On-chain balance check: only ${bal} shares remain (need ${pos.heldShares}) — previous sell likely worked!`);
              sellFailed = false;
              break;
            }
          } catch (err: any) {
            this.log(`  ⚠️ Balance check failed: ${err?.message} — continuing with retry`);
          }
        }

        // Get fresh best bid from order book WS
        let bidPrice = this.ws.getBestBid(pos.heldTokenId);
        if (!bidPrice || bidPrice <= 0) {
          // Fallback: use latestPrices
          const prices = this.latestPrices.get(pos.heldTokenId);
          bidPrice = prices?.bid ?? exitPrice;
          this.log(`  ⚠️ No WS orderbook bid, using fallback: ${(bidPrice * 100).toFixed(1)}¢`);
        }

        // Place at bid + 1 tick to REST on the book (avoids 3s sports delay).
        // Selling AT bid = marketable = delayed. Selling ABOVE bid = maker = instant.
        // On retries, we drop toward the bid (still +1 tick above the NEW bid).
        // Tick size is 0.01 for prices in [0.04, 0.96], 0.001 outside that.
        const tick = (bidPrice > 0.04 && bidPrice < 0.96) ? 0.01 : 0.001;
        const priceReduction = attempt * 0.02; // Drop 2¢ each retry (re-reads bid anyway)
        const sellPrice = Math.max(0.01, Math.round((bidPrice + tick - priceReduction) * 100) / 100);

        try {
          this.log(`  📤 ${attempt > 0 ? `RETRY #${attempt}: ` : ''}GTC SELL ${pos.heldShares} shares @ ${(sellPrice * 100).toFixed(1)}¢ (bid: ${(bidPrice * 100).toFixed(1)}¢, +${(tick*100).toFixed(1)}¢ tick${attempt > 0 ? `, -${(priceReduction * 100).toFixed(0)}¢` : ''})`);

          const result = await this.polyClient.sellSharesGTC(
            pos.heldTokenId,
            pos.heldShares,
            sellPrice,
            pos.negRisk,
          );

          if (!result.success || !result.orderID) {
            this.log(`  ⚠️ GTC place failed: ${result.error || 'no orderID'}`);
            sellFailed = true;
            continue;
          }

          // Check if immediately filled on placement
          if (result.filledShares && result.filledShares >= pos.heldShares * 0.95) {
            exitPrice = result.filledPrice ?? sellPrice;
            this.log(`  ✅ GTC immediate fill: ${result.filledShares} shares @ ${(exitPrice * 100).toFixed(1)}¢`);
            sellFailed = false;
            break;
          }

          // Order is resting — wait for fill via UserChannelWS or timeout
          this.log(`  ⏳ GTC resting (orderID: ${result.orderID.slice(0, 10)}…) — waiting up to ${GTC_FILL_TIMEOUT_MS / 1000}s for fill...`);

          const fillResult = await this.waitForGTCFill(
            result.orderID,
            pos.heldTokenId,
            pos.heldShares,
            GTC_FILL_TIMEOUT_MS,
          );

          if (fillResult.filled) {
            exitPrice = fillResult.price ?? sellPrice;
            this.log(`  ✅ GTC filled: ${fillResult.shares ?? pos.heldShares} shares @ ${(exitPrice * 100).toFixed(1)}¢`);
            sellFailed = false;
            break;
          }

          // Not filled — cancel and retry at lower price
          this.log(`  ⏰ GTC not filled in ${GTC_FILL_TIMEOUT_MS / 1000}s — cancelling...`);
          await this.polyClient.cancelSingleOrder(result.orderID);
          sellFailed = true;

        } catch (err: any) {
          this.log(`  ⚠️ GTC attempt ${attempt + 1}/${GTC_MAX_ATTEMPTS} error: ${err?.message || err}`);
          sellFailed = true;
        }
      }

      // Final fallback: FAK at floor price (accepts the 3s delay but guarantees execution)
      if (sellFailed && GTC_FALLBACK_TO_FAK) {
        this.log(`  🔄 GTC attempts exhausted — falling back to FAK at 1¢ floor`);
        try {
          // Verify shares still on-chain
          const bal = await this.polyClient.getTokenBalance(pos.heldTokenId);
          if (bal >= pos.heldShares * 0.5) {
            const result = await this.polyClient.sellShares(
              pos.heldTokenId,
              pos.heldShares,
              0.01, // Accept ANY price
              pos.negRisk,
            );
            if (result.success && result.filledShares && result.filledShares > 0) {
              exitPrice = result.filledPrice ?? 0.01;
              this.log(`  ✅ FAK fallback sold: ${result.filledShares} shares @ ${(exitPrice * 100).toFixed(1)}¢`);
              sellFailed = false;
            } else {
              this.log(`  ❌ FAK fallback also failed: ${result.error || 'no fills'}`);
            }
          } else {
            this.log(`  ✅ On-chain balance ${bal} < expected ${pos.heldShares} — previous GTC likely filled`);
            sellFailed = false;
          }
        } catch (err: any) {
          this.log(`  ❌ FAK fallback error: ${err?.message || err}`);
        }
      }

      if (sellFailed) {
        this.log(`  ❌ All sell attempts FAILED (GTC + FAK) — position NOT closed`);
      }
    } else if (this.config.dryRun) {
      this.log(`  [DRY-RUN] Would market-sell ${pos.heldShares} complement shares`);
    }

    // If sell failed, keep position OPEN for retry (don't record fake P&L)
    if (sellFailed) {
      this.log(`  ⚠️ Position ${pos.id} remains OPEN — complement sell failed, shares still held on-chain`);
      return;
    }

    // NOTE: No inventory deduction on exit!
    // Held shares came from the same split pairs as entry shares.
    // Entry ladder placement already deducted from inventory.
    this.log(`  📦 [INVENTORY] Position exit complete: NO deduction (held shares from position, not inventory pool)`);

    // Finalize with shared P&L logic (logs, stats, trade record, emit)
    this.finalizePositionClose(pos, reason, exitPrice);
  }

  // ============================================================================
  // CANCEL ORDER
  // ============================================================================

  private async cancelOrder(order: LiveLadderOrder): Promise<void> {
    if (order.status !== "RESTING" || !order.orderId) return;
    
    // Check if WS already handled this cancellation to prevent double inventory return
    if (this.wsHandledOrderIds.has(order.orderId)) {
      this.log(`  ⏭️ [DEBUG] Skipping cancelOrder() - already handled by WS for orderId=${order.orderId.slice(0,10)}…`);
      return;
    }

    if (!this.config.dryRun) {
      try {
        const result = await this.polyClient.cancelSingleOrder(order.orderId);
        if (!result.success) {
          this.log(`  ⚠️ Cancel failed for ${order.orderId}: ${result.error}`);
        }
      } catch (err: any) {
        this.log(`  ⚠️ Cancel error: ${err?.message || err}`);
      }
    } else {
      this.log(`  [DRY-RUN] Would cancel order ${order.orderId}`);
    }

    order.status = "CANCELLED";
    this.stats.totalOrdersCancelled++;

    // Return SELL-SIDE shares to inventory.
    // NOTE: If cancel-fill race occurs (CLOB filled before our cancel),
    // the WS fill handler will detect it and reverse this inventory return.
    
    // DEBUG: Log what we're looking for and what we found
    this.log(`  🔍 [DEBUG] Looking for inventory: order.marketSlug="${order.marketSlug}"`);
    const inv = this.inventory.get(order.marketSlug);
    if (inv) {
      this.log(`  🔍 [DEBUG] Found inventory: inv.marketSlug="${inv.marketSlug}" | tokenA=${inv.tokenA.slice(0,8)}… tokenB=${inv.tokenB.slice(0,8)}…`);
      this.log(`  🔍 [DEBUG] Order tokenId=${order.tokenId.slice(0,8)}… | Returning ${order.shares} shares`);
      
      if (order.tokenId === inv.tokenA) {
        const before = inv.sharesA;
        inv.sharesA += order.shares;
        this.log(`  📦 [INVENTORY] Order cancelled: tokenA ${before} → ${inv.sharesA} (+${order.shares} returned) | Market: ${inv.marketSlug} | Total: ${inv.sharesA}A / ${inv.sharesB}B`);
      } else {
        const before = inv.sharesB;
        inv.sharesB += order.shares;
        this.log(`  📦 [INVENTORY] Order cancelled: tokenB ${before} → ${inv.sharesB} (+${order.shares} returned) | Market: ${inv.marketSlug} | Total: ${inv.sharesA}A / ${inv.sharesB}B`);
      }
    } else {
      this.log(`  ⚠️ [DEBUG] No inventory found for marketSlug="${order.marketSlug}"!`);
    }

    // Mark in wsHandledOrderIds so poll doesn't re-process as fill
    if (order.orderId) {
      this.wsHandledOrderIds.add(order.orderId);
    }

    // Notify dashboard — WS handler won't emit because status is already CANCELLED
    this.emit("orderCancelled", order);
  }

  // ============================================================================
  // MERGE — recover unsold shares at end of game
  // ============================================================================

  /**
   * Merge remaining shares back to USDC when a game ends.
   */
  async mergeRemainingShares(marketSlug: string): Promise<void> {
    let inv = this.inventory.get(marketSlug);
    
    // If no inventory entry (e.g., decided game skipped during startup),
    // try to create one from registered token pair and check on-chain balance
    if (!inv && !this.config.dryRun) {
      const market = this.marketMeta.get(marketSlug);
      if (market && market.tokenIds.length >= 2) {
        const tokenA = market.tokenIds[0];
        const tokenB = market.tokenIds[1];
        this.log(`💡 No inventory for ${marketSlug} — checking on-chain for mergeable shares`);
        try {
          const balA = await this.polyClient.getTokenBalance(tokenA);
          const balB = await this.polyClient.getTokenBalance(tokenB);
          if (balA > 0 || balB > 0) {
            this.log(`  Found on-chain: ${balA.toFixed(2)}A / ${balB.toFixed(2)}B`);
            // Create temporary inventory entry for merge
            inv = {
              marketSlug,
              conditionId: market.conditionId,
              tokenA,
              tokenB,
              sharesA: balA,
              sharesB: balB,
              totalSplitCost: 0,
              splitCount: 0,
              negRisk: market.negRisk
            };
            this.inventory.set(marketSlug, inv);
          }
        } catch (err: any) {
          this.log(`⚠️ On-chain balance check failed: ${err?.message}`);
        }
      }
    }
    
    if (!inv) return;

    let mergeableShares = Math.min(inv.sharesA, inv.sharesB);

    // If internal state says 0 but we're not in dry-run, check on-chain (state may be desynced)
    if (mergeableShares <= 0 && !this.config.dryRun && inv.tokenA) {
      try {
        const balA = await this.polyClient.getTokenBalance(inv.tokenA);
        const balB = await this.polyClient.getTokenBalance(inv.tokenB);
        const onChainMergeable = Math.min(balA, balB);
        if (onChainMergeable > 0) {
          this.log(`💡 Internal shows 0 mergeable but on-chain has ${balA}A/${balB}B — using on-chain`);
          mergeableShares = onChainMergeable;
          inv.sharesA = balA;
          inv.sharesB = balB;
        }
      } catch (err: any) {
        this.log(`⚠️ On-chain balance check failed in merge: ${err?.message}`);
      }
    }

    if (mergeableShares <= 0) return;

    this.log(`🔄 Merging ${mergeableShares} remaining shares for ${marketSlug}`);

    if (this.config.dryRun) {
      this.log(`  [DRY-RUN] Would merge ${mergeableShares} shares`);
      inv.sharesA -= mergeableShares;
      inv.sharesB -= mergeableShares;
      if (inv.sharesA <= 0 && inv.sharesB <= 0) {
        this.inventory.delete(marketSlug);
        this.log(`🎰 Game slot freed: ${marketSlug} (${this.inventory.size}/${this.config.maxConcurrentGames} games active)`);
      }
      return;
    }

    try {
      const result = await this.mergeClient.merge(inv.conditionId, mergeableShares, inv.negRisk);
      if (result.success) {
        this.log(`✅ Merged ${mergeableShares} shares → $${mergeableShares} USDC`);
        inv.sharesA -= mergeableShares;
        inv.sharesB -= mergeableShares;
        // Free the game slot if inventory is empty
        if (inv.sharesA <= 0 && inv.sharesB <= 0) {
          this.inventory.delete(marketSlug);
          this.log(`🎰 Game slot freed: ${marketSlug} (${this.inventory.size}/${this.config.maxConcurrentGames} games active)`);
        }
      } else {
        this.log(`❌ Merge failed: ${result.error}`);
      }
    } catch (err: any) {
      this.log(`❌ Merge error: ${err?.message || err}`);
    }
  }

  // ============================================================================
  // CUMULATIVE TP MANAGEMENT
  // ============================================================================

  /**
   * Update or create a cumulative TP when an entry ladder order fills.
   * Cancels the old TP order and places a new one with updated blended price/shares.
   */
  private async updateCumulativeTP(
    marketSlug: string,
    shockId: string,
    soldTokenId: string,
    heldTokenId: string,
    newShares: number,
    newSoldPrice: number,
    conditionId: string,
    negRisk: boolean,
    shockTeam?: string | null,
  ): Promise<void> {
    const fadeTarget = this.config.fadeTargetCents / 100;
    let tp = this.cumulativeTPs.get(shockId);

    // Safety: if an old TP exists with a terminal status (shouldn't happen after fix,
    // but defensive), treat as new cycle — delete it and start fresh.
    if (tp && tp.status !== "WATCHING" && tp.status !== "PARTIAL") {
      this.log(`⚠️ Stale TP found for ${shockId} (status: ${tp.status}) — clearing for new cycle`);
      this.cumulativeTPs.delete(shockId);
      tp = undefined;
    }

    // Resolve shockTeam from stored map if not passed
    const resolvedShockTeam = shockTeam !== undefined ? shockTeam : (this.shockTeams.get(shockId) ?? null);

    if (!tp) {
      // First ladder fill — create new cumulative TP
      const blended = newSoldPrice;
      const tpPrice = Math.min(0.99, Math.max(0.01, 1.0 - blended + fadeTarget));

      tp = {
        marketSlug,
        conditionId,
        negRisk,
        soldTokenId,
        heldTokenId,
        totalEntryShares: newShares,
        filledTPShares: 0,
        blendedEntryPrice: blended,
        tpPrice,
        tpShares: newShares,
        tpOrderId: null,
        partialPnL: 0,
        shockId,
        createdAt: Date.now(),
        status: "WATCHING",
        _weightedEntrySum: newShares * newSoldPrice,
        shockTeam: resolvedShockTeam,
      };

      this.cumulativeTPs.set(shockId, tp);
      this.log(`📊 Cumulative TP created: ${marketSlug} [${shockId.slice(0, 16)}…] — ${newShares} shares, blended ${(blended * 100).toFixed(1)}¢, TP ${(tpPrice * 100).toFixed(1)}¢`);
      this.emit("tpUpdate", tp);
    } else {
      // Subsequent ladder fill — update existing TP with DCA
      // Cancel the existing TP order first
      await this.cancelCumulativeTPOrder(tp);

      // Account for any partial TP fills: remaining unfilled shares from old TP
      // keep their old blended price, new shares come in at new price
      const remainingOldShares = tp.totalEntryShares - tp.filledTPShares;
      const newWeightedSum = tp._weightedEntrySum - (tp.filledTPShares * tp.blendedEntryPrice) + (newShares * newSoldPrice);
      const newTotalRemaining = remainingOldShares + newShares;

      tp.totalEntryShares += newShares;
      tp._weightedEntrySum += newShares * newSoldPrice;

      // Blended entry across all remaining (non-TP'd) shares
      const newBlended = newWeightedSum / newTotalRemaining;
      tp.blendedEntryPrice = newBlended;
      tp.tpPrice = Math.min(0.99, Math.max(0.01, 1.0 - newBlended + fadeTarget));
      tp.tpShares = newTotalRemaining;
      tp.status = tp.filledTPShares > 0 ? "PARTIAL" : "WATCHING";

      this.log(`📊 Cumulative TP updated: ${marketSlug} [${shockId.slice(0, 16)}…] — ${tp.totalEntryShares} total shares (${tp.filledTPShares} TP'd), blended ${(newBlended * 100).toFixed(1)}¢, TP ${(tp.tpPrice * 100).toFixed(1)}¢, ${tp.tpShares} shares`);
      this.emit("tpUpdate", tp);
    }

    // Place the new TP order
    await this.placeCumulativeTPOrder(tp);
  }

  /**
   * Place a TP SELL limit order for the held (complement) token.
   */
  private async placeCumulativeTPOrder(tp: CumulativeTP): Promise<void> {
    if (tp.tpShares <= 0) return;

    if (this.config.dryRun) {
      const orderId = `dry_tp_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
      tp.tpOrderId = orderId;
      this.log(`  [DRY-RUN] TP order placed: SELL ${tp.tpShares} complement @ ${(tp.tpPrice * 100).toFixed(1)}¢ (${orderId})`);
      return;
    }

    try {
      const result = await this.polyClient.sellSharesGTC(
        tp.heldTokenId,
        tp.tpShares,
        tp.tpPrice,
        tp.negRisk,
      );

      if (result.success && result.orderID) {
        tp.tpOrderId = result.orderID;
        this.log(`  📋 TP order placed: SELL ${tp.tpShares} complement @ ${(tp.tpPrice * 100).toFixed(1)}¢ (${result.orderID.slice(0, 10)}…)`);

        // Check if immediately filled (API response confirms fill — not an assumption)
        if (result.filledShares && result.filledShares > 0) {
          this.log(`  💰 TP IMMEDIATELY FILLED: ${result.filledShares} shares @ ${((result.filledPrice ?? tp.tpPrice) * 100).toFixed(1)}¢`);

          // Mark in wsHandledOrderIds to prevent double-processing when WS fill arrives
          this.wsHandledOrderIds.add(result.orderID);

          // NOTE: No inventory deduction! Held shares came from split pairs.
          // Entry ladder placement already deducted from inventory.
          // TP immediate fill (exit) should NOT deduct again.
          this.log(`  📦 [INVENTORY] TP immediate fill: NO deduction (held shares from position, not inventory pool)`);

          if (result.filledShares >= tp.tpShares) {
            this.completeCumulativeTP(tp);
          } else {
            this.partialFillCumulativeTP(tp, result.filledShares, result.filledPrice ?? tp.tpPrice);
          }
        }
      } else {
        this.log(`  ⚠️ TP order failed: ${result.error}`);
        tp.tpOrderId = null;
      }
    } catch (err: any) {
      this.log(`  ⚠️ TP order error: ${err?.message || err}`);
      tp.tpOrderId = null;
    }
  }

  /**
   * Cancel the current resting TP order.
   */
  private async cancelCumulativeTPOrder(tp: CumulativeTP): Promise<void> {
    if (!tp.tpOrderId) return;

    if (!this.config.dryRun) {
      try {
        const result = await this.polyClient.cancelSingleOrder(tp.tpOrderId);
        if (!result.success) {
          this.log(`  ⚠️ TP cancel failed for ${tp.tpOrderId}: ${result.error}`);
        }
      } catch (err: any) {
        this.log(`  ⚠️ TP cancel error: ${err?.message || err}`);
      }
    } else {
      this.log(`  [DRY-RUN] Would cancel TP order ${tp.tpOrderId}`);
    }

    tp.tpOrderId = null;
  }

  /**
   * TP fills completely — cancel remaining unfilled ladders, close cycle.
   */
  private async completeCumulativeTP(tp: CumulativeTP): Promise<void> {
    // Book the remaining P&L
    const remainingShares = tp.tpShares;
    const pnlPerShare = tp.tpPrice + tp.blendedEntryPrice - 1.0;
    const thisPnL = pnlPerShare * remainingShares;
    tp.partialPnL += thisPnL;
    tp.filledTPShares += remainingShares;
    tp.tpShares = 0;
    tp.status = "HIT";

    this.log(`💰 Cumulative TP COMPLETE: ${tp.marketSlug} — total P&L: $${tp.partialPnL.toFixed(4)} (${tp.totalEntryShares} shares)`);

    // Close ONLY positions matching this cycle's shockId (mark as TAKE_PROFIT)
    for (const pos of this.positions.values()) {
      if (pos.shockId !== tp.shockId || pos.status !== "OPEN") continue;
      
      // Save exitShares BEFORE zeroing heldShares (for trade record)
      const exitedShares = pos.heldShares;
      
      pos.heldShares = 0; // TP sold all complement shares — nothing left to sell
      pos.status = "TAKE_PROFIT";
      pos.exitPrice = tp.tpPrice;
      pos.exitTime = Date.now();
      pos.pnl = (pos.soldPrice + tp.tpPrice - 1.0) * pos.soldShares;

      this.stats.totalPositionsClosed++;
      this.stats.totalPnL += pos.pnl;
      this.stats.totalProceeds += (pos.soldPrice + tp.tpPrice) * pos.soldShares;

      if (pos.pnl > 0) {
        this.stats.winCount++;
        this.consecutiveLosses = 0;
      } else {
        this.stats.lossCount++;
        this.consecutiveLosses++;
      }
      this.pnlHistory.push(pos.pnl);

      // Clear timeout
      const timer = this.positionTimeouts.get(pos.id);
      if (timer) { clearTimeout(timer); this.positionTimeouts.delete(pos.id); }

      // Create trade record
      const holdTimeMs = (pos.exitTime || Date.now()) - pos.entryTime;
      const record: LiveTradeRecord = {
        id: `ltrade_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        marketSlug: pos.marketSlug,
        soldTokenId: pos.soldTokenId,
        soldPrice: pos.soldPrice,
        soldShares: pos.soldShares,
        heldTokenId: pos.heldTokenId,
        exitPrice: tp.tpPrice,
        exitShares: exitedShares,  // Use saved value, not zeroed heldShares
        pnl: pos.pnl,
        splitCost: pos.splitCost,
        totalProceeds: (pos.soldPrice + tp.tpPrice) * pos.soldShares,
        entryTime: pos.entryTime,
        exitTime: pos.exitTime || Date.now(),
        exitReason: "TAKE_PROFIT",
        holdTimeMs,
      };
      this.tradeHistory.push(record);
      this.emit("positionClosed", { position: pos, record });
    }

    // Update win rate
    const totalTrades = this.stats.winCount + this.stats.lossCount;
    this.stats.winRate = totalTrades > 0 ? this.stats.winCount / totalTrades : 0;

    // Cancel ONLY resting entry ladder orders for THIS cycle and return shares
    let cancelledCount = 0;
    for (const order of this.orders.values()) {
      if (order.shockId !== tp.shockId || order.status !== "RESTING") continue;
      await this.cancelOrder(order);
      cancelledCount++;
    }
    if (cancelledCount > 0) {
      this.log(`  ↩️ Cancelled ${cancelledCount} unfilled ladder orders for cycle ${tp.shockId.slice(0, 16)}…, shares returned to inventory`);
    }

    // CRITICAL: Remove the completed TP from the map so this cycle is done.
    // Keyed by shockId — only removes THIS cycle's TP, not other concurrent cycles.
    this.cumulativeTPs.delete(tp.shockId);

    // Check if inventory needs refill after cycle completes
    this.checkAndRefill(tp.marketSlug).catch(err =>
      this.log(`⚠️ Refill check error: ${err?.message || err}`));
  }

  /**
   * TP partially fills (live mode) — update tracking.
   */
  private partialFillCumulativeTP(tp: CumulativeTP, filledShares: number, fillPrice: number): void {
    const pnl = (fillPrice + tp.blendedEntryPrice - 1.0) * filledShares;
    tp.partialPnL += pnl;
    tp.filledTPShares += filledShares;
    tp.tpShares -= filledShares;
    tp.status = tp.tpShares > 0 ? "PARTIAL" : "HIT";

    // Reduce heldShares on matching positions so batchClosePositions knows the correct remaining amount
    let remaining = filledShares;
    for (const pos of this.positions.values()) {
      if (remaining <= 0) break;
      if (pos.shockId !== tp.shockId || pos.status !== "OPEN" || pos.heldShares <= 0) continue;
      const deduct = Math.min(pos.heldShares, remaining);
      pos.heldShares -= deduct;
      remaining -= deduct;
    }

    this.log(`📊 Cumulative TP partial fill: ${tp.marketSlug} — ${filledShares} filled (${tp.filledTPShares}/${tp.totalEntryShares} total), remaining: ${tp.tpShares}`);

    if (tp.tpShares <= 0) {
      this.completeCumulativeTP(tp);
    }
  }

  /**
   * Event-driven exit for cumulative TP — cancel TP order, market-sell all AWAY shares.
   */
  private async eventExitCumulativeTP(tp: CumulativeTP, reason: "EVENT_EXIT" | "SCORING_RUN_BAIL"): Promise<void> {
    // Cancel the resting TP order
    await this.cancelCumulativeTPOrder(tp);

    tp.status = reason;

    // Check remaining positions for this cycle — are there shares to sell?
    const cyclePosns: LivePosition[] = [];
    let totalHeldRemaining = 0;
    for (const pos of this.positions.values()) {
      if (pos.shockId !== tp.shockId || pos.status !== "OPEN") continue;
      cyclePosns.push(pos);
      totalHeldRemaining += pos.heldShares;
    }

    const MIN_ORDER_SIZE = 5; // Polymarket minimum order size

    if (totalHeldRemaining > 0 && totalHeldRemaining < MIN_ORDER_SIZE) {
      // Below Polymarket's 5-share minimum — can't sell, accept orphan
      this.log(`🏟️ Cumulative TP ${reason}: ${tp.marketSlug} — ${totalHeldRemaining.toFixed(2)} remaining held shares ORPHANED (below ${MIN_ORDER_SIZE}-share minimum)`);
      this.log(`  ⚠️ Orphaned shares: ~$${(totalHeldRemaining * 0.50).toFixed(2)} estimated loss (will accumulate as imbalance)`);

      // Zero out heldShares so batchClosePositions doesn't try to sell them
      for (const pos of cyclePosns) {
        pos.heldShares = 0;
      }
    } else {
      this.log(`🏟️ Cumulative TP ${reason}: ${tp.marketSlug} — ${totalHeldRemaining.toFixed(1)} remaining shares to market-sell`);
    }

    // Notify dashboard before removing from map
    this.emit("tpUpdate", tp);

    // The actual market-sell of complement shares will be handled by batchClosePositions
    // which is called right after this in handleGameEvent/handleScoringRun.
    // We just need to mark the TP as exited so it stops monitoring.

    // Remove from map so this cycle is done (keyed by shockId)
    this.cumulativeTPs.delete(tp.shockId);

    // Check if inventory needs refill after event exit
    this.checkAndRefill(tp.marketSlug).catch(err =>
      this.log(`⚠️ Refill check error: ${err?.message || err}`));
  }

  // ============================================================================
  // HELPERS
  // ============================================================================

  /**
   * Wait for a GTC order to fill by monitoring UserChannelWS events.
   * Returns when either the order fills or timeout expires.
   */
  private async waitForGTCFill(
    orderId: string,
    tokenId: string,
    expectedShares: number,
    timeoutMs: number,
  ): Promise<{ filled: boolean; shares?: number; price?: number }> {
    return new Promise((resolve) => {
      let resolved = false;
      const startBal = this.getInventoryShares(tokenId);

      const timer = setTimeout(() => {
        if (resolved) return;
        resolved = true;
        // Check if wsHandledOrderIds picked it up (filled via UserChannelWS)
        if (this.wsHandledOrderIds.has(orderId)) {
          resolve({ filled: true });
          return;
        }
        resolve({ filled: false });
      }, timeoutMs);

      // Poll every 500ms: check if UserChannelWS detected the fill, or check order status
      const poll = setInterval(async () => {
        if (resolved) { clearInterval(poll); return; }

        // Check 1: Did UserChannelWS already handle this order?
        if (this.wsHandledOrderIds.has(orderId)) {
          resolved = true;
          clearTimeout(timer);
          clearInterval(poll);
          resolve({ filled: true });
          return;
        }

        // Check 2: Query order status from CLOB
        try {
          const orderStatus = await this.polyClient.getOrderById(orderId);
          if (orderStatus?.size_matched) {
            const matched = parseFloat(orderStatus.size_matched);
            if (matched >= expectedShares * 0.95) {
              const price = orderStatus.associate_trades?.[0]?.price
                ? parseFloat(orderStatus.associate_trades[0].price)
                : undefined;
              resolved = true;
              clearTimeout(timer);
              clearInterval(poll);
              resolve({ filled: true, shares: matched, price });
              return;
            }
          }
        } catch {
          // Ignore — will retry on next poll
        }
      }, 500);
    });
  }

  /**
   * Get current inventory shares for a token (from internal tracking)
   */
  private getInventoryShares(tokenId: string): number {
    for (const inv of this.inventory.values()) {
      if (inv.tokenA === tokenId) return inv.sharesA;
      if (inv.tokenB === tokenId) return inv.sharesB;
    }
    return 0;
  }

  private getComplementToken(tokenId: string): string | null {
    const pair = this.tokenPairs.get(tokenId);
    if (!pair) return null;
    return pair.tokenA === tokenId ? pair.tokenB : pair.tokenA;
  }

  /**
   * Get all active CumulativeTPs for a given market (across cycles).
   */
  private getCumulativeTPsForMarket(marketSlug: string): CumulativeTP[] {
    return Array.from(this.cumulativeTPs.values()).filter(tp => tp.marketSlug === marketSlug);
  }

  // ============================================================================
  // HOT-RELOAD CONFIG
  // ============================================================================

  /**
   * Hot-reload mutable config from new values. Only affects NEW shocks/cycles.
   * In-progress cycles (orders on-chain, TPs from fills) are untouched.
   * Returns human-readable summary of changes.
   */
  reloadConfig(newVals: {
    maxConcurrentGames?: number;
    maxCyclesPerGame?: number;
    ladderSizes?: number[];
    maxSessionLoss?: number;
    maxConsecutiveLosses?: number;
    // Detector params (forwarded)
    sigmaThreshold?: number;
    minAbsoluteMove?: number;
    ladderSpacing?: number;
    fadeTargetCents?: number;
    cooldownMs?: number;
    targetPriceRange?: [number, number];
    sellPriceMax?: number;
  }): string[] {
    const changes: string[] = [];

    // --- Validate before applying ---
    if (newVals.ladderSizes) {
      if (!Array.isArray(newVals.ladderSizes) || newVals.ladderSizes.some(s => isNaN(s) || s <= 0)) {
        this.log(`❌ Config reload rejected: invalid ladderSizes ${JSON.stringify(newVals.ladderSizes)}`);
        return ["ERROR: invalid ladderSizes — config unchanged"];
      }
    }
    if (newVals.maxConcurrentGames !== undefined && (isNaN(newVals.maxConcurrentGames) || newVals.maxConcurrentGames < 1)) {
      this.log(`❌ Config reload rejected: invalid maxConcurrentGames ${newVals.maxConcurrentGames}`);
      return ["ERROR: invalid maxConcurrentGames — config unchanged"];
    }
    if (newVals.sigmaThreshold !== undefined && (isNaN(newVals.sigmaThreshold) || newVals.sigmaThreshold <= 0)) {
      this.log(`❌ Config reload rejected: invalid sigmaThreshold ${newVals.sigmaThreshold}`);
      return ["ERROR: invalid sigmaThreshold — config unchanged"];
    }

    // --- Strategy-level params ---
    if (newVals.maxConcurrentGames !== undefined && newVals.maxConcurrentGames !== this.config.maxConcurrentGames) {
      changes.push(`maxConcurrentGames: ${this.config.maxConcurrentGames} → ${newVals.maxConcurrentGames}`);
      this.config.maxConcurrentGames = newVals.maxConcurrentGames;
    }
    if (newVals.maxCyclesPerGame !== undefined && newVals.maxCyclesPerGame !== this.config.maxCyclesPerGame) {
      changes.push(`maxCyclesPerGame: ${this.config.maxCyclesPerGame} → ${newVals.maxCyclesPerGame}`);
      this.config.maxCyclesPerGame = newVals.maxCyclesPerGame;
    }
    if (newVals.maxSessionLoss !== undefined && newVals.maxSessionLoss !== this.config.maxSessionLoss) {
      changes.push(`maxSessionLoss: $${this.config.maxSessionLoss} → $${newVals.maxSessionLoss}`);
      this.config.maxSessionLoss = newVals.maxSessionLoss;
    }
    if (newVals.maxConsecutiveLosses !== undefined && newVals.maxConsecutiveLosses !== this.config.maxConsecutiveLosses) {
      changes.push(`maxConsecutiveLosses: ${this.config.maxConsecutiveLosses} → ${newVals.maxConsecutiveLosses}`);
      this.config.maxConsecutiveLosses = newVals.maxConsecutiveLosses;
    }

    // --- Ladder sizes (+ recalculate derived values) ---
    if (newVals.ladderSizes) {
      const oldSizes = this.ladderSizes.join(",");
      const newSizes = newVals.ladderSizes.join(",");
      if (oldSizes !== newSizes) {
        changes.push(`ladderSizes: [${oldSizes}] → [${newSizes}]`);
        this.ladderSizes = newVals.ladderSizes;
        this.config.ladderSizes = newVals.ladderSizes;
        this.config.ladderLevels = newVals.ladderSizes.length;

        const oldCycleSize = this.cycleSize;
        this.cycleSize = this.ladderSizes.reduce((a, b) => a + b, 0);
        this.preSplitSize = (this.cycleSize * this.config.maxCyclesPerGame) + (this.ladderSizes[0] || 0) + (this.ladderSizes[1] || 0);
        this.refillThreshold = this.cycleSize;
        this.refillAmount = this.cycleSize;

        changes.push(`  → cycleSize: ${oldCycleSize} → ${this.cycleSize}`);
        changes.push(`  → preSplitSize: ${this.preSplitSize}, refillThreshold: ${this.refillThreshold}`);
      }
    }

    // Also recalc preSplitSize if maxCyclesPerGame changed (even without ladder change)
    if (newVals.maxCyclesPerGame !== undefined && !newVals.ladderSizes) {
      const newPreSplit = (this.cycleSize * this.config.maxCyclesPerGame) + (this.ladderSizes[0] || 0) + (this.ladderSizes[1] || 0);
      if (newPreSplit !== this.preSplitSize) {
        changes.push(`  → preSplitSize: ${this.preSplitSize} → ${newPreSplit}`);
        this.preSplitSize = newPreSplit;
      }
    }

    // --- Forward detector params ---
    if (newVals.ladderSpacing !== undefined && newVals.ladderSpacing !== this.config.ladderSpacing) {
      changes.push(`ladderSpacing: ${(this.config.ladderSpacing * 100).toFixed(0)}¢ → ${(newVals.ladderSpacing * 100).toFixed(0)}¢`);
      this.config.ladderSpacing = newVals.ladderSpacing;
    }
    if (newVals.fadeTargetCents !== undefined && newVals.fadeTargetCents !== this.config.fadeTargetCents) {
      changes.push(`fadeTargetCents: ${this.config.fadeTargetCents}¢ → ${newVals.fadeTargetCents}¢`);
      this.config.fadeTargetCents = newVals.fadeTargetCents;
    }
    if (newVals.sellPriceMax !== undefined && newVals.sellPriceMax !== this.config.sellPriceMax) {
      changes.push(`sellPriceMax: ${(this.config.sellPriceMax * 100).toFixed(0)}¢ → ${(newVals.sellPriceMax * 100).toFixed(0)}¢`);
      this.config.sellPriceMax = newVals.sellPriceMax;
    }

    if (changes.length === 0) {
      this.log("🔄 Config reloaded — no changes detected");
    } else {
      this.log("🔄 Config reloaded:");
      for (const c of changes) this.log(`   ${c}`);
      this.log(`   ⚠️ Changes apply to NEW shocks only — in-progress cycles untouched`);
    }

    return changes;
  }

  // ============================================================================
  // QUERIES
  // ============================================================================

  getStats(): LiveStats {
    return { ...this.stats };
  }

  getOpenPositions(): LivePosition[] {
    return Array.from(this.positions.values()).filter(p => p.status === "OPEN");
  }

  getAllPositions(): LivePosition[] {
    return Array.from(this.positions.values());
  }

  getActiveOrders(): LiveLadderOrder[] {
    return Array.from(this.orders.values()).filter(o => o.status === "RESTING");
  }

  /**
   * Cancel resting entry orders older than 60s.
   * If the overshoot didn't reach our price in 60s, it's not coming.
   * Returns shares to inventory.
   */
  private async cancelStaleOrders(): Promise<void> {
    const ENTRY_ORDER_EXPIRY_MS = 60_000;
    const now = Date.now();

    for (const order of this.orders.values()) {
      if (order.status !== "RESTING") continue;
      if (now - order.createdAt < ENTRY_ORDER_EXPIRY_MS) continue;

      // Cancel on CLOB first — shares are locked in resting orders until actually cancelled
      await this.cancelOrder(order);

      this.log(`🕐 Order expired (60s): L${order.level} ${order.shares}sh @ ${(order.price * 100).toFixed(1)}¢ [${order.marketSlug}]`);
      this.emit("orderCancelled", order);
    }
  }

  getAllOrders(): LiveLadderOrder[] {
    return Array.from(this.orders.values());
  }

  getTradeHistory(): LiveTradeRecord[] {
    return [...this.tradeHistory];
  }

  getCumulativeTPs(): CumulativeTP[] {
    return Array.from(this.cumulativeTPs.values());
  }

  getInventory(marketSlug: string): MarketInventory | undefined {
    return this.inventory.get(marketSlug);
  }

  getAllInventory(): MarketInventory[] {
    return Array.from(this.inventory.values());
  }

  getLatestPrice(tokenId: string): { bid: number; ask: number; mid: number } | undefined {
    return this.latestPrices.get(tokenId);
  }

  getUserChannelWS(): UserChannelWS | null {
    return this.userChannelWS;
  }

  isDryRun(): boolean {
    return this.config.dryRun;
  }

  isHalted(): boolean {
    return this.halted;
  }

  getHaltReason(): string | null {
    return this.haltReason;
  }

  getConsecutiveLosses(): number {
    return this.consecutiveLosses;
  }

  // ============================================================================
  // PERSISTENCE
  // ============================================================================

  private saveState(): void {
    try {
      const dir = path.dirname(this.statePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      const state = {
        timestamp: Date.now(),
        model: "shock-fade-live",
        inventory: Array.from(this.inventory.values()),
        orders: Array.from(this.orders.values()),
        positions: Array.from(this.positions.values()),
        tradeHistory: this.tradeHistory.slice(-200),
        stats: this.stats,
        pnlHistory: this.pnlHistory.slice(-500),
        cumulativeTPs: Array.from(this.cumulativeTPs.values()),
      };

      fs.writeFileSync(this.statePath, JSON.stringify(state, null, 2));
    } catch (err) {
      this.log(`Failed to save state: ${err}`);
    }
  }

  private loadState(): void {
    try {
      if (!fs.existsSync(this.statePath)) {
        this.log("No persisted state found, starting fresh");
        return;
      }

      const data = JSON.parse(fs.readFileSync(this.statePath, "utf-8"));

      if (data.model !== "shock-fade-live") {
        this.log("Wrong model in state file, starting fresh");
        return;
      }

      // Restore inventory (pre-split shares)
      for (const inv of data.inventory || []) {
        this.inventory.set(inv.marketSlug, inv);
      }

      // Restore ALL orders and positions (including active ones)
      // Active orders (RESTING) will be auto-cancelled by the 60s expiry timer if stale.
      // Filled orders need their positions and TPs to remain intact.
      for (const order of data.orders || []) {
        this.orders.set(order.id, order);
      }

      for (const pos of data.positions || []) {
        this.positions.set(pos.id, pos);
      }

      this.tradeHistory = data.tradeHistory || [];
      this.pnlHistory = data.pnlHistory || [];

      // CRITICAL FIX: Verify stats match tradeHistory
      // If stats show 78 closed but tradeHistory is empty, stats are stale
      const actualTradeCount = this.tradeHistory.length;
      const statsTradeCount = data.stats?.totalPositionsClosed || 0;
      
      if (actualTradeCount === 0 && statsTradeCount > 0) {
        this.log(`⚠️ STATS DESYNC: stats show ${statsTradeCount} closed but tradeHistory has ${actualTradeCount} — RESETTING STATS`);
        // Reset stats to fresh state
        this.stats = {
          totalShocksProcessed: 0,
          totalOrdersPlaced: 0,
          totalOrdersFilled: 0,
          totalOrdersCancelled: 0,
          totalPositionsOpened: 0,
          totalPositionsClosed: 0,
          totalPnL: 0,
          totalSplitCost: 0,
          totalProceeds: 0,
          winCount: 0,
          lossCount: 0,
          winRate: 0,
          startedAt: Date.now(),
        };
      } else if (data.stats) {
        this.stats = { ...this.stats, ...data.stats };
      }

      // Restore ALL cumulative TPs (active ones resume monitoring)
      // Key by shockId (new format). Migrate from old marketSlug-keyed format if needed.
      for (const tp of data.cumulativeTPs || []) {
        // Ensure shockTeam field exists (migration from pre-refactor)
        if (tp.shockTeam === undefined) {
          tp.shockTeam = null;
        }
        // Key by shockId (new format) — ignore if shockId is missing (corrupt state)
        if (tp.shockId) {
          this.cumulativeTPs.set(tp.shockId, tp);
        } else {
          // Fallback for very old state without shockId on TP — skip
          this.log(`⚠️ TP for ${tp.marketSlug} missing shockId — skipping`);
        }
      }

      // Reconstruct missing cumulative TPs from orphaned filled orders or open positions
      // Group filled orders by shockId that don't have a corresponding closed trade or active TP
      const filledByShockId = new Map<string, LiveLadderOrder[]>();
      for (const order of this.orders.values()) {
        if (order.status !== "FILLED") continue;
        const sid = order.shockId || order.marketSlug; // fallback for old orders without shockId
        if (this.cumulativeTPs.has(sid)) continue;
        // Check if this fill already has a closed trade
        const hasTrade = this.tradeHistory.some(t =>
          t.marketSlug === order.marketSlug &&
          Math.abs((t.soldPrice || 0) - order.price) < 0.001 &&
          (t.soldShares || t.exitShares || 0) === order.shares
        );
        if (hasTrade) continue;
        if (!filledByShockId.has(sid)) filledByShockId.set(sid, []);
        filledByShockId.get(sid)!.push(order);
      }

      // Also check open positions
      for (const pos of this.positions.values()) {
        if (pos.status !== "OPEN") continue;
        const sid = pos.shockId || pos.marketSlug;
        if (this.cumulativeTPs.has(sid)) continue;
        if (!filledByShockId.has(sid)) {
          filledByShockId.set(sid, []);
        }
      }

      const fadeTarget = this.config.fadeTargetCents / 100;
      for (const [shockIdKey, fills] of filledByShockId) {
        const marketSlug = fills[0]?.marketSlug || Array.from(this.positions.values()).find(p => (p.shockId || p.marketSlug) === shockIdKey)?.marketSlug || "";
        if (!marketSlug) continue;

        // Skip reconstruction if game is already decided
        if (this.extremePriceTriggered.has(marketSlug)) {
          this.log(`⏭️ Skipping TP reconstruction for ${marketSlug} — game decided`);
          continue;
        }
        // Also check live prices AND discovery prices for decided games
        // (extremePriceTriggered is empty on restart, live prices may not be populated yet)
        const reconMarket = this.marketMeta.get(marketSlug);
        if (reconMarket) {
          // Check live WS prices
          if (reconMarket.tokenIds && reconMarket.tokenIds.length >= 2) {
            const pA = this.latestPrices.get(reconMarket.tokenIds[0]);
            const pB = this.latestPrices.get(reconMarket.tokenIds[1]);
            if ((pA?.bid !== undefined && (pA.bid >= 0.95 || pA.bid <= 0.02)) ||
                (pB?.bid !== undefined && (pB.bid >= 0.95 || pB.bid <= 0.02))) {
              this.log(`⏭️ Skipping TP reconstruction for ${marketSlug} — game decided (live: ${pA?.bid !== undefined ? (pA.bid * 100).toFixed(1) + '¢' : '?'} / ${pB?.bid !== undefined ? (pB.bid * 100).toFixed(1) + '¢' : '?'})`);
              this.extremePriceTriggered.add(marketSlug);
              continue;
            }
          }
          // Fallback: check Gamma API discovery prices (available before WS connects)
          if (reconMarket.outcomePrices && reconMarket.outcomePrices.length >= 2) {
            const maxP = Math.max(...reconMarket.outcomePrices);
            const minP = Math.min(...reconMarket.outcomePrices);
            if (maxP >= 0.95 || minP <= 0.05) {
              this.log(`⏭️ Skipping TP reconstruction for ${marketSlug} — game decided (discovery: ${reconMarket.outcomePrices.map(p => (p * 100).toFixed(1) + '¢').join(' / ')})`);
              this.extremePriceTriggered.add(marketSlug);
              continue;
            }
          }
        }

        // Get inventory to find token IDs
        const inv = this.inventory.get(marketSlug);
        // Try to get info from position first, then from order
        const pos = Array.from(this.positions.values()).find(p => (p.shockId || p.marketSlug) === shockIdKey && p.status === "OPEN");

        let soldTokenId = pos?.soldTokenId || (fills[0]?.tokenId) || "";
        let heldTokenId = pos?.heldTokenId || "";
        let conditionId = pos?.conditionId || (fills[0]?.conditionId) || "";
        let negRisk = pos?.negRisk ?? false;

        // If no held token from position, derive from inventory
        if (!heldTokenId && inv) {
          heldTokenId = soldTokenId === inv.tokenA ? inv.tokenB : inv.tokenA;
        }

        // Calculate blended entry from fills
        let totalShares = 0;
        let weightedSum = 0;
        if (fills.length > 0) {
          for (const f of fills) {
            totalShares += f.shares;
            weightedSum += f.shares * f.price;
          }
        } else if (pos) {
          totalShares = pos.soldShares;
          weightedSum = pos.soldShares * pos.soldPrice;
        }

        if (totalShares === 0) continue;

        const blended = weightedSum / totalShares;
        const tpPrice = 1.0 - blended + fadeTarget;
        const resolvedShockId = fills[0]?.shockId || pos?.shockId || shockIdKey;

        const tp: CumulativeTP = {
          marketSlug,
          conditionId,
          negRisk,
          soldTokenId,
          heldTokenId,
          totalEntryShares: totalShares,
          filledTPShares: 0,
          blendedEntryPrice: blended,
          tpPrice,
          tpShares: totalShares,
          tpOrderId: null,
          partialPnL: 0,
          shockId: resolvedShockId,
          createdAt: fills[0]?.filledAt || fills[0]?.createdAt || pos?.entryTime || Date.now(),
          status: "WATCHING" as const,
          _weightedEntrySum: weightedSum,
          shockTeam: null,
        };
        this.cumulativeTPs.set(resolvedShockId, tp);
        this.log(`🔧 Reconstructed TP for ${marketSlug} [${resolvedShockId.slice(0, 16)}…]: ${totalShares}sh, blended ${(blended * 100).toFixed(1)}¢, TP @ ${(tpPrice * 100).toFixed(1)}¢`);

        // Also reconstruct position if missing
        if (!pos && fills.length > 0) {
          for (const f of fills) {
            const posId = `recon_${f.id}`;
            this.positions.set(posId, {
              id: posId,
              marketSlug,
              conditionId,
              negRisk,
              soldTokenId: f.tokenId,
              soldPrice: f.price,
              soldShares: f.shares,
              heldTokenId,
              heldShares: f.shares,
              splitCost: f.shares,
              entryTime: f.filledAt || f.createdAt,
              exitTime: null,
              takeProfitPrice: 1.0 - f.price + fadeTarget,
              exitPrice: null,
              pnl: null,
              shockId: f.shockId,
              status: "OPEN",
            });
            this.log(`🔧 Reconstructed position: ${posId} — ${f.shares}sh @ ${(f.price * 100).toFixed(1)}¢`);
          }
        }
      }

      this.log(`Loaded state: ${this.tradeHistory.length} trades, P&L: ${this.stats.totalPnL >= 0 ? "+" : ""}$${this.stats.totalPnL.toFixed(2)}`);
    } catch (err) {
      this.log(`Failed to load state: ${err}`);
    }
  }

  // ============================================================================
  // LOGGING
  // ============================================================================

  private log(message: string): void {
    const ts = new Date().toISOString();
    console.log(`${ts} [INFO] 🔴 [ShockFadeLive] ${message}`);
  }
}
