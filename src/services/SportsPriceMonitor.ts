/**
 * Sports Price Monitor Service
 *
 * Monitors real-time prices for sports markets and detects trading triggers.
 * Uses WebSocket connection to Polymarket CLOB for low-latency price updates.
 *
 * Features:
 * - Connects to Polymarket WebSocket for price updates
 * - Tracks YES/NO prices for each monitored market
 * - Detects sell trigger: when one side drops below sport-specific threshold
 * - Detects game end: when one side reaches 99c+ (US-810)
 * - Detects stop loss trigger (if enabled)
 * - Emits events: priceUpdate, sellTrigger, gameEnded, stopLossTrigger
 * - Handles WebSocket reconnection gracefully
 * - Supports monitoring 50+ markets concurrently
 *
 * Usage:
 *   const monitor = new SportsPriceMonitor();
 *   monitor.on('priceUpdate', (update) => { ... });
 *   monitor.on('sellTrigger', (trigger) => { ... });
 *   monitor.on('gameEnded', (event) => { ... });  // US-810
 *   monitor.on('stopLossTrigger', (trigger) => { ... });
 *   await monitor.start();
 *   await monitor.addMarket(market);
 */

import { EventEmitter } from "events";
import axios from "axios";
import {
  OrderBookWebSocket,
  PriceUpdateEvent,
  TradeEvent,
  OrderBookData,
} from "./OrderBookWS";
import { SportsMarket, SportConfig } from "./SportsMarketDiscovery";
import { RateLimiter, EndpointCategory } from "./RateLimiter";
import * as fs from "fs";
import * as path from "path";

// Configuration
const CONFIG_PATH = path.join(
  __dirname,
  "..",
  "config",
  "sss_sport_params.json",
);

// Default thresholds if config not available
const DEFAULT_SELL_THRESHOLD = 0.25;
const DEFAULT_STOP_LOSS_THRESHOLD: number | null = null; // No stop-loss by default (RQ-004 finding)

// Game end detection threshold (US-810)
// When either side's BID reaches 99c+, the game has effectively ended
const GAME_END_PRICE_THRESHOLD = 0.99;

// CLOB API for fresh price validation
const CLOB_API = process.env.POLYMARKET_HOST || "https://clob.polymarket.com";

// US-815: Fresh price validation configuration
const ENABLE_FRESH_PRICE_VALIDATION = true; // Toggle for fresh price validation
const FRESH_PRICE_MISMATCH_THRESHOLD = 0.05; // Log if price differs by more than 5c
const MAX_FRESH_PRICE_CALLS_PER_SECOND = 10; // Rate limit for fresh price calls

/**
 * Price data for a single outcome (YES or NO side)
 */
export interface OutcomePrice {
  tokenId: string;
  outcome: string; // e.g., "Lakers", "Celtics"
  bid: number;
  ask: number;
  lastTradePrice: number;
  lastTradeSize: number;
  lastTradeTime: number;
  timestamp: number;
}

/**
 * Monitored market with price tracking
 */
export interface MonitoredMarket {
  // Market identification
  marketSlug: string;
  sport: string;
  question: string;

  // Token IDs for both outcomes
  outcome1: OutcomePrice;
  outcome2: OutcomePrice;

  // Sport-specific parameters
  sellThreshold: number;
  stopLossThreshold: number | null;

  // Tracking state
  isMonitored: boolean;
  addedAt: Date;
  lastUpdateAt: Date;

  // Trigger detection state
  sellTriggerFired: {
    outcome1: boolean;
    outcome2: boolean;
  };
  stopLossTriggerFired: boolean;

  // US-816: Game end tracking
  gameEnded: boolean; // True when 99c+ detected, before removal from monitoring
  gameEndedAt: Date | null; // Timestamp of game end detection
}

/**
 * Event emitted on every price update
 */
export interface SportsPriceUpdate {
  marketSlug: string;
  sport: string;
  outcome1: OutcomePrice;
  outcome2: OutcomePrice;
  timestamp: number;
}

/**
 * Event emitted when sell threshold is crossed
 */
export interface SellTriggerEvent {
  marketSlug: string;
  sport: string;
  losingOutcome: string;
  losingTokenId: string;
  losingBid: number;
  winningOutcome: string;
  winningTokenId: string;
  winningBid: number;
  sellThreshold: number;
  timestamp: number;
}

/**
 * Event emitted when stop loss threshold is crossed (if enabled)
 */
export interface StopLossTriggerEvent {
  marketSlug: string;
  sport: string;
  outcome: string;
  tokenId: string;
  currentBid: number;
  stopLossThreshold: number;
  timestamp: number;
}

/**
 * Event emitted for significant winner price movements (for analysis only)
 *
 * Per RQ-004: NO STOP-LOSS IS OPTIMAL. This event is for logging/analysis only.
 * The strategy will NOT take any action based on these events.
 * 72% of eventual winners drop below 50c during the game - this is normal.
 */
export interface WinnerPriceLogEvent {
  marketSlug: string;
  sport: string;
  winnerOutcome: string;
  winnerTokenId: string;
  currentBid: number;
  previousBid: number;
  dropFromEntry: number; // How much it has dropped from initial ~50c
  loserSold: boolean; // True if we already sold the losing side
  timestamp: number;
}

/**
 * Event emitted when a game has ended (US-810)
 *
 * A game is considered ended when either side's BID reaches 99c+.
 * This indicates one team has definitively won and the market will soon settle.
 *
 * Actions to take on this event:
 * - If holding BOTH sides (never sold loser): MERGE immediately to recover capital
 * - If holding winner only (already sold loser): Continue holding for settlement/redemption
 */
export interface GameEndedEvent {
  marketSlug: string;
  sport: string;
  winningOutcome: string;
  winningTokenId: string;
  losingOutcome: string;
  losingTokenId: string;
  winnerPrice: number; // The 99c+ price that triggered detection
  loserPrice: number; // The ~1c price of the losing side
  timestamp: number;
}

/**
 * Monitor statistics
 */
export interface PriceMonitorStats {
  marketsMonitored: number;
  tokensSubscribed: number;
  priceUpdatesReceived: number;
  tradesReceived: number;
  sellTriggersEmitted: number;
  stopLossTriggersEmitted: number;
  winnerPriceLogsEmitted: number; // Count of significant winner price drops logged (for analysis)
  gamesEndedDetected: number; // Count of games detected as ended (99c+ price)
  wsConnected: boolean;
  lastPriceUpdateAt: number;
  errors: number;
  // US-815: Fresh price validation stats
  freshPriceCalls: number; // Total fresh price API calls made
  freshPriceMismatches: number; // Times fresh price differed significantly from stored
  freshPriceUpdates: number; // Times stored price was updated with fresh value
}

/**
 * Sports Price Monitor Service
 */
export class SportsPriceMonitor extends EventEmitter {
  private ws: OrderBookWebSocket | null = null;
  private running = false;

  // Market tracking
  private markets: Map<string, MonitoredMarket> = new Map(); // marketSlug -> MonitoredMarket
  private tokenToMarket: Map<string, string> = new Map(); // tokenId -> marketSlug
  private tokenToOutcome: Map<string, 1 | 2> = new Map(); // tokenId -> outcome index (1 or 2)

  // Configuration
  private sportParams: Record<string, SportConfig> = {};
  private globalDefaults: Record<string, any> = {};

  // Stats
  private stats: PriceMonitorStats = {
    marketsMonitored: 0,
    tokensSubscribed: 0,
    priceUpdatesReceived: 0,
    tradesReceived: 0,
    sellTriggersEmitted: 0,
    stopLossTriggersEmitted: 0,
    winnerPriceLogsEmitted: 0,
    gamesEndedDetected: 0,
    wsConnected: false,
    lastPriceUpdateAt: 0,
    errors: 0,
    // US-815: Fresh price validation stats
    freshPriceCalls: 0,
    freshPriceMismatches: 0,
    freshPriceUpdates: 0,
  };

  // Track initial prices for winner drop calculation
  private initialPrices: Map<string, { outcome1: number; outcome2: number }> =
    new Map();

  // Track which markets have sold the loser (for winner price logging context)
  private loserSoldMarkets: Set<string> = new Set();

  // Track which markets have been detected as ended (US-810)
  // Only emit gameEnded once per market to prevent duplicate handling
  private gameEndedMarkets: Set<string> = new Set();

  // US-815: Rate limiter for fresh price calls
  private freshPriceRateLimiter: RateLimiter;
  private lastFreshPriceCallTime: number = 0;
  private freshPriceCallCount: number = 0;
  private freshPriceCallWindowStart: number = 0;

  constructor() {
    super();
    this.loadConfig();
    // Initialize rate limiter for fresh price validation
    // Using clob-market-data category with 10 calls/second limit
    this.freshPriceRateLimiter = new RateLimiter({
      "clob-market-data": {
        maxRequestsPerWindow: 100, // 10/sec * 10 sec window
        windowMs: 10000,
        minIntervalMs: 100, // 10 calls per second max
        maxRetries: 2,
        baseBackoffMs: 500,
      },
    });
  }

  /**
   * Load configuration from sss_sport_params.json
   */
  private loadConfig(): void {
    try {
      if (fs.existsSync(CONFIG_PATH)) {
        const config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
        this.sportParams = config.sports || {};
        this.globalDefaults = config.global_defaults || {};
        this.log(
          `Loaded config: ${Object.keys(this.sportParams).length} sports configured`,
        );
      } else {
        this.log("Config file not found, using defaults", "WARN");
      }
    } catch (err) {
      this.log(`Error loading config: ${err}`, "ERROR");
    }
  }

  /**
   * Get sell threshold for a sport
   */
  private getSellThreshold(sport: string): number {
    const upperSport = sport.toUpperCase();
    const sportConfig = this.sportParams[upperSport];
    if (sportConfig && sportConfig.sell_threshold !== null) {
      return sportConfig.sell_threshold;
    }
    return DEFAULT_SELL_THRESHOLD;
  }

  /**
   * Get stop loss threshold for a sport (null means no stop-loss)
   */
  private getStopLossThreshold(sport: string): number | null {
    // Per RQ-004: No stop-loss is optimal - always return null
    // This is kept configurable for future changes
    return this.globalDefaults.stop_loss ?? DEFAULT_STOP_LOSS_THRESHOLD;
  }

  /**
   * Log helper
   */
  private log(
    message: string,
    level: "INFO" | "WARN" | "ERROR" = "INFO",
  ): void {
    const timestamp = new Date().toISOString();
    const prefix = level === "ERROR" ? "❌" : level === "WARN" ? "⚠️" : "📈";
    console.log(`${timestamp} [${level}] ${prefix} [PriceMonitor] ${message}`);
  }

  /**
   * Start the price monitor service
   */
  async start(): Promise<void> {
    if (this.running) {
      this.log("Price monitor already running", "WARN");
      return;
    }

    this.running = true;
    this.log("=".repeat(60));
    this.log("Starting Sports Price Monitor Service");
    this.log(`Default sell threshold: ${DEFAULT_SELL_THRESHOLD}c`);
    this.log(
      `Stop-loss: ${DEFAULT_STOP_LOSS_THRESHOLD === null ? "DISABLED (RQ-004)" : DEFAULT_STOP_LOSS_THRESHOLD + "c"}`,
    );
    this.log("=".repeat(60));

    // WebSocket will be created when first market is added
    this.log("Price monitor started (waiting for markets to monitor)");
  }

  /**
   * Stop the price monitor service
   */
  stop(): void {
    this.running = false;

    if (this.ws) {
      this.ws.disconnect();
      this.ws = null;
    }

    this.stats.wsConnected = false;

    this.log("=".repeat(60));
    this.log("Price monitor stopped");
    this.logStats();
    this.log("=".repeat(60));
  }

  /**
   * Add a market to monitor
   */
  async addMarket(market: SportsMarket): Promise<boolean> {
    if (!this.running) {
      this.log("Cannot add market - monitor not running", "ERROR");
      return false;
    }

    if (this.markets.has(market.marketSlug)) {
      this.log(`Market already monitored: ${market.marketSlug}`, "WARN");
      return false;
    }

    if (market.tokenIds.length < 2) {
      this.log(
        `Invalid market - needs 2 token IDs: ${market.marketSlug}`,
        "ERROR",
      );
      return false;
    }

    // Create monitored market entry
    const sellThreshold = this.getSellThreshold(market.sport);
    const stopLossThreshold = this.getStopLossThreshold(market.sport);

    const monitoredMarket: MonitoredMarket = {
      marketSlug: market.marketSlug,
      sport: market.sport,
      question: market.question,
      outcome1: {
        tokenId: market.tokenIds[0],
        outcome: market.outcomes[0] || "Outcome 1",
        bid: market.outcomePrices[0] || 0.5,
        ask: market.outcomePrices[0] || 0.5,
        lastTradePrice: 0,
        lastTradeSize: 0,
        lastTradeTime: 0,
        timestamp: Date.now(),
      },
      outcome2: {
        tokenId: market.tokenIds[1],
        outcome: market.outcomes[1] || "Outcome 2",
        bid: market.outcomePrices[1] || 0.5,
        ask: market.outcomePrices[1] || 0.5,
        lastTradePrice: 0,
        lastTradeSize: 0,
        lastTradeTime: 0,
        timestamp: Date.now(),
      },
      sellThreshold,
      stopLossThreshold,
      isMonitored: true,
      addedAt: new Date(),
      lastUpdateAt: new Date(),
      sellTriggerFired: {
        outcome1: false,
        outcome2: false,
      },
      stopLossTriggerFired: false,
      // US-816: Game end tracking
      gameEnded: false,
      gameEndedAt: null,
    };

    // Store mappings
    this.markets.set(market.marketSlug, monitoredMarket);
    this.tokenToMarket.set(market.tokenIds[0], market.marketSlug);
    this.tokenToMarket.set(market.tokenIds[1], market.marketSlug);
    this.tokenToOutcome.set(market.tokenIds[0], 1);
    this.tokenToOutcome.set(market.tokenIds[1], 2);

    // Store initial prices for winner drop analysis
    this.initialPrices.set(market.marketSlug, {
      outcome1: market.outcomePrices[0] || 0.5,
      outcome2: market.outcomePrices[1] || 0.5,
    });

    // Subscribe to WebSocket
    await this.ensureWebSocketSubscription(market.tokenIds);

    this.stats.marketsMonitored = this.markets.size;
    this.stats.tokensSubscribed = this.tokenToMarket.size;

    this.log(
      `Added market: ${market.marketSlug} [${market.sport}] ` +
        `(sell@${(sellThreshold * 100).toFixed(0)}c, ` +
        `tokens: ${market.tokenIds[0].slice(0, 8)}..., ${market.tokenIds[1].slice(0, 8)}...)`,
    );

    // Check if market is already at game end state (99c+ prices from restored positions)
    // This handles the case where positions are loaded from state with 99c+ prices
    // but no WebSocket updates will arrive because the game has already ended
    this.checkGameEnded(monitoredMarket);

    // US-834: Check if market already has a side below sell threshold at add time
    // This handles the case where a position is added with prices already below threshold
    // (e.g., a lopsided market that slipped through entry checks)
    this.checkSellTrigger(monitoredMarket);

    return true;
  }

  /**
   * Remove a market from monitoring
   *
   * US-816: Logs specific message when removing ended games
   */
  removeMarket(marketSlug: string): boolean {
    const market = this.markets.get(marketSlug);
    if (!market) {
      return false;
    }

    // US-816: Check if this is an ended game being removed
    const isEndedGame = market.gameEnded;

    // Remove mappings
    this.tokenToMarket.delete(market.outcome1.tokenId);
    this.tokenToMarket.delete(market.outcome2.tokenId);
    this.tokenToOutcome.delete(market.outcome1.tokenId);
    this.tokenToOutcome.delete(market.outcome2.tokenId);
    this.markets.delete(marketSlug);
    this.initialPrices.delete(marketSlug);
    this.loserSoldMarkets.delete(marketSlug);
    this.gameEndedMarkets.delete(marketSlug);

    this.stats.marketsMonitored = this.markets.size;
    this.stats.tokensSubscribed = this.tokenToMarket.size;

    // US-816: Log appropriate message based on removal reason
    if (isEndedGame) {
      this.log(
        `[PriceMonitor] Removed ended game from monitoring: ${marketSlug}`,
      );
    } else {
      this.log(`Removed market: ${marketSlug}`);
    }
    return true;
  }

  /**
   * Mark that the losing side has been sold for a market
   *
   * This is used for context in winner price drop logging.
   * Per RQ-004/US-202: After selling loser, we HOLD winner until settlement.
   */
  markLoserSold(marketSlug: string): void {
    this.loserSoldMarkets.add(marketSlug);
  }

  /**
   * Check if loser has been sold for a market
   */
  isLoserSold(marketSlug: string): boolean {
    return this.loserSoldMarkets.has(marketSlug);
  }

  /**
   * Ensure WebSocket is connected and tokens are subscribed
   */
  private async ensureWebSocketSubscription(
    newTokenIds: string[],
  ): Promise<void> {
    if (!this.ws) {
      // Create new WebSocket with all current tokens plus new ones
      const allTokenIds = Array.from(this.tokenToMarket.keys());
      for (const tokenId of newTokenIds) {
        if (!allTokenIds.includes(tokenId)) {
          allTokenIds.push(tokenId);
        }
      }

      this.ws = new OrderBookWebSocket(allTokenIds);
      this.setupWebSocketHandlers();
      await this.ws.connect();
      this.stats.wsConnected = true;
      this.log(
        `WebSocket connected, subscribed to ${allTokenIds.length} tokens`,
      );
    } else {
      // Add tokens to existing subscription
      this.ws.addTokens(newTokenIds);
      this.log(`Added ${newTokenIds.length} tokens to WebSocket subscription`);
    }
  }

  /**
   * Setup WebSocket event handlers
   */
  private setupWebSocketHandlers(): void {
    if (!this.ws) return;

    this.ws.on("priceUpdate", (event: PriceUpdateEvent) => {
      this.handlePriceUpdate(event);
    });

    this.ws.on("trade", (event: TradeEvent) => {
      this.handleTrade(event);
    });

    this.ws.on("error", (error: Error) => {
      this.log(`WebSocket error: ${error.message}`, "ERROR");
      this.stats.errors++;
    });
  }

  /**
   * Handle price update from WebSocket
   */
  private handlePriceUpdate(event: PriceUpdateEvent): void {
    const marketSlug = this.tokenToMarket.get(event.tokenId);
    if (!marketSlug) {
      // Token not tracked - could be from full subscription
      return;
    }

    const market = this.markets.get(marketSlug);
    if (!market || !market.isMonitored) {
      return;
    }

    const outcomeIndex = this.tokenToOutcome.get(event.tokenId);
    if (!outcomeIndex) return;

    // Update the appropriate outcome price
    const outcome = outcomeIndex === 1 ? market.outcome1 : market.outcome2;
    outcome.bid = event.bid;
    outcome.ask = event.ask;
    outcome.timestamp = event.timestamp;
    market.lastUpdateAt = new Date();

    this.stats.priceUpdatesReceived++;
    this.stats.lastPriceUpdateAt = Date.now();

    // Emit price update event
    const priceUpdate: SportsPriceUpdate = {
      marketSlug: market.marketSlug,
      sport: market.sport,
      outcome1: { ...market.outcome1 },
      outcome2: { ...market.outcome2 },
      timestamp: Date.now(),
    };
    this.emit("priceUpdate", priceUpdate);

    // Check for triggers
    this.checkSellTrigger(market);
    this.checkStopLossTrigger(market);
    this.checkGameEnded(market);
    this.logWinnerPriceMovement(market, outcomeIndex);
  }

  /**
   * Handle trade event from WebSocket
   */
  private handleTrade(event: TradeEvent): void {
    const marketSlug = this.tokenToMarket.get(event.tokenId);
    if (!marketSlug) return;

    const market = this.markets.get(marketSlug);
    if (!market || !market.isMonitored) return;

    const outcomeIndex = this.tokenToOutcome.get(event.tokenId);
    if (!outcomeIndex) return;

    // Update the appropriate outcome trade data
    const outcome = outcomeIndex === 1 ? market.outcome1 : market.outcome2;
    outcome.lastTradePrice = event.tradePrice;
    outcome.lastTradeSize = event.tradeSize;
    outcome.lastTradeTime = event.timestamp;
    outcome.bid = event.bestBid;
    outcome.ask = event.bestAsk;
    outcome.timestamp = event.timestamp;
    market.lastUpdateAt = new Date();

    this.stats.tradesReceived++;

    // Check for triggers after trade
    this.checkSellTrigger(market);
    this.checkGameEnded(market);
  }

  /**
   * Check if sell trigger should fire
   *
   * Sell trigger fires when one side's BID drops below the sport-specific threshold
   * This indicates that side is losing and should be sold
   */
  private checkSellTrigger(market: MonitoredMarket): void {
    const threshold = market.sellThreshold;

    // Check outcome1
    if (
      !market.sellTriggerFired.outcome1 &&
      market.outcome1.bid < threshold &&
      market.outcome1.bid > 0
    ) {
      market.sellTriggerFired.outcome1 = true;
      this.stats.sellTriggersEmitted++;

      const trigger: SellTriggerEvent = {
        marketSlug: market.marketSlug,
        sport: market.sport,
        losingOutcome: market.outcome1.outcome,
        losingTokenId: market.outcome1.tokenId,
        losingBid: market.outcome1.bid,
        winningOutcome: market.outcome2.outcome,
        winningTokenId: market.outcome2.tokenId,
        winningBid: market.outcome2.bid,
        sellThreshold: threshold,
        timestamp: Date.now(),
      };

      this.log(
        `🔔 SELL TRIGGER: ${market.marketSlug} [${market.sport}] ` +
          `${market.outcome1.outcome} @ ${(market.outcome1.bid * 100).toFixed(1)}c < ${(threshold * 100).toFixed(0)}c`,
      );
      this.emit("sellTrigger", trigger);
    }

    // Check outcome2
    if (
      !market.sellTriggerFired.outcome2 &&
      market.outcome2.bid < threshold &&
      market.outcome2.bid > 0
    ) {
      market.sellTriggerFired.outcome2 = true;
      this.stats.sellTriggersEmitted++;

      const trigger: SellTriggerEvent = {
        marketSlug: market.marketSlug,
        sport: market.sport,
        losingOutcome: market.outcome2.outcome,
        losingTokenId: market.outcome2.tokenId,
        losingBid: market.outcome2.bid,
        winningOutcome: market.outcome1.outcome,
        winningTokenId: market.outcome1.tokenId,
        winningBid: market.outcome1.bid,
        sellThreshold: threshold,
        timestamp: Date.now(),
      };

      this.log(
        `🔔 SELL TRIGGER: ${market.marketSlug} [${market.sport}] ` +
          `${market.outcome2.outcome} @ ${(market.outcome2.bid * 100).toFixed(1)}c < ${(threshold * 100).toFixed(0)}c`,
      );
      this.emit("sellTrigger", trigger);
    }
  }

  /**
   * Check if stop loss trigger should fire (if enabled)
   *
   * Note: Per RQ-004, NO STOP-LOSS IS OPTIMAL. This is kept for completeness
   * but will only fire if stop_loss is explicitly configured in the params.
   */
  private checkStopLossTrigger(market: MonitoredMarket): void {
    const threshold = market.stopLossThreshold;

    // Stop-loss disabled (default per RQ-004)
    if (threshold === null) return;

    // Already fired
    if (market.stopLossTriggerFired) return;

    // Check if BOTH sides are below stop-loss (indicates catastrophic scenario)
    // This would mean neither side is winning
    if (market.outcome1.bid < threshold && market.outcome2.bid < threshold) {
      market.stopLossTriggerFired = true;
      this.stats.stopLossTriggersEmitted++;

      // Emit for the higher-valued side (the "winner" that's dropping)
      const winningOutcome =
        market.outcome1.bid >= market.outcome2.bid
          ? market.outcome1
          : market.outcome2;

      const trigger: StopLossTriggerEvent = {
        marketSlug: market.marketSlug,
        sport: market.sport,
        outcome: winningOutcome.outcome,
        tokenId: winningOutcome.tokenId,
        currentBid: winningOutcome.bid,
        stopLossThreshold: threshold,
        timestamp: Date.now(),
      };

      this.log(
        `🛑 STOP-LOSS TRIGGER: ${market.marketSlug} [${market.sport}] ` +
          `${winningOutcome.outcome} @ ${(winningOutcome.bid * 100).toFixed(1)}c < ${(threshold * 100).toFixed(0)}c`,
        "WARN",
      );
      this.emit("stopLossTrigger", trigger);
    }
  }

  /**
   * Check if game has ended (US-810)
   *
   * Game is considered ended when either side's BID reaches 99c+.
   * Before emitting the event, we fetch fresh prices from CLOB API to confirm
   * (WebSocket data may be stale).
   *
   * Only emits 'gameEnded' once per market (tracked by gameEndedMarkets set).
   */
  private checkGameEnded(market: MonitoredMarket): void {
    // Already detected as ended - skip
    if (this.gameEndedMarkets.has(market.marketSlug)) {
      return;
    }

    // Check if either side has reached 99c+
    const outcome1AtEnd = market.outcome1.bid >= GAME_END_PRICE_THRESHOLD;
    const outcome2AtEnd = market.outcome2.bid >= GAME_END_PRICE_THRESHOLD;

    if (!outcome1AtEnd && !outcome2AtEnd) {
      return;
    }

    // Determine winner and loser
    const winnerOutcome = outcome1AtEnd ? market.outcome1 : market.outcome2;
    const loserOutcome = outcome1AtEnd ? market.outcome2 : market.outcome1;

    // Fetch fresh prices from CLOB API to confirm before emitting
    // This is async but we don't await - we fire and forget to avoid blocking
    // The confirmation will emit the event if validated
    this.confirmAndEmitGameEnded(market, winnerOutcome, loserOutcome);
  }

  /**
   * Fetch fresh prices from CLOB API and emit gameEnded if confirmed (US-810)
   *
   * This prevents false positives from stale WebSocket data by verifying
   * the 99c+ price with a fresh API call before emitting the event.
   */
  private async confirmAndEmitGameEnded(
    market: MonitoredMarket,
    winnerOutcome: OutcomePrice,
    loserOutcome: OutcomePrice,
  ): Promise<void> {
    // Double-check we haven't already processed this (race condition guard)
    if (this.gameEndedMarkets.has(market.marketSlug)) {
      return;
    }

    try {
      // Fetch fresh prices for the winner side
      const freshWinnerPrice = await this.fetchFreshPrice(
        winnerOutcome.tokenId,
      );

      if (!freshWinnerPrice) {
        this.log(
          `[GameEnd] Failed to fetch fresh price for ${market.marketSlug}, skipping confirmation`,
          "WARN",
        );
        return;
      }

      // Verify winner is still at 99c+
      if (freshWinnerPrice.bid < GAME_END_PRICE_THRESHOLD) {
        this.log(
          `[GameEnd] Fresh price ${(freshWinnerPrice.bid * 100).toFixed(1)}c < 99c for ` +
            `${market.marketSlug} - false positive from stale WebSocket data`,
        );
        return;
      }

      // Confirmed! Mark as ended and emit event
      this.gameEndedMarkets.add(market.marketSlug);
      this.stats.gamesEndedDetected++;

      // US-816: Set gameEnded flag on market before removal
      market.gameEnded = true;
      market.gameEndedAt = new Date();

      // Update stored prices with fresh data
      winnerOutcome.bid = freshWinnerPrice.bid;
      winnerOutcome.ask = freshWinnerPrice.ask;

      const event: GameEndedEvent = {
        marketSlug: market.marketSlug,
        sport: market.sport,
        winningOutcome: winnerOutcome.outcome,
        winningTokenId: winnerOutcome.tokenId,
        losingOutcome: loserOutcome.outcome,
        losingTokenId: loserOutcome.tokenId,
        winnerPrice: freshWinnerPrice.bid,
        loserPrice: loserOutcome.bid,
        timestamp: Date.now(),
      };

      this.log(
        `🏁 GAME ENDED: ${market.marketSlug} [${market.sport}] - ` +
          `${winnerOutcome.outcome} wins @ ${(freshWinnerPrice.bid * 100).toFixed(1)}c`,
      );

      this.emit("gameEnded", event);
    } catch (err: any) {
      this.log(
        `[GameEnd] Error confirming game end for ${market.marketSlug}: ${err.message}`,
        "ERROR",
      );
      this.stats.errors++;
    }
  }

  /**
   * US-815: Fetch fresh price from CLOB API
   *
   * Public method to fetch fresh prices before critical actions:
   * - Game end detection (US-810) - confirm 99c+ before emitting
   * - Force Sell execution (US-814) - get accurate sell price
   * - Suspicious 0c prices - validate and correct
   *
   * Features:
   * - Rate limited to MAX_FRESH_PRICE_CALLS_PER_SECOND (10/sec)
   * - Logs when fresh price differs significantly from stored
   * - Optionally updates stored price with fresh value
   *
   * @param tokenId - The token ID to fetch price for
   * @param options - Optional settings for comparison and update
   * @returns { bid, ask } or null if fetch failed
   */
  public async fetchFreshPrice(
    tokenId: string,
    options?: {
      compareToStored?: boolean; // If true, compare with stored price and log mismatch
      updateStored?: boolean; // If true, update stored price with fresh value
      marketSlug?: string; // Required if compareToStored or updateStored is true
      outcomeIndex?: 1 | 2; // Required if compareToStored or updateStored is true
    },
  ): Promise<{ bid: number; ask: number } | null> {
    // Check if fresh price validation is enabled
    if (!ENABLE_FRESH_PRICE_VALIDATION) {
      return null;
    }

    // Rate limiting check (simple in-memory tracking)
    const now = Date.now();
    if (now - this.freshPriceCallWindowStart > 1000) {
      // Reset window
      this.freshPriceCallWindowStart = now;
      this.freshPriceCallCount = 0;
    }

    if (this.freshPriceCallCount >= MAX_FRESH_PRICE_CALLS_PER_SECOND) {
      this.log(
        `[FreshPrice] Rate limit reached (${MAX_FRESH_PRICE_CALLS_PER_SECOND}/sec), skipping call`,
        "WARN",
      );
      return null;
    }

    try {
      // Execute with rate limiter
      const response = await this.freshPriceRateLimiter.execute(
        "clob-market-data",
        () =>
          axios.get(`${CLOB_API}/book?token_id=${tokenId}`, {
            timeout: 5000,
          }),
        `fetchFreshPrice for ${tokenId.slice(0, 8)}...`,
      );

      this.freshPriceCallCount++;
      this.stats.freshPriceCalls++;

      const book = response.data;
      const bids = book.bids || [];
      const asks = book.asks || [];

      // Best bid is last in ascending sorted array
      const bestBid =
        bids.length > 0 ? parseFloat(bids[bids.length - 1].price) : 0;
      // Best ask is first in ascending sorted array
      const bestAsk = asks.length > 0 ? parseFloat(asks[0].price) : 1;

      const freshPrice = { bid: bestBid, ask: bestAsk };

      // US-815: Compare with stored price and log mismatch
      if (
        options?.compareToStored &&
        options.marketSlug &&
        options.outcomeIndex
      ) {
        this.compareAndLogPriceMismatch(
          options.marketSlug,
          options.outcomeIndex,
          freshPrice,
        );
      }

      // US-815: Update stored price with fresh value
      if (options?.updateStored && options.marketSlug && options.outcomeIndex) {
        this.updateStoredPriceWithFresh(
          options.marketSlug,
          options.outcomeIndex,
          freshPrice,
        );
      }

      return freshPrice;
    } catch (err: any) {
      this.log(
        `[FreshPrice] Failed to fetch for token ${tokenId.slice(0, 8)}...: ${err.message}`,
        "ERROR",
      );
      this.stats.errors++;
      return null;
    }
  }

  /**
   * US-815: Compare fresh price with stored price and log if mismatch
   */
  private compareAndLogPriceMismatch(
    marketSlug: string,
    outcomeIndex: 1 | 2,
    freshPrice: { bid: number; ask: number },
  ): void {
    const market = this.markets.get(marketSlug);
    if (!market) return;

    const storedPrice = outcomeIndex === 1 ? market.outcome1 : market.outcome2;
    const storedBid = storedPrice.bid;

    const priceDiff = Math.abs(freshPrice.bid - storedBid);

    if (priceDiff >= FRESH_PRICE_MISMATCH_THRESHOLD) {
      this.stats.freshPriceMismatches++;
      this.log(
        `[PriceMonitor] Price mismatch: stored=${(storedBid * 100).toFixed(1)}c, ` +
          `fresh=${(freshPrice.bid * 100).toFixed(1)}c for ${marketSlug} outcome${outcomeIndex} ` +
          `(diff: ${(priceDiff * 100).toFixed(1)}c)`,
        "WARN",
      );
    }
  }

  /**
   * US-815: Update stored price with fresh value from CLOB API
   */
  private updateStoredPriceWithFresh(
    marketSlug: string,
    outcomeIndex: 1 | 2,
    freshPrice: { bid: number; ask: number },
  ): void {
    const market = this.markets.get(marketSlug);
    if (!market) return;

    const outcome = outcomeIndex === 1 ? market.outcome1 : market.outcome2;

    // Log update
    const oldBid = outcome.bid;
    if (freshPrice.bid !== oldBid) {
      this.stats.freshPriceUpdates++;
      this.log(
        `[FreshPrice] Updated stored price for ${marketSlug} outcome${outcomeIndex}: ` +
          `${(oldBid * 100).toFixed(1)}c → ${(freshPrice.bid * 100).toFixed(1)}c`,
      );
    }

    // Update stored values
    outcome.bid = freshPrice.bid;
    outcome.ask = freshPrice.ask;
    outcome.timestamp = Date.now();
  }

  /**
   * US-815: Validate and potentially fix suspicious prices (0c or very stale)
   *
   * Call this when you suspect the stored price is invalid (e.g., 0c).
   * Fetches fresh price and updates stored value.
   *
   * @param marketSlug - Market to validate
   * @param outcomeIndex - Which outcome to validate (1 or 2)
   * @returns Fresh price if validation was needed and succeeded, null otherwise
   */
  public async validateSuspiciousPrice(
    marketSlug: string,
    outcomeIndex: 1 | 2,
  ): Promise<{ bid: number; ask: number } | null> {
    const market = this.markets.get(marketSlug);
    if (!market) return null;

    const outcome = outcomeIndex === 1 ? market.outcome1 : market.outcome2;

    // Check if price is suspicious (0c or very stale)
    const isSuspicious =
      outcome.bid === 0 ||
      (outcome.timestamp && Date.now() - outcome.timestamp > 60000); // >1 minute stale

    if (!isSuspicious) {
      return null; // Price looks fine, no need to validate
    }

    this.log(
      `[FreshPrice] Validating suspicious price for ${marketSlug} outcome${outcomeIndex}: ` +
        `${(outcome.bid * 100).toFixed(1)}c (age: ${outcome.timestamp ? Math.round((Date.now() - outcome.timestamp) / 1000) : "unknown"}s)`,
    );

    return this.fetchFreshPrice(outcome.tokenId, {
      compareToStored: true,
      updateStored: true,
      marketSlug,
      outcomeIndex,
    });
  }

  /**
   * Log significant winner price movements for analysis (US-202)
   *
   * Per RQ-004: NO STOP-LOSS IS OPTIMAL. This method logs price drops for analysis
   * but the strategy takes NO ACTION. Key findings from RQ-004:
   * - 72% of eventual winners dropped below 50c during the game
   * - 50% dropped below 40c
   * - EV of holding exceeds stop-loss at ALL price levels
   * - Accept 9.1% reversal rate as cost of doing business
   *
   * We log when the winner (higher-priced side) drops significantly so we can:
   * 1. Validate RQ-004 findings in production
   * 2. Track how often winners recover from deep drops
   * 3. Build confidence that holding is the right strategy
   *
   * IMPORTANT: Strategy will NOT react to these events - hold until settlement.
   */
  private logWinnerPriceMovement(
    market: MonitoredMarket,
    updatedOutcomeIndex: 1 | 2,
  ): void {
    // Only log after loser has been sold (we're now holding winner only)
    if (!this.loserSoldMarkets.has(market.marketSlug)) {
      return;
    }

    // Get initial prices
    const initial = this.initialPrices.get(market.marketSlug);
    if (!initial) return;

    // Determine which side is the winner (the one we're still holding)
    // After selling loser, the winner is the side that did NOT trigger sell
    const outcome1Sold = market.sellTriggerFired.outcome1;
    const outcome2Sold = market.sellTriggerFired.outcome2;

    // If neither sold yet, we haven't identified loser
    if (!outcome1Sold && !outcome2Sold) return;

    // Winner is the side that wasn't sold
    const winnerIndex = outcome1Sold ? 2 : 1;
    const winnerOutcome = winnerIndex === 1 ? market.outcome1 : market.outcome2;
    const initialWinnerPrice =
      winnerIndex === 1 ? initial.outcome1 : initial.outcome2;

    // Only log if the updated outcome is the winner (optimization)
    if (updatedOutcomeIndex !== winnerIndex) return;

    // Calculate drop from initial entry price
    const dropFromEntry = initialWinnerPrice - winnerOutcome.bid;
    const dropPercent =
      initialWinnerPrice > 0 ? (dropFromEntry / initialWinnerPrice) * 100 : 0;

    // Log significant drops: > 10% or crossing key thresholds (50c, 40c, 30c)
    const significantDrop = dropPercent > 10;
    const crossedThreshold50 =
      initialWinnerPrice >= 0.5 && winnerOutcome.bid < 0.5;
    const crossedThreshold40 =
      initialWinnerPrice >= 0.4 && winnerOutcome.bid < 0.4;
    const crossedThreshold30 =
      initialWinnerPrice >= 0.3 && winnerOutcome.bid < 0.3;

    // Only emit for significant movements
    if (
      !significantDrop &&
      !crossedThreshold50 &&
      !crossedThreshold40 &&
      !crossedThreshold30
    ) {
      return;
    }

    this.stats.winnerPriceLogsEmitted++;

    const logEvent: WinnerPriceLogEvent = {
      marketSlug: market.marketSlug,
      sport: market.sport,
      winnerOutcome: winnerOutcome.outcome,
      winnerTokenId: winnerOutcome.tokenId,
      currentBid: winnerOutcome.bid,
      previousBid: initialWinnerPrice,
      dropFromEntry,
      loserSold: true,
      timestamp: Date.now(),
    };

    // Log for analysis - note we take NO ACTION per RQ-004/US-202
    this.log(
      `📊 [ANALYSIS] WINNER DROP: ${market.marketSlug} [${market.sport}] ` +
        `${winnerOutcome.outcome} ${(initialWinnerPrice * 100).toFixed(1)}c → ${(winnerOutcome.bid * 100).toFixed(1)}c ` +
        `(${dropPercent.toFixed(1)}% drop) - HOLDING per RQ-004`,
    );

    // Emit event for external analysis/dashboard (NO ACTION TAKEN)
    this.emit("winnerPriceLog", logEvent);
  }

  /**
   * Reset trigger states for a market (e.g., after handling the trigger)
   */
  resetTriggers(marketSlug: string): void {
    const market = this.markets.get(marketSlug);
    if (market) {
      market.sellTriggerFired = {
        outcome1: false,
        outcome2: false,
      };
      market.stopLossTriggerFired = false;
      this.log(`Reset triggers for: ${marketSlug}`);
    }
  }

  /**
   * Get current price data for a market
   */
  getMarketPrices(marketSlug: string): MonitoredMarket | null {
    return this.markets.get(marketSlug) || null;
  }

  /**
   * Get all monitored markets
   */
  getAllMarkets(): MonitoredMarket[] {
    return Array.from(this.markets.values());
  }

  /**
   * Get markets by sport
   */
  getMarketsBySport(sport: string): MonitoredMarket[] {
    const upperSport = sport.toUpperCase();
    return Array.from(this.markets.values()).filter(
      (m) => m.sport.toUpperCase() === upperSport,
    );
  }

  /**
   * Get order book for a token (from WebSocket)
   */
  getOrderBook(tokenId: string): OrderBookData | null {
    if (!this.ws) return null;
    return this.ws.getOrderBook(tokenId);
  }

  /**
   * Get best bid for a token
   */
  getBestBid(tokenId: string): number {
    if (!this.ws) return 0;
    return this.ws.getBestBid(tokenId);
  }

  /**
   * Get best ask for a token
   */
  getBestAsk(tokenId: string): number {
    if (!this.ws) return 0;
    return this.ws.getBestAsk(tokenId);
  }

  /**
   * Check if WebSocket is connected
   */
  isConnected(): boolean {
    return this.ws !== null && this.ws.isConnected();
  }

  /**
   * Check if monitor is running
   */
  isRunning(): boolean {
    return this.running;
  }

  /**
   * Get monitor statistics
   */
  getStats(): PriceMonitorStats {
    return {
      ...this.stats,
      wsConnected: this.isConnected(),
    };
  }

  /**
   * Log current statistics
   */
  private logStats(): void {
    this.log(
      `[STATS] markets=${this.stats.marketsMonitored}, ` +
        `tokens=${this.stats.tokensSubscribed}, ` +
        `price_updates=${this.stats.priceUpdatesReceived}, ` +
        `trades=${this.stats.tradesReceived}, ` +
        `sell_triggers=${this.stats.sellTriggersEmitted}, ` +
        `stop_loss_triggers=${this.stats.stopLossTriggersEmitted}, ` +
        `winner_price_logs=${this.stats.winnerPriceLogsEmitted}, ` +
        `games_ended=${this.stats.gamesEndedDetected}, ` +
        `errors=${this.stats.errors}, ` +
        `ws_connected=${this.isConnected()}`,
    );
  }

  /**
   * Check if a market has been detected as ended
   */
  isGameEnded(marketSlug: string): boolean {
    return this.gameEndedMarkets.has(marketSlug);
  }
}

// Export types
export type {
  MonitoredMarket as MonitoredSportsMarket,
  SportsPriceUpdate as SportsPriceUpdateEvent,
  SellTriggerEvent as SportsSellTriggerEvent,
  StopLossTriggerEvent as SportsStopLossTriggerEvent,
  WinnerPriceLogEvent as SportsWinnerPriceLogEvent,
  GameEndedEvent as SportsGameEndedEvent,
};
