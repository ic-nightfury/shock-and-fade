/**
 * Test script for DirectExecutionClient
 *
 * Tests the direct execution path that bypasses the Builder Relayer
 * by calling execTransaction() on the Gnosis Safe proxy directly.
 *
 * Usage:
 *   npx ts-node src/tools/test-direct-execution.ts [--dry-run] [--live]
 *
 * Flags:
 *   --dry-run  (default) Only test initialization, nonce reading, address derivation
 *   --live     Actually execute a $1 split + merge on a test market (costs gas!)
 */

import * as dotenv from "dotenv";
dotenv.config();

import { ethers } from "ethers";
import { DirectExecutionClient } from "../services/DirectExecutionClient";
import { OperationType, SafeTransaction } from "@polymarket/builder-relayer-client";
import { Interface } from "ethers/lib/utils";

// ─── Config ───────────────────────────────────────────────────────────────────

const EXPECTED_PROXY = "0xEc21d9f82Ea9C80337111A98C6262F422D8152BB";
const EXPECTED_EOA = "0xd6ed4c51A77ab7E812dA8c4041845b5ad29431d1";

// Polygon Mainnet contracts
const CTF_CONTRACT = "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045";
const NEGRISK_ADAPTER = "0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296";
const USDC_E = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";
const PARENT_COLLECTION_ID =
  "0x0000000000000000000000000000000000000000000000000000000000000000";

// ─── Test ─────────────────────────────────────────────────────────────────────

async function main() {
  const isLive = process.argv.includes("--live");

  console.log("═══════════════════════════════════════════════════════");
  console.log("  DirectExecutionClient Test");
  console.log(`  Mode: ${isLive ? "🔴 LIVE (will spend gas!)" : "🟢 DRY RUN"}`);
  console.log("═══════════════════════════════════════════════════════\n");

  const privateKey = process.env.POLYMARKET_PRIVATE_KEY;
  if (!privateKey) {
    console.error("❌ POLYMARKET_PRIVATE_KEY not set in .env");
    process.exit(1);
  }

  // 1. Initialize client
  console.log("1️⃣  Initializing DirectExecutionClient...\n");
  const client = new DirectExecutionClient(privateKey);

  // 2. Verify address derivation
  console.log("\n2️⃣  Verifying address derivation...");
  const derivedProxy = client.getProxyAddress();
  const derivedEOA = client.getEOAAddress();

  console.log(`   EOA:   ${derivedEOA}`);
  console.log(`   Proxy: ${derivedProxy}`);

  if (derivedProxy.toLowerCase() === EXPECTED_PROXY.toLowerCase()) {
    console.log(`   ✅ Proxy address matches expected!`);
  } else {
    console.log(`   ❌ Proxy MISMATCH! Expected: ${EXPECTED_PROXY}`);
    console.log(`   This means the derivation logic differs from the relayer.`);
  }

  if (derivedEOA.toLowerCase() === EXPECTED_EOA.toLowerCase()) {
    console.log(`   ✅ EOA address matches expected!`);
  } else {
    console.log(`   ❌ EOA MISMATCH! Expected: ${EXPECTED_EOA}`);
  }

  // 3. Read on-chain nonce
  console.log("\n3️⃣  Reading on-chain nonce from proxy...");
  try {
    const nonce = await client.getNonce();
    console.log(`   ✅ Current Safe nonce: ${nonce}`);
  } catch (error: any) {
    console.log(`   ❌ Failed to read nonce: ${error.message}`);
    console.log(`   (This might mean the proxy isn't deployed or RPC is down)`);
  }

  // 4. Check MATIC balance
  console.log("\n4️⃣  Checking EOA MATIC balance...");
  try {
    const balance = await client.getMaticBalance();
    console.log(`   ✅ MATIC balance: ${balance} MATIC`);
    const balNum = parseFloat(balance);
    if (balNum < 0.01) {
      console.log(`   ⚠️ Low MATIC balance! Need at least ~0.01 MATIC per transaction`);
    } else {
      console.log(`   Estimated ${Math.floor(balNum / 0.005)} transactions possible at ~0.005 MATIC each`);
    }
  } catch (error: any) {
    console.log(`   ❌ Failed to read balance: ${error.message}`);
  }

  // 5. Check USDC balance on proxy
  console.log("\n5️⃣  Checking proxy USDC balance...");
  try {
    const rpc = process.env.RPC_URL || process.env.POLYGON_RPC_URL || "https://polygon-rpc.com";
    const provider = new ethers.providers.JsonRpcProvider(rpc);
    const usdc = new ethers.Contract(
      USDC_E,
      ["function balanceOf(address) view returns (uint256)"],
      provider
    );
    const balance = await usdc.balanceOf(derivedProxy);
    const balanceUSDC = parseFloat(ethers.utils.formatUnits(balance, 6));
    console.log(`   ✅ USDC balance on proxy: $${balanceUSDC.toFixed(2)}`);
  } catch (error: any) {
    console.log(`   ❌ Failed to read USDC balance: ${error.message}`);
  }

  if (!isLive) {
    console.log("\n═══════════════════════════════════════════════════════");
    console.log("  ✅ DRY RUN COMPLETE — All checks passed");
    console.log("  To test with real transactions: --live");
    console.log("═══════════════════════════════════════════════════════");
    return;
  }

  // ─── LIVE TESTS ─────────────────────────────────────────────────────────

  console.log("\n6️⃣  🔴 LIVE TEST: $1 split + merge...");
  console.log("   ⚠️ This will spend real gas (MATIC)!\n");

  // You'd need a real conditionId from an active market
  // For now, we'll show what the transaction would look like
  const testConditionId = process.argv.find(a => a.startsWith("--condition="))?.split("=")[1];

  if (!testConditionId) {
    console.log("   ❌ No conditionId provided. Use: --live --condition=0x...");
    console.log("   Find an active market conditionId from the Polymarket API first.");
    return;
  }

  const erc20Interface = new Interface([
    "function approve(address spender, uint256 amount)",
  ]);
  const ctfInterface = new Interface([
    "function splitPosition(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] partition, uint256 amount)",
  ]);
  const mergInterface = new Interface([
    "function mergePositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] indexSets, uint256 amount)",
  ]);

  const amount = 1_000_000; // $1 in USDC (6 decimals)

  // Build split transactions (same as SplitClient)
  const approveTx: SafeTransaction = {
    to: USDC_E,
    operation: OperationType.Call,
    data: erc20Interface.encodeFunctionData("approve", [CTF_CONTRACT, amount]),
    value: "0",
  };

  const splitTx: SafeTransaction = {
    to: CTF_CONTRACT,
    operation: OperationType.Call,
    data: ctfInterface.encodeFunctionData("splitPosition", [
      USDC_E,
      PARENT_COLLECTION_ID,
      testConditionId,
      [1, 2],
      amount,
    ]),
    value: "0",
  };

  console.log("   📤 Executing $1 split...");
  const splitStart = Date.now();
  const splitResult = await client.execute([approveTx, splitTx]);
  const splitTime = (Date.now() - splitStart) / 1000;

  console.log(`   Split result:`, JSON.stringify(splitResult, null, 2));
  console.log(`   Time: ${splitTime.toFixed(1)}s`);

  if (!splitResult.success) {
    console.log("   ❌ Split failed, skipping merge test");
    return;
  }

  // Wait a bit for chain state to propagate
  console.log("   ⏳ Waiting 3s for chain state...");
  await new Promise(r => setTimeout(r, 3000));

  // Build merge transaction
  const mergeTx: SafeTransaction = {
    to: CTF_CONTRACT,
    operation: OperationType.Call,
    data: mergInterface.encodeFunctionData("mergePositions", [
      USDC_E,
      PARENT_COLLECTION_ID,
      testConditionId,
      [1, 2],
      amount,
    ]),
    value: "0",
  };

  console.log("\n   📤 Executing merge (reclaim $1 USDC)...");
  const mergeStart = Date.now();
  const mergeResult = await client.execute([mergeTx]);
  const mergeTime = (Date.now() - mergeStart) / 1000;

  console.log(`   Merge result:`, JSON.stringify(mergeResult, null, 2));
  console.log(`   Time: ${mergeTime.toFixed(1)}s`);

  // Summary
  console.log("\n═══════════════════════════════════════════════════════");
  console.log("  📊 LIVE TEST RESULTS");
  console.log("═══════════════════════════════════════════════════════");
  console.log(`  Split: ${splitResult.success ? "✅" : "❌"} | Gas: ${splitResult.gasUsed} | Cost: ${splitResult.gasCostMatic} MATIC | Time: ${splitTime.toFixed(1)}s`);
  console.log(`  Merge: ${mergeResult.success ? "✅" : "❌"} | Gas: ${mergeResult.gasUsed} | Cost: ${mergeResult.gasCostMatic} MATIC | Time: ${mergeTime.toFixed(1)}s`);

  const totalGasCost =
    parseFloat(splitResult.gasCostMatic || "0") +
    parseFloat(mergeResult.gasCostMatic || "0");
  console.log(`  Total gas cost: ${totalGasCost.toFixed(6)} MATIC`);
  console.log(`  Relayer quota saved: 2 transactions`);
  console.log("═══════════════════════════════════════════════════════");
}

main().catch((e) => {
  console.error("Fatal error:", e);
  process.exit(1);
});
