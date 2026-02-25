/**
 * CLI: Rebase Baseline
 *
 * Usage:
 *   npm run rebase         - Redeem positions, show AUM, update if profit
 *   npm run rebase DEFAULT - Same + reset baseline to max(CAPITAL_BASE, AUM)
 */

import dotenv from 'dotenv';
import { PolymarketClient } from '../services/PolymarketClient';
import { DatabaseService, Position } from '../services/Database';
import { ProxyRedemptionClient } from '../services/ProxyRedemptionClient';
import { PnlTracker } from '../services/PnlTracker';
import { PolymarketConfig, getConfigurableThresholds } from '../types';

dotenv.config();

/**
 * Redeem all unredeemed closed positions
 */
async function redeemAllPositions(
  db: DatabaseService,
  redemptionClient: ProxyRedemptionClient,
  pnlTracker: PnlTracker
): Promise<number> {
  const unredeemed = db.getUnredeemedClosedPositions();

  if (unredeemed.length === 0) {
    console.log('   No unredeemed positions found.');
    return 0;
  }

  console.log(`   Found ${unredeemed.length} unredeemed position(s)`);
  let redeemedCount = 0;

  for (const position of unredeemed) {
    try {
      // Check if market is closed via Gamma API
      const response = await fetch(
        `https://gamma-api.polymarket.com/markets?slug=${position.market_slug}`
      );
      const markets = await response.json() as any[];

      if (!markets || markets.length === 0 || !markets[0].closed) {
        console.log(`   ${position.market_slug}: Market not closed yet, skipping`);
        continue;
      }

      console.log(`   ${position.market_slug}: Redeeming...`);

      // Get outcome index (always 'Up' for this strategy)
      const outcomeIndex = await ProxyRedemptionClient.getOutcomeIndex(
        'Up',
        position.condition_id
      );

      // Execute redemption with retries (5s delay for CLI)
      const result = await redemptionClient.redeemWithRetry(
        position.condition_id,
        outcomeIndex,
        3,
        5000
      );

      if (result.success) {
        const txHash = result.transactionHash?.substring(0, 20) || 'unknown';
        console.log(`   Redeemed: ${txHash}...`);

        // Fetch realized PNL
        const realizedPnl = await pnlTracker.getRealizedPnl(position.condition_id);
        if (realizedPnl.found) {
          db.updatePositionPnl(position.id!, realizedPnl.realizedPnl);
        }

        // Mark as redeemed
        db.markPositionRedeemed(position.id!);
        redeemedCount++;

      } else if (result.error === 'ALREADY_REDEEMED') {
        console.log(`   Already redeemed, marking in database`);
        db.markPositionRedeemed(position.id!);
        redeemedCount++;

      } else {
        console.log(`   Failed: ${result.error}`);
      }

    } catch (error: any) {
      console.log(`   Error: ${error.message}`);
    }
  }

  return redeemedCount;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const resetToDefault = args[0]?.toUpperCase() === 'DEFAULT';

  // Initialize services
  const config: PolymarketConfig = {
    host: process.env.POLYMARKET_HOST || 'https://clob.polymarket.com',
    chainId: parseInt(process.env.POLYMARKET_CHAIN_ID || '137'),
    privateKey: process.env.POLYMARKET_PRIVATE_KEY!,
    funderAddress: process.env.POLYMARKET_FUNDER!,
  };

  const dbPath = process.env.DATABASE_PATH || './data/trading.db';
  const db = new DatabaseService(dbPath);
  const client = new PolymarketClient(config);
  await client.initialize();

  // Initialize redemption services
  const redemptionClient = new ProxyRedemptionClient(process.env.POLYMARKET_PRIVATE_KEY!);
  const pnlTracker = new PnlTracker(config.funderAddress);

  const configThresholds = getConfigurableThresholds();

  console.log('═══════════════════════════════════════════════════════════');
  console.log('   AUM Rebase Check');
  console.log('═══════════════════════════════════════════════════════════');
  console.log('');

  // Step 1: Redeem all unredeemed positions
  console.log('1. Checking for unredeemed positions...');
  const redeemedCount = await redeemAllPositions(db, redemptionClient, pnlTracker);
  if (redeemedCount > 0) {
    console.log(`   Redeemed ${redeemedCount} position(s)`);
  }
  console.log('');

  // Step 2: Fetch fresh AUM breakdown
  console.log('2. AUM Breakdown:');
  const aumBreakdown = await client.getAUMBreakdown();
  const currentBaseline = db.getBaseline();
  console.log(`   USDC.e Balance:       $${aumBreakdown.balance.toFixed(2)}`);
  console.log(`   Active Positions:     $${aumBreakdown.activePositionsValue.toFixed(2)}  (initialValue)`);
  console.log(`   Redeemable Value:     $${aumBreakdown.redeemableValue.toFixed(2)}  (settlement value)`);
  console.log('   ─────────────────────────────────────────────────────────');
  console.log(`   Total AUM:            $${aumBreakdown.total.toFixed(2)}`);
  console.log('');
  console.log(`   Current Baseline:     $${currentBaseline.toFixed(2)}`);
  console.log(`   CAPITAL_BASE:         $${configThresholds.CAPITAL_BASE.toFixed(2)}`);
  console.log('');

  const currentAUM = aumBreakdown.total;
  const currentPnl = currentAUM - currentBaseline;
  console.log(`   Current PNL: $${currentPnl.toFixed(2)} (${currentPnl >= 0 ? 'profit' : 'loss'})`);
  console.log('');

  // Step 3: Update baseline
  console.log('3. Baseline Update:');
  if (resetToDefault) {
    // DEFAULT mode: Reset to max(CAPITAL_BASE, current AUM)
    const newBaseline = Math.max(configThresholds.CAPITAL_BASE, currentAUM);

    console.log('   DEFAULT Mode - Resetting baseline...');
    console.log(`   CAPITAL_BASE: $${configThresholds.CAPITAL_BASE.toFixed(2)}`);
    console.log(`   Current AUM:  $${currentAUM.toFixed(2)}`);
    console.log(`   -> New Baseline: $${newBaseline.toFixed(2)}`);

    db.setBaseline(newBaseline);

    const newPnl = currentAUM - newBaseline;
    console.log('');
    console.log(`   Baseline reset to: $${newBaseline.toFixed(2)}`);
    console.log(`   New PNL: $${newPnl.toFixed(2)}`);
  } else {
    // Normal mode: Only update if AUM > baseline (lock in profit)
    if (currentAUM > currentBaseline) {
      console.log('   AUM exceeds baseline - locking in profit...');
      db.setBaseline(currentAUM);
      console.log(`   Baseline updated: $${currentBaseline.toFixed(2)} -> $${currentAUM.toFixed(2)}`);
      console.log(`   Profit locked: $${(currentAUM - currentBaseline).toFixed(2)}`);
    } else {
      console.log('   No update needed (AUM <= baseline)');
      console.log(`   Baseline stays at: $${currentBaseline.toFixed(2)}`);
    }
  }

  console.log('');
  console.log('═══════════════════════════════════════════════════════════');

  db.close();
}

main().catch((error) => {
  console.error('Error:', error.message);
  process.exit(1);
});
