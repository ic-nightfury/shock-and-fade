/**
 * UserChannelWS.ts — Real-time user-channel WebSocket for order fill detection.
 *
 * Connects to Polymarket's user WebSocket channel to receive:
 *   - Trade messages (order fills) → emits "orderFill"
 *   - Order messages (placements/cancellations) → emits "orderUpdate"
 *
 * Replaces the 5s polling approach with sub-second fill detection.
 * Handles reconnection with exponential backoff and ping/pong keepalive.
 */

import WebSocket from "ws";
import { EventEmitter } from "events";

// ============================================================================
// TYPES
// ============================================================================

export interface OrderFillEvent {
  orderId: string;
  price: number;
  size: number;
  status: string;      // MATCHED | MINED | CONFIRMED | RETRYING | FAILED
  tradeId: string;
  market: string;      // conditionId
  assetId: string;     // tokenId
  side: string;        // BUY | SELL
}

export interface OrderUpdateEvent {
  orderId: string;
  type: string;        // PLACEMENT | UPDATE | CANCELLATION
  sizeMatched: number;
  originalSize: number;
  price: number;
  market: string;      // conditionId
  assetId: string;     // tokenId
  side: string;
}

export interface UserChannelAuth {
  apiKey: string;
  secret: string;
  passphrase: string;
}

// ============================================================================
// USER CHANNEL WEBSOCKET
// ============================================================================

export class UserChannelWS extends EventEmitter {
  private ws: WebSocket | null = null;
  private auth: UserChannelAuth;
  private subscribedMarkets: Set<string> = new Set();  // conditionIds
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 50;
  private pingInterval: NodeJS.Timeout | null = null;
  private disposed = false;
  private lastDataReceived: number = 0;
  private reconnectCount: number = 0;
  private startedAt: number = Date.now();
  private disconnectedAt: number = 0;
  private connected = false;

  private static readonly WS_URL = "wss://ws-subscriptions-clob.polymarket.com/ws/user";
  private static readonly PING_INTERVAL_MS = 30_000;
  private static readonly STALE_TIMEOUT_MS = 90_000;  // longer than market WS since user channel is less chatty

  constructor(auth: UserChannelAuth) {
    super();
    this.auth = auth;
  }

  // ============================================================================
  // LIFECYCLE
  // ============================================================================

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.disposed) {
        reject(new Error("UserChannelWS is disposed"));
        return;
      }

      try {
        this.ws = new WebSocket(UserChannelWS.WS_URL);

        this.ws.on("open", () => {
          const now = Date.now();

          if (this.disconnectedAt > 0) {
            this.reconnectCount++;
            const gapMs = now - this.disconnectedAt;
            this.log(`Reconnected (reconnect #${this.reconnectCount}, gap ${(gapMs / 1000).toFixed(1)}s)`);
            this.disconnectedAt = 0;
          } else {
            this.log("Connected to Polymarket user channel");
          }

          this.reconnectAttempts = 0;
          this.lastDataReceived = now;
          this.connected = true;

          // Send initial subscription with auth
          this.sendInitialSubscription();

          // Setup ping/keepalive
          this.pingInterval = setInterval(() => {
            if (this.ws && this.ws.readyState === WebSocket.OPEN) {
              const now = Date.now();
              if (
                this.lastDataReceived > 0 &&
                now - this.lastDataReceived > UserChannelWS.STALE_TIMEOUT_MS
              ) {
                this.log(`Stale connection (no data for ${UserChannelWS.STALE_TIMEOUT_MS / 1000}s), reconnecting...`);
                this.ws.close();
                return;
              }
              this.ws.ping();
            }
          }, UserChannelWS.PING_INTERVAL_MS);

          resolve();
        });

        this.ws.on("message", (data: Buffer) => {
          try {
            const text = data.toString();
            // Skip non-JSON messages
            if (!text.startsWith("{") && !text.startsWith("[")) {
              return;
            }
            const message = JSON.parse(text);
            this.lastDataReceived = Date.now();
            this.handleMessage(message);
          } catch (error) {
            this.log(`Error parsing message: ${error}`);
          }
        });

        this.ws.on("pong", () => {
          this.lastDataReceived = Date.now();
        });

        this.ws.on("error", (error) => {
          this.log(`WebSocket error: ${error.message}`);
          if (!this.connected) {
            reject(error);
          }
        });

        this.ws.on("close", (code, reason) => {
          this.connected = false;
          this.log(`Connection closed (code: ${code}, reason: ${reason?.toString() || "none"})`);
          if (this.disconnectedAt === 0) {
            this.disconnectedAt = Date.now();
          }
          this.clearPingInterval();
          this.reconnect();
        });
      } catch (error) {
        reject(error);
      }
    });
  }

  disconnect(): void {
    this.disposed = true;
    this.clearPingInterval();
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.connected = false;
    this.subscribedMarkets.clear();
    this.log("Disconnected");
  }

  // ============================================================================
  // SUBSCRIPTION MANAGEMENT
  // ============================================================================

  /**
   * Subscribe to user events for the given condition IDs.
   * Can be called before or after connect — if before, they'll be included
   * in the initial subscription message.
   */
  subscribe(conditionIds: string[]): void {
    const newIds: string[] = [];
    for (const id of conditionIds) {
      if (!this.subscribedMarkets.has(id)) {
        this.subscribedMarkets.add(id);
        newIds.push(id);
      }
    }

    if (newIds.length === 0) return;

    // If already connected, send a dynamic subscribe message
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      const msg = {
        assets_ids: [],
        markets: newIds,
        operation: "subscribe",
      };
      this.ws.send(JSON.stringify(msg));
      this.log(`Subscribed to ${newIds.length} markets (total: ${this.subscribedMarkets.size})`);
    } else {
      this.log(`Queued ${newIds.length} markets for subscription (total: ${this.subscribedMarkets.size})`);
    }
  }

  /**
   * Unsubscribe from user events for the given condition IDs.
   */
  unsubscribe(conditionIds: string[]): void {
    const removed: string[] = [];
    for (const id of conditionIds) {
      if (this.subscribedMarkets.delete(id)) {
        removed.push(id);
      }
    }

    if (removed.length === 0) return;

    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      const msg = {
        assets_ids: [],
        markets: removed,
        operation: "unsubscribe",
      };
      this.ws.send(JSON.stringify(msg));
      this.log(`Unsubscribed from ${removed.length} markets (total: ${this.subscribedMarkets.size})`);
    }
  }

  // ============================================================================
  // MESSAGE HANDLING
  // ============================================================================

  private handleMessage(message: any): void {
    // Handle arrays of messages
    if (Array.isArray(message)) {
      for (const msg of message) {
        this.handleMessage(msg);
      }
      return;
    }

    const eventType = message.event_type;

    if (eventType === "trade") {
      this.handleTradeMessage(message);
    } else if (eventType === "order") {
      this.handleOrderMessage(message);
    }
    // Silently ignore other message types (connection acks, etc.)
  }

  private handleTradeMessage(msg: any): void {
    const tradeId = msg.id || "";
    const market = msg.market || "";
    const assetId = msg.asset_id || "";
    const side = msg.side || "";
    const status = msg.status || "";
    const tradePrice = parseFloat(msg.price || "0");
    const tradeSize = parseFloat(msg.size || "0");

    // Emit for each maker order in the trade (our fills)
    const makerOrders = msg.maker_orders || [];
    for (const maker of makerOrders) {
      const fillEvent: OrderFillEvent = {
        orderId: maker.order_id || "",
        price: parseFloat(maker.price || msg.price || "0"),
        size: parseFloat(maker.matched_amount || msg.size || "0"),
        status,
        tradeId,
        market,
        assetId: maker.asset_id || assetId,
        side,
      };

      this.log(
        `Trade: orderId=${fillEvent.orderId.slice(0, 10)}… ` +
        `${fillEvent.size}sh @ ${(fillEvent.price * 100).toFixed(1)}¢ ` +
        `status=${status} [${market.slice(0, 10)}…]`
      );

      this.emit("orderFill", fillEvent);
    }

    // Also emit the taker order if present (we might be the taker)
    if (msg.taker_order_id) {
      const takerFill: OrderFillEvent = {
        orderId: msg.taker_order_id,
        price: tradePrice,
        size: tradeSize,
        status,
        tradeId,
        market,
        assetId,
        side,
      };
      this.emit("orderFill", takerFill);
    }
  }

  private handleOrderMessage(msg: any): void {
    const updateEvent: OrderUpdateEvent = {
      orderId: msg.id || "",
      type: msg.type || "",         // PLACEMENT | UPDATE | CANCELLATION
      sizeMatched: parseFloat(msg.size_matched || "0"),
      originalSize: parseFloat(msg.original_size || "0"),
      price: parseFloat(msg.price || "0"),
      market: msg.market || "",
      assetId: msg.asset_id || "",
      side: msg.side || "",
    };

    this.log(
      `Order: ${updateEvent.type} orderId=${updateEvent.orderId.slice(0, 10)}… ` +
      `matched=${updateEvent.sizeMatched}/${updateEvent.originalSize} ` +
      `@ ${(updateEvent.price * 100).toFixed(1)}¢ [${updateEvent.market.slice(0, 10)}…]`
    );

    this.emit("orderUpdate", updateEvent);
  }

  // ============================================================================
  // INTERNAL
  // ============================================================================

  private sendInitialSubscription(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    const markets = Array.from(this.subscribedMarkets);
    const msg = {
      type: "user",
      auth: {
        apiKey: this.auth.apiKey,
        secret: this.auth.secret,
        passphrase: this.auth.passphrase,
      },
      markets,
    };

    this.ws.send(JSON.stringify(msg));
    this.log(`Sent auth + subscribed to ${markets.length} markets`);
  }

  private clearPingInterval(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }

  private reconnect(): void {
    if (this.disposed) return;

    if (this.reconnectAttempts < this.maxReconnectAttempts) {
      this.reconnectAttempts++;
      // Exponential backoff: 2s, 4s, 8s, 16s, capped at 60s
      const delay = Math.min(2000 * Math.pow(2, this.reconnectAttempts - 1), 60_000);
      this.log(`Reconnecting in ${(delay / 1000).toFixed(0)}s... (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`);
      setTimeout(() => this.connect().catch(err => {
        this.log(`Reconnect failed: ${err?.message || err}`);
      }), delay);
    } else {
      // Never give up — keep retrying forever with 60s cooldown
      this.log(`Max reconnect attempts (${this.maxReconnectAttempts}) exhausted — infinite retry mode (60s cooldown)`);
      this.reconnectAttempts = 0;
      setTimeout(() => this.connect().catch(err => {
        this.log(`Reconnect failed: ${err?.message || err}`);
      }), 60_000);
    }
  }

  // ============================================================================
  // QUERIES
  // ============================================================================

  isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  getSubscribedMarkets(): string[] {
    return Array.from(this.subscribedMarkets);
  }

  getStats(): {
    connected: boolean;
    reconnectCount: number;
    lastDataTs: number;
    uptimeMs: number;
    subscribedMarkets: number;
  } {
    return {
      connected: this.isConnected(),
      reconnectCount: this.reconnectCount,
      lastDataTs: this.lastDataReceived,
      uptimeMs: Date.now() - this.startedAt,
      subscribedMarkets: this.subscribedMarkets.size,
    };
  }

  forceReconnect(): void {
    this.log("Force reconnect requested");
    if (this.disconnectedAt === 0) {
      this.disconnectedAt = Date.now();
    }
    if (this.ws) {
      this.ws.close();
    }
  }

  // ============================================================================
  // LOGGING
  // ============================================================================

  private log(msg: string): void {
    const ts = new Date().toISOString();
    console.log(`${ts} [INFO] 📡 [UserChannelWS] ${msg}`);
  }
}
