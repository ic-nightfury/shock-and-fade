/**
 * CLI: Status
 *
 * Usage:
 *   npm run status
 *
 * Shows current market, orders, positions, and balance.
 */

import dotenv from 'dotenv';
import { PolymarketClient } from '../services/PolymarketClient';
import { PolymarketConfig } from '../types';

dotenv.config();

async function main() {
  console.log('');
  console.log('═══════════════════════════════════════════════════════════');
  console.log('                         STATUS');
  console.log('═══════════════════════════════════════════════════════════');
  console.log('');

  // Validate environment
  const privateKey = process.env.POLYMARKET_PRIVATE_KEY;
  const funderAddress = process.env.POLYMARKET_FUNDER;

  if (!privateKey || !funderAddress) {
    console.error('❌ Missing POLYMARKET_PRIVATE_KEY or POLYMARKET_FUNDER');
    process.exit(1);
  }

  // Initialize client
  const config: PolymarketConfig = {
    host: process.env.POLYMARKET_HOST || 'https://clob.polymarket.com',
    chainId: parseInt(process.env.POLYMARKET_CHAIN_ID || '137'),
    privateKey,
    funderAddress,
  };

  const client = new PolymarketClient(config);
  await client.initialize();

  // 1. Current Market
  console.log('📊 CURRENT MARKET');
  console.log('─────────────────────────────────────────────────────────');
  const market = await client.findNext15MinMarket();
  if (market) {
    const now = Date.now();
    const marketSecond = Math.floor((now - market.startTime) / 1000);
    const timeToEnd = 900 - marketSecond;

    console.log(`   Slug: ${market.slug}`);
    console.log(`   Condition ID: ${market.conditionId}`);
    console.log(`   End: ${market.endDate}`);
    console.log(`   Time: ${marketSecond}s / 900s (${timeToEnd}s remaining)`);
    if (market.outcomePrices && market.outcomePrices.length >= 2) {
      console.log(`   Prices: UP=$${market.outcomePrices[0]} DOWN=$${market.outcomePrices[1]}`);
    }
    if (market.clobTokenIds && market.clobTokenIds.length >= 2) {
      console.log(`   UP Token: ${market.clobTokenIds[0]}`);
      console.log(`   DOWN Token: ${market.clobTokenIds[1]}`);
    }
  } else {
    console.log('   No active market found');
  }
  console.log('');

  // 2. Open Orders (for current market)
  console.log('📋 OPEN ORDERS');
  console.log('─────────────────────────────────────────────────────────');
  if (market) {
    const ordersResult = await client.getOpenOrders(market.conditionId);
    if (ordersResult.success && ordersResult.orders && ordersResult.orders.length > 0) {
      for (const order of ordersResult.orders) {
        const side = order.side === 'BUY' ? '🟢 BUY' : '🔴 SELL';
        console.log(`   ${side} ${order.original_size} @ $${order.price} (${order.order_id?.slice(0, 8)}...)`);
      }
    } else {
      console.log('   No open orders');
    }
  } else {
    console.log('   No market to check');
  }
  console.log('');

  // 3. Active Positions
  console.log('📈 ACTIVE POSITIONS');
  console.log('─────────────────────────────────────────────────────────');
  const positions = await client.getActivePositionsRaw();
  if (positions.length > 0) {
    for (const pos of positions) {
      const outcome = pos.outcome || 'Unknown';
      const size = parseFloat(pos.size || '0');
      const avgCost = parseFloat(pos.avgCost || '0');
      const curPrice = parseFloat(pos.curPrice || '0');
      const pnl = (curPrice - avgCost) * size;
      const pnlSign = pnl >= 0 ? '+' : '';
      console.log(`   ${outcome}: ${size.toFixed(2)} shares @ $${avgCost.toFixed(4)} (cur: $${curPrice.toFixed(4)}) ${pnlSign}$${pnl.toFixed(2)}`);
      console.log(`      Condition: ${pos.conditionId?.slice(0, 16)}...`);
    }
  } else {
    console.log('   No active positions');
  }
  console.log('');

  // 4. Balance & AUM
  console.log('💰 BALANCE & AUM');
  console.log('─────────────────────────────────────────────────────────');
  const breakdown = await client.getAUMBreakdown();
  console.log(`   USDC.e Balance:    $${breakdown.balance.toFixed(2)}`);
  console.log(`   Active Positions:  $${breakdown.activePositionsValue.toFixed(2)}`);
  console.log(`   Redeemable:        $${breakdown.redeemableValue.toFixed(2)}`);
  console.log(`   ─────────────────────────`);
  console.log(`   Total AUM:         $${breakdown.total.toFixed(2)}`);
  console.log('');

  console.log('═══════════════════════════════════════════════════════════');
  console.log('');

  process.exit(0);
}

main().catch((error) => {
  console.error('❌ Error:', error.message);
  process.exit(1);
});
