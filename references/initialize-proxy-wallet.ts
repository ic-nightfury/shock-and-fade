/**
 * Initialize PROXY_WALLET Only
 *
 * Dedicated script for Polyburg integration to:
 * 1. Update PROXY_WALLET address from environment
 * 2. Query wallet USDC balance from Polygon blockchain
 * 3. Initialize AUM from wallet balance
 *
 * Usage: npm run vault:init-proxy
 */

import dotenv from 'dotenv';
import { ethers } from 'ethers';
import VaultService from '../../services/VaultService';
import db from '../../database/connection';

dotenv.config();

async function getWalletBalance(address: string): Promise<number> {
  try {
    // Connect to Polygon RPC
    const rpcUrl = process.env.POLYGON_RPC_URL || 'https://polygon-rpc.com';
    const provider = new ethers.providers.JsonRpcProvider(rpcUrl);

    // USDC.e contract on Polygon (bridged USDC)
    const usdcAddress = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
    const usdcAbi = [
      'function balanceOf(address owner) view returns (uint256)',
      'function decimals() view returns (uint8)'
    ];

    const usdcContract = new ethers.Contract(usdcAddress, usdcAbi, provider);

    // Get balance
    const balance = await usdcContract.balanceOf(address);
    const decimals = await usdcContract.decimals();

    // Convert to human-readable number
    const balanceFormatted = parseFloat(ethers.utils.formatUnits(balance, decimals));

    return balanceFormatted;

  } catch (error: any) {
    console.error(`❌ Error getting balance for ${address}:`, error.message);
    throw error;
  }
}

async function main() {
  console.log('');
  console.log('='.repeat(80));
  console.log('🏦 PROXY_WALLET INITIALIZATION');
  console.log('='.repeat(80));

  try {
    // Initialize database
    db.initializePool();

    // Get PROXY_WALLET credentials from environment
    const proxyWalletAddress = process.env.PROXY_WALLET;
    const proxyPrivateKey = process.env.PROXY_WALLET_PRIVATE_KEY;

    if (!proxyWalletAddress || !proxyPrivateKey) {
      console.error('\n❌ Error: PROXY_WALLET configuration missing');
      console.error('\nPlease add to .env:');
      console.error('  PROXY_WALLET=0x...');
      console.error('  PROXY_WALLET_PRIVATE_KEY=0x...');
      process.exit(1);
    }

    console.log('');
    console.log('-'.repeat(80));
    console.log('Initializing PROXY_WALLET');
    console.log('-'.repeat(80));

    // Step 1: Update wallet address
    console.log(`\n1️⃣  Updating wallet address...`);
    console.log(`   Address: ${proxyWalletAddress}`);

    await VaultService.updateWalletAddress('PROXY_WALLET', proxyWalletAddress);

    // Step 2: Token approvals note
    console.log(`\n2️⃣  Token Approvals...`);
    console.log(`   ℹ️  PROXY_WALLET uses browser wallet (Metamask)`);
    console.log(`   ℹ️  Approvals should be set via Polymarket web interface`);
    console.log(`   ⏭️  Skipping automatic approval (set manually on web)`);

    // Step 3: Query wallet balance
    console.log(`\n3️⃣  Querying USDC.e balance from Polygon...`);

    const balance = await getWalletBalance(proxyWalletAddress);

    console.log(`   Balance: $${balance.toFixed(2)} USDC.e`);

    if (balance === 0) {
      console.log(`\n⚠️  Warning: Wallet has zero balance!`);
      console.log(`   Please fund the wallet before trading.`);
      console.log(`   IMPORTANT: Use USDC.e (0x2791...174), NOT native USDC!`);
    }

    // Step 4: Initialize AUM
    console.log(`\n4️⃣  Initializing AUM...`);

    await VaultService.initializeAUM('PROXY_WALLET', balance);

    console.log(`\n✅ PROXY_WALLET initialized successfully!`);
    console.log(`   Wallet: ${proxyWalletAddress}`);
    console.log(`   Initial AUM: $${balance.toFixed(2)}`);
    console.log(`   Position Size (0.1%): $${(balance * 0.001).toFixed(2)} per trade`);

    // Summary
    console.log('');
    console.log('='.repeat(80));
    console.log('✅ INITIALIZATION COMPLETE');
    console.log('='.repeat(80));

    const vault = await VaultService.getVault('PROXY_WALLET');

    if (!vault) {
      console.error('\n❌ Error: Failed to retrieve PROXY_WALLET from database');
      process.exit(1);
    }

    console.log('\nVault Details:');
    console.log(`  Name: ${vault.name}`);
    console.log(`  Address: ${vault.wallet_address}`);
    console.log(`  Current AUM: $${vault.current_aum.toFixed(2)}`);
    console.log(`  Initial Balance: $${vault.initial_balance.toFixed(2)}`);
    console.log(`  Open Positions: ${vault.active_positions}`);
    console.log(`  Total Positions: ${vault.total_positions}`);

    console.log('');
    console.log('Next steps:');
    console.log('  1. If balance is zero, fund wallet with USDC.e on Polygon');
    console.log('     Contract: 0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174');
    console.log('  2. Approve USDC.e spending on Polymarket web interface');
    console.log('  3. If you added funds, re-run: npm run vault:init-proxy');
    console.log('  4. Check vault status: npm run vault:status');
    console.log('  5. Test trade: POST /api/v1/vault/proxy-trade');
    console.log('');

    await db.closePool();
    process.exit(0);

  } catch (error: any) {
    console.error('');
    console.error('='.repeat(80));
    console.error('❌ INITIALIZATION FAILED');
    console.error('='.repeat(80));
    console.error('Error:', error.message);
    console.error('');

    await db.closePool();
    process.exit(1);
  }
}

main();
