/**
 * DashboardRelay - WebSocket CLIENT that connects to dashboard backend
 *
 * This singleton class connects to the dashboard backend's /bot WebSocket endpoint
 * and sends order lifecycle events from trading strategies (ASSV2_Live, simulations).
 *
 * The dashboard backend relays these events to connected dashboard frontends.
 *
 * Events:
 * - ORDER_PLACED: New limit order placed
 * - ORDER_FILLED: Order fully filled
 * - ORDER_PARTIAL: Partial fill
 * - ORDER_CANCELLED: Order cancelled
 * - POSITION_UPDATE: Position quantities changed
 * - MARKET_SWITCH: New 15-min market started
 * - PRICE_UPDATE: Bid/ask prices updated
 * - LOG_MESSAGE: Log message for dashboard display
 */

import { WebSocket } from "ws";

// =============================================================================
// Types
// =============================================================================

export type OrderEventType =
  | "ORDER_PLACED"
  | "ORDER_FILLED"
  | "ORDER_PARTIAL"
  | "ORDER_CANCELLED";

export type EventType =
  | OrderEventType
  | "POSITION_UPDATE"
  | "MARKET_SWITCH"
  | "PRICE_UPDATE"
  | "MERGE"
  | "SURGE_LINE"
  | "HEDGE_LINE"
  | "CONNECTION_STATUS"
  | "LOG_MESSAGE";

export interface OrderEventData {
  orderId: string;
  side: "UP" | "DOWN";
  price: number;
  size: number;
  filledSize?: number;
  remaining?: number;
  orderType: "trigger" | "hedge" | "accumulation" | "zone";
  setId: string;
  label?: string;
  timestamp: number;
}

export interface PositionEventData {
  upQty: number;
  downQty: number;
  upAvg: number;
  downAvg: number;
  pairCost: number;
  hedgedPairs: number;
  totalPnL: number;
  balance: number;
  initialBalance: number;
  windowCount: number;
  windowMergedPairs: number;
  windowMergeProfit: number;
  windowAvgPairCost: number;
  // US-434: Sales tracking metrics
  upSold: number; // Total UP shares sold (filled) in current window
  downSold: number; // Total DOWN shares sold (filled) in current window
  upRevenue: number; // Total revenue from UP sales
  downRevenue: number; // Total revenue from DOWN sales
  timestamp: number;
}

export interface MergeEventData {
  pairs: number;
  profit: number;
  timestamp: number;
}

export interface SurgeLineEventData {
  side: "UP" | "DOWN";
  supplyPrice: number;
  entryPrice: number;
  active: boolean;
  timestamp: number;
}

export interface HedgeLineEventData {
  side: "UP" | "DOWN";
  price: number;
  size: number;
  active: boolean;
  timestamp: number;
}

export interface MarketEventData {
  slug: string;
  conditionId: string;
  endTime: number;
  upTokenId: string;
  downTokenId: string;
  timestamp: number;
}

export interface PriceEventData {
  upBid: number;
  upAsk: number;
  downBid: number;
  downAsk: number;
  timestamp: number;
}

export type LogLevel = "info" | "warn" | "error" | "success" | "debug";

export interface LogEventData {
  message: string;
  level: LogLevel;
  timestamp: number;
}

export interface DashboardEvent {
  type: EventType;
  data:
    | OrderEventData
    | PositionEventData
    | MarketEventData
    | PriceEventData
    | MergeEventData
    | SurgeLineEventData
    | HedgeLineEventData
    | LogEventData
    | { connected: boolean; clientCount: number };
}

// =============================================================================
// DashboardRelay Class - WebSocket CLIENT
// =============================================================================

class DashboardRelay {
  private ws: WebSocket | null = null;
  private isRunning: boolean = false;
  private isConnecting: boolean = false;
  private reconnectTimeout: NodeJS.Timeout | null = null;
  private pingInterval: NodeJS.Timeout | null = null;

  // Dashboard backend URL (can be overridden via env)
  private dashboardUrl: string =
    process.env.DASHBOARD_URL || "ws://localhost:3001/bot";

  // Queue messages while disconnected
  private messageQueue: string[] = [];
  private maxQueueSize: number = 100;

  // Cache latest state for reconnection resync
  private latestMarket: MarketEventData | null = null;
  private latestPosition: PositionEventData | null = null;
  private latestPrices: PriceEventData | null = null;
  private latestSurgeLine: SurgeLineEventData | null = null;
  private latestHedgeLine: HedgeLineEventData | null = null;
  private pendingOrders: Map<string, OrderEventData> = new Map();

  constructor() {
    // Singleton
  }

  /**
   * Start the WebSocket client - connect to dashboard backend
   */
  start(): void {
    if (this.isRunning || this.isConnecting) {
      console.log(`[DashboardRelay] Already running/connecting`);
      return;
    }

    this.isRunning = true;
    this.connect();
  }

  /**
   * Connect to dashboard backend
   */
  private connect(): void {
    if (this.isConnecting) return;
    this.isConnecting = true;

    console.log(`[DashboardRelay] Connecting to ${this.dashboardUrl}`);

    try {
      this.ws = new WebSocket(this.dashboardUrl);

      this.ws.on("open", () => {
        this.isConnecting = false;
        console.log(`[DashboardRelay] Connected to dashboard backend`);

        // Register as a bot (sender)
        this.ws!.send(JSON.stringify({ type: "BOT_REGISTER" }));

        // Send cached state to resync
        this.resyncState();

        // Flush queued messages
        this.flushQueue();

        // Start ping interval
        this.startPingInterval();
      });

      this.ws.on("message", (data) => {
        try {
          const message = JSON.parse(data.toString());
          // Handle pong from server
          if (message.type === "pong") {
            // Connection is alive
          }
        } catch {
          // Ignore parse errors
        }
      });

      this.ws.on("close", () => {
        this.isConnecting = false;
        console.log(`[DashboardRelay] Disconnected from dashboard backend`);
        this.stopPingInterval();
        this.scheduleReconnect();
      });

      this.ws.on("error", (error) => {
        this.isConnecting = false;
        console.error(`[DashboardRelay] WebSocket error:`, error.message);
        // Connection will close, triggering reconnect
      });
    } catch (error) {
      this.isConnecting = false;
      console.error(`[DashboardRelay] Failed to connect:`, error);
      this.scheduleReconnect();
    }
  }

  /**
   * Schedule reconnection attempt
   */
  private scheduleReconnect(): void {
    if (!this.isRunning) return;

    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
    }

    this.reconnectTimeout = setTimeout(() => {
      if (this.isRunning) {
        this.connect();
      }
    }, 3000); // Reconnect after 3 seconds
  }

  /**
   * Start ping interval to keep connection alive
   */
  private startPingInterval(): void {
    this.stopPingInterval();
    this.pingInterval = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: "ping", timestamp: Date.now() }));
      }
    }, 30000);
  }

  /**
   * Stop ping interval
   */
  private stopPingInterval(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }

  /**
   * Resync cached state after reconnection
   */
  private resyncState(): void {
    // Send market info
    if (this.latestMarket) {
      this.send({ type: "MARKET_SWITCH", data: this.latestMarket });
    }

    // Send pending orders
    for (const order of this.pendingOrders.values()) {
      this.send({ type: "ORDER_PLACED", data: order });
    }

    // Send position
    if (this.latestPosition) {
      this.send({ type: "POSITION_UPDATE", data: this.latestPosition });
    }

    // Send surge line
    if (this.latestSurgeLine?.active) {
      this.send({ type: "SURGE_LINE", data: this.latestSurgeLine });
    }

    // Send hedge line
    if (this.latestHedgeLine?.active) {
      this.send({ type: "HEDGE_LINE", data: this.latestHedgeLine });
    }
  }

  /**
   * Flush queued messages
   */
  private flushQueue(): void {
    while (
      this.messageQueue.length > 0 &&
      this.ws?.readyState === WebSocket.OPEN
    ) {
      const message = this.messageQueue.shift();
      if (message) {
        this.ws.send(message);
      }
    }
  }

  /**
   * Stop the WebSocket client
   */
  stop(): void {
    this.isRunning = false;

    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }

    this.stopPingInterval();

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }

    this.messageQueue = [];
    console.log(`[DashboardRelay] Stopped`);
  }

  /**
   * Send event to dashboard backend
   */
  private send(event: DashboardEvent): void {
    const message = JSON.stringify(event);

    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(message);
    } else {
      // Queue message for when connection is restored
      if (this.messageQueue.length < this.maxQueueSize) {
        this.messageQueue.push(message);
      }
    }
  }

  // Alias for backward compatibility
  broadcast(event: DashboardEvent): void {
    this.send(event);
  }

  // ============================================================
  // ORDER EVENTS
  // ============================================================

  /**
   * Emit when a new order is placed
   */
  orderPlaced(
    orderId: string,
    side: "UP" | "DOWN",
    price: number,
    size: number,
    orderType: "trigger" | "hedge" | "accumulation" | "zone",
    setId: string,
    label?: string,
  ): void {
    const data: OrderEventData = {
      orderId,
      side,
      price,
      size,
      orderType,
      setId,
      label,
      timestamp: Date.now(),
    };
    this.pendingOrders.set(orderId.toLowerCase(), data);
    this.send({ type: "ORDER_PLACED", data });
  }

  /**
   * Emit when an order is fully filled
   */
  orderFilled(
    orderId: string,
    side: "UP" | "DOWN",
    price: number,
    filledSize: number,
  ): void {
    const key = orderId.toLowerCase();
    const existing = this.pendingOrders.get(key);
    const data: OrderEventData = {
      orderId,
      side,
      price,
      size: existing?.size || filledSize,
      filledSize,
      remaining: 0,
      orderType: existing?.orderType || "trigger",
      setId: existing?.setId || "",
      timestamp: Date.now(),
    };
    this.pendingOrders.delete(key);
    this.send({ type: "ORDER_FILLED", data });
  }

  /**
   * Emit when an order is partially filled
   */
  orderPartial(
    orderId: string,
    side: "UP" | "DOWN",
    price: number,
    filledSize: number,
    remaining: number,
  ): void {
    const existing = this.pendingOrders.get(orderId.toLowerCase());
    const data: OrderEventData = {
      orderId,
      side,
      price,
      size: existing?.size || filledSize + remaining,
      filledSize,
      remaining,
      orderType: existing?.orderType || "trigger",
      setId: existing?.setId || "",
      timestamp: Date.now(),
    };
    // Update cached order with new remaining
    if (existing) {
      existing.remaining = remaining;
    }
    this.send({ type: "ORDER_PARTIAL", data });
  }

  /**
   * Emit when an order is cancelled
   */
  orderCancelled(orderId: string, side: "UP" | "DOWN", price: number): void {
    const existing = this.pendingOrders.get(orderId.toLowerCase());
    const data: OrderEventData = {
      orderId,
      side,
      price,
      size: existing?.size || 0,
      orderType: existing?.orderType || "trigger",
      setId: existing?.setId || "",
      timestamp: Date.now(),
    };
    this.pendingOrders.delete(orderId.toLowerCase());
    this.send({ type: "ORDER_CANCELLED", data });
  }

  // ============================================================
  // POSITION EVENTS
  // ============================================================

  /**
   * Emit position update
   */
  positionUpdate(
    upQty: number,
    downQty: number,
    upAvg: number,
    downAvg: number,
    pairCost: number,
    hedgedPairs: number,
    totalPnL: number = 0,
    balance: number = 0,
    initialBalance: number = 1000,
    windowCount: number = 0,
    windowMergedPairs: number = 0,
    windowMergeProfit: number = 0,
    windowAvgPairCost: number = 0,
    // US-434: Sales tracking metrics
    upSold: number = 0,
    downSold: number = 0,
    upRevenue: number = 0,
    downRevenue: number = 0,
  ): void {
    const data: PositionEventData = {
      upQty,
      downQty,
      upAvg,
      downAvg,
      pairCost,
      hedgedPairs,
      totalPnL,
      balance,
      initialBalance,
      windowCount,
      windowMergedPairs,
      windowMergeProfit,
      windowAvgPairCost,
      // US-434: Sales tracking metrics
      upSold,
      downSold,
      upRevenue,
      downRevenue,
      timestamp: Date.now(),
    };
    this.latestPosition = data;
    this.send({ type: "POSITION_UPDATE", data });
  }

  /**
   * Emit merge event
   */
  merge(pairs: number, profit: number): void {
    const data: MergeEventData = {
      pairs,
      profit,
      timestamp: Date.now(),
    };
    this.send({ type: "MERGE", data });
  }

  /**
   * Emit surge line (supply line when surge is detected)
   */
  surgeLine(
    side: "UP" | "DOWN",
    supplyPrice: number,
    entryPrice: number,
    active: boolean = true,
  ): void {
    const data: SurgeLineEventData = {
      side,
      supplyPrice,
      entryPrice,
      active,
      timestamp: Date.now(),
    };
    this.latestSurgeLine = data;
    this.send({ type: "SURGE_LINE", data });
  }

  /**
   * Clear surge line (when surge ends or market switches)
   */
  clearSurgeLine(): void {
    if (this.latestSurgeLine) {
      this.latestSurgeLine.active = false;
      this.send({ type: "SURGE_LINE", data: this.latestSurgeLine });
      this.latestSurgeLine = null;
    }
  }

  /**
   * Emit hedge line (horizontal line showing hedge order price)
   */
  hedgeLine(
    side: "UP" | "DOWN",
    price: number,
    size: number,
    active: boolean = true,
  ): void {
    const data: HedgeLineEventData = {
      side,
      price,
      size,
      active,
      timestamp: Date.now(),
    };
    this.latestHedgeLine = data;
    this.send({ type: "HEDGE_LINE", data });
  }

  /**
   * Clear hedge line (when hedge fills or market switches)
   */
  clearHedgeLine(): void {
    if (this.latestHedgeLine) {
      this.latestHedgeLine.active = false;
      this.send({ type: "HEDGE_LINE", data: this.latestHedgeLine });
      this.latestHedgeLine = null;
    }
  }

  // ============================================================
  // MARKET EVENTS
  // ============================================================

  /**
   * Emit market switch (new 15-min window)
   */
  marketSwitch(
    slug: string,
    conditionId: string,
    endTime: number,
    upTokenId: string,
    downTokenId: string,
  ): void {
    // Clear pending orders, surge line, and hedge line on market switch
    this.pendingOrders.clear();
    this.latestSurgeLine = null;
    this.latestHedgeLine = null;

    const data: MarketEventData = {
      slug,
      conditionId,
      endTime,
      upTokenId,
      downTokenId,
      timestamp: Date.now(),
    };
    this.latestMarket = data;
    this.send({ type: "MARKET_SWITCH", data });
  }

  /**
   * Emit price update
   */
  priceUpdate(
    upBid: number,
    upAsk: number,
    downBid: number,
    downAsk: number,
  ): void {
    const data: PriceEventData = {
      upBid,
      upAsk,
      downBid,
      downAsk,
      timestamp: Date.now(),
    };
    this.latestPrices = data;
    this.send({ type: "PRICE_UPDATE", data });
  }

  // ============================================================
  // LOG EVENTS
  // ============================================================

  /**
   * Emit a log message to dashboard
   */
  log(message: string, level: LogLevel = "info"): void {
    const data: LogEventData = {
      message,
      level,
      timestamp: Date.now(),
    };
    this.send({ type: "LOG_MESSAGE", data });
  }

  /**
   * Convenience methods for different log levels
   */
  logInfo(message: string): void {
    this.log(message, "info");
  }

  logWarn(message: string): void {
    this.log(message, "warn");
  }

  logError(message: string): void {
    this.log(message, "error");
  }

  logSuccess(message: string): void {
    this.log(message, "success");
  }

  logDebug(message: string): void {
    this.log(message, "debug");
  }

  // ============================================================
  // UTILITIES
  // ============================================================

  /**
   * Check if client is connected
   */
  isActive(): boolean {
    return this.isRunning && this.ws?.readyState === WebSocket.OPEN;
  }

  /**
   * Get connection status
   */
  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  /**
   * Get pending orders for debugging
   */
  getPendingOrders(): OrderEventData[] {
    return Array.from(this.pendingOrders.values());
  }

  /**
   * Get number of queued messages
   */
  getQueuedMessageCount(): number {
    return this.messageQueue.length;
  }
}

// Singleton instance
export const dashboardRelay = new DashboardRelay();
