/**
 * CLI: Test Cancel Orders
 *
 * Usage:
 *   npm run test-cancel
 *
 * Cancels all open orders on the current BTC 15-min market.
 */

import dotenv from 'dotenv';
import { PolymarketClient } from '../services/PolymarketClient';
import { PolymarketConfig } from '../types';

dotenv.config();

async function main() {
  console.log('');
  console.log('═══════════════════════════════════════════════════════════');
  console.log('                   TEST CANCEL ORDERS');
  console.log('═══════════════════════════════════════════════════════════');
  console.log('');

  // Validate environment
  const privateKey = process.env.POLYMARKET_PRIVATE_KEY;
  const authMode = (process.env.AUTH_MODE || 'PROXY') as 'EOA' | 'PROXY';
  const funderAddress = process.env.POLYMARKET_FUNDER;

  if (!privateKey) {
    console.error('❌ Missing POLYMARKET_PRIVATE_KEY');
    process.exit(1);
  }

  if (authMode === 'PROXY' && !funderAddress) {
    console.error('❌ Missing POLYMARKET_FUNDER (required in PROXY mode)');
    console.error('   Set AUTH_MODE=EOA to use signer as funder');
    process.exit(1);
  }

  // Initialize client
  const config: PolymarketConfig = {
    host: process.env.POLYMARKET_HOST || 'https://clob.polymarket.com',
    chainId: parseInt(process.env.POLYMARKET_CHAIN_ID || '137'),
    privateKey,
    funderAddress: funderAddress || '',  // Will be overridden by EOA mode
    authMode,
  };

  const client = new PolymarketClient(config);
  await client.initialize();

  // Find current market
  console.log('🔍 Finding current market...');
  const market = await client.findNext15MinMarket();

  if (!market) {
    console.error('❌ No active BTC 15-min market found');
    process.exit(1);
  }

  console.log(`   Market: ${market.slug}`);
  console.log(`   Condition ID: ${market.conditionId}`);
  console.log('');

  // Check current orders first
  console.log('📋 Checking open orders...');
  const ordersResult = await client.getOpenOrders(market.conditionId);

  if (!ordersResult.success) {
    console.error(`❌ Failed to get orders: ${ordersResult.error}`);
    process.exit(1);
  }

  if (!ordersResult.orders || ordersResult.orders.length === 0) {
    console.log('   No open orders to cancel');
    console.log('');
    console.log('═══════════════════════════════════════════════════════════');
    console.log('');
    process.exit(0);
  }

  console.log(`   Found ${ordersResult.orders.length} open order(s):`);
  for (const order of ordersResult.orders) {
    const side = order.side === 'BUY' ? '🟢 BUY' : '🔴 SELL';
    console.log(`   ${side} ${order.original_size} @ $${order.price}`);
  }
  console.log('');

  // Cancel all orders
  console.log('❌ Cancelling all orders...');
  const cancelResult = await client.cancelOrders(market.conditionId);

  if (cancelResult.success) {
    if (cancelResult.cancelled && cancelResult.cancelled.length > 0) {
      console.log(`✅ Cancelled ${cancelResult.cancelled.length} order(s)`);
      for (const orderId of cancelResult.cancelled) {
        console.log(`   - ${orderId.slice(0, 16)}...`);
      }
    } else {
      console.log('✅ Cancel request sent (no order IDs returned)');
    }
  } else {
    console.error(`❌ Cancel failed: ${cancelResult.error}`);
  }

  console.log('');
  console.log('═══════════════════════════════════════════════════════════');
  console.log('');

  process.exit(cancelResult.success ? 0 : 1);
}

main().catch((error) => {
  console.error('❌ Error:', error.message);
  process.exit(1);
});
