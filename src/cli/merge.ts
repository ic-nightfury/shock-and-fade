/**
 * CLI: Merge Hedged Positions
 *
 * Usage:
 *   npm run merge          # Normal mode
 *   npm run merge --debug  # Debug mode (shows on-chain balances)
 *
 * Fetches active positions, finds hedged pairs (UP + DOWN for same market),
 * and merges them back to USDC via the Builder Relayer (gas-free).
 */

import dotenv from 'dotenv';
import { ethers } from 'ethers';
import { MergeClient } from '../services/MergeClient';

dotenv.config();

const POSITIONS_API = 'https://data-api.polymarket.com/positions';
const CTF_CONTRACT = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045';

// ERC1155 ABI for balance checking
const CTF_ABI = [
  'function balanceOf(address account, uint256 id) view returns (uint256)',
  'function getPositionId(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256 indexSet) view returns (uint256)'
];

const DEBUG = process.argv.includes('--debug');

interface Position {
  proxyWallet: string;
  asset: string;
  conditionId: string;
  size: number;
  avgPrice: number;
  initialValue: number;
  currentValue: number;
  title: string;
  slug: string;
  outcome: string;
  outcomeIndex: number;
}

interface HedgedPair {
  conditionId: string;
  title: string;
  slug: string;
  upPosition: Position;
  downPosition: Position;
  mergeableAmount: number;
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

async function checkMarketStatus(slug: string): Promise<{ closed: boolean; active: boolean }> {
  const url = `https://gamma-api.polymarket.com/markets?slug=${slug}`;
  const response = await fetch(url);
  if (!response.ok) {
    return { closed: false, active: true }; // Assume open if can't check
  }

  const markets = await response.json() as any[];
  if (markets && markets[0]) {
    return {
      closed: markets[0].closed === true,
      active: markets[0].active === true
    };
  }
  return { closed: false, active: true };
}

async function getOnChainBalance(wallet: string, tokenId: string): Promise<bigint> {
  const provider = new ethers.providers.JsonRpcProvider(
    process.env.RPC_URL || 'https://polygon-rpc.com'
  );
  const ctf = new ethers.Contract(CTF_CONTRACT, CTF_ABI, provider);
  return ctf.balanceOf(wallet, tokenId);
}

async function debugPositions(pair: HedgedPair, wallet: string): Promise<void> {
  console.log('\n   🔍 DEBUG: On-chain balances');

  try {
    // Get on-chain balances using the asset (token ID) from positions
    const upBalance = await getOnChainBalance(wallet, pair.upPosition.asset);
    const downBalance = await getOnChainBalance(wallet, pair.downPosition.asset);

    // Convert to human-readable (6 decimals)
    const upShares = Number(upBalance) / 1_000_000;
    const downShares = Number(downBalance) / 1_000_000;

    console.log(`       UP token ID: ${pair.upPosition.asset.substring(0, 20)}...`);
    console.log(`       UP on-chain: ${upShares.toFixed(6)} shares (raw: ${upBalance.toString()})`);
    console.log(`       UP API says: ${pair.upPosition.size.toFixed(6)} shares`);
    console.log(`       DOWN token ID: ${pair.downPosition.asset.substring(0, 20)}...`);
    console.log(`       DOWN on-chain: ${downShares.toFixed(6)} shares (raw: ${downBalance.toString()})`);
    console.log(`       DOWN API says: ${pair.downPosition.size.toFixed(6)} shares`);

    const minOnChain = Math.min(upShares, downShares);
    console.log(`       Actual mergeable: ${minOnChain.toFixed(6)} shares`);

    if (Math.abs(minOnChain - pair.mergeableAmount) > 0.01) {
      console.log(`       ⚠️ MISMATCH! API says ${pair.mergeableAmount.toFixed(2)} but on-chain is ${minOnChain.toFixed(6)}`);
    }

    // Try to simulate the merge to get revert reason
    await simulateMerge(pair, wallet, minOnChain);
  } catch (error: any) {
    console.log(`       ⚠️ Failed to fetch on-chain balance: ${error.message}`);
  }
}

async function simulateMerge(pair: HedgedPair, wallet: string, amount: number): Promise<void> {
  console.log(`\n   🧪 Simulating merge transaction...`);

  const provider = new ethers.providers.JsonRpcProvider(
    process.env.RPC_URL || 'https://polygon-rpc.com'
  );

  const USDC_E = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
  const PARENT_COLLECTION_ID = '0x0000000000000000000000000000000000000000000000000000000000000000';

  const ctfInterface = new ethers.utils.Interface([
    'function mergePositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] indexSets, uint256 amount)'
  ]);

  const conditionId = pair.conditionId.startsWith('0x') ? pair.conditionId : `0x${pair.conditionId}`;
  const amountWei = Math.floor(amount * 1_000_000);

  const data = ctfInterface.encodeFunctionData('mergePositions', [
    USDC_E,
    PARENT_COLLECTION_ID,
    conditionId,
    [1, 2],
    amountWei
  ]);

  try {
    await provider.call({
      to: CTF_CONTRACT,
      from: wallet,
      data: data
    });
    console.log(`       ✅ Simulation succeeded!`);
  } catch (error: any) {
    const reason = error.reason || error.message || 'Unknown';
    console.log(`       ❌ Simulation failed: ${reason}`);

    // Try to decode the error
    if (error.data) {
      console.log(`       Error data: ${error.data}`);
    }
  }
}

function findHedgedPairs(positions: Position[]): HedgedPair[] {
  // Group positions by conditionId
  const byCondition = new Map<string, Position[]>();

  for (const pos of positions) {
    const existing = byCondition.get(pos.conditionId) || [];
    existing.push(pos);
    byCondition.set(pos.conditionId, existing);
  }

  // Find pairs with both Up and Down
  const hedgedPairs: HedgedPair[] = [];

  for (const [conditionId, posArray] of byCondition) {
    const upPos = posArray.find(p => p.outcome === 'Up');
    const downPos = posArray.find(p => p.outcome === 'Down');

    if (upPos && downPos) {
      const mergeableAmount = Math.min(upPos.size, downPos.size);
      if (mergeableAmount > 0) {
        hedgedPairs.push({
          conditionId,
          title: upPos.title,
          slug: upPos.slug,
          upPosition: upPos,
          downPosition: downPos,
          mergeableAmount,
        });
      }
    }
  }

  return hedgedPairs;
}

async function main() {
  console.log('');
  console.log('═══════════════════════════════════════════════════════════');
  console.log('                  Merge Hedged Positions');
  console.log('═══════════════════════════════════════════════════════════');
  console.log('');

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
  if (DEBUG) {
    console.log(`🔍 Debug mode: ON (checking on-chain balances)`);
  }
  console.log('');

  // Fetch positions
  const positions = await fetchPositions(targetWallet);
  console.log(`   Found ${positions.length} active positions\n`);

  if (positions.length === 0) {
    console.log('   No active positions found.');
    process.exit(0);
  }

  // Find hedged pairs
  const hedgedPairs = findHedgedPairs(positions);

  if (hedgedPairs.length === 0) {
    console.log('   No hedged pairs found (need both UP and DOWN for same market).');
    console.log('');
    console.log('   Current positions:');
    for (const pos of positions) {
      console.log(`     - ${pos.outcome}: ${pos.size.toFixed(2)} shares @ ${pos.slug}`);
    }
    process.exit(0);
  }

  // Display hedged pairs
  console.log('🔀 Found hedged pairs:\n');
  for (let i = 0; i < hedgedPairs.length; i++) {
    const pair = hedgedPairs[i];
    console.log(`   [${i + 1}] ${pair.title}`);
    console.log(`       Slug: ${pair.slug}`);
    console.log(`       UP:   ${pair.upPosition.size.toFixed(2)} shares @ $${pair.upPosition.avgPrice.toFixed(3)}`);
    console.log(`       DOWN: ${pair.downPosition.size.toFixed(2)} shares @ $${pair.downPosition.avgPrice.toFixed(3)}`);
    console.log(`       Mergeable: ${pair.mergeableAmount.toFixed(2)} shares → $${pair.mergeableAmount.toFixed(2)} USDC`);
    console.log('');
  }

  const totalMergeable = hedgedPairs.reduce((sum, p) => sum + p.mergeableAmount, 0);
  console.log(`   Total mergeable: ${totalMergeable.toFixed(2)} shares → $${totalMergeable.toFixed(2)} USDC`);
  console.log('');

  // Initialize MergeClient
  console.log('🔧 Initializing MergeClient...');
  const mergeClient = new MergeClient(privateKey);
  console.log('');

  // Execute merges
  console.log('═══════════════════════════════════════════════════════════');
  console.log('                    Executing Merges');
  console.log('═══════════════════════════════════════════════════════════');
  console.log('');

  let successCount = 0;
  let failCount = 0;
  let totalMerged = 0;

  for (const pair of hedgedPairs) {
    console.log(`🔀 Merging: ${pair.slug}`);
    console.log(`   Amount: ${pair.mergeableAmount.toFixed(2)} shares`);

    // Check if market is still open (merge only works before settlement)
    const marketStatus = await checkMarketStatus(pair.slug);
    if (marketStatus.closed) {
      console.log(`   ⚠️ Market is CLOSED - cannot merge after settlement`);
      console.log(`   💡 Use REDEEM instead to claim winning side tokens`);
      failCount++;
      console.log('');
      continue;
    }

    // Debug: Check on-chain balances before merge
    if (DEBUG) {
      await debugPositions(pair, targetWallet);
    }

    try {
      const result = await mergeClient.merge(pair.conditionId, pair.mergeableAmount);

      if (result.success) {
        console.log(`   ✅ Success!`);
        if (result.transactionHash) {
          console.log(`   TX: ${result.transactionHash}`);
        }
        successCount++;
        totalMerged += pair.mergeableAmount;
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
  console.log(`   Successful: ${successCount}/${hedgedPairs.length}`);
  console.log(`   Failed:     ${failCount}/${hedgedPairs.length}`);
  console.log(`   Total USDC: $${totalMerged.toFixed(2)}`);
  console.log('');
  console.log('═══════════════════════════════════════════════════════════');
  console.log('');

  process.exit(failCount > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error('❌ Error:', error.message);
  process.exit(1);
});
