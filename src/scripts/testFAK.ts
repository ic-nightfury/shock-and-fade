/**
 * testFAK.ts - Test FAK Buy for V19 Testing
 *
 * Usage: npm run testFAK <side> [size]
 *   side: UP or DOWN
 *   size: optional, defaults to 5 shares
 *
 * This script:
 * 1. Finds the current BTC 15-min market
 * 2. Gets the current best ask price
 * 3. Places a FAK order 3c above market (instant fill)
 * 4. Reports the order ID and fill status
 *
 * Use this to test V19 by:
 * 1. npm run testFAK UP 10
 * 2. npm run checkorder <orderId> <conditionId>
 */

import { config } from 'dotenv';
config();

import { PolymarketClient } from '../services/PolymarketClient';
import { PolymarketConfig, Side } from '../types';

async function main() {
  const args = process.argv.slice(2);

  if (args.length < 1) {
    console.log('Usage: npm run testFAK <side> [size]');
    console.log('');
    console.log('  side: UP or DOWN');
    console.log('  size: number of shares (default: 5)');
    console.log('');
    console.log('Example:');
    console.log('  npm run testFAK UP 10');
    console.log('  npm run testFAK DOWN');
    process.exit(1);
  }

  const side = args[0].toUpperCase() as Side;
  const size = args[1] ? parseFloat(args[1]) : 5;

  if (side !== 'UP' && side !== 'DOWN') {
    console.log('Error: side must be UP or DOWN');
    process.exit(1);
  }

  if (size < 5) {
    console.log('Error: minimum size is 5 shares');
    process.exit(1);
  }

  console.log('\n🧪 V19 Test FAK Buy');
  console.log('='.repeat(50));
  console.log(`Side: ${side}`);
  console.log(`Size: ${size} shares`);
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

  // Find current market
  console.log('\n🔍 Finding current market...');
  const market = await client.findNext15MinMarket();

  if (!market) {
    console.log('❌ No market found');
    process.exit(1);
  }

  console.log(`   Market: ${market.slug}`);
  console.log(`   Condition ID: ${market.conditionId}`);

  // Find the correct token
  const upToken = market.tokens?.find((t) => t.outcome === "Up");
  const downToken = market.tokens?.find((t) => t.outcome === "Down");

  if (!upToken || !downToken) {
    console.log('❌ Could not find UP/DOWN tokens');
    process.exit(1);
  }

  const tokenId = side === 'UP' ? upToken.token_id : downToken.token_id;
  console.log(`   Token ID: ${tokenId.slice(0, 20)}...`);

  // Get current price from CLOB API
  console.log('\n📈 Getting current price...');
  const currentPrice = await client.getClobPrice(tokenId);

  if (!currentPrice) {
    console.log('❌ Could not get price (market may be closed)');
    process.exit(1);
  }

  const aggressivePrice = Math.min(0.95, currentPrice + 0.03); // 3c above current price

  console.log(`   Current Price: $${currentPrice.toFixed(4)}`);
  console.log(`   Our Price: $${aggressivePrice.toFixed(4)} (+3c to ensure fill)`);

  // Execute FAK buy
  console.log('\n📤 Executing FAK buy...');
  const result = await client.buySharesFAK(tokenId, size, aggressivePrice);

  console.log('\n📋 Result:');
  console.log('='.repeat(50));
  console.log(`   Success: ${result.success}`);
  console.log(`   Order ID: ${result.orderID || 'N/A'}`);
  console.log(`   Filled Shares: ${result.filledShares?.toFixed(4) || 'N/A'}`);
  console.log(`   Fill Price: $${result.filledPrice?.toFixed(4) || 'N/A'}`);

  if (result.error) {
    console.log(`   Error: ${result.error}`);
  }

  if (result.orderID) {
    console.log('\n📋 To check this order:');
    console.log(`   npm run checkorder ${result.orderID} ${market.conditionId}`);
  }

  console.log('\n✅ Done');
}

main().catch(console.error);
