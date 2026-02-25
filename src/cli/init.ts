#!/usr/bin/env ts-node
/**
 * Vault Initialization CLI
 *
 * Signs Polymarket contracts for trading based on AUTH_MODE:
 * - EOA mode: Signer IS the funder (direct wallet control)
 * - PROXY mode: Signer signs for funder (Gnosis Safe)
 *
 * Required approvals (6 total):
 * - USDC.e (ERC-20) approve() for 3 Polymarket contracts
 * - CTF (ERC-1155) setApprovalForAll() for 3 Polymarket contracts
 *
 * Usage:
 *   npm run init             # Initialize vault with contract approvals
 *   npm run init -- --check  # Check approval status only (no transactions)
 */

import dotenv from 'dotenv';
dotenv.config();

import { ApprovalService } from '../services/ApprovalService';
import { DatabaseService } from '../services/Database';
import { PolymarketClient } from '../services/PolymarketClient';
import { PolymarketConfig } from '../types';

const SEPARATOR = '═══════════════════════════════════════════════════════════';
const THIN_SEP = '───────────────────────────────────────────────────────────';

async function main() {
  console.log(`\n${SEPARATOR}`);
  console.log('   VAULT INITIALIZATION');
  console.log(SEPARATOR);

  // Parse arguments
  const checkOnly = process.argv.includes('--check');

  // Validate environment
  const privateKey = process.env.POLYMARKET_PRIVATE_KEY;
  const authMode = (process.env.AUTH_MODE || 'PROXY') as 'EOA' | 'PROXY';
  const funderAddress = process.env.POLYMARKET_FUNDER;

  if (!privateKey) {
    console.error('\n❌ Missing POLYMARKET_PRIVATE_KEY');
    console.error('\nRequired environment variables:');
    console.error('   POLYMARKET_PRIVATE_KEY=0x...');
    console.error('   AUTH_MODE=EOA|PROXY (default: PROXY)');
    if (authMode === 'PROXY') {
      console.error('   POLYMARKET_FUNDER=0x... (required for PROXY mode)');
    }
    process.exit(1);
  }

  if (authMode === 'PROXY' && !funderAddress) {
    console.error('\n❌ Missing POLYMARKET_FUNDER (required in PROXY mode)');
    console.error('\nSet AUTH_MODE=EOA to use signer as funder, or provide POLYMARKET_FUNDER');
    process.exit(1);
  }

  // Initialize approval service
  const approvalService = new ApprovalService(privateKey);
  const signerAddress = approvalService.getWalletAddress();
  const targetAddress = authMode === 'EOA' ? signerAddress : funderAddress!;

  console.log(`\n${THIN_SEP}`);
  console.log('Configuration');
  console.log(THIN_SEP);
  console.log(`   Auth Mode:      ${authMode}`);
  console.log(`   Signer:         ${signerAddress}`);
  if (authMode === 'PROXY') {
    console.log(`   Funder (Safe):  ${funderAddress}`);
  }
  console.log(`   Target Wallet:  ${targetAddress}`);

  // Check balances
  console.log(`\n${THIN_SEP}`);
  console.log('Balances');
  console.log(THIN_SEP);

  const polBalance = await approvalService.getPolBalance();
  const usdcBalance = await approvalService.getUsdcBalance();

  console.log(`   POL (gas):      ${polBalance.toFixed(4)} POL`);
  console.log(`   USDC.e:         $${usdcBalance.toFixed(2)}`);

  if (polBalance < 0.01) {
    console.error(`\n⚠️  Low POL balance for gas fees (need ~0.01 POL)`);
    if (!checkOnly) {
      console.error('   Fund the wallet with POL before proceeding');
      process.exit(1);
    }
  }

  // Check current approval status
  console.log(`\n${THIN_SEP}`);
  console.log('Current Approval Status');
  console.log(THIN_SEP);

  const status = await approvalService.checkApprovals();
  const contracts = ApprovalService.getContractList();

  console.log('\n   USDC.e Approvals:');
  for (const contract of contracts) {
    const approved = status.usdcApprovals[contract.name];
    const icon = approved ? '✅' : '❌';
    console.log(`      ${icon} ${contract.name}`);
  }

  console.log('\n   CTF Approvals:');
  for (const contract of contracts) {
    const approved = status.ctfApprovals[contract.name];
    const icon = approved ? '✅' : '❌';
    console.log(`      ${icon} ${contract.name}`);
  }

  if (status.hasAllApprovals) {
    console.log('\n✅ All approvals already set');
  } else {
    console.log('\n⚠️  Missing approvals detected');
  }

  // If check only, exit here
  if (checkOnly) {
    console.log(`\n${SEPARATOR}`);
    console.log('   CHECK COMPLETE');
    console.log(SEPARATOR);
    process.exit(status.hasAllApprovals ? 0 : 1);
  }

  // If already approved, skip to initialization
  if (!status.hasAllApprovals) {
    // Set approvals
    console.log(`\n${THIN_SEP}`);
    console.log('Setting Approvals');
    console.log(THIN_SEP);

    const result = await approvalService.setAllApprovals((msg) => {
      console.log(`   🔄 ${msg}`);
    });

    if (!result.success) {
      console.error(`\n❌ Approval failed: ${result.error}`);
      process.exit(1);
    }

    console.log('\n   Approval Transactions:');
    for (const r of result.results) {
      const shortHash = r.result.txHash === 'already-approved'
        ? '(already approved)'
        : r.result.txHash?.substring(0, 18) + '...';
      console.log(`      ✅ ${r.token} → ${r.contract}: ${shortHash}`);
    }
  }

  // Initialize Polymarket client and database
  console.log(`\n${THIN_SEP}`);
  console.log('Initializing Vault');
  console.log(THIN_SEP);

  const config: PolymarketConfig = {
    host: process.env.POLYMARKET_HOST || 'https://clob.polymarket.com',
    chainId: parseInt(process.env.POLYMARKET_CHAIN_ID || '137'),
    privateKey: privateKey,
    funderAddress: targetAddress,
    authMode: authMode,
  };

  const client = new PolymarketClient(config);
  await client.initialize();

  // Get AUM breakdown
  console.log('   📊 Fetching AUM breakdown...');
  const aum = await client.getAUMBreakdown();

  console.log(`\n   Balance:          $${aum.balance.toFixed(2)}`);
  console.log(`   Redeemable:       $${aum.redeemableValue.toFixed(2)}`);
  console.log(`   Active Positions: $${aum.activePositionsValue.toFixed(2)}`);
  console.log(`   ─────────────────────────────`);
  console.log(`   Total AUM:        $${aum.total.toFixed(2)}`);

  // Initialize database and set baseline
  const db = new DatabaseService();
  const existingBaselineInfo = db.getBaselineInfo();
  const capitalBase = parseFloat(process.env.CAPITAL_BASE || '100');
  const newBaseline = Math.max(capitalBase, aum.total);

  if (existingBaselineInfo) {
    console.log(`\n   Existing Baseline: $${existingBaselineInfo.baseline.toFixed(2)}`);
    console.log(`   Last Updated:      ${new Date(existingBaselineInfo.last_updated).toISOString()}`);
  }

  // Update baseline
  db.setBaseline(newBaseline);
  console.log(`   New Baseline:      $${newBaseline.toFixed(2)}`);

  // Calculate PNL
  const pnl = aum.total - newBaseline;
  const pnlPercent = newBaseline > 0 ? (pnl / newBaseline) * 100 : 0;
  const pnlSign = pnl >= 0 ? '+' : '';
  console.log(`   Current PNL:       ${pnlSign}$${pnl.toFixed(2)} (${pnlSign}${pnlPercent.toFixed(2)}%)`);

  // Cleanup
  db.close();

  // Final summary
  console.log(`\n${SEPARATOR}`);
  console.log('   VAULT INITIALIZED SUCCESSFULLY');
  console.log(SEPARATOR);
  console.log(`\n   Wallet: ${targetAddress}`);
  console.log(`   Mode:   ${authMode}`);
  console.log(`   AUM:    $${aum.total.toFixed(2)}`);
  console.log('\n   Next steps:');
  console.log('   1. Run the bot:     npm run bot');
  console.log('   2. Check status:    npm run status');
  console.log('   3. Check AUM:       npm run aum');
  console.log('');
}

main().catch((error) => {
  console.error('\n❌ Initialization failed:', error.message);
  process.exit(1);
});
