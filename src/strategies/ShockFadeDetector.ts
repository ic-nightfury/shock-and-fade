/**
 * ShockFadeDetector - Detects in-game price shocks on Polymarket sports markets.
 *
 * Consumes real-time OrderBookWebSocket events and detects shocks via:
 * 1. Rolling 60s window of mid-price changes per token
 * 2. Z-score detection: price moves > N standard deviations
 * 3. Absolute move detection: price moves > X cents as backup
 *
 * After shock, monitors free league APIs for game event confirmation (10-20s later).
 * Classifies shocks as: single_event (fadeable), scoring_run (don't fade), structural (don't fade).
 */

import { EventEmitter } from "events";
import {
  OrderBookWebSocket,
  PriceUpdateEvent,
} from "../services/OrderBookWS";

// ============================================================================
// TYPES & INTERFACES
// ============================================================================

export interface ShockEvent {
  type: "shock";
  tokenId: string;
  marketSlug: string;
  direction: "up" | "down";
  magnitude: number; // absolute price change
  zScore: number; // standard deviations from mean
  preShockPrice: number; // price before the shock
  currentPrice: number; // price at shock detection
  timestamp: number;
  classification?: ShockClassification;
  getMarket(marketSlug: string): SportsMarket | undefined {
    return this.markets.get(marketSlug);
  }

}

export type ShockClassification =
  | "single_event" // Fadeable — one goal/basket, likely to revert
  | "scoring_run" // Don't fade — 3+ unanswered, momentum
  | "structural" // Don't fade — injury, ejection, etc.
  | "unclassified"; // Pending API confirmation

export interface ShockFadeConfig {
  sigmaThreshold: number; // default 3.0
  minAbsoluteMove: number; // default 0.03 (3¢)
  rollingWindowMs: number; // default 60000 (60s)
  ladderLevels: number; // default 3
  ladderSpacing: number; // default 0.01 (1¢ between levels)
  fadeTargetCents: number; // default 3 (take profit at 3¢ reversion)
  fadeWindowMs: number; // default 120000 (cancel after 2min)
  maxPositionSize: number; // default 100 (USDC per level)
  cooldownMs: number; // default 30000 (30s between shocks on same market)
  targetPriceRange: [number, number]; // default [0.07, 0.91]
  getMarket(marketSlug: string): SportsMarket | undefined {
    return this.markets.get(marketSlug);
  }

}

/** Internal price tick stored in rolling window */
interface PriceTick {
  mid: number;
  timestamp: number;
  getMarket(marketSlug: string): SportsMarket | undefined {
    return this.markets.get(marketSlug);
  }

}

/** Per-token tracking state */
interface TokenState {
  ticks: PriceTick[];
  lastShockTs: number;
  marketSlug: string;
  getMarket(marketSlug: string): SportsMarket | undefined {
    return this.markets.get(marketSlug);
  }

}

// ============================================================================
// DEFAULT CONFIG
// ============================================================================

export const DEFAULT_SHOCK_FADE_CONFIG: ShockFadeConfig = {
  sigmaThreshold: 3.0,
  minAbsoluteMove: 0.03,
  rollingWindowMs: 60000,
  ladderLevels: 3,
  ladderSpacing: 0.01,
  fadeTargetCents: 3,
  fadeWindowMs: 120000,
  maxPositionSize: 100,
  cooldownMs: 30000,
  targetPriceRange: [0.07, 0.91],
};

// ============================================================================
// SHOCK FADE DETECTOR
// ============================================================================

export class ShockFadeDetector extends EventEmitter {
  private config: ShockFadeConfig;
  private tokenStates: Map<string, TokenState> = new Map();
  private ws: OrderBookWebSocket;
  private shockLog: ShockEvent[] = [];

  // Mapping token → market slug
  private tokenToMarket: Map<string, string> = new Map();

  constructor(ws: OrderBookWebSocket, config: Partial<ShockFadeConfig> = {}) {
    super();
    this.ws = ws;
    this.config = { ...DEFAULT_SHOCK_FADE_CONFIG, ...config };
  }

  // ============================================================================
  // LIFECYCLE
  // ============================================================================

  /**
   * Start listening for price updates from the WebSocket.
   */
  start(): void {
    this.ws.on("priceUpdate", (event: PriceUpdateEvent) =>
      this.handlePriceUpdate(event),
    );
    this.log("ShockFadeDetector started");
    this.log(
      `  σ threshold: ${this.config.sigmaThreshold}, min absolute: ${(this.config.minAbsoluteMove * 100).toFixed(0)}¢`,
    );
    this.log(
      `  rolling window: ${this.config.rollingWindowMs / 1000}s, cooldown: ${this.config.cooldownMs / 1000}s`,
    );
    this.log(
      `  target price range: [${this.config.targetPriceRange[0]}, ${this.config.targetPriceRange[1]}]`,
    );
  }

  /**
   * Register a token with its market slug for tracking.
   */
  /**
   * Hot-reload config. Only updates detection parameters (sigma, minMove, priceRange, cooldown).
   * Returns list of changed fields for logging.
   */
  updateConfig(patch: Partial<ShockFadeConfig>): string[] {
    const changes: string[] = [];
    const fields: (keyof ShockFadeConfig)[] = [
      "sigmaThreshold", "minAbsoluteMove", "cooldownMs",
      "rollingWindowMs", "ladderSpacing", "fadeTargetCents",
      "ladderLevels", "fadeWindowMs", "maxPositionSize",
    ];
    for (const key of fields) {
      if (patch[key] !== undefined && patch[key] !== this.config[key]) {
        changes.push(`${key}: ${this.config[key]} → ${patch[key]}`);
        (this.config as any)[key] = patch[key];
      }
    }
    // Special handling for targetPriceRange (tuple)
    if (patch.targetPriceRange) {
      const [oldMin, oldMax] = this.config.targetPriceRange;
      const [newMin, newMax] = patch.targetPriceRange;
      if (oldMin !== newMin || oldMax !== newMax) {
        changes.push(`targetPriceRange: [${oldMin},${oldMax}] → [${newMin},${newMax}]`);
        this.config.targetPriceRange = patch.targetPriceRange;
      }
    }
    return changes;
  }

  registerToken(tokenId: string, marketSlug: string): void {
    this.tokenToMarket.set(tokenId, marketSlug);
    if (!this.tokenStates.has(tokenId)) {
      this.tokenStates.set(tokenId, {
        ticks: [],
        lastShockTs: 0,
        marketSlug,
      });
    }
  }

  /**
   * Register multiple tokens for a market.
   */
  registerMarketTokens(tokenIds: string[], marketSlug: string): void {
    for (const tokenId of tokenIds) {
      this.registerToken(tokenId, marketSlug);
    }
  }

  /**
   * Check if a market is already registered for shock detection.
   */
  hasMarket(marketSlug: string): boolean {
    for (const slug of this.tokenToMarket.values()) {
      if (slug === marketSlug) return true;
    }
    return false;
  }

  // ============================================================================
  // PRICE UPDATE HANDLER
  // ============================================================================

  // Market-level dedup: only emit one shock per market per cooldown window
  private lastMarketShockTs: Map<string, number> = new Map();

  private handlePriceUpdate(event: PriceUpdateEvent): void {
    const { tokenId, bid, ask, timestamp } = event;

    // Only track registered tokens
    if (!this.tokenToMarket.has(tokenId)) return;

    const marketSlug = this.tokenToMarket.get(tokenId)!;
    const mid = (bid + ask) / 2;

    // Skip zero/invalid prices
    if (mid <= 0 || bid <= 0 || ask <= 0) return;

    // Skip prices outside target range (per MoltQuant)
    // This filters NOISE on extreme-priced tokens. The actual sell-price filter
    // is in ShockFadeLive (checks sell token price against range before placing orders).
    if (
      mid < this.config.targetPriceRange[0] ||
      mid > this.config.targetPriceRange[1]
    ) {
      return;
    }

    // Get or create token state
    let state = this.tokenStates.get(tokenId);
    if (!state) {
      state = { ticks: [], lastShockTs: 0, marketSlug };
      this.tokenStates.set(tokenId, state);
    }

    // Add tick to rolling window
    state.ticks.push({ mid, timestamp });

    // Prune old ticks outside window
    const windowStart = timestamp - this.config.rollingWindowMs;
    state.ticks = state.ticks.filter((t) => t.timestamp >= windowStart);

    // Need at least 5 ticks to calculate meaningful stats
    if (state.ticks.length < 5) return;

    // Calculate rolling statistics
    const returns = this.calculateReturns(state.ticks);
    if (returns.length < 3) return;

    const { mean, stddev } = this.calculateStats(returns);

    // Latest return
    const latestReturn = returns[returns.length - 1];
    const zScore = stddev > 0 ? (latestReturn - mean) / stddev : 0;

    // Pre-shock price (tick before latest)
    const preShockPrice = state.ticks[state.ticks.length - 2].mid;
    const currentPrice = mid;
    const absoluteMove = Math.abs(currentPrice - preShockPrice);

    // Check for shock conditions
    const isZScoreShock = Math.abs(zScore) >= this.config.sigmaThreshold;
    const isAbsoluteShock = absoluteMove >= this.config.minAbsoluteMove;

    if (!isZScoreShock && !isAbsoluteShock) return;

    // Check cooldown
    const timeSinceLastShock = timestamp - state.lastShockTs;
    if (timeSinceLastShock < this.config.cooldownMs) return;

    // Shock detected!
    state.lastShockTs = timestamp;

    // Market-level dedup: skip if same market already shocked within cooldown
    const lastMarketShock = this.lastMarketShockTs.get(marketSlug) || 0;
    if (timestamp - lastMarketShock < this.config.cooldownMs) return;
    this.lastMarketShockTs.set(marketSlug, timestamp);

    const direction: "up" | "down" = currentPrice > preShockPrice ? "up" : "down";

    const shockEvent: ShockEvent = {
      type: "shock",
      tokenId,
      marketSlug,
      direction,
      magnitude: absoluteMove,
      zScore: Math.abs(zScore),
      preShockPrice,
      currentPrice,
      timestamp,
      classification: "unclassified",
    };

    this.shockLog.push(shockEvent);

    // Keep last 500 shocks
    if (this.shockLog.length > 500) {
      this.shockLog = this.shockLog.slice(-250);
    }

    this.log(
      `⚡ SHOCK DETECTED: ${marketSlug} ${direction.toUpperCase()} ` +
        `${(absoluteMove * 100).toFixed(1)}¢ (z=${Math.abs(zScore).toFixed(1)}σ) ` +
        `${(preShockPrice * 100).toFixed(0)}¢ → ${(currentPrice * 100).toFixed(0)}¢`,
    );

    // Emit shock event
    this.emit("shock", shockEvent);
  }

  // ============================================================================
  // CLASSIFICATION (called externally after API confirmation)
  // ============================================================================

  /**
   * Classify a shock after game event confirmation from league APIs.
   * Returns the classification and updates the shock event.
   */
  classifyShock(
    shockEvent: ShockEvent,
    recentEvents: number, // how many scoring events in last 2 minutes
    isStructural: boolean, // injury, ejection, etc.
  ): ShockClassification {
    let classification: ShockClassification;

    if (isStructural) {
      classification = "structural";
    } else if (recentEvents >= 3) {
      classification = "scoring_run";
    } else {
      classification = "single_event";
    }

    shockEvent.classification = classification;

    this.log(
      `📋 Shock classified: ${shockEvent.marketSlug} → ${classification} ` +
        `(${recentEvents} events, structural=${isStructural})`,
    );

    this.emit("shockClassified", { shock: shockEvent, classification });

    return classification;
  }

  // ============================================================================
  // STATISTICS HELPERS
  // ============================================================================

  /**
   * Calculate returns (price changes) from tick array.
   */
  private calculateReturns(ticks: PriceTick[]): number[] {
    const returns: number[] = [];
    for (let i = 1; i < ticks.length; i++) {
      returns.push(ticks[i].mid - ticks[i - 1].mid);
    }
    return returns;
  }

  /**
   * Calculate mean and standard deviation of an array.
   */
  private calculateStats(values: number[]): { mean: number; stddev: number } {
    if (values.length === 0) return { mean: 0, stddev: 0 };

    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const variance =
      values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length;
    const stddev = Math.sqrt(variance);

    return { mean, stddev };
  }

  // ============================================================================
  // QUERIES
  // ============================================================================

  getShockLog(): ShockEvent[] {
    return [...this.shockLog];
  }

  getRecentShocks(windowMs: number = 300000): ShockEvent[] {
    const cutoff = Date.now() - windowMs;
    return this.shockLog.filter((s) => s.timestamp >= cutoff);
  }

  getTokenState(tokenId: string): TokenState | undefined {
    return this.tokenStates.get(tokenId);
  }

  getTrackedTokenCount(): number {
    return this.tokenStates.size;
  }

  getConfig(): ShockFadeConfig {
    return { ...this.config };
  }

  /**
   * Reset cooldown for a market — call when a shock is SKIPPED (no trade placed).
   * Allows the detector to fire again immediately on the next price move,
   * instead of waiting 30s for a shock we didn't even trade.
   */
  resetCooldown(marketSlug: string): void {
    this.lastMarketShockTs.delete(marketSlug);
    // Also reset per-token cooldowns for this market's tokens
    for (const [tokenId, state] of this.tokenStates.entries()) {
      if (state.marketSlug === marketSlug) {
        state.lastShockTs = 0;
      }
    }
  }

  // ============================================================================
  // LOGGING
  // ============================================================================

  private log(message: string): void {
    const ts = new Date().toISOString();
    console.log(`${ts} [INFO] ⚡ [ShockDetector] ${message}`);
  }
  getMarket(marketSlug: string): SportsMarket | undefined {
    return this.markets.get(marketSlug);
  }

}
