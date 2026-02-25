/**
 * Open Orders Monitor
 *
 * Shows all open orders for the current BTC 15-min market.
 * Use this to verify GTC orders are correctly tracked.
 *
 * Usage: npm run openorders
 */

import { config } from "dotenv";
config();

import { PolymarketClient } from "../services/PolymarketClient";
import { PolymarketConfig } from "../types";

// OpenOrder structure from Polymarket API
interface OpenOrder {
  id: string;
  status: string;
  market: string;
  original_size: string;
  outcome: string;
  maker_address: string;
  owner: string;
  price: string;
  side: string;
  size_matched: string;
  asset_id: string;
  expiration: string;
  type: string;  // GTC, FOK, GTD
  created_at: string;
  associate_trades?: string[];
}

function formatTimestamp(unixMs: string | number): string {
  const ms = typeof unixMs === 'string' ? parseInt(unixMs) : unixMs;
  if (ms === 0) return 'Never';
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
}

async function main(): Promise<void> {
  console.log('═'.repeat(60));
  console.log('   OPEN ORDERS MONITOR');
  console.log('   Showing all open orders for current market');
  console.log('═'.repeat(60));
  console.log('');

  // Initialize client
  const polyConfig: PolymarketConfig = {
    host: process.env.POLYMARKET_HOST || "https://clob.polymarket.com",
    chainId: parseInt(process.env.POLYMARKET_CHAIN_ID || "137"),
    privateKey: process.env.POLYMARKET_PRIVATE_KEY!,
    funderAddress: process.env.POLYMARKET_FUNDER!,
  };

  const client = new PolymarketClient(polyConfig);
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

  console.log(`Market: ${market.slug}`);
  console.log(`Condition ID: ${market.conditionId}`);
  console.log(`Ends: ${market.endDate}`);
  console.log('');

  if (upToken) {
    console.log(`UP Token:   ${upToken.token_id.slice(0, 20)}...`);
  }
  if (downToken) {
    console.log(`DOWN Token: ${downToken.token_id.slice(0, 20)}...`);
  }
  console.log('');

  // Fetch open orders
  console.log('Fetching open orders...');
  const result = await client.getOpenOrders(market.conditionId);

  if (!result.success) {
    console.error(`Failed to fetch orders: ${result.error}`);
    process.exit(1);
  }

  const orders = result.orders as OpenOrder[] || [];
  const funderAddress = process.env.POLYMARKET_FUNDER?.toLowerCase() || '';

  // Filter to our orders (maker_address matches funder)
  const ourOrders = orders.filter(o =>
    o.maker_address?.toLowerCase() === funderAddress
  );

  console.log('');
  console.log('═'.repeat(60));
  console.log(`Found ${orders.length} total orders, ${ourOrders.length} are ours`);
  console.log('═'.repeat(60));

  if (ourOrders.length === 0) {
    console.log('\nNo open orders found for this market.');
    console.log('');
  } else {
    for (let i = 0; i < ourOrders.length; i++) {
      const order = ourOrders[i];
      const tokenType = order.asset_id === upToken?.token_id ? 'UP' :
                        order.asset_id === downToken?.token_id ? 'DOWN' : 'UNKNOWN';

      console.log(`\nOrder ${i + 1}:`);
      console.log(`  ID:            ${order.id}`);
      console.log(`  Type:          ${order.type}`);
      console.log(`  Side:          ${order.side}`);
      console.log(`  Token:         ${tokenType}`);
      console.log(`  Price:         $${parseFloat(order.price).toFixed(4)}`);
      console.log(`  Original Size: ${order.original_size}`);
      console.log(`  Size Matched:  ${order.size_matched}`);
      console.log(`  Status:        ${order.status}`);
      console.log(`  Created:       ${formatTimestamp(order.created_at)}`);
      console.log(`  Expiration:    ${formatTimestamp(order.expiration)}`);
      console.log(`  Maker:         ${order.maker_address?.slice(0, 20)}...`);

      // Show raw order for debugging
      console.log(`  [RAW] ${JSON.stringify(order)}`);
    }
  }

  // Also show ALL orders (not just ours) for debugging
  if (orders.length > ourOrders.length) {
    console.log('');
    console.log('─'.repeat(60));
    console.log('Other orders in this market (not ours):');
    console.log('─'.repeat(60));

    const otherOrders = orders.filter(o =>
      o.maker_address?.toLowerCase() !== funderAddress
    );

    for (const order of otherOrders.slice(0, 5)) {
      console.log(`  ${order.id.slice(0, 16)}... | ${order.side} ${order.type} | $${parseFloat(order.price).toFixed(3)} x ${order.original_size}`);
    }
    if (otherOrders.length > 5) {
      console.log(`  ... and ${otherOrders.length - 5} more`);
    }
  }

  console.log('');
  console.log('Done!');
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
