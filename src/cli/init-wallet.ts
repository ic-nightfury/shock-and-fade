/**
 * CLI: Initialize Wallet
 *
 * Queries USDC.e balance from Polygon and initializes the AUM baseline.
 *
 * Usage: npm run init-wallet
 */

import dotenv from 'dotenv';
import { DatabaseService } from '../services/Database';
import { PolymarketClient } from '../services/PolymarketClient';
import { PolymarketConfig, getConfigurableThresholds } from '../types';

dotenv.config();

async function main(): Promise<void> {
  console.log('');
  console.log('='.repeat(60));
  console.log('   Wallet Initialization');
  console.log('='.repeat(60));

  // Validate required env vars
  const funderAddress = process.env.POLYMARKET_FUNDER;
  const privateKey = process.env.POLYMARKET_PRIVATE_KEY;

  if (!funderAddress || !privateKey) {
    console.error('');
    console.error('Error: Missing required environment variables');
    console.error('');
    console.error('Please add to .env:');
    console.error('  POLYMARKET_FUNDER=0x...');
    console.error('  POLYMARKET_PRIVATE_KEY=0x...');
    process.exit(1);
  }

  // Initialize services
  const config: PolymarketConfig = {
    host: process.env.POLYMARKET_HOST || 'https://clob.polymarket.com',
    chainId: parseInt(process.env.POLYMARKET_CHAIN_ID || '137'),
    privateKey: privateKey,
    funderAddress: funderAddress,
  };

  const dbPath = process.env.DATABASE_PATH || './data/trading.db';
  const db = new DatabaseService(dbPath);
  const client = new PolymarketClient(config);
  await client.initialize();

  const configThresholds = getConfigurableThresholds();

  console.log('');
  console.log('-'.repeat(60));
  console.log('1. Wallet Information');
  console.log('-'.repeat(60));
  console.log(`   Funder Address: ${funderAddress}`);

  // Query AUM breakdown
  console.log('');
  console.log('-'.repeat(60));
  console.log('2. Querying AUM Breakdown');
  console.log('-'.repeat(60));

  const aumBreakdown = await client.getAUMBreakdown();
  console.log(`   USDC.e Balance:       $${aumBreakdown.balance.toFixed(2)}`);
  console.log(`   Active Positions:     $${aumBreakdown.activePositionsValue.toFixed(2)}  (initialValue)`);
  console.log(`   Redeemable Value:     $${aumBreakdown.redeemableValue.toFixed(2)}  (settlement value)`);
  console.log('   ─────────────────────────────────────────────────────────');
  console.log(`   Total AUM:            $${aumBreakdown.total.toFixed(2)}`);

  const currentAUM = aumBreakdown.total;

  if (currentAUM === 0) {
    console.log('');
    console.log('Warning: Wallet has zero AUM!');
    console.log('   Please fund the wallet before trading.');
    console.log('   Use USDC.e (0x2791...174), NOT native USDC!');
  }

  // Initialize baseline
  console.log('');
  console.log('-'.repeat(60));
  console.log('3. Initializing Baseline');
  console.log('-'.repeat(60));

  const existingBaseline = db.getBaseline();
  const newBaseline = Math.max(configThresholds.CAPITAL_BASE, currentAUM);

  console.log(`   CAPITAL_BASE:      $${configThresholds.CAPITAL_BASE.toFixed(2)}`);
  console.log(`   Existing Baseline: $${existingBaseline.toFixed(2)}`);
  console.log(`   Current AUM:       $${currentAUM.toFixed(2)}`);
  console.log(`   -> New Baseline:   $${newBaseline.toFixed(2)}`);

  db.setBaseline(newBaseline);

  // Summary
  console.log('');
  console.log('='.repeat(60));
  console.log('   Initialization Complete');
  console.log('='.repeat(60));
  console.log('');
  console.log('Wallet Details:');
  console.log(`   Address:     ${funderAddress}`);
  console.log(`   AUM:         $${currentAUM.toFixed(2)}`);
  console.log(`   Baseline:    $${newBaseline.toFixed(2)}`);
  console.log(`   PNL:         $${(currentAUM - newBaseline).toFixed(2)}`);
  console.log('');
  console.log('Next steps:');
  console.log('   1. If balance is zero, fund wallet with USDC.e on Polygon');
  console.log('      Contract: 0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174');
  console.log('   2. Start trading: npm run dev');
  console.log('   3. Check status: npm run rebase');
  console.log('');

  db.close();
}

main().catch((error) => {
  console.error('Error:', error.message);
  process.exit(1);
});
