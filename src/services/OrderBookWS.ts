import WebSocket from "ws";
import { EventEmitter } from "events";

export interface OrderBookData {
  bids: Array<{ price: string; size: string }>;
  asks: Array<{ price: string; size: string }>;
  timestamp: number;
}

export interface PriceUpdateEvent {
  tokenId: string;
  bid: number;
  ask: number;
  timestamp: number;
}

export interface TradeEvent {
  tokenId: string;
  tradePrice: number;
  tradeSize: number;
  side: "buy" | "sell"; // Taker side: 'sell' = taker selling into bids
  bestBid: number;
  bestAsk: number;
  timestamp: number;
}

export class OrderBookWebSocket extends EventEmitter {
  private ws: WebSocket | null = null;
  private orderBooks: Map<string, OrderBookData> = new Map();
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 50;
  private pingInterval: NodeJS.Timeout | null = null;
  private disposed = false; // Prevents auto-reconnect after intentional disconnect
  private lastDataReceived: number = 0; // Track last data receipt for stale detection
  private reconnectCount: number = 0; // Total reconnects since start
  private startedAt: number = Date.now(); // Process start time
  private disconnectedAt: number = 0; // When connection was lost (for gap tracking)

  constructor(private tokenIds: string[]) {
    super();
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        this.ws = new WebSocket(
          "wss://ws-subscriptions-clob.polymarket.com/ws/market",
        );

        this.ws.on("open", () => {
          const now = Date.now();
          // Emit reconnected event if this is a reconnection (not first connect)
          if (this.disconnectedAt > 0) {
            this.reconnectCount++;
            const gapMs = now - this.disconnectedAt;
            console.log(`✅ WebSocket reconnected to Polymarket (reconnect #${this.reconnectCount}, gap ${(gapMs / 1000).toFixed(1)}s)`);
            this.emit("reconnected", {
              reconnectCount: this.reconnectCount,
              disconnectedAt: this.disconnectedAt,
              reconnectedAt: now,
              gapMs,
            });
            this.disconnectedAt = 0;
          } else {
            console.log("✅ WebSocket connected to Polymarket");
          }
          this.reconnectAttempts = 0;
          this.lastDataReceived = now;

          // Subscribe to all token IDs at once
          this.subscribe(this.tokenIds);

          // Setup ping/keepalive every 30 seconds with stale connection check
          this.pingInterval = setInterval(() => {
            if (this.ws && this.ws.readyState === WebSocket.OPEN) {
              // Check for stale connection (no data for 60s)
              const now = Date.now();
              if (
                this.lastDataReceived > 0 &&
                now - this.lastDataReceived > 60000
              ) {
                console.log(
                  "⚠️ WebSocket stale (no data for 60s), reconnecting...",
                );
                this.ws.close();
                return;
              }
              this.ws.ping();
            }
          }, 30000);

          resolve();
        });

        this.ws.on("message", (data: Buffer) => {
          try {
            const text = data.toString();
            // Skip non-JSON messages (pings, pongs, text messages)
            if (!text.startsWith("{") && !text.startsWith("[")) {
              return;
            }
            const message = JSON.parse(text);
            this.lastDataReceived = Date.now(); // Track data receipt for stale detection
            this.handleMessage(message);
          } catch (error) {
            console.error("Error parsing WebSocket message:", error);
          }
        });

        this.ws.on("error", (error) => {
          console.error("WebSocket error:", error.message);
          reject(error);
        });

        this.ws.on("close", () => {
          console.log("WebSocket connection closed");
          if (this.disconnectedAt === 0) {
            this.disconnectedAt = Date.now();
          }
          this.reconnect();
        });
      } catch (error) {
        reject(error);
      }
    });
  }

  private subscribe(tokenIds: string[]): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      const subscribeMsg = {
        auth: {},
        assets_ids: tokenIds,
        type: "MARKET",
      };
      this.ws.send(JSON.stringify(subscribeMsg));
      console.log(`📡 Subscribed to ${tokenIds.length} tokens`);
    }
  }

  /**
   * Add tokens to existing subscription without reconnecting
   */
  addTokens(newTokenIds: string[]): void {
    for (const tokenId of newTokenIds) {
      if (!this.tokenIds.includes(tokenId)) {
        this.tokenIds.push(tokenId);
      }
    }

    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.subscribe(this.tokenIds);
      console.log(
        `➕ Added ${newTokenIds.length} tokens to subscription (total: ${this.tokenIds.length})`,
      );
    }
  }

  getSubscribedTokens(): string[] {
    return [...this.tokenIds];
  }

  private handleMessage(message: any): void {
    // PRIORITY 1: Handle full order book snapshots
    if (message.asset_id && (message.bids || message.asks)) {
      const bids = message.bids || [];
      const asks = message.asks || [];
      const timestamp = Date.now();

      this.orderBooks.set(message.asset_id, {
        bids,
        asks,
        timestamp,
      });

      // Also store with full token ID if we have it
      const matchingFullId = this.tokenIds.find((id) =>
        id.startsWith(message.asset_id),
      );

      if (matchingFullId && matchingFullId !== message.asset_id) {
        this.orderBooks.set(matchingFullId, {
          bids,
          asks,
          timestamp,
        });
      }

      // Emit price update event
      const tokenId = matchingFullId || message.asset_id;
      this.emitPriceUpdate(tokenId);
    }

    // Handle price_changes (trade notifications) for fill detection
    // Note: asset_id is inside each price_change object, not at the message level
    if (message.price_changes && Array.isArray(message.price_changes)) {
      for (const change of message.price_changes) {
        // Use the asset_id from the change itself, not from the outer message
        const changeAssetId = change.asset_id || message.asset_id;
        const tokenId =
          this.tokenIds.find(
            (id) =>
              id.startsWith(changeAssetId) || changeAssetId.startsWith(id),
          ) || changeAssetId;

        this.handlePriceChange(tokenId, change);
      }
    }
  }

  /**
   * Handle a price change (trade) event and emit TradeEvent for fill detection
   */
  private handlePriceChange(tokenId: string, change: any): void {
    const tradePrice = parseFloat(change.price || "0");
    const tradeSize = change.size ? parseFloat(change.size) : 0;

    // Skip trades with no meaningful price
    if (tradePrice <= 0) return;

    // If no size provided, use a default of 1 for fill detection
    const effectiveSize = tradeSize > 0 ? tradeSize : 1;

    // Use API-provided side if available, otherwise infer from price vs mid
    let side: "buy" | "sell" = "sell";
    if (change.side) {
      side = change.side.toLowerCase() as "buy" | "sell";
    } else {
      // Fallback: infer from price relative to bid/ask
      const book = this.orderBooks.get(tokenId);
      if (book) {
        const bestBid = this.getBestBid(tokenId);
        const bestAsk = this.getBestAsk(tokenId);
        const midPrice = (bestBid + bestAsk) / 2;
        side = tradePrice >= midPrice ? "buy" : "sell";
      }
    }

    const tradeEvent: TradeEvent = {
      tokenId,
      tradePrice,
      tradeSize: effectiveSize,
      side,
      bestBid: this.getBestBid(tokenId),
      bestAsk: this.getBestAsk(tokenId),
      timestamp: Date.now(),
    };

    this.emit("trade", tradeEvent);
  }

  private emitPriceUpdate(tokenId: string): void {
    const bid = this.getBestBid(tokenId);
    const ask = this.getBestAsk(tokenId);

    const event: PriceUpdateEvent = {
      tokenId,
      bid,
      ask,
      timestamp: Date.now(),
    };

    this.emit("priceUpdate", event);
  }

  getOrderBook(tokenId: string): OrderBookData | null {
    return this.orderBooks.get(tokenId) || null;
  }

  getAllOrderBooks(): Map<string, OrderBookData> {
    return this.orderBooks;
  }

  getBestBid(tokenId: string): number {
    const orderBook = this.getOrderBook(tokenId);
    if (!orderBook || !orderBook.bids || orderBook.bids.length === 0) {
      return 0;
    }
    // Bids sorted ascending, best bid is LAST (highest price)
    return parseFloat(orderBook.bids[orderBook.bids.length - 1].price);
  }

  getBestAsk(tokenId: string): number {
    const orderBook = this.getOrderBook(tokenId);
    if (!orderBook || !orderBook.asks || orderBook.asks.length === 0) {
      return 0;
    }
    // Asks sorted DESCENDING (0.99, 0.98, 0.97...), best ask (lowest) is LAST
    return parseFloat(orderBook.asks[orderBook.asks.length - 1].price);
  }

  hasOrderBookData(tokenId: string): boolean {
    const ob = this.getOrderBook(tokenId);
    return ob !== null && (ob.bids.length > 0 || ob.asks.length > 0);
  }

  /**
   * Get total available quantity at or below a maximum price
   * Used for liquidity checking before averaging down
   * @param tokenId Token to check
   * @param maxPrice Maximum price to include in the sum
   * @returns Total quantity available at or below maxPrice
   */
  getAvailableQuantityAtPrice(tokenId: string, maxPrice: number): number {
    const orderBook = this.getOrderBook(tokenId);
    if (!orderBook || !orderBook.asks || orderBook.asks.length === 0) {
      return 0;
    }

    let available = 0;
    for (const ask of orderBook.asks) {
      const price = parseFloat(ask.price);
      if (price <= maxPrice) {
        available += parseFloat(ask.size);
      }
    }

    return available;
  }

  private reconnect(): void {
    // Don't reconnect if intentionally disconnected
    if (this.disposed) {
      return;
    }

    if (this.reconnectAttempts < this.maxReconnectAttempts) {
      this.reconnectAttempts++;
      // Exponential backoff: 2s, 4s, 8s, 16s, capped at 30s
      const delay = Math.min(2000 * Math.pow(2, this.reconnectAttempts - 1), 30000);
      console.log(
        `🔄 Reconnecting in ${(delay/1000).toFixed(0)}s... (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`,
      );
      setTimeout(() => this.connect(), delay);
    } else {
      // NEVER give up — keep retrying forever with 60s cooldown
      console.warn(
        `⚠️ Max reconnect attempts (${this.maxReconnectAttempts}) exhausted — ` +
        `entering infinite retry mode (60s cooldown). Total reconnects: ${this.reconnectCount}`,
      );
      this.reconnectAttempts = 0;
      setTimeout(() => this.connect(), 60000);
    }
  }

  /**
   * Check if WebSocket is currently connected and ready
   */
  isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  /**
   * Get WebSocket connection stats for health monitoring
   */
  getStats(): { connected: boolean; reconnectCount: number; lastDataTs: number; uptimeMs: number } {
    return {
      connected: this.isConnected(),
      reconnectCount: this.reconnectCount,
      lastDataTs: this.lastDataReceived,
      uptimeMs: Date.now() - this.startedAt,
    };
  }

  /**
   * Force a reconnection (e.g. from external health monitor)
   */
  forceReconnect(): void {
    console.log("🔌 Force reconnect requested");
    if (this.disconnectedAt === 0) {
      this.disconnectedAt = Date.now();
    }
    if (this.ws) {
      this.ws.close();
    }
  }

  disconnect(): void {
    this.disposed = true; // Prevent auto-reconnect
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.orderBooks.clear();
  }
}
