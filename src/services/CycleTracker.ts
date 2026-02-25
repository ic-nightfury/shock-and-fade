/**
 * CycleTracker - V22 Cycle State Management Service
 *
 * Centralized tracking of:
 * - Per-cycle position (UP/DOWN quantities and costs)
 * - Initial accumulation price constraint
 * - Lock target (for FAK lock execution)
 *
 * V22 CHANGE: Lock orders now use FAK instead of GTC
 * - Store lock target (side, shares, price) instead of tracking GTC fills
 * - Execute FAK at target price or lower
 * - Retry with remaining gap if partial fill
 *
 * Key Invariant: Accumulation only allowed when price <= initialAccumPrice
 */

import { Side } from '../types';

// Get max pair cost from environment (default 0.98)
function getMaxPairCost(): number {
  return parseFloat(process.env.PAIR_COST_TARGET || '0.98');
}

export interface AccumulationEntry {
  side: Side;
  price: number;
  shares: number;
  timestamp: number;
}

// V22: Simplified lock target for FAK execution (replaces GTC LockOrderState)
export interface LockTarget {
  side: Side;
  targetShares: number;  // How many shares we need to lock
  targetPrice: number;   // Maximum price we're willing to pay
}

// Legacy: Keep for backward compatibility during transition
export interface LockOrderState {
  orderId: string;
  side: Side;
  shares: number;
  price: number;
  filledShares: number;
  filledCost: number;
}

export interface CycleState {
  cycleNumber: number;

  // Position tracking (per-cycle, NOT total position)
  upQty: number;
  upCost: number;
  downQty: number;
  downCost: number;

  // Initial price constraint
  // First accumulation sets this as ceiling for subsequent buys
  initialAccumPrice: number | null;
  initialAccumSide: Side | null;

  // Active accumulation side (for lock calculations)
  activeAccumSide: Side | null;

  // V22: Lock target for FAK execution
  lockTarget: LockTarget | null;

  // Legacy: Lock order tracking (kept for backward compatibility)
  lockOrder: LockOrderState | null;

  // Accumulation history
  accumulations: AccumulationEntry[];

  // Flags
  isLocked: boolean;
  awaitingLock: boolean;  // Block accumulates until lock fills
}

export class CycleTracker {
  private state: CycleState;
  private testMode: boolean;

  // Callbacks for external notifications
  private onLockComplete?: () => void;
  private onLockPartialFill?: (remaining: number) => void;

  constructor() {
    this.state = this.createInitialState();
    this.testMode = process.env.TESTBUY === 'true';
  }

  // ============================================================
  // LIFECYCLE
  // ============================================================

  private createInitialState(): CycleState {
    return {
      cycleNumber: 1,
      upQty: 0,
      upCost: 0,
      downQty: 0,
      downCost: 0,
      initialAccumPrice: null,
      initialAccumSide: null,
      activeAccumSide: null,
      lockTarget: null,  // V22: FAK lock target
      lockOrder: null,   // Legacy
      accumulations: [],
      isLocked: false,
      awaitingLock: false,
    };
  }

  /**
   * Reset all state for a new market
   */
  resetCycle(): void {
    this.state = this.createInitialState();
  }

  /**
   * Start a new cycle after profit lock
   * Called when a cycle completes (min(UP, DOWN) > totalCost)
   */
  startNewCycle(): void {
    const prevCycle = this.state.cycleNumber;
    this.state = {
      ...this.createInitialState(),
      cycleNumber: prevCycle + 1,
    };
  }

  /**
   * Set callbacks for lock events
   */
  setCallbacks(callbacks: {
    onLockComplete?: () => void;
    onLockPartialFill?: (remaining: number) => void;
  }): void {
    this.onLockComplete = callbacks.onLockComplete;
    this.onLockPartialFill = callbacks.onLockPartialFill;
  }

  // ============================================================
  // RECORDING
  // ============================================================

  /**
   * Record an accumulation (buy) to the cycle
   * On FIRST accumulation, sets the initialAccumPrice ceiling
   */
  recordAccumulation(side: Side, price: number, shares: number): void {
    // V14: Round to 2 decimals for consistent precision
    const roundedShares = Math.round(shares * 100) / 100;
    const cost = roundedShares * price;

    // Update position
    if (side === 'UP') {
      this.state.upQty += roundedShares;
      this.state.upCost += cost;
    } else {
      this.state.downQty += roundedShares;
      this.state.downCost += cost;
    }

    // Set active accumulation side
    this.state.activeAccumSide = side;

    // On FIRST accumulation, set the initial price ceiling
    if (this.state.initialAccumPrice === null) {
      this.state.initialAccumPrice = price;
      this.state.initialAccumSide = side;
    }

    // Record to history
    this.state.accumulations.push({
      side,
      price,
      shares: roundedShares,
      timestamp: Date.now(),
    });
  }

  /**
   * Record a lock fill (partial or full)
   * Called when WSS reports a MATCHED event for the lock order
   */
  recordLockFill(shares: number, price: number): void {
    if (!this.state.lockOrder) {
      console.warn(`⚠️ [CycleTracker] Lock fill received but no lock order pending`);
      return;
    }

    // V14: Round to 2 decimals for consistent precision
    const roundedShares = Math.round(shares * 100) / 100;
    const cost = roundedShares * price;
    const lockSide = this.state.lockOrder.side;

    // Update lock order state
    this.state.lockOrder.filledShares += roundedShares;
    this.state.lockOrder.filledCost += cost;

    // Update position
    if (lockSide === 'UP') {
      this.state.upQty += roundedShares;
      this.state.upCost += cost;
    } else {
      this.state.downQty += roundedShares;
      this.state.downCost += cost;
    }

    // Record to accumulations
    this.state.accumulations.push({
      side: lockSide,
      price,
      shares: roundedShares,
      timestamp: Date.now(),
    });

    const remaining = this.state.lockOrder.shares - this.state.lockOrder.filledShares;

    // Check if lock is complete
    // V14: Apply 1-share tolerance to prevent recursion from tolerance handler
    // If remaining < 1, consider it complete (don't call partial handler again)
    if (remaining < 1) {
      this.handleLockFullFill();
    } else {
      this.handleLockPartialFill(remaining);
    }
  }

  // ============================================================
  // LOCK MANAGEMENT
  // ============================================================

  /**
   * Register a new GTC lock order
   * Called after placing the order, before it fills
   */
  setLockOrder(orderId: string, side: Side, shares: number, price: number): void {
    this.state.lockOrder = {
      orderId,
      side,
      shares,
      price,
      filledShares: 0,
      filledCost: 0,
    };
    this.state.awaitingLock = true;
  }

  /**
   * Update the pending lock order (e.g., after cancel and re-place)
   */
  updateLockOrder(orderId: string, shares: number, price: number): void {
    if (!this.state.lockOrder) {
      console.warn(`⚠️ [CycleTracker] Cannot update lock - no order pending`);
      return;
    }
    this.state.lockOrder.orderId = orderId;
    this.state.lockOrder.shares = shares;
    this.state.lockOrder.price = price;
  }

  /**
   * Handle partial lock fill
   * Returns remaining shares needed
   */
  private handleLockPartialFill(remaining: number): void {
    // Notify callback
    if (this.onLockPartialFill) {
      this.onLockPartialFill(remaining);
    }
  }

  /**
   * Handle full lock fill - cycle is now locked!
   */
  private handleLockFullFill(): void {
    this.state.isLocked = true;
    this.state.awaitingLock = false;

    // Clear lock order state
    this.state.lockOrder = null;

    // Notify callback
    if (this.onLockComplete) {
      this.onLockComplete();
    }

    this.logState();
  }

  /**
   * Clear lock order (e.g., on cancel)
   */
  clearLockOrder(): void {
    this.state.lockOrder = null;
    this.state.awaitingLock = false;
  }

  // ============================================================
  // V22: FAK LOCK TARGET MANAGEMENT
  // ============================================================

  /**
   * V22: Set lock target for FAK execution
   * Called after accumulation to store target for immediate FAK lock
   */
  setLockTarget(side: Side, shares: number, price: number): void {
    this.state.lockTarget = {
      side,
      targetShares: shares,
      targetPrice: price,
    };
    this.state.awaitingLock = true;
  }

  /**
   * V22: Get current lock target
   * Returns null if no lock target is set
   */
  getLockTarget(): LockTarget | null {
    return this.state.lockTarget;
  }

  /**
   * V22: Update lock target with remaining shares after partial fill
   */
  updateLockTarget(remainingShares: number): void {
    if (!this.state.lockTarget) {
      console.warn(`⚠️ [CycleTracker] Cannot update lock target - none set`);
      return;
    }
    this.state.lockTarget.targetShares = remainingShares;
  }

  /**
   * V22: Clear lock target (on full fill or cancel)
   */
  clearLockTarget(): void {
    this.state.lockTarget = null;
    this.state.awaitingLock = false;
  }

  /**
   * V22: Check if we have a pending lock target
   */
  hasLockTarget(): boolean {
    return this.state.lockTarget !== null;
  }

  /**
   * V22: Record FAK lock fill and update position
   * Simpler than GTC - just records the fill, no incremental tracking
   */
  recordLockFAKFill(side: Side, shares: number, price: number): void {
    // V14: Round to 2 decimals for consistent precision
    const roundedShares = Math.round(shares * 100) / 100;
    const cost = roundedShares * price;

    // Update position
    if (side === 'UP') {
      this.state.upQty += roundedShares;
      this.state.upCost += cost;
    } else {
      this.state.downQty += roundedShares;
      this.state.downCost += cost;
    }

    // Record to accumulations
    this.state.accumulations.push({
      side,
      price,
      shares: roundedShares,
      timestamp: Date.now(),
    });
  }

  /**
   * V22: Handle lock completion (called after FAK lock fills)
   */
  handleLockComplete(): void {
    this.state.isLocked = true;
    this.state.awaitingLock = false;
    this.state.lockTarget = null;
    this.state.lockOrder = null;  // Clear legacy too

    // Notify callback
    if (this.onLockComplete) {
      this.onLockComplete();
    }

    this.logState();
  }

  // ============================================================
  // QUERIES
  // ============================================================

  /**
   * Check if accumulation is allowed at the given price
   * Returns false if price > initialAccumPrice (ceiling constraint)
   *
   * Note: Post-flip blocking is handled by awaitingFlipLock in BilateralStrategyV6
   */
  canAccumulate(currentPrice: number): boolean {
    // If no initial price yet, allow accumulation
    if (this.state.initialAccumPrice === null) {
      return true;
    }

    // Price must be <= initial price (ceiling)
    // Allow accumulation while awaiting lock, as long as price is good
    return currentPrice <= this.state.initialAccumPrice;
  }

  /**
   * Get the gap between active side and opposite side
   * This is how many shares we need to buy on opposite side to balance
   */
  getLockGap(): number {
    if (!this.state.activeAccumSide) {
      return 0;
    }

    const activeQty = this.state.activeAccumSide === 'UP'
      ? this.state.upQty
      : this.state.downQty;
    const oppositeQty = this.state.activeAccumSide === 'UP'
      ? this.state.downQty
      : this.state.upQty;

    return Math.max(0, activeQty - oppositeQty);
  }

  /**
   * Calculate the lock price based on active side's average price
   * Lock price = maxPairCost - avgActivePrice
   */
  calculateLockPrice(): number {
    if (!this.state.activeAccumSide) {
      return 0;
    }

    const activeQty = this.state.activeAccumSide === 'UP'
      ? this.state.upQty
      : this.state.downQty;
    const activeCost = this.state.activeAccumSide === 'UP'
      ? this.state.upCost
      : this.state.downCost;

    if (activeQty === 0) {
      return 0;
    }

    const avgActivePrice = activeCost / activeQty;
    const lockPrice = getMaxPairCost() - avgActivePrice;

    return Math.max(0.01, lockPrice);  // Minimum lock price
  }

  /**
   * Check if position is balanced (locked)
   * min(UP, DOWN) >= max(UP, DOWN)
   */
  isBalanced(): boolean {
    return Math.min(this.state.upQty, this.state.downQty) >=
           Math.max(this.state.upQty, this.state.downQty);
  }

  /**
   * Check if position is imbalanced (has gap that needs locking)
   * Returns true if activeQty > oppositeQty
   */
  isImbalanced(): boolean {
    if (!this.state.activeAccumSide) {
      return false;  // No position yet
    }

    const activeQty = this.state.activeAccumSide === 'UP'
      ? this.state.upQty
      : this.state.downQty;
    const oppositeQty = this.state.activeAccumSide === 'UP'
      ? this.state.downQty
      : this.state.upQty;

    return activeQty > oppositeQty;
  }

  /**
   * Check if a lock is needed (imbalanced AND not already handling it)
   * This is the main check for imbalance monitoring.
   *
   * Returns true if:
   * - Position is imbalanced (activeQty > oppositeQty)
   * - NOT already awaiting a lock fill
   * - NOT already locked
   *
   * The strategy should call this periodically and execute a lock if true.
   */
  needsLock(): boolean {
    // Already locked or waiting for lock - no action needed
    if (this.state.isLocked || this.state.awaitingLock) {
      return false;
    }

    // Check if there's an imbalance to lock
    return this.isImbalanced();
  }

  /**
   * Check if we're in an orphaned state - imbalanced with no lock order tracked
   * Used by periodic monitor to detect missing lock orders
   *
   * Returns true if:
   * - Position is imbalanced
   * - NOT locked and NOT awaiting lock
   * - No pending lock order ID tracked
   */
  isOrphaned(): boolean {
    if (this.state.isLocked || this.state.awaitingLock) {
      return false;
    }
    if (!this.isImbalanced()) {
      return false;
    }
    // Truly orphaned if we don't have a pending lock order
    return !this.state.lockOrder;
  }

  /**
   * Get lock parameters for recovery lock
   * Returns null if no lock needed
   */
  getLockParams(): { side: Side; gap: number; price: number } | null {
    if (!this.needsLock()) {
      return null;
    }

    const lockSide = this.getLockSide();
    if (!lockSide) {
      return null;
    }

    const gap = this.getLockGap();
    if (gap <= 0) {
      return null;
    }

    const price = this.calculateLockPrice();
    if (price <= 0.01) {
      return null;
    }

    return {
      side: lockSide,
      gap: Math.max(5, gap),  // Polymarket minimum is 5, use exact gap (fractional supported)
      price,
    };
  }

  // ============================================================
  // V19: LOCK ORDER STATE GETTERS (for reconciliation)
  // ============================================================

  /**
   * Get the filled shares count for current lock order
   * Used by V19 reconciliation to detect missed WSS fills
   */
  getLockFilledShares(): number {
    return this.state.lockOrder?.filledShares || 0;
  }

  /**
   * Get the original order size for current lock order
   * Used by V19 reconciliation to calculate missed fills
   */
  getLockOrderShares(): number {
    return this.state.lockOrder?.shares || 0;
  }

  /**
   * Get the lock order price
   * Used by V19 reconciliation to record missed fills at correct price
   */
  getLockOrderPrice(): number {
    return this.state.lockOrder?.price || 0;
  }

  /**
   * Check if profit is locked
   * min(UP, DOWN) > totalCost
   */
  isProfitLocked(): boolean {
    const hedged = Math.min(this.state.upQty, this.state.downQty);
    const totalCost = this.state.upCost + this.state.downCost;
    return hedged > totalCost;
  }

  /**
   * Get guaranteed profit
   * hedged - totalCost
   */
  getProfit(): number {
    const hedged = Math.min(this.state.upQty, this.state.downQty);
    const totalCost = this.state.upCost + this.state.downCost;
    return hedged - totalCost;
  }

  /**
   * Get the pair cost (totalCost / hedged)
   */
  getPairCost(): number {
    const hedged = Math.min(this.state.upQty, this.state.downQty);
    if (hedged === 0) return 0;
    const totalCost = this.state.upCost + this.state.downCost;
    return totalCost / hedged;
  }

  /**
   * Get average price for a side
   */
  getAvgPrice(side: Side): number {
    const qty = side === 'UP' ? this.state.upQty : this.state.downQty;
    const cost = side === 'UP' ? this.state.upCost : this.state.downCost;
    return qty > 0 ? cost / qty : 0;
  }

  /**
   * Get the opposite side of the active accumulation
   */
  getLockSide(): Side | null {
    if (!this.state.activeAccumSide) return null;
    return this.state.activeAccumSide === 'UP' ? 'DOWN' : 'UP';
  }

  /**
   * Get pending lock order ID (for WSS matching)
   */
  getPendingLockOrderId(): string | null {
    return this.state.lockOrder?.orderId || null;
  }

  /**
   * Check if we have a pending lock order
   */
  hasLockPending(): boolean {
    return this.state.lockOrder !== null;
  }

  /**
   * Get full state for external inspection
   */
  getState(): Readonly<CycleState> {
    return { ...this.state };
  }

  /**
   * Get cycle number
   */
  getCycleNumber(): number {
    return this.state.cycleNumber;
  }

  /**
   * Check if awaiting lock fill
   */
  isAwaitingLock(): boolean {
    return this.state.awaitingLock;
  }

  /**
   * Set awaiting lock flag (for flip buy handling)
   */
  setAwaitingLock(value: boolean): void {
    this.state.awaitingLock = value;
  }

  /**
   * Get initial accumulation price ceiling
   */
  getInitialAccumPrice(): number | null {
    return this.state.initialAccumPrice;
  }

  /**
   * Update initial accumulation price (for flippening)
   * When we flip to the new side, we update the ceiling to the new side's price
   */
  updateInitialAccumPrice(price: number, side: Side): void {
    this.state.initialAccumPrice = price;
    this.state.initialAccumSide = side;
  }

  // ============================================================
  // LOGGING
  // ============================================================

  private logState(): void {
    const s = this.state;
    const upAvg = s.upQty > 0 ? (s.upCost / s.upQty).toFixed(4) : '0';
    const downAvg = s.downQty > 0 ? (s.downCost / s.downQty).toFixed(4) : '0';
    const hedged = Math.min(s.upQty, s.downQty);
    const totalCost = s.upCost + s.downCost;
    const pairCost = hedged > 0 ? (totalCost / hedged).toFixed(4) : '0';
    const profit = hedged - totalCost;

    console.log(`   📊 Cycle ${s.cycleNumber}: UP=${s.upQty.toFixed(0)} @$${upAvg} | DOWN=${s.downQty.toFixed(0)} @$${downAvg}`);
    console.log(`   📊 Hedged=${hedged.toFixed(0)} | PairCost=$${pairCost} | Profit=$${profit.toFixed(2)}`);
    if (s.initialAccumPrice !== null) {
      console.log(`   📊 Initial price ceiling: $${s.initialAccumPrice.toFixed(4)} (${s.initialAccumSide})`);
    }
    if (s.lockOrder) {
      const filled = s.lockOrder.filledShares;
      const total = s.lockOrder.shares;
      console.log(`   📊 Lock: ${filled}/${total} ${s.lockOrder.side} @ $${s.lockOrder.price.toFixed(4)}`);
    }
  }

  /**
   * Get status summary string
   */
  getStatusSummary(): string {
    const s = this.state;
    const hedged = Math.min(s.upQty, s.downQty);
    const totalCost = s.upCost + s.downCost;
    const profit = hedged - totalCost;
    return `Cycle ${s.cycleNumber}: UP=${s.upQty.toFixed(0)} DOWN=${s.downQty.toFixed(0)} Profit=$${profit.toFixed(2)}`;
  }
}
