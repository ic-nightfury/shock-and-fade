/**
 * ProxyRedemptionClient
 * Handles redemption using Polymarket's Builder Relayer (gas-free for PROXY)
 * or direct on-chain execution (for EOA mode)
 */

import { RelayClient, OperationType, SafeTransaction } from '@polymarket/builder-relayer-client';
import { BuilderApiKeyCreds, BuilderConfig } from '@polymarket/builder-signing-sdk';
import { createWalletClient, http, Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { polygon } from 'viem/chains';
import { Interface } from 'ethers/lib/utils';
import { ethers } from 'ethers';

// Polygon Mainnet Constants
const CTF_CONTRACT = '0x4d97dcd97ec945f40cf65f87097ace5ea0476045';
const NEGRISK_ADAPTER = '0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296';
const USDC_E = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
const PARENT_COLLECTION_ID = '0x0000000000000000000000000000000000000000000000000000000000000000';
const POLYGON_CHAIN_ID = 137;

export interface ProxyRedemptionResult {
  success: boolean;
  transactionHash?: string;
  error?: string;
  note?: string;
  rateLimitResetSeconds?: number;  // V86: How long until rate limit resets
}

export class ProxyRedemptionClient {
  private client: RelayClient | null = null;
  private eoaWallet: ethers.Wallet | null = null;
  private authMode: 'EOA' | 'PROXY';
  private ctfInterface: Interface;
  private negRiskInterface: Interface;
  private walletAddress: string;

  constructor(privateKey: string) {
    const formattedPk = privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`;
    this.authMode = (process.env.AUTH_MODE || 'PROXY') as 'EOA' | 'PROXY';

    // Initialize interfaces (used by both modes)
    this.ctfInterface = new Interface([
      'function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint[] indexSets)'
    ]);

    this.negRiskInterface = new Interface([
      'function redeemPositions(bytes32 _conditionId, uint256[] _amounts)'
    ]);

    if (this.authMode === 'EOA') {
      // EOA mode: Direct on-chain execution (requires MATIC for gas)
      const provider = new ethers.providers.JsonRpcProvider(
        process.env.RPC_URL || 'https://polygon-rpc.com'
      );
      this.eoaWallet = new ethers.Wallet(formattedPk, provider);
      this.walletAddress = this.eoaWallet.address;
      console.log(`🔧 ProxyRedemptionClient initialized [EOA] for wallet: ${this.walletAddress}`);
      console.log(`   ⚠️ EOA mode requires MATIC for gas fees`);
    } else {
      // PROXY mode: Use Builder Relayer (gas-free)
      const account = privateKeyToAccount(formattedPk as Hex);
      const wallet = createWalletClient({
        account,
        chain: polygon,
        transport: http(process.env.RPC_URL || 'https://polygon-rpc.com')
      });

      const builderCreds: BuilderApiKeyCreds = {
        key: process.env.BUILDER_API_KEY!,
        secret: process.env.BUILDER_SECRET!,
        passphrase: process.env.BUILDER_PASS_PHRASE!,
      };

      const builderConfig = new BuilderConfig({
        localBuilderCreds: builderCreds
      });

      this.client = new RelayClient(
        process.env.RELAYER_URL || 'https://relayer.polymarket.com',
        POLYGON_CHAIN_ID,
        wallet,
        builderConfig
      );

      this.walletAddress = account.address;
      console.log(`🔧 ProxyRedemptionClient initialized [PROXY] for wallet: ${this.walletAddress}`);
    }
  }

  static async getOutcomeIndex(outcome: string, conditionId: string): Promise<number> {
    const normalized = outcome.toLowerCase();

    const response = await fetch(`https://clob.polymarket.com/markets/${conditionId}`);
    if (!response.ok) {
      throw new Error(`CLOB API returned ${response.status}`);
    }

    const marketData: any = await response.json();
    const tokens = marketData.tokens;

    if (!tokens || !Array.isArray(tokens)) {
      throw new Error(`Invalid market data structure`);
    }

    const outcomeIdx = tokens.findIndex((token: any) =>
      token.outcome.toLowerCase() === normalized
    );

    if (outcomeIdx === -1) {
      const availableOutcomes = tokens.map((t: any) => t.outcome).join(', ');
      throw new Error(`Outcome '${outcome}' not found. Available: ${availableOutcomes}`);
    }

    return outcomeIdx + 1;
  }

  async redeemWithRetry(
    conditionId: string,
    outcomeIndex: number,
    maxRetries: number = 3,
    retryDelayMs: number = 30000,
    isNegRisk: boolean = false,
    shares?: number
  ): Promise<ProxyRedemptionResult> {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      const result = await this.redeem(conditionId, outcomeIndex, isNegRisk, shares);

      if (result.success || result.error === 'ALREADY_REDEEMED') {
        return result;
      }

      // V86: Don't retry on rate limit - return immediately with reset time
      if (result.error === 'RATE_LIMITED') {
        return result;
      }

      if (attempt < maxRetries) {
        await new Promise(resolve => setTimeout(resolve, retryDelayMs));
      }
    }

    return {
      success: false,
      error: `Failed after ${maxRetries} attempts`
    };
  }

  async redeem(
    conditionId: string,
    outcomeIndex: number,
    negRisk: boolean = false,
    shares?: number
  ): Promise<ProxyRedemptionResult> {
    // Route based on AUTH_MODE
    if (this.authMode === 'EOA') {
      return this.redeemDirectOnChain(conditionId, outcomeIndex, negRisk, shares);
    } else {
      return this.redeemViaRelayer(conditionId, outcomeIndex, negRisk, shares);
    }
  }

  /**
   * EOA mode: Execute redemption directly on-chain
   * Requires MATIC for gas fees
   */
  private async redeemDirectOnChain(
    conditionId: string,
    outcomeIndex: number,
    negRisk: boolean = false,
    shares?: number
  ): Promise<ProxyRedemptionResult> {
    if (!this.eoaWallet) {
      return { success: false, error: 'EOA wallet not initialized' };
    }

    try {
      const formattedConditionId = conditionId.startsWith('0x') ? conditionId : `0x${conditionId}`;

      let tx: ethers.ContractTransaction;

      if (negRisk) {
        if (!shares) {
          return {
            success: false,
            error: 'Shares parameter required for NegRisk market redemption'
          };
        }

        const sharesInWei = Math.floor(shares * 1_000_000);
        const amounts = outcomeIndex === 1 ? [sharesInWei, 0] : [0, sharesInWei];

        const negRiskContract = new ethers.Contract(
          NEGRISK_ADAPTER,
          ['function redeemPositions(bytes32 _conditionId, uint256[] _amounts)'],
          this.eoaWallet
        );

        console.log(`   📤 Sending NegRisk redemption tx...`);
        // Polygon requires higher gas prices - use at least 30 gwei
        const feeData = await this.eoaWallet!.provider!.getFeeData();
        const gasPrice = feeData.gasPrice || ethers.utils.parseUnits('30', 'gwei');
        const minGasPrice = ethers.utils.parseUnits('30', 'gwei');
        const finalGasPrice = gasPrice.lt(minGasPrice) ? minGasPrice : gasPrice;

        tx = await negRiskContract.redeemPositions(formattedConditionId, amounts, { gasPrice: finalGasPrice });
      } else {
        const ctfContract = new ethers.Contract(
          CTF_CONTRACT,
          ['function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] indexSets)'],
          this.eoaWallet
        );

        // First estimate gas to catch contract reverts early
        try {
          await ctfContract.estimateGas.redeemPositions(
            USDC_E,
            PARENT_COLLECTION_ID,
            formattedConditionId,
            [outcomeIndex]
          );
        } catch (gasError: any) {
          const msg = gasError.message || '';
          if (msg.includes('payout is zero') || msg.includes('subtraction overflow')) {
            return { success: false, error: 'ALREADY_REDEEMED' };
          }
          console.log(`   ❌ Gas estimation failed: ${msg.slice(0, 100)}`);
          throw gasError;
        }

        console.log(`   📤 Sending CTF redemption tx...`);
        // Polygon requires higher gas prices - use at least 30 gwei
        const feeData = await this.eoaWallet!.provider!.getFeeData();
        const gasPrice = feeData.gasPrice || ethers.utils.parseUnits('30', 'gwei');
        const minGasPrice = ethers.utils.parseUnits('30', 'gwei');
        const finalGasPrice = gasPrice.lt(minGasPrice) ? minGasPrice : gasPrice;

        tx = await ctfContract.redeemPositions(
          USDC_E,
          PARENT_COLLECTION_ID,
          formattedConditionId,
          [outcomeIndex],
          { gasPrice: finalGasPrice }
        );
      }

      console.log(`   ⏳ Waiting for confirmation (tx: ${tx.hash.slice(0, 10)}...)`);
      const receipt = await tx.wait();

      if (receipt.status === 0) {
        console.log(`   ❌ Redeem failed on-chain`);
        return {
          success: false,
          error: 'TRANSACTION_REVERTED'
        };
      }

      console.log(`   ✅ Redeemed (tx: ${receipt.transactionHash.slice(0, 10)}...)`);
      return {
        success: true,
        transactionHash: receipt.transactionHash
      };

    } catch (error: any) {
      const errMsg = error.message || JSON.stringify(error) || 'Unknown error';

      if (errMsg.includes('SafeMath: subtraction overflow') || errMsg.includes('payout is zero')) {
        return { success: false, error: 'ALREADY_REDEEMED' };
      }
      if (errMsg.includes('insufficient funds')) {
        console.log(`   ❌ Insufficient MATIC for gas`);
        return { success: false, error: 'INSUFFICIENT_GAS' };
      }
      if (errMsg.includes('execution reverted')) {
        // Extract revert reason if available
        const revertMatch = errMsg.match(/reason="([^"]+)"/);
        const reason = revertMatch ? revertMatch[1] : 'execution reverted';
        console.log(`   ❌ Contract reverted: ${reason}`);
        return { success: false, error: reason };
      }
      // Log full error for debugging RPC issues
      console.log(`   ❌ Redeem failed: ${errMsg.slice(0, 200)}`);
      if (error.error?.message) {
        console.log(`      RPC error: ${error.error.message}`);
      }
      return { success: false, error: errMsg };
    }
  }

  /**
   * PROXY mode: Execute redemption via Builder Relayer (gas-free)
   */
  private async redeemViaRelayer(
    conditionId: string,
    outcomeIndex: number,
    negRisk: boolean = false,
    shares?: number
  ): Promise<ProxyRedemptionResult> {
    if (!this.client) {
      return { success: false, error: 'Relayer client not initialized' };
    }

    try {
      const formattedConditionId = conditionId.startsWith('0x') ? conditionId : `0x${conditionId}`;

      let redeemTx: SafeTransaction;

      if (negRisk) {
        if (!shares) {
          return {
            success: false,
            error: 'Shares parameter required for NegRisk market redemption'
          };
        }

        const sharesInWei = Math.floor(shares * 1_000_000);
        const amounts = outcomeIndex === 1 ? [sharesInWei, 0] : [0, sharesInWei];

        redeemTx = {
          to: NEGRISK_ADAPTER,
          operation: OperationType.Call,
          data: this.negRiskInterface.encodeFunctionData('redeemPositions', [
            formattedConditionId,
            amounts
          ]),
          value: '0'
        };
      } else {
        redeemTx = {
          to: CTF_CONTRACT,
          operation: OperationType.Call,
          data: this.ctfInterface.encodeFunctionData('redeemPositions', [
            USDC_E,
            PARENT_COLLECTION_ID,
            formattedConditionId,
            [outcomeIndex]
          ]),
          value: '0'
        };
      }

      // Suppress builder-relayer-client verbose logging
      const originalLog = console.log;
      console.log = () => {};

      let response;
      try {
        response = await this.client.execute([redeemTx], 'Redeem position');
      } finally {
        console.log = originalLog;
      }

      const TIMEOUT_MS = 60000;
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('RELAYER_TIMEOUT')), TIMEOUT_MS)
      );

      // Suppress logs during wait() as well
      console.log = () => {};

      let result: any;
      try {
        result = await Promise.race([
          response.wait(),
          timeoutPromise
        ]);
      } catch (error: any) {
        console.log = originalLog;
        if (error.message === 'RELAYER_TIMEOUT') {
          console.log(`   ⚠️ Redeem timeout - verify on-chain`);
          return {
            success: false,
            error: 'RELAYER_TIMEOUT'
          };
        }
        throw error;
      } finally {
        console.log = originalLog;
      }

      if (!result || !result.transactionHash) {
        console.log(`   ❌ Redeem failed on-chain`);
        return {
          success: false,
          error: 'TRANSACTION_FAILED_ONCHAIN'
        };
      }

      console.log(`   ✅ Redeemed (tx: ${result.transactionHash.slice(0, 10)}...)`);

      return {
        success: true,
        transactionHash: result.transactionHash
      };

    } catch (error: any) {
      const errMsg = error.message || JSON.stringify(error) || 'Unknown error';

      // V86: Detect rate limit (429) errors and extract reset time
      const is429 = errMsg.includes('429') || errMsg.includes('Too Many Requests') || errMsg.includes('quota exceeded');
      if (is429) {
        // Extract reset time from error like "resets in 38306 seconds"
        const resetMatch = errMsg.match(/resets in (\d+) seconds/);
        const resetSeconds = resetMatch ? parseInt(resetMatch[1], 10) : 3600; // Default 1 hour
        console.log(`   ⚠️ Rate limited - quota resets in ${Math.ceil(resetSeconds / 60)} minutes`);
        return {
          success: false,
          error: 'RATE_LIMITED',
          rateLimitResetSeconds: resetSeconds
        };
      }

      if (errMsg.includes('SafeMath: subtraction overflow')) {
        return { success: false, error: 'ALREADY_REDEEMED' };
      }
      console.log(`   ❌ Redeem failed: ${errMsg.slice(0, 80)}`);
      return { success: false, error: errMsg };
    }
  }
}

export default ProxyRedemptionClient;
