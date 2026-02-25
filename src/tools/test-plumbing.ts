/**
 * Plumbing Test Script
 * Tests the full Split → Place Order → Cancel → Merge cycle
 * with timing for each operation.
 * 
 * Uses the SMALLEST possible amount ($1) on a real market.
 * All orders placed WAY off-market (won't fill).
 * Everything merges back at the end — net zero cost (minus gas on EOA).
 */

import dotenv from 'dotenv';
dotenv.config();

import { SplitClient } from '../services/SplitClient';
import { MergeClient } from '../services/MergeClient';
import { PolymarketClient } from '../services/PolymarketClient';

// Will Trump deport 750K+ in 2025 — active, non-neg-risk, 2 tokens, liquid
const TEST_MARKET = {
  name: 'Will Trump deport 750,000 or more people in 2025?',
  conditionId: '0x22ac5f75af18fdb453497fbf7ac0606a09a6fd55b78b2d08aace6b946ad62038',
  tokenYes: '97449340182256366014320155718265676486703217567849039806162053075113517266910',
  tokenNo: '59259495934562596318644973716893809974860301509869285036503555129962149752635',
  isNegRisk: false,
};

const SPLIT_AMOUNT = 5; // $5 test

async function timeOp<T>(name: string, fn: () => Promise<T>): Promise<{ result: T; ms: number }> {
  const start = Date.now();
  const result = await fn();
  const ms = Date.now() - start;
  return { result, ms };
}

async function main() {
  console.log('='.repeat(60));
  console.log('🔧 PLUMBING TEST — Split → Order → Cancel → Merge');
  console.log('='.repeat(60));
  console.log(`Market: ${TEST_MARKET.name}`);
  console.log(`Amount: $${SPLIT_AMOUNT}`);
  console.log(`Auth: ${process.env.AUTH_MODE || 'PROXY'}`);
  console.log(`Time: ${new Date().toISOString()}`);
  console.log('');

  const pk = process.env.POLYMARKET_PRIVATE_KEY!;
  const splitClient = new SplitClient(pk);
  const mergeClient = new MergeClient(pk);

  const polyConfig = {
    host: process.env.POLYMARKET_HOST || 'https://clob.polymarket.com',
    chainId: parseInt(process.env.POLYMARKET_CHAIN_ID || '137'),
    privateKey: pk,
    funderAddress: process.env.POLYMARKET_FUNDER,
    authMode: (process.env.AUTH_MODE || 'PROXY') as 'EOA' | 'PROXY',
  };
  const polyClient = new PolymarketClient(polyConfig);

  // Step 0: Initialize CLOB client
  console.log('📡 Step 0: Initializing CLOB client...');
  const { ms: initMs } = await timeOp('init', () => polyClient.initialize());
  console.log(`   ✅ Initialized in ${initMs}ms`);
  console.log('');

  // Step 1: Ensure CTF approvals (needed for selling)
  console.log('🔐 Step 1: Ensuring CTF approvals...');
  const { result: approvalResult, ms: approvalMs } = await timeOp('approval', () => 
    splitClient.ensureCTFApprovals()
  );
  console.log(`   Result: ${approvalResult.success ? '✅' : '❌'} ${approvalResult.alreadyApproved ? '(already approved)' : `(tx: ${approvalResult.transactionHash?.slice(0, 10)}...)`}`);
  console.log(`   Time: ${approvalMs}ms`);
  console.log('');

  // Step 2: SPLIT — convert $1 USDC into 1 YES + 1 NO token
  console.log(`💰 Step 2: SPLIT $${SPLIT_AMOUNT} USDC → ${SPLIT_AMOUNT} YES + ${SPLIT_AMOUNT} NO tokens...`);
  const { result: splitResult, ms: splitMs } = await timeOp('split', () =>
    splitClient.split(TEST_MARKET.conditionId, SPLIT_AMOUNT, TEST_MARKET.isNegRisk)
  );
  console.log(`   Result: ${splitResult.success ? '✅' : '❌'} ${splitResult.error || ''}`);
  if (splitResult.transactionHash) {
    console.log(`   TX: ${splitResult.transactionHash}`);
    console.log(`   Polygonscan: https://polygonscan.com/tx/${splitResult.transactionHash}`);
  }
  console.log(`   ⏱️  SPLIT TIME: ${splitMs}ms (${(splitMs/1000).toFixed(1)}s)`);
  console.log('');

  if (!splitResult.success) {
    console.log('❌ Split failed — aborting test');
    process.exit(1);
  }

  // Step 3: Place GTC SELL limit orders at ridiculous prices (won't fill)
  console.log('   Waiting 3s to avoid Cloudflare rate-limit...');
  await new Promise(r => setTimeout(r, 3000));
  console.log('📋 Step 3: Placing GTC SELL limit orders (way off-market, will NOT fill)...');
  
  // Place YES sell at 99¢ (way above market)
  console.log('   Placing SELL YES @ $0.99...');
  const { result: sellYes, ms: sellYesMs } = await timeOp('sellYesGTC', () =>
    polyClient.sellSharesGTC(TEST_MARKET.tokenYes, SPLIT_AMOUNT, 0.99, TEST_MARKET.isNegRisk)
  );
  console.log(`   YES: ${sellYes.success ? '✅' : '❌'} OrderID: ${sellYes.orderID?.slice(0, 20)}... (${sellYesMs}ms)`);
  
  // Place NO sell at 99¢ (way above market)
  console.log('   Placing SELL NO @ $0.99...');
  const { result: sellNo, ms: sellNoMs } = await timeOp('sellNoGTC', () =>
    polyClient.sellSharesGTC(TEST_MARKET.tokenNo, SPLIT_AMOUNT, 0.99, TEST_MARKET.isNegRisk)
  );
  console.log(`   NO:  ${sellNo.success ? '✅' : '❌'} OrderID: ${sellNo.orderID?.slice(0, 20)}... (${sellNoMs}ms)`);
  console.log(`   ⏱️  ORDER PLACEMENT: YES=${sellYesMs}ms, NO=${sellNoMs}ms`);
  console.log('');

  // Step 4: Cancel both orders
  console.log('🗑️  Step 4: Cancelling orders...');
  
  const orderIds: string[] = [];
  if (sellYes.orderID) orderIds.push(sellYes.orderID);
  if (sellNo.orderID) orderIds.push(sellNo.orderID);

  if (orderIds.length > 0) {
    const { result: cancelResult, ms: cancelMs } = await timeOp('cancel', () =>
      polyClient.cancelOrdersByIds(orderIds)
    );
    console.log(`   Result: ${cancelResult.success ? '✅' : '❌'} Cancelled ${orderIds.length} orders`);
    console.log(`   ⏱️  CANCEL TIME: ${cancelMs}ms`);
  } else {
    console.log('   ⚠️ No orders to cancel');
  }
  console.log('');

  // Step 5: MERGE — convert tokens back to USDC
  console.log(`🔀 Step 5: MERGE ${SPLIT_AMOUNT} YES + ${SPLIT_AMOUNT} NO → $${SPLIT_AMOUNT} USDC...`);
  const { result: mergeResult, ms: mergeMs } = await timeOp('merge', () =>
    mergeClient.merge(TEST_MARKET.conditionId, SPLIT_AMOUNT, TEST_MARKET.isNegRisk)
  );
  console.log(`   Result: ${mergeResult.success ? '✅' : '❌'} ${mergeResult.error || ''}`);
  if (mergeResult.transactionHash) {
    console.log(`   TX: ${mergeResult.transactionHash}`);
    console.log(`   Polygonscan: https://polygonscan.com/tx/${mergeResult.transactionHash}`);
  }
  console.log(`   ⏱️  MERGE TIME: ${mergeMs}ms (${(mergeMs/1000).toFixed(1)}s)`);
  console.log('');

  // Summary
  console.log('='.repeat(60));
  console.log('📊 TIMING SUMMARY');
  console.log('='.repeat(60));
  console.log(`   Init:      ${initMs}ms`);
  console.log(`   Approval:  ${approvalMs}ms`);
  console.log(`   SPLIT:     ${splitMs}ms (${(splitMs/1000).toFixed(1)}s)`);
  console.log(`   Order YES: ${sellYesMs}ms`);
  console.log(`   Order NO:  ${sellNoMs}ms`);
  console.log(`   Cancel:    ${orderIds.length > 0 ? 'done' : 'skipped'}`);
  console.log(`   MERGE:     ${mergeMs}ms (${(mergeMs/1000).toFixed(1)}s)`);
  console.log('');
  console.log(`   💵 Net cost: $0 (split + merge = round-trip)`);
  console.log(`   ✅ All operations ${splitResult.success && mergeResult.success ? 'PASSED' : 'HAD FAILURES'}`);
  console.log('='.repeat(60));
}

main().catch(err => {
  console.error('❌ Fatal error:', err);
  process.exit(1);
});
