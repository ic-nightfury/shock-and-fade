/**
 * Sports Position Manager Service
 *
 * Tracks positions across multiple concurrent sports games for the SSS strategy.
 * Manages position lifecycle from SPLIT to settlement and calculates P&L.
 *
 * Features:
 * - Track position state: pending_split, holding, partial_sold, fully_sold, settled
 * - Store: market, entry_time, split_cost, yes_shares, no_shares, sold_revenue
 * - Support up to 50 concurrent positions
 * - Calculate real-time P&L per position and total
 * - Persist positions to file for crash recovery
 * - Handle position cleanup after settlement
 *
 * Usage:
 *   const manager = new SportsPositionManager();
 *   await manager.start();
 *   await manager.openPosition(market, splitCost, shares);
 *   manager.recordSale(marketSlug, outcome, shares, revenue);
 *   const pnl = manager.getTotalPnL();
 */

import { EventEmitter } from "events";
import * as fs from "fs";
import * as path from "path";
import { SportsMarket } from "./SportsMarketDiscovery";

// Configuration
const DEFAULT_POSITIONS_FILE = "./sss_positions.json";
const DEFAULT_PERSISTENCE_INTERVAL_MS = 30 * 1000; // 30 seconds
const MAX_CONCURRENT_POSITIONS = 50;

/**
 * Position state enumeration
 */
export enum PositionState {
  PENDING_SPLIT = "pending_split", // SPLIT requested, waiting for confirmation
  HOLDING = "holding", // Both sides held, waiting for sell trigger
  PARTIAL_SOLD = "partial_sold", // One side sold, holding winner
  FULLY_SOLD = "fully_sold", // Both sides sold (unusual - emergency exit)
  PENDING_SETTLEMENT = "pending_settlement", // US-818: Game ended, awaiting redemption or manual action
  SETTLED = "settled", // Position settled (winner redeemed or merged)
}

/**
 * Outcome data for a position side
 */
export interface PositionOutcome {
  tokenId: string;
  outcome: string; // e.g., "Lakers", "Celtics"
  shares: number;
  sold: boolean;
  soldAt: Date | null;
  soldPrice: number; // Price per share when sold
  soldShares: number; // Number of shares sold
  soldRevenue: number; // Total revenue from sale
}

/**
 * Position in a sports market
 */
export interface SportsPosition {
  // Identification
  marketSlug: string;
  sport: string;
  question: string;
  conditionId?: string;

  // Timing
  entryTime: Date;
  gameStartTime: Date | null;
  settledAt: Date | null;
  gameEndedAt: Date | null; // US-818: When game ended (99c+ detected)

  // Position details
  splitCost: number; // Total cost of SPLIT (in USDC)
  outcome1: PositionOutcome;
  outcome2: PositionOutcome;

  // State
  state: PositionState;
  stateChangedAt: Date;

  // US-818: Winner information for pending_settlement positions
  winningOutcome: string | null; // Name of the winning outcome (e.g., "Lakers")

  // P&L tracking
  totalSoldRevenue: number;
  settlementRevenue: number; // Revenue from settlement (winner pays $1)
  realizedPnL: number; // Total realized P&L (settled positions only)

  // Market type
  negRisk: boolean; // true = NegRiskAdapter (0% fee), false = standard CTF (10% fee)

  // Current prices for unrealized P&L (updated externally)
  currentPrice1: number;
  currentPrice2: number;
  lastPriceUpdateAt: Date | null;

  // Metadata
  notes: string;
}

/**
 * Summary of P&L across all positions
 */
export interface PnLSummary {
  realizedPnL: number; // Sum of settled positions
  unrealizedPnL: number; // Sum of open positions based on current prices
  totalPnL: number; // realized + unrealized
  positionsOpen: number;
  positionsSettled: number;
  winCount: number;
  lossCount: number;
  winRate: number; // % of settled positions that were profitable
  avgPnLPerPosition: number;
  bySport: Record<
    string,
    {
      realizedPnL: number;
      unrealizedPnL: number;
      positionsOpen: number;
      positionsSettled: number;
    }
  >;
}

/**
 * Event emitted when position state changes
 */
export interface PositionStateChange {
  position: SportsPosition;
  previousState: PositionState;
  newState: PositionState;
  reason: string;
}

/**
 * Manager statistics
 */
export interface PositionManagerStats {
  positionsOpen: number;
  positionsSettled: number;
  totalSplitCost: number;
  totalSoldRevenue: number;
  totalSettlementRevenue: number;
  persistenceEnabled: boolean;
  lastPersistenceAt: number;
  errors: number;
}

/**
 * Sports Position Manager Service
 */
export class SportsPositionManager extends EventEmitter {
  private running = false;
  private positions: Map<string, SportsPosition> = new Map(); // marketSlug -> position
  private settledPositions: SportsPosition[] = []; // History of settled positions

  // Persistence
  private persistenceEnabled: boolean;
  private positionsFilePath: string;
  private persistenceIntervalMs: number;
  private persistenceTimer: NodeJS.Timeout | null = null;

  // Stats
  private stats: PositionManagerStats = {
    positionsOpen: 0,
    positionsSettled: 0,
    totalSplitCost: 0,
    totalSoldRevenue: 0,
    totalSettlementRevenue: 0,
    persistenceEnabled: false,
    lastPersistenceAt: 0,
    errors: 0,
  };

  constructor(
    options: {
      positionsFilePath?: string;
      persistenceEnabled?: boolean;
      persistenceIntervalMs?: number;
    } = {},
  ) {
    super();
    this.positionsFilePath =
      options.positionsFilePath || DEFAULT_POSITIONS_FILE;
    this.persistenceEnabled = options.persistenceEnabled ?? true;
    this.persistenceIntervalMs =
      options.persistenceIntervalMs || DEFAULT_PERSISTENCE_INTERVAL_MS;
    this.stats.persistenceEnabled = this.persistenceEnabled;
  }

  /**
   * Log helper
   */
  private log(
    message: string,
    level: "INFO" | "WARN" | "ERROR" = "INFO",
  ): void {
    const timestamp = new Date().toISOString();
    const prefix = level === "ERROR" ? "❌" : level === "WARN" ? "⚠️" : "💼";
    console.log(
      `${timestamp} [${level}] ${prefix} [PositionManager] ${message}`,
    );
  }

  /**
   * Start the position manager service
   */
  async start(): Promise<void> {
    if (this.running) {
      this.log("Position manager already running", "WARN");
      return;
    }

    this.running = true;
    this.log("=".repeat(60));
    this.log("Starting Sports Position Manager Service");
    this.log(`Max concurrent positions: ${MAX_CONCURRENT_POSITIONS}`);
    this.log(
      `Persistence: ${this.persistenceEnabled ? "ENABLED" : "DISABLED"}`,
    );
    if (this.persistenceEnabled) {
      this.log(`Positions file: ${this.positionsFilePath}`);
    }
    this.log("=".repeat(60));

    // Load persisted positions if enabled
    if (this.persistenceEnabled) {
      await this.loadPositionsFromDisk();
      this.startPersistenceLoop();
    }

    this.log("Position manager started successfully");
  }

  /**
   * Stop the position manager service
   */
  stop(): void {
    this.running = false;

    // Stop persistence loop
    if (this.persistenceTimer) {
      clearInterval(this.persistenceTimer);
      this.persistenceTimer = null;
    }

    // Final save before shutdown
    if (this.persistenceEnabled) {
      this.savePositionsToDisk();
    }

    this.log("=".repeat(60));
    this.log("Position manager stopped");
    this.logStats();
    this.log("=".repeat(60));
  }

  /**
   * Open a new position after SPLIT
   */
  async openPosition(
    market: SportsMarket,
    splitCost: number,
    shares: number,
  ): Promise<SportsPosition | null> {
    if (!this.running) {
      this.log("Cannot open position - manager not running", "ERROR");
      return null;
    }

    // Check if position already exists
    if (this.positions.has(market.marketSlug)) {
      this.log(`Position already exists: ${market.marketSlug}`, "WARN");
      return this.positions.get(market.marketSlug) || null;
    }

    // Check max positions limit
    if (this.positions.size >= MAX_CONCURRENT_POSITIONS) {
      this.log(
        `Max positions reached (${MAX_CONCURRENT_POSITIONS}), cannot open new position`,
        "ERROR",
      );
      return null;
    }

    // Create new position
    const now = new Date();
    const position: SportsPosition = {
      marketSlug: market.marketSlug,
      sport: market.sport,
      question: market.question,
      conditionId: market.conditionId,
      entryTime: now,
      gameStartTime: market.gameStartTime,
      settledAt: null,
      gameEndedAt: null, // US-818: Set when game ends (99c+ detected)
      splitCost,
      outcome1: {
        tokenId: market.tokenIds[0],
        outcome: market.outcomes[0] || "Outcome 1",
        shares,
        sold: false,
        soldAt: null,
        soldPrice: 0,
        soldShares: 0,
        soldRevenue: 0,
      },
      outcome2: {
        tokenId: market.tokenIds[1],
        outcome: market.outcomes[1] || "Outcome 2",
        shares,
        sold: false,
        soldAt: null,
        soldPrice: 0,
        soldShares: 0,
        soldRevenue: 0,
      },
      state: PositionState.HOLDING,
      stateChangedAt: now,
      winningOutcome: null, // US-818: Set when game ends
      totalSoldRevenue: 0,
      settlementRevenue: 0,
      realizedPnL: 0,
      negRisk: market.negRisk, // From market data - affects fee rate and exchange
      currentPrice1: market.outcomePrices[0] || 0.5,
      currentPrice2: market.outcomePrices[1] || 0.5,
      lastPriceUpdateAt: now,
      notes: "",
    };

    this.positions.set(market.marketSlug, position);
    this.updateStats();

    this.log(
      `Opened position: ${market.marketSlug} [${market.sport}] ` +
        `cost=$${splitCost.toFixed(2)}, shares=${shares}`,
    );

    // Emit event
    this.emit("positionOpened", position);

    return position;
  }

  /**
   * Record a sale of one outcome
   */
  recordSale(
    marketSlug: string,
    outcomeIndex: 1 | 2,
    shares: number,
    price: number,
    revenue: number,
  ): boolean {
    const position = this.positions.get(marketSlug);
    if (!position) {
      this.log(`Position not found for sale: ${marketSlug}`, "ERROR");
      return false;
    }

    const outcome = outcomeIndex === 1 ? position.outcome1 : position.outcome2;

    // Record sale
    outcome.sold = true;
    outcome.soldAt = new Date();
    outcome.soldPrice = price;
    outcome.soldShares = shares;
    outcome.soldRevenue = revenue;

    // Update totals
    position.totalSoldRevenue += revenue;

    // Determine new state
    const previousState = position.state;
    if (position.outcome1.sold && position.outcome2.sold) {
      position.state = PositionState.FULLY_SOLD;
    } else {
      position.state = PositionState.PARTIAL_SOLD;
    }
    position.stateChangedAt = new Date();

    this.updateStats();

    this.log(
      `Recorded sale: ${marketSlug} ${outcome.outcome} ` +
        `shares=${shares}, price=${(price * 100).toFixed(1)}c, revenue=$${revenue.toFixed(2)}`,
    );

    // Emit state change event
    if (previousState !== position.state) {
      const change: PositionStateChange = {
        position,
        previousState,
        newState: position.state,
        reason: `Sold ${outcome.outcome}`,
      };
      this.emit("stateChange", change);
    }

    return true;
  }

  /**
   * Update current prices for a position (for unrealized P&L calculation)
   */
  updatePrices(marketSlug: string, price1: number, price2: number): void {
    const position = this.positions.get(marketSlug);
    if (position) {
      position.currentPrice1 = price1;
      position.currentPrice2 = price2;
      position.lastPriceUpdateAt = new Date();
    }
  }

  /**
   * Settle a position (winner redeemed or position merged)
   */
  settlePosition(
    marketSlug: string,
    settlementRevenue: number,
    reason: string = "settlement",
  ): boolean {
    const position = this.positions.get(marketSlug);
    if (!position) {
      this.log(`Position not found for settlement: ${marketSlug}`, "ERROR");
      return false;
    }

    const previousState = position.state;

    // Update position
    position.settledAt = new Date();
    position.settlementRevenue = settlementRevenue;
    position.realizedPnL =
      position.totalSoldRevenue + settlementRevenue - position.splitCost;
    position.state = PositionState.SETTLED;
    position.stateChangedAt = new Date();
    position.notes = reason;

    // Move to settled history
    this.settledPositions.push(position);
    this.positions.delete(marketSlug);

    this.updateStats();

    const pnlStr =
      position.realizedPnL >= 0
        ? `+$${position.realizedPnL.toFixed(2)}`
        : `-$${Math.abs(position.realizedPnL).toFixed(2)}`;

    this.log(
      `Settled position: ${marketSlug} [${position.sport}] P&L=${pnlStr} (${reason})`,
    );

    // Emit events
    const change: PositionStateChange = {
      position,
      previousState,
      newState: PositionState.SETTLED,
      reason,
    };
    this.emit("stateChange", change);
    this.emit("positionSettled", position);

    return true;
  }

  /**
   * US-818: Mark position as pending settlement
   *
   * Called when a game ends (99c+ detected) and the position should await
   * redemption or manual action. This is distinct from SETTLED which is
   * the final state after redemption completes.
   *
   * State transitions:
   * - HOLDING → PENDING_SETTLEMENT (game ended, both sides held, after MERGE)
   * - PARTIAL_SOLD → PENDING_SETTLEMENT (game ended, holding winner)
   */
  markPendingSettlement(
    marketSlug: string,
    winningOutcome: string,
    reason: string = "game_ended",
  ): boolean {
    const position = this.positions.get(marketSlug);
    if (!position) {
      this.log(
        `Position not found for pending settlement: ${marketSlug}`,
        "ERROR",
      );
      return false;
    }

    const previousState = position.state;

    // Update position
    position.gameEndedAt = new Date();
    position.winningOutcome = winningOutcome;
    position.state = PositionState.PENDING_SETTLEMENT;
    position.stateChangedAt = new Date();
    position.notes = reason;

    this.log(
      `Marked pending settlement: ${marketSlug} [${position.sport}] ` +
        `winner=${winningOutcome} (${reason})`,
    );

    // Emit state change event
    if (previousState !== position.state) {
      const change: PositionStateChange = {
        position,
        previousState,
        newState: PositionState.PENDING_SETTLEMENT,
        reason,
      };
      this.emit("stateChange", change);
    }

    return true;
  }

  /**
   * Get a position by market slug
   */
  getPosition(marketSlug: string): SportsPosition | null {
    return this.positions.get(marketSlug) || null;
  }

  /**
   * Get all open positions
   */
  getOpenPositions(): SportsPosition[] {
    return Array.from(this.positions.values());
  }

  /**
   * Get positions by state
   */
  getPositionsByState(state: PositionState): SportsPosition[] {
    return Array.from(this.positions.values()).filter((p) => p.state === state);
  }

  /**
   * Get positions by sport
   */
  getPositionsBySport(sport: string): SportsPosition[] {
    const upperSport = sport.toUpperCase();
    return Array.from(this.positions.values()).filter(
      (p) => p.sport.toUpperCase() === upperSport,
    );
  }

  /**
   * Get settled positions history
   */
  getSettledPositions(): SportsPosition[] {
    return [...this.settledPositions];
  }

  /**
   * Calculate unrealized P&L for a single position
   */
  calculateUnrealizedPnL(position: SportsPosition): number {
    if (position.state === PositionState.SETTLED) {
      return 0; // Settled positions have no unrealized P&L
    }

    // Value of unsold shares at current prices
    let currentValue = 0;

    if (!position.outcome1.sold) {
      currentValue += position.outcome1.shares * position.currentPrice1;
    }
    if (!position.outcome2.sold) {
      currentValue += position.outcome2.shares * position.currentPrice2;
    }

    // Add already sold revenue
    currentValue += position.totalSoldRevenue;

    // P&L = current value - cost
    return currentValue - position.splitCost;
  }

  /**
   * Get P&L summary across all positions
   */
  getPnLSummary(): PnLSummary {
    let realizedPnL = 0;
    let unrealizedPnL = 0;
    let winCount = 0;
    let lossCount = 0;
    const bySport: PnLSummary["bySport"] = {};

    // Calculate from settled positions
    for (const position of this.settledPositions) {
      realizedPnL += position.realizedPnL;
      if (position.realizedPnL >= 0) {
        winCount++;
      } else {
        lossCount++;
      }

      // By sport
      const sport = position.sport;
      if (!bySport[sport]) {
        bySport[sport] = {
          realizedPnL: 0,
          unrealizedPnL: 0,
          positionsOpen: 0,
          positionsSettled: 0,
        };
      }
      bySport[sport].realizedPnL += position.realizedPnL;
      bySport[sport].positionsSettled++;
    }

    // Calculate from open positions
    const openPositions = Array.from(this.positions.values());
    for (const position of openPositions) {
      const posUnrealized = this.calculateUnrealizedPnL(position);
      unrealizedPnL += posUnrealized;

      // By sport
      const sport = position.sport;
      if (!bySport[sport]) {
        bySport[sport] = {
          realizedPnL: 0,
          unrealizedPnL: 0,
          positionsOpen: 0,
          positionsSettled: 0,
        };
      }
      bySport[sport].unrealizedPnL += posUnrealized;
      bySport[sport].positionsOpen++;
    }

    const totalSettled = this.settledPositions.length;
    const winRate = totalSettled > 0 ? (winCount / totalSettled) * 100 : 0;
    const avgPnL = totalSettled > 0 ? realizedPnL / totalSettled : 0;

    return {
      realizedPnL,
      unrealizedPnL,
      totalPnL: realizedPnL + unrealizedPnL,
      positionsOpen: this.positions.size,
      positionsSettled: totalSettled,
      winCount,
      lossCount,
      winRate,
      avgPnLPerPosition: avgPnL,
      bySport,
    };
  }

  /**
   * Get total P&L (realized + unrealized)
   */
  getTotalPnL(): number {
    const summary = this.getPnLSummary();
    return summary.totalPnL;
  }

  /**
   * Get position count
   */
  getPositionCount(): number {
    return this.positions.size;
  }

  /**
   * Check if can open new position
   */
  canOpenPosition(): boolean {
    return this.running && this.positions.size < MAX_CONCURRENT_POSITIONS;
  }

  /**
   * Get statistics
   */
  getStats(): PositionManagerStats {
    return { ...this.stats };
  }

  /**
   * Check if manager is running
   */
  isRunning(): boolean {
    return this.running;
  }

  // ===========================================================================
  // Persistence
  // ===========================================================================

  /**
   * Start the persistence loop
   */
  private startPersistenceLoop(): void {
    if (this.persistenceTimer) {
      return;
    }

    this.log(
      `Starting persistence loop (every ${this.persistenceIntervalMs / 1000}s)`,
    );

    this.persistenceTimer = setInterval(() => {
      this.savePositionsToDisk();
    }, this.persistenceIntervalMs);
  }

  /**
   * Save positions to disk
   */
  private savePositionsToDisk(): void {
    try {
      const state = {
        timestamp: Date.now(),
        version: 1,
        positions: Array.from(this.positions.values()),
        settledPositions: this.settledPositions,
      };

      fs.writeFileSync(this.positionsFilePath, JSON.stringify(state, null, 2));
      this.stats.lastPersistenceAt = Date.now();
    } catch (err) {
      this.log(`Failed to save positions: ${err}`, "ERROR");
      this.stats.errors++;
    }
  }

  /**
   * Load positions from disk
   */
  private async loadPositionsFromDisk(): Promise<void> {
    if (!fs.existsSync(this.positionsFilePath)) {
      this.log("No persisted positions file found, starting fresh");
      return;
    }

    try {
      const data = JSON.parse(fs.readFileSync(this.positionsFilePath, "utf-8"));

      if (!data.positions || !Array.isArray(data.positions)) {
        this.log("Invalid positions file format", "WARN");
        return;
      }

      const ageSeconds = (Date.now() - data.timestamp) / 1000;
      this.log(
        `Found persisted positions from ${new Date(data.timestamp).toISOString()} (${ageSeconds.toFixed(0)}s ago)`,
      );

      // Restore open positions
      for (const posData of data.positions) {
        // Convert date strings back to Date objects
        const position: SportsPosition = {
          ...posData,
          entryTime: new Date(posData.entryTime),
          gameStartTime: posData.gameStartTime
            ? new Date(posData.gameStartTime)
            : null,
          settledAt: posData.settledAt ? new Date(posData.settledAt) : null,
          gameEndedAt: posData.gameEndedAt
            ? new Date(posData.gameEndedAt)
            : null, // US-818
          stateChangedAt: new Date(posData.stateChangedAt),
          winningOutcome: posData.winningOutcome || null, // US-818
          lastPriceUpdateAt: posData.lastPriceUpdateAt
            ? new Date(posData.lastPriceUpdateAt)
            : null,
          outcome1: {
            ...posData.outcome1,
            soldAt: posData.outcome1.soldAt
              ? new Date(posData.outcome1.soldAt)
              : null,
          },
          outcome2: {
            ...posData.outcome2,
            soldAt: posData.outcome2.soldAt
              ? new Date(posData.outcome2.soldAt)
              : null,
          },
        };

        this.positions.set(position.marketSlug, position);
        this.log(
          `  Restored: ${position.marketSlug} [${position.sport}] state=${position.state}`,
        );
      }

      // Restore settled positions history
      if (data.settledPositions && Array.isArray(data.settledPositions)) {
        for (const posData of data.settledPositions) {
          const position: SportsPosition = {
            ...posData,
            entryTime: new Date(posData.entryTime),
            gameStartTime: posData.gameStartTime
              ? new Date(posData.gameStartTime)
              : null,
            settledAt: posData.settledAt ? new Date(posData.settledAt) : null,
            gameEndedAt: posData.gameEndedAt
              ? new Date(posData.gameEndedAt)
              : null, // US-818
            stateChangedAt: new Date(posData.stateChangedAt),
            winningOutcome: posData.winningOutcome || null, // US-818
            lastPriceUpdateAt: posData.lastPriceUpdateAt
              ? new Date(posData.lastPriceUpdateAt)
              : null,
            outcome1: {
              ...posData.outcome1,
              soldAt: posData.outcome1.soldAt
                ? new Date(posData.outcome1.soldAt)
                : null,
            },
            outcome2: {
              ...posData.outcome2,
              soldAt: posData.outcome2.soldAt
                ? new Date(posData.outcome2.soldAt)
                : null,
            },
          };
          this.settledPositions.push(position);
        }
        this.log(
          `  Restored ${this.settledPositions.length} settled positions`,
        );
      }

      this.updateStats();
      this.log(
        `Loaded ${this.positions.size} open positions, ${this.settledPositions.length} settled`,
      );
    } catch (err) {
      this.log(`Failed to load positions: ${err}`, "ERROR");
      this.stats.errors++;
    }
  }

  /**
   * Clear all positions (for testing)
   */
  clearAllPositions(): void {
    this.positions.clear();
    this.settledPositions = [];
    this.updateStats();
    this.log("Cleared all positions");

    // Also clear persisted file
    if (fs.existsSync(this.positionsFilePath)) {
      try {
        fs.unlinkSync(this.positionsFilePath);
      } catch {}
    }
  }

  /**
   * Update statistics
   */
  private updateStats(): void {
    let totalSplitCost = 0;
    let totalSoldRevenue = 0;
    let totalSettlementRevenue = 0;

    // From open positions
    const allOpenPositions = Array.from(this.positions.values());
    for (const position of allOpenPositions) {
      totalSplitCost += position.splitCost;
      totalSoldRevenue += position.totalSoldRevenue;
    }

    // From settled positions
    for (const position of this.settledPositions) {
      totalSplitCost += position.splitCost;
      totalSoldRevenue += position.totalSoldRevenue;
      totalSettlementRevenue += position.settlementRevenue;
    }

    this.stats.positionsOpen = this.positions.size;
    this.stats.positionsSettled = this.settledPositions.length;
    this.stats.totalSplitCost = totalSplitCost;
    this.stats.totalSoldRevenue = totalSoldRevenue;
    this.stats.totalSettlementRevenue = totalSettlementRevenue;
  }

  /**
   * Log current statistics
   */
  private logStats(): void {
    const pnl = this.getPnLSummary();
    this.log(
      `[STATS] open=${this.stats.positionsOpen}, ` +
        `settled=${this.stats.positionsSettled}, ` +
        `totalPnL=$${pnl.totalPnL.toFixed(2)}, ` +
        `winRate=${pnl.winRate.toFixed(1)}%, ` +
        `errors=${this.stats.errors}`,
    );
  }
}

// Export types
export type {
  SportsPosition as SportsPositionInfo,
  PositionOutcome as SportsPositionOutcome,
  PnLSummary as SportsPnLSummary,
  PositionStateChange as SportsPositionStateChange,
};
