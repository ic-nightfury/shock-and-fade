/**
 * Market Channel WebSocket Monitor
 *
 * Shows real-time order book data and liquidity calculations.
 * Use this to verify the data model for preciseBuy() liquidity checks.
 *
 * Usage: npm run marketwss
 */

import { config } from "dotenv";
config();

import { PolymarketClient } from "../services/PolymarketClient";
import { OrderBookWebSocket, OrderBookData } from "../services/OrderBookWS";
import { PolymarketConfig } from "../types";

// State
let client: PolymarketClient;
let ws: OrderBookWebSocket | null = null;
let upTokenId: string = "";
let downTokenId: string = "";
let updateCount = 0;

function formatTimestamp(): string {
  return new Date().toISOString().slice(11, 23);
}

function formatOrderBook(tokenId: string, side: 'UP' | 'DOWN'): void {
  if (!ws) return;

  const orderBook = ws.getOrderBook(tokenId);
  const bestBid = ws.getBestBid(tokenId);
  const bestAsk = ws.getBestAsk(tokenId);

  console.log(`\n${side}:`);
  console.log(`  Best Bid: $${bestBid.toFixed(4)}`);
  console.log(`  Best Ask: $${bestAsk.toFixed(4)}`);

  if (orderBook) {
    // Show liquidity at various price levels
    const testPrices = [
      bestAsk,
      bestAsk + 0.01,
      bestAsk + 0.02,
      bestAsk + 0.05,
      bestAsk + 0.10,
    ];

    console.log(`  Liquidity calculations:`);
    for (const price of testPrices) {
      const liq = ws.getAvailableQuantityAtPrice(tokenId, price);
      console.log(`    @ $${price.toFixed(2)}: ${liq.toFixed(0)} shares`);
    }

    // Show raw asks (first 5)
    console.log(`  Raw asks (first 5):`);
    const asks = orderBook.asks.slice(-5).reverse(); // Get lowest 5 asks
    for (const ask of asks) {
      console.log(`    { price: "${ask.price}", size: "${ask.size}" }`);
    }

    // Show raw bids (first 5)
    console.log(`  Raw bids (first 5):`);
    const bids = orderBook.bids.slice(-5).reverse(); // Get highest 5 bids
    for (const bid of bids) {
      console.log(`    { price: "${bid.price}", size: "${bid.size}" }`);
    }
  }
}

function handlePriceUpdate(): void {
  if (!ws) return;

  updateCount++;

  // Only log every 10th update to avoid spam
  if (updateCount % 10 !== 0) return;

  console.log('\n' + '═'.repeat(60));
  console.log(`[${formatTimestamp()}] ORDER BOOK UPDATE #${updateCount}`);
  console.log('═'.repeat(60));

  formatOrderBook(upTokenId, 'UP');
  formatOrderBook(downTokenId, 'DOWN');

  // Pair cost calculation
  const upAsk = ws.getBestAsk(upTokenId);
  const downAsk = ws.getBestAsk(downTokenId);
  if (upAsk > 0 && downAsk > 0) {
    const pairCost = upAsk + downAsk;
    console.log(`\nPair Cost: $${upAsk.toFixed(4)} + $${downAsk.toFixed(4)} = $${pairCost.toFixed(4)}`);
    if (pairCost < 1.0) {
      console.log(`  --> PROFITABLE! (${((1 - pairCost) * 100).toFixed(2)}% margin)`);
    }
  }
}

async function main(): Promise<void> {
  console.log('═'.repeat(60));
  console.log('   MARKET CHANNEL WSS MONITOR');
  console.log('   Verifying order book data model for preciseBuy()');
  console.log('═'.repeat(60));
  console.log('');

  // Initialize client
  const polyConfig: PolymarketConfig = {
    host: process.env.POLYMARKET_HOST || "https://clob.polymarket.com",
    chainId: parseInt(process.env.POLYMARKET_CHAIN_ID || "137"),
    privateKey: process.env.POLYMARKET_PRIVATE_KEY!,
    funderAddress: process.env.POLYMARKET_FUNDER!,
  };

  client = new PolymarketClient(polyConfig);
  await client.initialize();

  // Find current market
  const market = await client.findNext15MinMarket();
  if (!market) {
    console.error('No market found');
    process.exit(1);
  }

  // Find UP and DOWN tokens
  const upToken = market.tokens.find((t) => t.outcome === "Up");
  const downToken = market.tokens.find((t) => t.outcome === "Down");

  if (!upToken || !downToken) {
    console.error('Missing UP or DOWN token');
    process.exit(1);
  }

  upTokenId = upToken.token_id;
  downTokenId = downToken.token_id;

  console.log(`Market: ${market.slug}`);
  console.log(`Condition ID: ${market.conditionId}`);
  console.log(`Ends: ${market.endDate}`);
  console.log('');
  console.log(`UP Token:   ${upTokenId.slice(0, 20)}...`);
  console.log(`DOWN Token: ${downTokenId.slice(0, 20)}...`);
  console.log('');
  console.log('Connecting to Market WSS...');

  // Connect to WebSocket
  ws = new OrderBookWebSocket([upTokenId, downTokenId]);
  ws.on("priceUpdate", handlePriceUpdate);
  await ws.connect();

  console.log('');
  console.log('Waiting for order book updates...');
  console.log('(Logging every 10th update to reduce noise)');
  console.log('Press Ctrl+C to exit');
  console.log('');

  // Graceful shutdown
  process.on("SIGINT", () => {
    console.log("\n\nShutting down...");
    if (ws) ws.disconnect();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
