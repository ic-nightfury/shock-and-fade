/**
 * testGTC.ts - Test GTC Buy to verify fill response behavior
 *
 * Usage: npm run testGTC <side> [size] [priceOffset]
 *   side: UP or DOWN
 *   size: optional, defaults to 5 shares (minimum)
 *   priceOffset: optional, how much above market price (default: 0.05 = 5c)
 *
 * This script tests whether GTC orders:
 * 1. Return immediate fill data in API response
 * 2. Or only report fills via WSS MATCHED events
 *
 * Key: Logs RAW API response to verify behavior
 */

import { config } from 'dotenv';
config();

import { ClobClient, Side, OrderType } from '@polymarket/clob-client';
import { PolymarketClient } from '../services/PolymarketClient';
import { PolymarketConfig } from '../types';

async function main() {
  const args = process.argv.slice(2);

  if (args.length < 1) {
    console.log('Usage: npm run testGTC <side> [size] [priceOffset]');
    console.log('');
    console.log('  side: UP or DOWN');
    console.log('  size: number of shares (default: 5, minimum: 5)');
    console.log('  priceOffset: cents above market (default: 5c)');
    console.log('');
    console.log('Example:');
    console.log('  npm run testGTC UP 5 0.05');
    console.log('  npm run testGTC DOWN');
    process.exit(1);
  }

  const side = args[0].toUpperCase() as 'UP' | 'DOWN';
  const size = args[1] ? parseFloat(args[1]) : 5;
  const priceOffset = args[2] ? parseFloat(args[2]) : 0.05;

  if (side !== 'UP' && side !== 'DOWN') {
    console.log('Error: side must be UP or DOWN');
    process.exit(1);
  }

  if (size < 5) {
    console.log('Error: minimum size is 5 shares');
    process.exit(1);
  }

  console.log('\n🧪 Test GTC Buy - Verify Fill Response');
  console.log('='.repeat(60));
  console.log(`Side: ${side}`);
  console.log(`Size: ${size} shares`);
  console.log(`Price Offset: +${(priceOffset * 100).toFixed(0)}c above market`);
  console.log('='.repeat(60));

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

  const aggressivePrice = Math.min(0.95, currentPrice + priceOffset);
  const totalCost = size * aggressivePrice;

  console.log(`   Current Price: $${currentPrice.toFixed(4)}`);
  console.log(`   Our Price: $${aggressivePrice.toFixed(4)} (+${(priceOffset * 100).toFixed(0)}c)`);
  console.log(`   Total Cost: $${totalCost.toFixed(2)}`);

  // Check $1 minimum
  if (totalCost < 1) {
    console.log(`   ⚠️ Warning: Total cost $${totalCost.toFixed(2)} < $1 minimum`);
    const minShares = Math.ceil(1 / aggressivePrice);
    console.log(`   Need at least ${minShares} shares at this price`);
  }

  // Get raw CLOB client for direct API access
  const clobClient = (client as any).clobClient as ClobClient;

  // Round shares to 2 decimals
  const actualShares = Math.round(size * 100) / 100;

  console.log('\n📤 Creating GTC order...');
  console.log(`   Shares: ${actualShares}`);
  console.log(`   Price: $${aggressivePrice.toFixed(4)}`);

  try {
    // Create the limit order
    const limitOrder = await clobClient.createOrder({
      tokenID: tokenId,
      side: Side.BUY,
      size: actualShares,
      price: Math.min(aggressivePrice, 0.99),
      feeRateBps: 0,
      nonce: 0,
    });

    console.log('\n📋 Limit Order Created:');
    console.log(JSON.stringify(limitOrder, null, 2));

    // Post with GTC
    console.log('\n📤 Posting GTC order...');
    const response = await clobClient.postOrder(limitOrder, OrderType.GTC);

    console.log('\n' + '='.repeat(60));
    console.log('📋 RAW API RESPONSE:');
    console.log('='.repeat(60));
    console.log(JSON.stringify(response, null, 2));
    console.log('='.repeat(60));

    // Parse key fields
    console.log('\n📊 Parsed Response:');
    console.log(`   success: ${response.success}`);
    console.log(`   orderID: ${response.orderID || 'N/A'}`);
    console.log(`   status: ${response.status || 'N/A'}`);
    console.log(`   takingAmount: ${response.takingAmount || 'N/A'}`);
    console.log(`   makingAmount: ${response.makingAmount || 'N/A'}`);

    if (response.takingAmount && response.makingAmount) {
      const filledShares = parseFloat(response.takingAmount);
      const spent = parseFloat(response.makingAmount);
      const avgPrice = filledShares > 0 ? spent / filledShares : 0;
      console.log('\n📈 Fill Calculation:');
      console.log(`   Filled Shares: ${filledShares.toFixed(4)}`);
      console.log(`   Total Spent: $${spent.toFixed(4)}`);
      console.log(`   Avg Price: $${avgPrice.toFixed(4)}`);
      console.log(`   Resting: ${filledShares < actualShares ? 'YES (partially filled)' : 'NO (fully filled)'}`);
    } else {
      console.log('\n⚠️ No takingAmount/makingAmount in response');
      console.log('   Order may be resting on book (not immediately filled)');
    }

    if (response.orderID) {
      console.log('\n📋 To check/cancel this order:');
      console.log(`   npm run checkorder ${response.orderID} ${market.conditionId}`);
      console.log(`   npm run openorders`);
    }

  } catch (error) {
    console.error('\n❌ Error:', error instanceof Error ? error.message : error);
  }

  console.log('\n✅ Done');
}

main().catch(console.error);
