/**
 * CLI: AUM Analysis (R&D)
 *
 * Usage:
 *   npm run aum
 *
 * Shows AUM components and calculations for both PNL and Baseline methods.
 * No database interaction - just API calls.
 */

import dotenv from 'dotenv';
import { PolymarketClient } from '../services/PolymarketClient';
import { PolymarketConfig } from '../types';

dotenv.config();

async function main() {
  console.log('');
  console.log('═══════════════════════════════════════════════════════════');
  console.log('                    AUM Analysis (R&D)');
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

  console.log('📊 Fetching AUM components...\n');

  // Fetch all components
  const balance = await client.getBalance();
  const activeCurrentValue = await client.getActivePositionsCurrentValue();
  const activeInitialValue = await client.getActivePositionsInitialValue();
  const redeemableValue = await client.getRedeemableValue();

  // Calculate both AUM methods
  const aumForPnl = balance + redeemableValue + activeCurrentValue;
  const aumForBaseline = balance + activeInitialValue;

  // Difference analysis
  const unrealizedPnl = activeCurrentValue - activeInitialValue;

  // Display components
  console.log('1. Components:');
  console.log(`   USDC.e Balance:           $${balance.toFixed(2)}`);
  console.log(`   Active Positions:`);
  console.log(`     - currentValue:         $${activeCurrentValue.toFixed(2)}   (market value)`);
  console.log(`     - initialValue:         $${activeInitialValue.toFixed(2)}   (cost basis)`);
  console.log(`   Redeemable Value:         $${redeemableValue.toFixed(2)}   (pending redemption)`);
  console.log('');

  // Display calculations
  console.log('2. AUM Calculations:');
  console.log('   ┌─────────────────────────────────────────────────────┐');
  console.log('   │ AUM for PNL Display:                                │');
  console.log('   │   Balance + Redeemable + Active(current)            │');
  console.log(`   │   $${balance.toFixed(2)} + $${redeemableValue.toFixed(2)} + $${activeCurrentValue.toFixed(2)} = $${aumForPnl.toFixed(2)}`);
  console.log('   ├─────────────────────────────────────────────────────┤');
  console.log('   │ AUM for Baseline:                                   │');
  console.log('   │   Balance + Active(initial)                         │');
  console.log(`   │   $${balance.toFixed(2)} + $${activeInitialValue.toFixed(2)} = $${aumForBaseline.toFixed(2)}`);
  console.log('   └─────────────────────────────────────────────────────┘');
  console.log('');

  // Display difference analysis
  console.log('3. Difference Analysis:');
  const pnlSign = unrealizedPnl >= 0 ? '+' : '';
  console.log(`   Unrealized P&L:  ${pnlSign}$${unrealizedPnl.toFixed(2)}   (current - initial)`);
  console.log(`   Pending Redeem:  $${redeemableValue.toFixed(2)}   (not in baseline AUM)`);
  console.log(`   AUM Difference:  $${(aumForPnl - aumForBaseline).toFixed(2)}   (PNL AUM - Baseline AUM)`);
  console.log('');
  console.log('═══════════════════════════════════════════════════════════');
  console.log('');

  process.exit(0);
}

main().catch((error) => {
  console.error('❌ Error:', error.message);
  process.exit(1);
});
