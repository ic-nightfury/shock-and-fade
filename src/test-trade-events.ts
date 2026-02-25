/**
 * Test script to verify raw WebSocket trade event format
 * Run: npm run test:trade-events
 */

// Force IPv4 to avoid Cloudflare blocks on IPv6 datacenter IPs
import dns from "dns";
dns.setDefaultResultOrder("ipv4first");

import dotenv from "dotenv";
import { Wallet } from "@ethersproject/wallet";
import { OrderBookWebSocket, TradeEvent } from "./services/OrderBookWS";
import { PolymarketClient } from "./services/PolymarketClient";
import { PolymarketConfig } from "./types";

dotenv.config();

async function main() {
  console.log("🔍 Testing WebSocket Trade Events...\n");

  // Initialize configuration
  const authMode = (process.env.AUTH_MODE || "PROXY") as "EOA" | "PROXY";

  let funderAddress: string;
  if (authMode === "EOA") {
    const wallet = new Wallet(process.env.POLYMARKET_PRIVATE_KEY!);
    funderAddress = wallet.address;
  } else {
    funderAddress = process.env.POLYMARKET_FUNDER!;
  }

  const config: PolymarketConfig = {
    host: process.env.POLYMARKET_HOST || "https://clob.polymarket.com",
    chainId: parseInt(process.env.POLYMARKET_CHAIN_ID || "137"),
    privateKey: process.env.POLYMARKET_PRIVATE_KEY!,
    funderAddress,
    authMode,
  };

  const client = new PolymarketClient(config);
  await client.initialize();

  const market = await client.findNext15MinMarket();

  if (!market) {
    console.log("No active market found");
    return;
  }

  console.log(`Market: ${market.slug}`);

  const upToken = market.tokens.find(
    (t: any) => t.outcome === "Up" || t.outcome === "UP",
  );
  const downToken = market.tokens.find(
    (t: any) => t.outcome === "Down" || t.outcome === "DOWN",
  );

  if (!upToken || !downToken) {
    console.log("Could not find UP/DOWN tokens");
    return;
  }

  console.log(`UP Token: ${upToken.token_id.slice(0, 20)}...`);
  console.log(`DOWN Token: ${downToken.token_id.slice(0, 20)}...`);
  console.log("");

  const orderBookWS = new OrderBookWebSocket([
    upToken.token_id,
    downToken.token_id,
  ]);

  let tradeCount = 0;
  let sellCount = 0;
  let buyCount = 0;

  // Listen for trade events
  orderBookWS.on("trade", (event: TradeEvent) => {
    tradeCount++;
    if (event.side === "sell") sellCount++;
    else buyCount++;

    const side = event.tokenId === upToken.token_id ? "UP" : "DOWN";
    console.log(
      `[TRADE #${tradeCount}] ${side} | ` +
        `price: ${event.tradePrice.toFixed(3)} | ` +
        `size: ${event.tradeSize.toFixed(1)} | ` +
        `taker: ${event.side.toUpperCase()} | ` +
        `bid: ${event.bestBid.toFixed(2)} | ` +
        `ask: ${event.bestAsk.toFixed(2)} | ` +
        `(sell=${sellCount}, buy=${buyCount})`,
    );
  });

  // Listen for price updates
  orderBookWS.on("priceUpdate", (event: any) => {
    const side = event.tokenId === upToken.token_id ? "UP" : "DOWN";
    console.log(
      `[BOOK] ${side} | bid: ${event.bid.toFixed(3)} | ask: ${event.ask.toFixed(3)}`,
    );
  });

  await orderBookWS.connect();
  console.log("Connected! Listening for trades (Ctrl+C to stop)...\n");

  // Handle graceful shutdown
  process.on("SIGINT", () => {
    console.log("\n\n📊 Summary:");
    console.log(`   Total trades: ${tradeCount}`);
    console.log(`   Sell trades: ${sellCount} (can fill our BUY orders)`);
    console.log(`   Buy trades: ${buyCount} (cannot fill our BUY orders)`);
    orderBookWS.disconnect();
    process.exit(0);
  });

  // Keep running
  await new Promise(() => {});
}

main().catch(console.error);
