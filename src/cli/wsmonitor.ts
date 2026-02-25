/**
 * WebSocket Price Monitor for BTC 15-minute Up/Down markets
 * Logs when Up + Down ask prices sum below $1.00
 */

import * as fs from "fs";
import * as path from "path";
import { config } from "dotenv";
config();

import { PolymarketClient } from "../services/PolymarketClient";
import { OrderBookWebSocket } from "../services/OrderBookWS";
import { MarketInfo, PolymarketConfig } from "../types";

const CSV_PATH = path.join(process.cwd(), "market_logs.csv");

// State
let client: PolymarketClient;
let ws: OrderBookWebSocket | null = null;
let currentMarket: MarketInfo | null = null;
let upTokenId: string = "";
let downTokenId: string = "";

function ensureCsvHeader(): void {
  if (!fs.existsSync(CSV_PATH)) {
    fs.writeFileSync(
      CSV_PATH,
      "timestamp,market_slug,up_ask,down_ask,pair_cost\n"
    );
    console.log(`Created ${CSV_PATH}`);
  }
}

function logToCSV(
  marketSlug: string,
  upAsk: number,
  downAsk: number,
  pairCost: number
): void {
  const timestamp = new Date().toISOString();
  const line = `${timestamp},${marketSlug},${upAsk.toFixed(4)},${downAsk.toFixed(4)},${pairCost.toFixed(4)}\n`;
  fs.appendFileSync(CSV_PATH, line);
}

async function setupMarket(): Promise<boolean> {
  // Clean up previous WebSocket
  if (ws) {
    ws.disconnect();
    ws = null;
  }

  currentMarket = await client.findNext15MinMarket();
  if (!currentMarket) {
    console.log("No market found, waiting...");
    return false;
  }

  // Find UP and DOWN token IDs
  const upToken = currentMarket.tokens.find((t) => t.outcome === "Up");
  const downToken = currentMarket.tokens.find((t) => t.outcome === "Down");

  if (!upToken || !downToken) {
    console.log("Missing UP or DOWN token");
    return false;
  }

  upTokenId = upToken.token_id;
  downTokenId = downToken.token_id;

  console.log(`\n📊 Market: ${currentMarket.slug}`);
  console.log(`   Ends: ${currentMarket.endDate}`);

  // Setup WebSocket
  ws = new OrderBookWebSocket([upTokenId, downTokenId]);
  ws.on("priceUpdate", handlePriceUpdate);
  await ws.connect();

  return true;
}

function handlePriceUpdate(): void {
  if (!ws || !currentMarket) return;

  const upAsk = ws.getBestAsk(upTokenId);
  const downAsk = ws.getBestAsk(downTokenId);

  // Wait for both prices
  if (upAsk === 0 || downAsk === 0) return;

  const pairCost = upAsk + downAsk;

  // Only log if pair cost < 1.00
  if (pairCost < 1.0) {
    console.log(
      `⚡ OPPORTUNITY: UP=$${upAsk.toFixed(3)} + DOWN=$${downAsk.toFixed(3)} = $${pairCost.toFixed(4)}`
    );
    logToCSV(currentMarket.slug, upAsk, downAsk, pairCost);
  }
}

async function checkMarketEnd(): Promise<void> {
  if (!currentMarket) return;

  const now = Date.now();
  const endTime = new Date(currentMarket.endDate).getTime();

  // If market ended, find next one
  if (now >= endTime) {
    console.log(`\n⏱️ Market ended, finding next...`);
    await setupMarket();
  }
}

async function main(): Promise<void> {
  console.log("=".repeat(50));
  console.log("   BTC 15-Min WebSocket Price Monitor");
  console.log("   Logging pair costs < $1.00 to market_logs.csv");
  console.log("=".repeat(50));

  ensureCsvHeader();

  // Initialize client (no trading, just market discovery)
  const polyConfig: PolymarketConfig = {
    host: process.env.POLYMARKET_HOST || "https://clob.polymarket.com",
    chainId: parseInt(process.env.POLYMARKET_CHAIN_ID || "137"),
    privateKey: process.env.POLYMARKET_PRIVATE_KEY!,
    funderAddress: process.env.POLYMARKET_FUNDER!,
  };

  client = new PolymarketClient(polyConfig);
  await client.initialize();

  // Setup first market
  await setupMarket();

  // Check for market end every 5 seconds
  setInterval(checkMarketEnd, 5000);

  // Keep alive
  process.on("SIGINT", () => {
    console.log("\nShutting down...");
    if (ws) ws.disconnect();
    process.exit(0);
  });
}

main().catch(console.error);
