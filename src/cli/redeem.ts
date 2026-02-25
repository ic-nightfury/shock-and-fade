/**
 * CLI: Redeem All Pending Positions
 *
 * Usage:
 *   npm run redeem              # Redeem all pending positions
 *   npm run redeem --dry-run    # Preview without executing
 *
 * Fetches all redeemable positions from Polymarket API and redeems them
 * via the Builder Relayer (gas-free). Retries up to 3 times per position.
 */

import * as dotenv from 'dotenv';
import { ethers } from 'ethers';
import { ProxyRedemptionClient } from '../services/ProxyRedemptionClient';

dotenv.config();

const POSITIONS_API = 'https://data-api.polymarket.com/positions';
const CLOSED_POSITIONS_API = 'https://data-api.polymarket.com/closed-positions';
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 5000;

const DRY_RUN = process.argv.includes('--dry-run');

interface Position {
  asset: string;
  conditionId: string;
  size: number;
  curPrice: number;
  avgPrice: number;
  totalBought: number;
  initialValue: number;
  currentValue: number;
  realizedPnl: number;
  title: string;
  slug: string;
  outcome: string;
  outcomeIndex: number;
  redeemable?: boolean;
}

interface RedeemablePosition {
  conditionId: string;
  title: string;
  slug: string;
  outcome: string;
  outcomeIndex: number;
  size: number;
  curPrice: number;
  expectedValue: number;
  source: 'active' | 'closed';
}

async function fetchRedeemablePositions(wallet: string): Promise<RedeemablePosition[]> {
  const redeemables: RedeemablePosition[] = [];

  // 1. Fetch active positions with redeemable = true
  console.log('📡 Fetching active positions...');
  try {
    const activeUrl = `${POSITIONS_API}?sizeThreshold=0.01&limit=100&user=${wallet}`;
    const activeResponse = await fetch(activeUrl);
    if (activeResponse.ok) {
      const activePositions = await activeResponse.json() as Position[];

      for (const pos of activePositions) {
        if (pos.redeemable && pos.size > 0) {
          redeemables.push({
            conditionId: pos.conditionId,
            title: pos.title,
            slug: pos.slug,
            outcome: pos.outcome,
            outcomeIndex: pos.outcomeIndex,
            size: pos.size,
            curPrice: pos.curPrice || 0,
            expectedValue: (pos.totalBought || pos.size) * (pos.curPrice || 0),
            source: 'active',
          });
        }
      }
    }
  } catch (error: any) {
    console.log(`   Warning: Failed to fetch active positions: ${error.message}`);
  }

  // 2. Fetch closed positions that haven't been redeemed yet
  console.log('📡 Fetching closed positions...');
  try {
    const closedUrl = `${CLOSED_POSITIONS_API}?limit=500&user=${wallet}`;
    const closedResponse = await fetch(closedUrl);
    if (closedResponse.ok) {
      const closedPositions = await closedResponse.json() as Position[];

      for (const pos of closedPositions) {
        // realizedPnl = 0 means not yet redeemed
        if ((pos.realizedPnl || 0) === 0 && pos.size > 0) {
          // Check if we already have this conditionId
          const existing = redeemables.find(r => r.conditionId === pos.conditionId && r.outcome === pos.outcome);
          if (!existing) {
            redeemables.push({
              conditionId: pos.conditionId,
              title: pos.title,
              slug: pos.slug,
              outcome: pos.outcome,
              outcomeIndex: pos.outcomeIndex,
              size: pos.size,
              curPrice: pos.curPrice || 0,
              expectedValue: (pos.totalBought || pos.size) * (pos.curPrice || 0),
              source: 'closed',
            });
          }
        }
      }
    }
  } catch (error: any) {
    console.log(`   Warning: Failed to fetch closed positions: ${error.message}`);
  }

  return redeemables;
}

async function main() {
  console.log('');
  console.log('═══════════════════════════════════════════════════════════');
  console.log('                  Redeem All Positions');
  console.log('═══════════════════════════════════════════════════════════');
  console.log('');

  if (DRY_RUN) {
    console.log('🔍 DRY RUN MODE - No redemptions will be executed\n');
  }

  // Validate environment
  const privateKey = process.env.POLYMARKET_PRIVATE_KEY;
  const authMode = (process.env.AUTH_MODE || 'PROXY') as 'EOA' | 'PROXY';
  const funderAddress = process.env.POLYMARKET_FUNDER;

  if (!privateKey) {
    console.error('❌ Missing POLYMARKET_PRIVATE_KEY');
    process.exit(1);
  }

  // Determine target wallet based on AUTH_MODE
  let targetWallet: string;
  if (authMode === 'EOA') {
    // In EOA mode, derive wallet address from private key
    const wallet = new ethers.Wallet(privateKey);
    targetWallet = wallet.address;
  } else {
    // In PROXY mode, use POLYMARKET_FUNDER
    if (!funderAddress) {
      console.error('❌ Missing POLYMARKET_FUNDER (required in PROXY mode)');
      console.error('   Set AUTH_MODE=EOA to use signer as funder');
      process.exit(1);
    }
    targetWallet = funderAddress;
  }

  // Check Builder Relayer credentials
  if (!process.env.BUILDER_API_KEY || !process.env.BUILDER_SECRET || !process.env.BUILDER_PASS_PHRASE) {
    console.error('❌ Missing Builder Relayer credentials (BUILDER_API_KEY, BUILDER_SECRET, BUILDER_PASS_PHRASE)');
    process.exit(1);
  }

  console.log(`👛 Wallet: ${targetWallet}`);
  console.log(`   Mode: ${authMode}`);
  console.log('');

  // Fetch redeemable positions
  const positions = await fetchRedeemablePositions(targetWallet);

  console.log(`\n   Found ${positions.length} redeemable position(s)\n`);

  if (positions.length === 0) {
    console.log('   No positions to redeem.');
    process.exit(0);
  }

  // Display positions
  console.log('📊 Redeemable Positions:\n');
  let totalExpectedValue = 0;

  for (let i = 0; i < positions.length; i++) {
    const pos = positions[i];
    totalExpectedValue += pos.expectedValue;

    console.log(`   [${i + 1}] ${pos.title}`);
    console.log(`       ${pos.outcome}: ${pos.size.toFixed(2)} shares`);
    console.log(`       Settlement price: $${pos.curPrice.toFixed(2)}`);
    console.log(`       Expected value: $${pos.expectedValue.toFixed(2)}`);
    console.log(`       Source: ${pos.source}`);
    console.log('');
  }

  console.log(`   Total expected value: $${totalExpectedValue.toFixed(2)}`);
  console.log('');

  if (DRY_RUN) {
    console.log('═══════════════════════════════════════════════════════════');
    console.log('   DRY RUN - No redemptions executed');
    console.log('═══════════════════════════════════════════════════════════');
    process.exit(0);
  }

  // Initialize redemption client
  console.log('🔧 Initializing ProxyRedemptionClient...');
  const redemptionClient = new ProxyRedemptionClient(privateKey);
  console.log('');

  // Execute redemptions
  console.log('═══════════════════════════════════════════════════════════');
  console.log('                    Executing Redemptions');
  console.log('═══════════════════════════════════════════════════════════');
  console.log('');

  let successCount = 0;
  let failCount = 0;
  let alreadyRedeemedCount = 0;
  let totalRedeemed = 0;

  for (const pos of positions) {
    console.log(`🔄 Redeeming: ${pos.outcome} @ ${pos.slug}`);
    console.log(`   Condition: ${pos.conditionId.substring(0, 20)}...`);
    console.log(`   Expected: $${pos.expectedValue.toFixed(2)}`);

    try {
      // Get outcome index from CLOB API
      const outcomeIndex = await ProxyRedemptionClient.getOutcomeIndex(
        pos.outcome,
        pos.conditionId
      );

      const result = await redemptionClient.redeemWithRetry(
        pos.conditionId,
        outcomeIndex,
        MAX_RETRIES,
        RETRY_DELAY_MS
      );

      if (result.success) {
        console.log(`   ✅ Redeemed!`);
        if (result.transactionHash) {
          console.log(`   TX: ${result.transactionHash}`);
        }
        successCount++;
        totalRedeemed += pos.expectedValue;
      } else if (result.error === 'ALREADY_REDEEMED') {
        console.log(`   ℹ️  Already redeemed`);
        alreadyRedeemedCount++;
      } else {
        console.log(`   ❌ Failed: ${result.error}`);
        failCount++;
      }
    } catch (error: any) {
      console.log(`   ❌ Error: ${error.message}`);
      failCount++;
    }

    console.log('');
  }

  // Summary
  console.log('═══════════════════════════════════════════════════════════');
  console.log('                        Summary');
  console.log('═══════════════════════════════════════════════════════════');
  console.log('');
  console.log(`   Successful:       ${successCount}/${positions.length}`);
  console.log(`   Already redeemed: ${alreadyRedeemedCount}/${positions.length}`);
  console.log(`   Failed:           ${failCount}/${positions.length}`);
  console.log(`   Total redeemed:   ~$${totalRedeemed.toFixed(2)}`);
  console.log('');
  console.log('═══════════════════════════════════════════════════════════');
  console.log('');

  process.exit(failCount > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error('❌ Error:', error.message);
  process.exit(1);
});
