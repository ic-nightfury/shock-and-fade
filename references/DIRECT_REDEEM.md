/**
 * RedemptionService
 *
 * Handles redemption of winning positions from resolved markets.
 *
 * Flow:
 * 1. Identify redeemable positions (market resolved, we hold winning outcome)
 * 2. Call Polymarket redemption API
 * 3. Log redemption in redemptions table
 * 4. Delete position from positions table
 * 5. Update vault AUM
 *
 * TODO: Integrate with Polymarket Relayer Client for actual redemption
 * Reference: https://docs.polymarket.com/developers/builders/relayer-client#redeem-positions
 */

import db from '../database/connection';
import VaultService from './VaultService';
import PositionService, { Position } from './PositionService';
import { getMarketBySlug } from './utils/marketData';
import DirectRedemptionClient from './DirectRedemptionClient';
import PolymarketPositionFetcher from './PolymarketPositionFetcher';

export interface RedeemablePosition extends Position {
  condition_id: string;
  market_closed: boolean;
  market_resolved: boolean;
}

export interface RedemptionResult {
  success: boolean;
  positionId: string;
  redemptionId?: string;
  sharesRedeemed?: number;
  usdcReceived?: number;
  profit?: number;
  transactionHash?: string;
  error?: string;
}

export class RedemptionService {
  /**
   * Find all redeemable positions for a vault
   *
   * Uses Polymarket live API to find positions with curPrice >= 0.99 (winning positions)
   *
   * A position is redeemable if:
   * - Current price is 0.99 or higher (market resolved in favor of outcome)
   * - We hold outcome tokens (shares > 0)
   * - Position exists on-chain (verified via live API)
   */
  async findRedeemablePositions(vaultName: 'HEDGE_VAULT'): Promise<RedeemablePosition[]> {
    console.log(`\n🔍 [${vaultName}] Finding redeemable positions from Polymarket API...`);

    // Get vault wallet address
    const vault = await VaultService.getVault(vaultName);
    if (!vault) {
      console.log(`❌ Vault ${vaultName} not found`);
      return [];
    }

    const walletAddress = vault.wallet_address;
    console.log(`   Wallet: ${walletAddress}`);

    // Fetch redeemable positions from Polymarket live API (curPrice >= 0.99)
    const liveRedeemable = await PolymarketPositionFetcher.findRedeemablePositions(walletAddress);

    if (liveRedeemable.length === 0) {
      console.log(`📊 No redeemable positions found on Polymarket API`);
      return [];
    }

    // Match live positions with database positions to get position IDs
    const dbPositions = await PositionService.getOpenPositions(vaultName);
    const redeemable: RedeemablePosition[] = [];

    for (const livePos of liveRedeemable) {
      // Find matching database position by conditionId
      const dbPos = dbPositions.find(p =>
        p.metadata?.conditionId === livePos.conditionId
      );

      if (dbPos) {
        console.log(`   ✅ Matched (tracked): ${livePos.title} (${livePos.outcome})`);
        redeemable.push({
          ...dbPos,
          condition_id: livePos.conditionId,
          market_closed: true,
          market_resolved: true,
          shares: livePos.size,  // Use live share count, not stale DB value
        });
      } else {
        console.log(`   ✅ Found (untracked): ${livePos.title} (${livePos.outcome})`);
        console.log(`      Will redeem without database logging`);

        // Create temporary position structure for untracked positions
        // These will be redeemed but not logged to database
        redeemable.push({
          id: `untracked-${livePos.conditionId}`,  // Temporary ID
          vault_id: vault.id,
          market_slug: livePos.slug,
          token_id: livePos.asset,
          outcome: livePos.outcome,
          side: 'BUY',
          amount: livePos.initialValue,
          shares: livePos.size,
          entry_price: livePos.avgPrice,
          current_price: livePos.curPrice,
          status: 'open',
          order_id: null,
          metadata: {
            conditionId: livePos.conditionId,
            negativeRisk: (livePos as any).negativeRisk || false
          },
          opened_at: new Date(),
          closed_at: null,
          condition_id: livePos.conditionId,
          market_closed: true,
          market_resolved: true,
        });
      }
    }

    console.log(`📊 Found ${redeemable.length} redeemable positions (tracked + untracked)`);
    return redeemable;
  }

  /**
   * Redeem a single position
   *
   * @param vaultName - Vault name
   * @param positionId - Position ID (can be temporary for untracked positions)
   * @param positionData - Optional position data (for untracked positions)
   */
  async redeemPosition(
    vaultName: 'HEDGE_VAULT',
    positionId: string,
    positionData?: Position
  ): Promise<RedemptionResult> {
    console.log(`\n💰 [${vaultName}] Redeeming position ${positionId}...`);

    try {
      // Get position details (use provided data or fetch from DB)
      let position: Position | null;

      if (positionData) {
        position = positionData;
        console.log(`   Using provided position data (untracked)`);
      } else {
        position = await PositionService.getPositionById(positionId);
      }

      if (!position) {
        return {
          success: false,
          positionId,
          error: 'Position not found'
        };
      }

      const conditionId = position.metadata?.conditionId;
      if (!conditionId) {
        return {
          success: false,
          positionId,
          error: 'Position missing conditionId in metadata'
        };
      }

      // Get vault private key for redemption
      const privateKeyEnv = `${vaultName}_PRIVATE_KEY`;
      const privateKey = process.env[privateKeyEnv];

      if (!privateKey) {
        return {
          success: false,
          positionId,
          error: `Private key not found: ${privateKeyEnv}`
        };
      }

      // Initialize Direct Redemption Client (for EOA wallet)
      const redemptionClient = new DirectRedemptionClient(privateKey);

      // Get outcome index (1 for Yes, 2 for No, or multi-outcome index)
      let outcomeIndex: number;
      try {
        outcomeIndex = await DirectRedemptionClient.getOutcomeIndex(position.outcome, conditionId);
      } catch (error: any) {
        return {
          success: false,
          positionId,
          error: error.message
        };
      }

      console.log(`   Redeeming ${position.outcome} position (index: ${outcomeIndex})`);
      console.log(`   Shares: ${position.shares}`);
      console.log(`   Condition ID: ${conditionId}`);

      // Check if this is a NegRisk market (from position metadata)
      const negRisk = position.metadata?.negativeRisk === true;
      console.log(`   Market Type: ${negRisk ? 'NegRisk' : 'Regular'}`);

      // Execute actual redemption via Direct Client with negRisk parameter and shares
      const redemptionResult = await redemptionClient.redeem(
        conditionId,
        outcomeIndex,
        negRisk,
        position.shares  // Pass shares for NegRisk markets
      );

      if (!redemptionResult.success) {
        // Check if position was already redeemed (stale API data)
        if (redemptionResult.error === 'ALREADY_REDEEMED') {
          console.log(`   ℹ️  Position already redeemed - marking as settled`);

          // Check if this is an untracked position
          const isUntracked = positionId.startsWith('untracked-');

          if (!isUntracked) {
            // Mark as settled to prevent future retry attempts
            await this.markPositionAsSettled(positionId);
            console.log(`   ✅ Position marked as settled (already redeemed)`);
          }

          // Return success (already redeemed = good outcome)
          return {
            success: true,
            positionId,
            sharesRedeemed: 0,
            usdcReceived: 0,
            profit: 0,
            transactionHash: 'already_redeemed'
          };
        }

        // Other errors - return as failure
        return {
          success: false,
          positionId,
          error: redemptionResult.error || 'Redemption failed'
        };
      }

      const transactionHash = redemptionResult.transactionHash!;

      // Calculate expected USDC (1 USDC per share for winning outcome)
      const expectedUSDC = position.shares * 1.0;
      const profit = expectedUSDC - position.amount;

      console.log(`   Expected USDC: $${expectedUSDC.toFixed(2)}`);
      console.log(`   Profit: $${profit.toFixed(2)}`);
      console.log(`   Transaction: ${transactionHash}`);

      // Check if this is an untracked position (temporary ID)
      const isUntracked = positionId.startsWith('untracked-');

      let redemptionId: string | undefined;

      if (!isUntracked) {
        // Log redemption in redemptions table (tracked positions only)
        redemptionId = await this.logRedemption(
          vaultName,
          position,
          conditionId,
          position.shares,
          expectedUSDC,
          profit,
          transactionHash
        );

        // Mark position as settled (preserve historical record)
        await this.markPositionAsSettled(positionId);

        console.log(`✅ Redemption logged: ${redemptionId}`);
        console.log(`✅ Position marked as settled (preserved in database)`);
      } else {
        console.log(`ℹ️  Untracked position - skipping database logging`);
      }

      // Sync vault AUM to wallet balance (always, even for untracked positions)
      // This captures both redemption gains AND any unrealized losses from other positions
      await this.syncVaultAUMToWallet(vaultName);
      console.log(`✅ Vault AUM synced to wallet balance`);

      return {
        success: true,
        positionId,
        redemptionId,
        sharesRedeemed: position.shares,
        usdcReceived: expectedUSDC,
        profit,
        transactionHash
      };

    } catch (error: any) {
      console.error(`❌ Redemption failed:`, error.message);
      return {
        success: false,
        positionId,
        error: error.message
      };
    }
  }

  /**
   * Log redemption in redemptions table
   */
  private async logRedemption(
    vaultName: 'HEDGE_VAULT',
    position: Position,
    conditionId: string,
    sharesRedeemed: number,
    usdcReceived: number,
    profit: number,
    transactionHash: string
  ): Promise<string> {
    // Get vault ID
    const vaultResult = await db.query('SELECT id FROM vaults WHERE name = $1', [vaultName]);
    const vaultId = vaultResult.rows[0].id;

    // Insert redemption record
    const result = await db.query(
      `INSERT INTO redemptions
       (vault_id, position_id, market_slug, condition_id, token_id, outcome,
        shares_redeemed, usdc_received, original_investment, profit, transaction_hash, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       RETURNING id`,
      [
        vaultId,
        position.id,
        position.market_slug,
        conditionId,
        position.token_id,
        position.outcome,
        sharesRedeemed,
        usdcReceived,
        position.amount,
        profit,
        transactionHash,
        JSON.stringify({ method: 'automatic', ...position.metadata })
      ]
    );

    return result.rows[0].id;
  }

  /**
   * Mark position as settled (preserve historical record)
   * NEVER delete positions - keep them as historical data
   */
  private async markPositionAsSettled(positionId: string): Promise<void> {
    await db.query(
      'UPDATE positions SET status = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
      ['settled', positionId]
    );
  }

  /**
   * Sync vault AUM to current wallet balance after redemption
   * Uses wallet balance as source of truth to capture all gains/losses
   */
  private async syncVaultAUMToWallet(vaultName: 'HEDGE_VAULT'): Promise<void> {
    await VaultService.syncAUMToWallet(vaultName);
  }

  /**
   * Redeem all redeemable positions for a vault
   *
   * Returns summary of redemptions
   */
  async redeemAllRedeemable(vaultName: 'HEDGE_VAULT'): Promise<{
    total: number;
    successful: number;
    failed: number;
    totalUsdcReceived: number;
    totalProfit: number;
    results: RedemptionResult[];
  }> {
    console.log(`\n🔄 [${vaultName}] Redeeming all redeemable positions...`);

    const redeemablePositions = await this.findRedeemablePositions(vaultName);

    if (redeemablePositions.length === 0) {
      console.log(`✅ No positions to redeem`);
      return {
        total: 0,
        successful: 0,
        failed: 0,
        totalUsdcReceived: 0,
        totalProfit: 0,
        results: []
      };
    }

    const results: RedemptionResult[] = [];
    let successful = 0;
    let failed = 0;
    let totalUsdcReceived = 0;
    let totalProfit = 0;

    for (const position of redeemablePositions) {
      // For untracked positions, pass the position data directly
      const isUntracked = position.id.startsWith('untracked-');
      const result = await this.redeemPosition(
        vaultName,
        position.id,
        isUntracked ? position : undefined
      );
      results.push(result);

      if (result.success) {
        successful++;
        totalUsdcReceived += result.usdcReceived || 0;
        totalProfit += result.profit || 0;
      } else {
        failed++;
      }

      // Rate limiting
      await this.delay(500);
    }

    console.log(`\n✅ Redemption complete:`);
    console.log(`   Total: ${redeemablePositions.length}`);
    console.log(`   Successful: ${successful}`);
    console.log(`   Failed: ${failed}`);
    console.log(`   USDC Received: $${totalUsdcReceived.toFixed(2)}`);
    console.log(`   Profit: $${totalProfit.toFixed(2)}`);

    return {
      total: redeemablePositions.length,
      successful,
      failed,
      totalUsdcReceived,
      totalProfit,
      results
    };
  }

  /**
   * Utility: Delay for rate limiting
   */
  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// Export singleton instance
export default new RedemptionService();
