/**
 * CLI: Sell All Active Positions
 *
 * Usage:
 *   npm run sell              # Sell all positions
 *   npm run sell --dry-run    # Preview without executing
 *
 * Fetches active positions and sells tokens using market orders.
 *
 * Sell criteria:
 * - Sell all positions with size > 0
 * - Skip if: endDate passed AND closed=true AND redeemable=true (should redeem instead)
 *
 * Retries up to 2 times per position on failure.
 */

import * as dotenv from 'dotenv';
import { ethers } from 'ethers';
import { PolymarketClient } from '../services/PolymarketClient';
import { PolymarketConfig } from '../types';

dotenv.config();

const POSITIONS_API = 'https://data-api.polymarket.com/positions';
const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 2000;

const DRY_RUN = process.argv.includes('--dry-run');

interface Position {
  proxyWallet: string;
  asset: string;          // Token ID
  conditionId: string;
  size: number;           // Number of shares
  avgPrice: number;
  initialValue: number;
  currentValue: number;
  title: string;
  slug: string;
  outcome: string;
  outcomeIndex: number;
  curPrice: number;       // Current market price
  cashPnl?: number;       // Cash PNL (unrealized)
  realizedPnl?: number;   // Realized PNL
  redeemable?: boolean;   // Can be redeemed (market settled)
}

async function fetchPositions(wallet: string): Promise<Position[]> {
  const url = `${POSITIONS_API}?sizeThreshold=0.01&limit=100&user=${wallet}`;
  console.log(`📡 Fetching positions from API...`);

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Positions API error: ${response.status} ${response.statusText}`);
  }

  return response.json() as Promise<Position[]>;
}

interface MarketStatus {
  isSellable: boolean;
  reason?: string;
}

/**
 * Check if a market's orderbook is still active based on slug timestamp
 * For 15-min markets like btc-updown-15m-{timestamp}, orderbook closes after 15 min
 */
function isOrderbookActive(slug: string): { active: boolean; reason?: string } {
  // Extract timestamp from slug like "btc-updown-15m-1766235600"
  const match = slug.match(/-(\d{10})$/);
  if (!match) {
    // Not a timestamped market, assume active
    return { active: true };
  }

  const startTimestamp = parseInt(match[1]) * 1000; // Convert to ms
  const duration = slug.includes('-15m-') ? 15 * 60 * 1000 : 60 * 60 * 1000; // 15min or 1hr
  const endTimestamp = startTimestamp + duration;
  const now = Date.now();

  if (now > endTimestamp) {
    return { active: false, reason: 'market ended (redeem instead)' };
  }

  return { active: true };
}

/**
 * Check market sellability
 * Returns a map of slug -> MarketStatus
 *
 * A market is NOT sellable if:
 * - The market's end time has passed (orderbook no longer exists)
 */
function checkMarketsSellable(slugs: string[]): Map<string, MarketStatus> {
  const statusMap = new Map<string, MarketStatus>();

  for (const slug of slugs) {
    const { active, reason } = isOrderbookActive(slug);
    if (!active) {
      statusMap.set(slug, { isSellable: false, reason });
    } else {
      statusMap.set(slug, { isSellable: true });
    }
  }

  return statusMap;
}

async function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function sellWithRetry(
  client: PolymarketClient,
  position: Position,
  maxRetries: number
): Promise<{ success: boolean; received: number; error?: string }> {
  let lastError = '';

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    console.log(`   Attempt ${attempt}/${maxRetries}...`);

    try {
      // Use minPrice of 0.01 to ensure fill (market sell)
      const result = await client.sellShares(
        position.asset,
        position.size,
        0.01  // Minimum price to accept
      );

      if (result.success) {
        const received = result.details?.totalCost || (position.size * (result.filledPrice || position.curPrice));
        return { success: true, received };
      }

      lastError = result.error || 'Unknown error';
      console.log(`   ❌ Attempt ${attempt} failed: ${lastError}`);

    } catch (error: any) {
      lastError = error.message || 'Unknown error';
      console.log(`   ❌ Attempt ${attempt} error: ${lastError}`);
    }

    if (attempt < maxRetries) {
      console.log(`   ⏳ Waiting ${RETRY_DELAY_MS / 1000}s before retry...`);
      await sleep(RETRY_DELAY_MS);
    }
  }

  return { success: false, received: 0, error: lastError };
}

async function main() {
  console.log('');
  console.log('═══════════════════════════════════════════════════════════');
  console.log('                  Sell All Positions');
  console.log('═══════════════════════════════════════════════════════════');
  console.log('');

  if (DRY_RUN) {
    console.log('🔍 DRY RUN MODE - No orders will be executed\n');
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

  console.log(`👛 Wallet: ${targetWallet}`);
  console.log(`   Mode: ${authMode}`);
  console.log('');

  // Fetch positions
  const positions = await fetchPositions(targetWallet);

  // Filter positions with actual holdings
  const positionsWithHoldings = positions.filter(p => p.size > 0);

  console.log(`   Found ${positions.length} positions, ${positionsWithHoldings.length} with holdings`);

  if (positionsWithHoldings.length === 0) {
    console.log('   No positions with holdings found.');
    process.exit(0);
  }

  // Check which markets are sellable (orderbook still active)
  console.log(`📡 Checking market status...`);
  const uniqueSlugs = [...new Set(positionsWithHoldings.map(p => p.slug))];
  const statusMap = checkMarketsSellable(uniqueSlugs);

  // Filter out positions based on:
  // 1. Market not sellable (ended + closed + redeemable) - should redeem instead
  const skippedReasons: { [key: string]: number } = {};
  const activePositions = positionsWithHoldings.filter(p => {
    // Check market sellability
    const status = statusMap.get(p.slug);
    if (status && !status.isSellable) {
      const reason = status.reason || 'unknown';
      skippedReasons[reason] = (skippedReasons[reason] || 0) + 1;
      return false;
    }

    return true;
  });

  const skippedCount = positionsWithHoldings.length - activePositions.length;
  if (skippedCount > 0) {
    const reasonStr = Object.entries(skippedReasons)
      .map(([reason, count]) => `${count} ${reason}`)
      .join(', ');
    console.log(`   ${activePositions.length} sellable (${skippedCount} skipped: ${reasonStr})\n`);
  } else {
    console.log(`   ${activePositions.length} sellable\n`);
  }

  if (activePositions.length === 0) {
    console.log('   No active positions to sell.');
    process.exit(0);
  }

  // Display positions
  console.log('📊 Active Positions:\n');
  let totalValue = 0;

  for (let i = 0; i < activePositions.length; i++) {
    const pos = activePositions[i];
    const currentValue = pos.size * (pos.curPrice || pos.avgPrice);
    totalValue += currentValue;

    const realizedPnl = pos.realizedPnl || 0;
    const cashPnl = pos.cashPnl || 0;
    const unrealizedValue = cashPnl - realizedPnl;

    console.log(`   [${i + 1}] ${pos.title}`);
    console.log(`       ${pos.outcome}: ${pos.size.toFixed(2)} shares`);
    console.log(`       Avg: $${pos.avgPrice.toFixed(3)} | Current: $${(pos.curPrice || pos.avgPrice).toFixed(3)}`);
    console.log(`       Value: ~$${currentValue.toFixed(2)} | Unrealized: $${unrealizedValue.toFixed(2)}`);
    console.log('');
  }

  console.log(`   Total estimated value: $${totalValue.toFixed(2)}`);
  console.log('');

  if (DRY_RUN) {
    console.log('═══════════════════════════════════════════════════════════');
    console.log('   DRY RUN - No orders executed');
    console.log('═══════════════════════════════════════════════════════════');
    process.exit(0);
  }

  // Initialize client
  console.log('🔧 Initializing PolymarketClient...');
  const config: PolymarketConfig = {
    host: process.env.POLYMARKET_HOST || 'https://clob.polymarket.com',
    chainId: parseInt(process.env.POLYMARKET_CHAIN_ID || '137'),
    privateKey,
    funderAddress: targetWallet,
    authMode,
  };
  const client = new PolymarketClient(config);
  await client.initialize();
  console.log('');

  // Cancel all open orders first (like test-cancel)
  console.log('═══════════════════════════════════════════════════════════');
  console.log('                  Cancelling Open Orders');
  console.log('═══════════════════════════════════════════════════════════');
  console.log('');

  const uniqueConditionIds = [...new Set(activePositions.map(p => p.conditionId))];
  let totalCancelled = 0;

  for (const conditionId of uniqueConditionIds) {
    // Check for open orders on this market
    const ordersResult = await client.getOpenOrders(conditionId);

    if (ordersResult.success && ordersResult.orders && ordersResult.orders.length > 0) {
      console.log(`📋 Found ${ordersResult.orders.length} open order(s) on ${conditionId.slice(0, 16)}...`);

      // Cancel all orders for this market
      const cancelResult = await client.cancelOrders(conditionId);

      if (cancelResult.success) {
        const cancelled = cancelResult.cancelled?.length || ordersResult.orders.length;
        console.log(`   ✅ Cancelled ${cancelled} order(s)`);
        totalCancelled += cancelled;
      } else {
        console.log(`   ⚠️ Cancel failed: ${cancelResult.error}`);
      }

      await sleep(500); // Small delay between cancel batches
    }
  }

  if (totalCancelled > 0) {
    console.log(`\n   Total cancelled: ${totalCancelled} order(s)`);
  } else {
    console.log('   No open orders to cancel');
  }
  console.log('');

  // Execute sells
  console.log('═══════════════════════════════════════════════════════════');
  console.log('                    Executing Sells');
  console.log('═══════════════════════════════════════════════════════════');
  console.log('');

  let successCount = 0;
  let failCount = 0;
  let totalReceived = 0;

  for (const pos of activePositions) {
    console.log(`💰 Selling: ${pos.outcome} @ ${pos.slug}`);
    console.log(`   Shares: ${pos.size.toFixed(2)}`);

    const result = await sellWithRetry(client, pos, MAX_RETRIES);

    if (result.success) {
      console.log(`   ✅ Sold! Received: ~$${result.received.toFixed(2)}`);
      successCount++;
      totalReceived += result.received;
    } else {
      console.log(`   ❌ Failed after ${MAX_RETRIES} attempts: ${result.error}`);
      failCount++;
    }

    console.log('');

    // Small delay between positions
    if (activePositions.indexOf(pos) < activePositions.length - 1) {
      await sleep(1000);
    }
  }

  // Summary
  console.log('═══════════════════════════════════════════════════════════');
  console.log('                        Summary');
  console.log('═══════════════════════════════════════════════════════════');
  console.log('');
  console.log(`   Successful: ${successCount}/${activePositions.length}`);
  console.log(`   Failed:     ${failCount}/${activePositions.length}`);
  console.log(`   Total received: ~$${totalReceived.toFixed(2)}`);
  console.log('');
  console.log('═══════════════════════════════════════════════════════════');
  console.log('');

  process.exit(failCount > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error('❌ Error:', error.message);
  process.exit(1);
});
