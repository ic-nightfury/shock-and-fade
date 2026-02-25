/**
 * testBuy.ts - FAK Buy at Current Market Price
 *
 * Usage: npm run testbuy <side>
 *   side: UP or DOWN
 *
 * This script:
 * 1. Finds the current BTC 15-min market
 * 2. Gets the current best ask price
 * 3. Calculates minimum shares based on price (min 5 shares, min $1 cost)
 * 4. Places a FAK order 3c above market (instant fill)
 * 5. Reports the fill status with RAW API response
 */

import { config } from 'dotenv';
config();

import { ClobClient, Side as ClobSide, OrderType } from '@polymarket/clob-client';
import { PolymarketClient } from '../services/PolymarketClient';
import { PolymarketConfig, Side } from '../types';

async function main() {
  const args = process.argv.slice(2);

  if (args.length < 1) {
    console.log('Usage: npm run testbuy <side>');
    console.log('');
    console.log('  side: UP or DOWN');
    console.log('');
    console.log('Example:');
    console.log('  npm run testbuy UP');
    console.log('  npm run testbuy DOWN');
    process.exit(1);
  }

  const side = args[0].toUpperCase() as Side;

  if (side !== 'UP' && side !== 'DOWN') {
    console.log('Error: side must be UP or DOWN');
    process.exit(1);
  }

  console.log('\n🧪 Test Buy - FAK at Market');
  console.log('='.repeat(50));
  console.log(`Side: ${side}`);

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

  // Calculate minimum shares: max(5, ceil(1 / price))
  // - Polymarket minimum: 5 shares
  // - Polymarket minimum: $1 cost
  const minSharesForDollar = Math.ceil(1 / currentPrice);
  const minShares = Math.max(5, minSharesForDollar);
  const estimatedCost = minShares * currentPrice;

  console.log(`   Current Price: $${currentPrice.toFixed(4)}`);
  console.log(`   Min shares for $1: ${minSharesForDollar}`);
  console.log(`   Order size: ${minShares} shares`);
  console.log(`   Estimated cost: $${estimatedCost.toFixed(2)}`);

  // Aggressive price: 3c above current to ensure fill
  const aggressivePrice = Math.min(0.99, currentPrice + 0.03);
  console.log(`   Our Price: $${aggressivePrice.toFixed(4)} (+3c to ensure fill)`);

  // Get CLOB client for raw API access
  const clobClient = (client as any).clobClient as ClobClient;

  // Execute FAK buy with raw response logging
  console.log('\n📤 Executing FAK buy...');

  try {
    // Step 1: Create order
    console.log('\n📝 Creating order...');
    const limitOrder = await clobClient.createOrder({
      tokenID: tokenId,
      side: ClobSide.BUY,
      size: minShares,
      price: aggressivePrice,
      feeRateBps: 0,
      nonce: 0,
    });

    console.log('\n📦 Order object:');
    console.log(JSON.stringify(limitOrder, null, 2));

    // Step 2: Post order with FAK (Fill-And-Kill)
    console.log('\n📤 Posting order (FAK)...');
    const response = await clobClient.postOrder(limitOrder, OrderType.FAK);

    console.log('\n' + '='.repeat(60));
    console.log('📨 RAW API RESPONSE:');
    console.log('='.repeat(60));
    console.log(JSON.stringify(response, null, 2));
    console.log('='.repeat(60));

    // Parse the response
    if (response.orderID) {
      console.log('\n✅ Order submitted successfully');
      console.log(`   Order ID: ${response.orderID}`);

      if (response.takingAmount && response.makingAmount) {
        const filledShares = parseFloat(response.takingAmount);
        const spent = parseFloat(response.makingAmount);
        const avgPrice = filledShares > 0 ? spent / filledShares : 0;
        console.log(`   Filled Shares: ${filledShares.toFixed(4)}`);
        console.log(`   Spent: $${spent.toFixed(4)}`);
        console.log(`   Avg Price: $${avgPrice.toFixed(4)}`);
      }

      console.log('\n📋 To check this order:');
      console.log(`   npm run checkorder ${response.orderID} ${market.conditionId}`);
    } else {
      console.log('\n❌ Order failed');
      console.log(`   Error: ${response.error || response.errorMsg || 'Unknown'}`);
    }
  } catch (error: any) {
    console.log('\n❌ Exception:');
    console.log(error.message || error);
    if (error.response?.data) {
      console.log('\n📨 Error response data:');
      console.log(JSON.stringify(error.response.data, null, 2));
    }
  }

  console.log('\n✅ Done');
}

main().catch(console.error);
