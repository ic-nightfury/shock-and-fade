/**
 * checkOrder.ts - V19 Manual Order Fill Checker
 *
 * Usage: npm run checkorder <orderId> <conditionId>
 *
 * This script queries a GTC order to check its fill status.
 * Used to verify V19 reconciliation logic is correct.
 */

import { config } from 'dotenv';
config();

import { PolymarketClient } from '../services/PolymarketClient';
import { PolymarketConfig } from '../types';

async function main() {
  const args = process.argv.slice(2);

  if (args.length < 2) {
    console.log('Usage: npm run checkorder <orderId> <conditionId>');
    console.log('');
    console.log('Example:');
    console.log('  npm run checkorder 0x21a749... 0x0fa07d18a6cec48de4...');
    console.log('');
    console.log('This will query the order and show:');
    console.log('  - Original size');
    console.log('  - Size matched (filled)');
    console.log('  - Remaining size');
    console.log('  - Order status');
    process.exit(1);
  }

  const [orderId, conditionId] = args;

  console.log('\n📊 V19 Order Fill Checker');
  console.log('='.repeat(50));
  console.log(`Order ID: ${orderId}`);
  console.log(`Condition ID: ${conditionId}`);
  console.log('='.repeat(50));

  // Initialize client
  const polyConfig: PolymarketConfig = {
    host: process.env.POLYMARKET_HOST || "https://clob.polymarket.com",
    chainId: parseInt(process.env.POLYMARKET_CHAIN_ID || "137"),
    privateKey: process.env.POLYMARKET_PRIVATE_KEY!,
    funderAddress: process.env.POLYMARKET_FUNDER!,
  };

  const client = new PolymarketClient(polyConfig);
  await client.initialize();

  console.log('\n🔍 Querying order status...\n');

  // Get order details
  const details = await client.getOrderDetails(orderId, conditionId);

  if (details.status === 'NOT_FOUND') {
    console.log('❌ Order not found in open orders');
    console.log('');
    console.log('This means either:');
    console.log('  1. Order was fully filled (no longer open)');
    console.log('  2. Order was cancelled');
    console.log('  3. Order ID is incorrect');
    console.log('');
    console.log('📋 V19 Logic: If cancelOrders() returns 0, assume fully filled');
  } else {
    console.log('✅ Order found (still LIVE on book)\n');
    console.log(`   Original Size:  ${details.originalSize?.toFixed(4)} shares`);
    console.log(`   Size Matched:   ${details.sizeMatched?.toFixed(4)} shares (filled)`);
    console.log(`   Remaining:      ${details.remainingSize?.toFixed(4)} shares`);
    console.log(`   Price:          $${details.price?.toFixed(4)}`);
    console.log('');

    const fillPercent = details.originalSize && details.sizeMatched
      ? ((details.sizeMatched / details.originalSize) * 100).toFixed(1)
      : '0';
    console.log(`   Fill %:         ${fillPercent}%`);
  }

  // Also show all open orders for this market
  console.log('\n📋 All open orders for this market:');
  const openOrders = await client.getOpenOrders(conditionId);

  if (openOrders.success && openOrders.orders && openOrders.orders.length > 0) {
    console.log(`   Found ${openOrders.orders.length} open order(s):\n`);
    for (const order of openOrders.orders) {
      const origSize = parseFloat(order.original_size || order.size || '0');
      const matched = parseFloat(order.size_matched || '0');
      const remaining = origSize - matched;
      console.log(`   [${order.id.slice(0, 8)}...] ${order.side} ${origSize.toFixed(2)} @ $${parseFloat(order.price).toFixed(4)}`);
      console.log(`      Filled: ${matched.toFixed(2)} | Remaining: ${remaining.toFixed(2)}`);
      console.log('');
    }
  } else {
    console.log('   No open orders found for this market');
  }

  console.log('\n✅ Done');
}

main().catch(console.error);
