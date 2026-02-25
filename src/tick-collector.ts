#!/usr/bin/env npx tsx
/**
 * Polymarket Tick Data Collector (TypeScript)
 *
 * Uses the same OrderBookWebSocket class as live simulations to ensure
 * tick data has identical granularity and format.
 *
 * Captures:
 * - book_update events: timestamp, tokenId, full bids[], full asks[]
 * - trade events: timestamp, tokenId, price, size, side (CRITICAL for fill detection)
 *
 * Usage:
 *   npx tsx src/tick-collector.ts [--asset BTC|ETH|SOL|XRP] [--data-dir /path/to/data]
 */

import dns from "dns";
dns.setDefaultResultOrder("ipv4first");

import * as fs from "fs";
import * as path from "path";
import axios from "axios";
import {
  OrderBookWebSocket,
  PriceUpdateEvent,
  TradeEvent,
  OrderBookData,
} from "./services/OrderBookWS";

// Configuration
const GAMMA_API = "https://gamma-api.polymarket.com";
const DEFAULT_DATA_DIR = "/mnt/HC_Volume_102468263/polymarket_ticks";
const MARKET_REFRESH_INTERVAL_MS = 60 * 1000; // Refresh markets every 1 minute
const ASSETS = ["BTC", "ETH", "SOL", "XRP"];

interface MarketInfo {
  slug: string;
  conditionId: string;
  upTokenId: string;
  downTokenId: string;
  endTime: number;
}

interface TickData {
  event_type: "book" | "trade";
  timestamp: number;
  iso_timestamp: string;
  token_id: string;
  outcome: "UP" | "DOWN";
  market_slug: string;
  market_type: "15min";
  // Book data (for event_type: "book")
  bids?: Array<{ price: string; size: string }>;
  asks?: Array<{ price: string; size: string }>;
  best_bid?: number;
  best_ask?: number;
  // Trade data (for event_type: "trade")
  trade_price?: number;
  trade_size?: number;
  trade_side?: string;
}

class TickCollector {
  private dataDir: string;
  private assets: string[];
  private orderBookWS: OrderBookWebSocket | null = null;
  private activeMarkets: Map<string, MarketInfo> = new Map(); // conditionId -> MarketInfo
  private tokenToMarket: Map<string, MarketInfo> = new Map(); // tokenId -> MarketInfo
  private tokenToOutcome: Map<string, "UP" | "DOWN"> = new Map();
  private writeBuffers: Map<string, TickData[]> = new Map(); // date -> ticks
  private stats = {
    booksReceived: 0,
    tradesReceived: 0,
    ticksWritten: 0,
    marketsTracked: 0,
    reconnections: 0,
    errors: 0,
  };
  private running = false;
  private marketRefreshInterval: NodeJS.Timeout | null = null;
  private flushInterval: NodeJS.Timeout | null = null;
  private allTokenIds: string[] = [];

  constructor(assets: string[] = ASSETS, dataDir: string = DEFAULT_DATA_DIR) {
    this.dataDir = dataDir;
    this.assets = assets;
    this.ensureDirectories();
  }

  private ensureDirectories(): void {
    const dirs = [
      this.dataDir,
      path.join(this.dataDir, "15min"),
      path.join(this.dataDir, "logs"),
    ];
    for (const dir of dirs) {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    }
  }

  private log(
    message: string,
    level: "INFO" | "WARN" | "ERROR" = "INFO",
  ): void {
    const timestamp = new Date().toISOString();
    const logLine = `${timestamp} [${level}] ${message}`;
    console.log(logLine);

    // Also write to log file
    const logFile = path.join(this.dataDir, "logs", "collector.log");
    fs.appendFileSync(logFile, logLine + "\n");
  }

  /**
   * Fetch currently active 15-min markets for all configured assets
   */
  private async fetchActiveMarkets(): Promise<MarketInfo[]> {
    const markets: MarketInfo[] = [];
    const now = Math.floor(Date.now() / 1000);

    // Check current window and next 3 windows (to catch markets early)
    for (const asset of this.assets) {
      for (let windowOffset = 0; windowOffset <= 3; windowOffset++) {
        const windowStart =
          Math.floor(now / (15 * 60)) * (15 * 60) + windowOffset * 15 * 60;
        const slug = `${asset.toLowerCase()}-updown-15m-${windowStart}`;

        try {
          const response = await axios.get(
            `${GAMMA_API}/markets?slug=${slug}`,
            {
              timeout: 10000,
            },
          );

          if (response.data && response.data.length > 0) {
            const market = response.data[0];

            if (!market.active) continue;

            const tokenIds = JSON.parse(market.clobTokenIds);
            const outcomes = JSON.parse(market.outcomes);

            // Determine which token is UP and which is DOWN
            const upIndex = outcomes.indexOf("Up");
            const downIndex = outcomes.indexOf("Down");

            if (upIndex === -1 || downIndex === -1) continue;

            const endTime = new Date(market.endDate).getTime() / 1000;

            // Only include markets that haven't ended yet
            if (endTime > now) {
              markets.push({
                slug,
                conditionId: market.conditionId,
                upTokenId: tokenIds[upIndex],
                downTokenId: tokenIds[downIndex],
                endTime,
              });
            }
          }
        } catch (err) {
          // Market might not exist yet, that's okay
          if ((err as any)?.response?.status !== 404) {
            this.log(`Error fetching market ${slug}: ${err}`, "WARN");
          }
        }
      }
    }

    return markets;
  }

  /**
   * Refresh active markets and update WebSocket subscriptions
   */
  private async refreshMarkets(): Promise<void> {
    try {
      const markets = await this.fetchActiveMarkets();

      // Remove expired markets
      const now = Math.floor(Date.now() / 1000);
      for (const [conditionId, market] of this.activeMarkets) {
        if (market.endTime < now) {
          this.activeMarkets.delete(conditionId);
          this.tokenToMarket.delete(market.upTokenId);
          this.tokenToMarket.delete(market.downTokenId);
          this.tokenToOutcome.delete(market.upTokenId);
          this.tokenToOutcome.delete(market.downTokenId);
          this.log(`Expired market: ${market.slug}`);
        }
      }

      // Add new markets
      const newTokenIds: string[] = [];
      for (const market of markets) {
        if (!this.activeMarkets.has(market.conditionId)) {
          this.activeMarkets.set(market.conditionId, market);
          this.tokenToMarket.set(market.upTokenId, market);
          this.tokenToMarket.set(market.downTokenId, market);
          this.tokenToOutcome.set(market.upTokenId, "UP");
          this.tokenToOutcome.set(market.downTokenId, "DOWN");

          if (!this.allTokenIds.includes(market.upTokenId)) {
            newTokenIds.push(market.upTokenId);
            this.allTokenIds.push(market.upTokenId);
          }
          if (!this.allTokenIds.includes(market.downTokenId)) {
            newTokenIds.push(market.downTokenId);
            this.allTokenIds.push(market.downTokenId);
          }

          this.log(
            `Added market: ${market.slug} (UP: ${market.upTokenId.slice(0, 8)}..., DOWN: ${market.downTokenId.slice(0, 8)}...)`,
          );
        }
      }

      // Subscribe to new tokens if WebSocket is connected
      if (
        newTokenIds.length > 0 &&
        this.orderBookWS &&
        this.orderBookWS.isConnected()
      ) {
        this.orderBookWS.addTokens(newTokenIds);
      }

      this.stats.marketsTracked = this.activeMarkets.size;
      this.log(
        `Tracking ${this.activeMarkets.size} markets (${this.allTokenIds.length} tokens)`,
      );
    } catch (err) {
      this.log(`Error refreshing markets: ${err}`, "ERROR");
      this.stats.errors++;
    }
  }

  /**
   * Handle order book snapshot events
   */
  private handlePriceUpdate(event: PriceUpdateEvent): void {
    const market = this.tokenToMarket.get(event.tokenId);
    if (!market) return;

    const outcome = this.tokenToOutcome.get(event.tokenId);
    if (!outcome) return;

    // Get full order book data
    const orderBook = this.orderBookWS?.getOrderBook(event.tokenId);

    const tick: TickData = {
      event_type: "book",
      timestamp: event.timestamp,
      iso_timestamp: new Date(event.timestamp).toISOString(),
      token_id: event.tokenId,
      outcome,
      market_slug: market.slug,
      market_type: "15min",
      bids: orderBook?.bids || [],
      asks: orderBook?.asks || [],
      best_bid: event.bid,
      best_ask: event.ask,
    };

    this.bufferTick(tick);
    this.stats.booksReceived++;
  }

  /**
   * Handle trade events (CRITICAL for fill detection)
   */
  private handleTradeEvent(event: TradeEvent): void {
    const market = this.tokenToMarket.get(event.tokenId);
    if (!market) return;

    const outcome = this.tokenToOutcome.get(event.tokenId);
    if (!outcome) return;

    const tick: TickData = {
      event_type: "trade",
      timestamp: event.timestamp,
      iso_timestamp: new Date(event.timestamp).toISOString(),
      token_id: event.tokenId,
      outcome,
      market_slug: market.slug,
      market_type: "15min",
      trade_price: event.tradePrice,
      trade_size: event.tradeSize,
      trade_side: event.side,
    };

    this.bufferTick(tick);
    this.stats.tradesReceived++;
  }

  /**
   * Buffer tick for batch writing
   */
  private bufferTick(tick: TickData): void {
    const date = tick.iso_timestamp.slice(0, 10); // YYYY-MM-DD

    if (!this.writeBuffers.has(date)) {
      this.writeBuffers.set(date, []);
    }
    this.writeBuffers.get(date)!.push(tick);

    // Flush if buffer is large
    const buffer = this.writeBuffers.get(date)!;
    if (buffer.length >= 100) {
      this.flushBuffer(date);
    }
  }

  /**
   * Flush buffer to disk
   */
  private flushBuffer(date?: string): void {
    const datesToFlush = date ? [date] : Array.from(this.writeBuffers.keys());

    for (const d of datesToFlush) {
      const buffer = this.writeBuffers.get(d);
      if (!buffer || buffer.length === 0) continue;

      const filePath = path.join(this.dataDir, "15min", `${d}.jsonl`);
      const lines =
        buffer.map((tick) => JSON.stringify(tick)).join("\n") + "\n";

      fs.appendFileSync(filePath, lines);

      this.stats.ticksWritten += buffer.length;
      this.writeBuffers.set(d, []);
    }
  }

  /**
   * Initialize WebSocket connection
   */
  private async initializeWebSocket(): Promise<void> {
    // Start with tokens from current active markets
    const initialTokens =
      this.allTokenIds.length > 0 ? [...this.allTokenIds] : ["placeholder"]; // Need at least one token to connect

    this.orderBookWS = new OrderBookWebSocket(initialTokens);

    // Subscribe to book updates
    this.orderBookWS.on("priceUpdate", (event: PriceUpdateEvent) => {
      this.handlePriceUpdate(event);
    });

    // Subscribe to trade events (CRITICAL for fill detection)
    this.orderBookWS.on("trade", (event: TradeEvent) => {
      this.handleTradeEvent(event);
    });

    await this.orderBookWS.connect();
    this.log("WebSocket connected");
  }

  /**
   * Start the collector
   */
  async start(): Promise<void> {
    this.running = true;
    this.log(`Starting tick collector for assets: ${this.assets.join(", ")}`);
    this.log(`Data directory: ${this.dataDir}`);

    // Initial market fetch
    await this.refreshMarkets();

    // Initialize WebSocket
    await this.initializeWebSocket();

    // Setup periodic market refresh
    this.marketRefreshInterval = setInterval(async () => {
      await this.refreshMarkets();
    }, MARKET_REFRESH_INTERVAL_MS);

    // Setup periodic buffer flush
    this.flushInterval = setInterval(() => {
      this.flushBuffer();
    }, 10000); // Flush every 10 seconds

    // Log stats periodically
    setInterval(() => {
      this.log(
        `Stats: books=${this.stats.booksReceived}, trades=${this.stats.tradesReceived}, written=${this.stats.ticksWritten}, markets=${this.stats.marketsTracked}`,
      );
    }, 60000); // Every minute

    this.log("Collector started");

    // Keep running
    await new Promise<void>((resolve) => {
      process.on("SIGINT", () => {
        this.log("Received SIGINT, stopping...");
        this.stop();
        resolve();
      });
      process.on("SIGTERM", () => {
        this.log("Received SIGTERM, stopping...");
        this.stop();
        resolve();
      });
    });
  }

  /**
   * Stop the collector
   */
  stop(): void {
    this.running = false;

    if (this.marketRefreshInterval) {
      clearInterval(this.marketRefreshInterval);
    }
    if (this.flushInterval) {
      clearInterval(this.flushInterval);
    }

    // Flush remaining data
    this.flushBuffer();

    // Disconnect WebSocket
    if (this.orderBookWS) {
      this.orderBookWS.disconnect();
    }

    this.log(
      `Final stats: books=${this.stats.booksReceived}, trades=${this.stats.tradesReceived}, written=${this.stats.ticksWritten}`,
    );
    this.log("Collector stopped");
  }
}

// CLI
async function main() {
  const args = process.argv.slice(2);

  let assets = ASSETS;
  let dataDir = DEFAULT_DATA_DIR;

  // Parse CLI args
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--asset" || args[i] === "-a") {
      assets = [args[++i].toUpperCase()];
    } else if (args[i] === "--data-dir" || args[i] === "-d") {
      dataDir = args[++i];
    } else if (args[i] === "--help" || args[i] === "-h") {
      console.log(`
Polymarket Tick Collector (TypeScript)

Uses the same OrderBookWebSocket as live simulations for data parity.

Usage:
  npx tsx src/tick-collector.ts [options]

Options:
  --asset, -a <ASSET>     Asset to track (BTC, ETH, SOL, XRP). Default: all
  --data-dir, -d <PATH>   Data directory. Default: ${DEFAULT_DATA_DIR}
  --help, -h              Show this help

Output Format (JSONL):
  Book events: { event_type: "book", bids: [], asks: [], best_bid, best_ask, ... }
  Trade events: { event_type: "trade", trade_price, trade_size, trade_side, ... }
      `);
      process.exit(0);
    }
  }

  const collector = new TickCollector(assets, dataDir);
  await collector.start();
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
