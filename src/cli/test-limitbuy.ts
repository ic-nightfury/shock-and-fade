/**
 * CLI: Test Limit Buy
 *
 * Usage:
 *   npm run test-limitbuy              # Buy $1 of cheaper side
 *   npm run test-limitbuy 5            # Buy $5 of cheaper side
 *   npm run test-limitbuy 5 UP         # Buy $5 of UP side
 *   npm run test-limitbuy 5 DOWN       # Buy $5 of DOWN side
 *
 * Places a limit buy order on the current BTC 15-min market.
 */

import dotenv from 'dotenv';
import { PolymarketClient } from '../services/PolymarketClient';
import { PolymarketConfig } from '../types';

dotenv.config();

async function main() {
  console.log('');
  console.log('═══════════════════════════════════════════════════════════');
  console.log('                    TEST LIMIT BUY');
  console.log('═══════════════════════════════════════════════════════════');
  console.log('');

  // Parse arguments
  const args = process.argv.slice(2);
  const amountUSD = args[0] ? parseFloat(args[0]) : 1.0;
  const forceSide = args[1]?.toUpperCase() as 'UP' | 'DOWN' | undefined;

  if (isNaN(amountUSD) || amountUSD <= 0) {
    console.error('❌ Invalid amount. Usage: npm run test-limitbuy [amount] [UP|DOWN]');
    process.exit(1);
  }

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

  // Find current market
  console.log('🔍 Finding current market...');
  const market = await client.findNext15MinMarket();

  if (!market) {
    console.error('❌ No active BTC 15-min market found');
    process.exit(1);
  }

  if (!market.clobTokenIds || market.clobTokenIds.length < 2) {
    console.error('❌ Market missing token IDs');
    process.exit(1);
  }

  const upTokenId = market.clobTokenIds[0];
  const downTokenId = market.clobTokenIds[1];

  console.log(`   Market: ${market.slug}`);
  console.log('');

  // Get current prices
  console.log('📊 Fetching prices...');
  const upPrice = await client.getClobPrice(upTokenId);
  const downPrice = await client.getClobPrice(downTokenId);

  if (!upPrice || !downPrice) {
    console.error('❌ Could not fetch prices. Market may be closed.');
    process.exit(1);
  }

  console.log(`   UP:   $${upPrice.toFixed(4)}`);
  console.log(`   DOWN: $${downPrice.toFixed(4)}`);
  console.log('');

  // Determine which side to buy
  let side: 'UP' | 'DOWN';
  let tokenId: string;
  let price: number;

  if (forceSide) {
    side = forceSide;
    tokenId = forceSide === 'UP' ? upTokenId : downTokenId;
    price = forceSide === 'UP' ? upPrice : downPrice;
    console.log(`🎯 Forced side: ${side}`);
  } else {
    // Auto-select cheaper side
    if (upPrice <= downPrice) {
      side = 'UP';
      tokenId = upTokenId;
      price = upPrice;
    } else {
      side = 'DOWN';
      tokenId = downTokenId;
      price = downPrice;
    }
    console.log(`🎯 Auto-selected cheaper side: ${side} ($${price.toFixed(4)})`);
  }
  console.log('');

  // Calculate shares
  const shares = amountUSD / price;

  // Execute buy
  console.log('💰 Placing limit buy order...');
  console.log(`   Side:   ${side}`);
  console.log(`   Amount: $${amountUSD.toFixed(2)}`);
  console.log(`   Price:  $${price.toFixed(4)}`);
  console.log(`   Shares: ~${shares.toFixed(2)}`);
  console.log('');

  const result = await client.buyAtLimitGTC(tokenId, price, amountUSD);

  if (result.success) {
    console.log('✅ Order placed successfully!');
    console.log(`   Order ID: ${result.orderID}`);
    if (result.filledShares && result.filledShares > 0) {
      console.log(`   Filled: ${result.filledShares.toFixed(2)} shares @ $${result.filledPrice?.toFixed(4)}`);
    } else {
      console.log('   Status: Resting on book (GTC - waiting for fill)');
    }
  } else {
    console.error(`❌ Order failed: ${result.error}`);
  }

  console.log('');
  console.log('═══════════════════════════════════════════════════════════');
  console.log('');

  process.exit(result.success ? 0 : 1);
}

main().catch((error) => {
  console.error('❌ Error:', error.message);
  process.exit(1);
});
