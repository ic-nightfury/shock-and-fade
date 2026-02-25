/**
 * MergeClient
 * Handles merging of conditional token positions via Polymarket's Builder Relayer (gas-free for PROXY)
 * or direct on-chain execution (for EOA mode)
 * MERGE: Combines equal UP + DOWN tokens back to USDC collateral
 */

import {
  RelayClient,
  OperationType,
  SafeTransaction,
} from "@polymarket/builder-relayer-client";
import {
  BuilderApiKeyCreds,
  BuilderConfig,
} from "@polymarket/builder-signing-sdk";
import { createWalletClient, http, Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { polygon } from "viem/chains";
import { Interface } from "ethers/lib/utils";
import { ethers } from "ethers";
import { DirectExecutionClient } from "./DirectExecutionClient";

// Polygon Mainnet Constants
const CTF_CONTRACT = "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045";
const NEGRISK_ADAPTER = "0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296"; // For sports markets
const USDC_E = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";
const PARENT_COLLECTION_ID =
  "0x0000000000000000000000000000000000000000000000000000000000000000";
const POLYGON_CHAIN_ID = 137;

export interface MergeResult {
  success: boolean;
  transactionHash?: string;
  error?: string;
  amountMerged?: number;
}

export class MergeClient {
  private client: RelayClient | null = null;
  private directClient: DirectExecutionClient | null = null;
  private useDirectExecution: boolean = false;
  private eoaWallet: ethers.Wallet | null = null;
  private authMode: "EOA" | "PROXY";
  private ctfInterface: Interface;
  private negRiskInterface: Interface;
  private walletAddress: string;

  constructor(privateKey: string) {
    const formattedPk = privateKey.startsWith("0x")
      ? privateKey
      : `0x${privateKey}`;
    this.authMode = (process.env.AUTH_MODE || "PROXY") as "EOA" | "PROXY";

    // Standard CTF mergePositions signature (for crypto markets)
    this.ctfInterface = new Interface([
      "function mergePositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] indexSets, uint256 amount)",
    ]);

    // NegRiskAdapter mergePositions signature (for sports markets - simpler interface)
    this.negRiskInterface = new Interface([
      "function mergePositions(bytes32 conditionId, uint256 amount)",
    ]);

    // Check if direct execution is enabled (bypass relayer, pay own gas)
    this.useDirectExecution =
      process.env.USE_DIRECT_EXECUTION === "true" ||
      process.env.PAY_OWN_GAS === "true";

    if (this.authMode === "EOA") {
      // EOA mode: Direct on-chain execution (requires MATIC for gas)
      const provider = new ethers.providers.JsonRpcProvider(
        process.env.RPC_URL || "https://polygon-rpc.com",
      );
      this.eoaWallet = new ethers.Wallet(formattedPk, provider);
      this.walletAddress = this.eoaWallet.address;
      console.log(
        `🔧 MergeClient initialized [EOA] for wallet: ${this.walletAddress}`,
      );
      console.log(`   ⚠️ EOA mode requires MATIC for gas fees`);
    } else {
      // PROXY mode: Use Builder Relayer (gas-free) or DirectExecution (pay own gas)
      const account = privateKeyToAccount(formattedPk as Hex);

      if (this.useDirectExecution) {
        // Direct execution mode: bypass relayer, call execTransaction() on proxy directly
        this.directClient = new DirectExecutionClient(formattedPk);
        this.walletAddress = account.address;
        console.log(
          `🔧 MergeClient initialized [PROXY → DirectExecution] for wallet: ${this.walletAddress}`,
        );
        console.log(`   ⚡ Bypassing relayer — paying gas from EOA`);
      } else {
        // Standard relayer mode
        const wallet = createWalletClient({
          account,
          chain: polygon,
          transport: http(process.env.RPC_URL || "https://polygon-rpc.com"),
        });

        const builderCreds: BuilderApiKeyCreds = {
          key: process.env.BUILDER_API_KEY!,
          secret: process.env.BUILDER_SECRET!,
          passphrase: process.env.BUILDER_PASS_PHRASE!,
        };

        const builderConfig = new BuilderConfig({
          localBuilderCreds: builderCreds,
        });

        this.client = new RelayClient(
          process.env.RELAYER_URL || "https://relayer.polymarket.com",
          POLYGON_CHAIN_ID,
          wallet,
          builderConfig,
        );

        this.walletAddress = account.address;
        console.log(
          `🔧 MergeClient initialized [PROXY] for wallet: ${this.walletAddress}`,
        );
      }
    }
  }

  /**
   * Merge UP + DOWN tokens back to USDC
   * @param conditionId - Market condition ID
   * @param amount - Number of shares to merge (must have equal UP and DOWN)
   * @param isNegRisk - If true, use NegRiskAdapter (for sports markets). Default false for crypto markets.
   */
  async merge(
    conditionId: string,
    amount: number,
    isNegRisk: boolean = false,
  ): Promise<MergeResult> {
    // Route based on AUTH_MODE and market type
    if (this.authMode === "EOA") {
      return this.mergeDirectOnChain(conditionId, amount, isNegRisk);
    } else {
      return this.mergeViaRelayer(conditionId, amount, isNegRisk);
    }
  }

  /**
   * EOA mode: Execute merge directly on-chain
   * Requires MATIC for gas fees
   */
  private async mergeDirectOnChain(
    conditionId: string,
    amount: number,
    isNegRisk: boolean = false,
  ): Promise<MergeResult> {
    if (!this.eoaWallet) {
      return { success: false, error: "EOA wallet not initialized" };
    }

    try {
      const formattedConditionId = conditionId.startsWith("0x")
        ? conditionId
        : `0x${conditionId}`;

      // Convert to 6 decimals (USDC precision) - shares are stored as 1e6
      const amountInWei = Math.floor(amount * 1_000_000);

      // Polygon requires higher gas prices - use at least 30 gwei for priority fee
      const feeData = await this.eoaWallet!.provider!.getFeeData();
      const minPriorityFee = ethers.utils.parseUnits("30", "gwei");
      const minMaxFee = ethers.utils.parseUnits("100", "gwei");

      // Use EIP-1559 gas pricing with higher minimums
      const maxPriorityFeePerGas =
        feeData.maxPriorityFeePerGas &&
        feeData.maxPriorityFeePerGas.gt(minPriorityFee)
          ? feeData.maxPriorityFeePerGas
          : minPriorityFee;
      const maxFeePerGas =
        feeData.maxFeePerGas && feeData.maxFeePerGas.gt(minMaxFee)
          ? feeData.maxFeePerGas
          : minMaxFee;

      const gasOverrides = {
        maxPriorityFeePerGas,
        maxFeePerGas,
      };

      let tx;
      if (isNegRisk) {
        // Sports markets use NegRiskAdapter with simpler interface
        const negRiskContract = new ethers.Contract(
          NEGRISK_ADAPTER,
          ["function mergePositions(bytes32 conditionId, uint256 amount)"],
          this.eoaWallet,
        );

        console.log(
          `🔀 Merging ${amount} shares via NegRiskAdapter (sports market)...`,
        );
        console.log(`   📤 Sending merge tx...`);

        tx = await negRiskContract.mergePositions(
          formattedConditionId, // conditionId
          amountInWei, // amount
          gasOverrides,
        );
      } else {
        // Standard CTF for crypto markets
        const ctfContract = new ethers.Contract(
          CTF_CONTRACT,
          [
            "function mergePositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] indexSets, uint256 amount)",
          ],
          this.eoaWallet,
        );

        console.log(`🔀 Merging ${amount} shares directly on-chain...`);
        console.log(`   📤 Sending merge tx...`);

        tx = await ctfContract.mergePositions(
          USDC_E, // collateralToken
          PARENT_COLLECTION_ID, // parentCollectionId
          formattedConditionId, // conditionId
          [1, 2], // indexSets: [YES=1, NO=2] for binary markets
          amountInWei, // amount
          gasOverrides,
        );
      }

      console.log(
        `   ⏳ Waiting for confirmation (tx: ${tx.hash.slice(0, 10)}...)`,
      );
      const receipt = await tx.wait();

      if (receipt.status === 0) {
        console.log(`   ❌ Merge failed on-chain`);
        return {
          success: false,
          error: "TRANSACTION_REVERTED",
        };
      }

      console.log(
        `   ✅ Merged → $${amount.toFixed(0)} USDC (tx: ${receipt.transactionHash.slice(0, 10)}...)`,
      );
      return {
        success: true,
        transactionHash: receipt.transactionHash,
        amountMerged: amount,
      };
    } catch (error: any) {
      const errMsg = error.message || "Unknown error";
      if (errMsg.includes("SafeMath: subtraction overflow")) {
        console.log(`   ❌ Merge failed: insufficient balance`);
        return { success: false, error: "INSUFFICIENT_BALANCE" };
      }
      if (errMsg.includes("ERC20: transfer amount exceeds balance")) {
        console.log(`   ❌ Merge failed: balance mismatch`);
        return { success: false, error: "BALANCE_MISMATCH" };
      }
      if (errMsg.includes("insufficient funds")) {
        console.log(`   ❌ Insufficient MATIC for gas`);
        return { success: false, error: "INSUFFICIENT_GAS" };
      }
      console.log(`   ❌ Merge failed: ${errMsg.slice(0, 50)}`);
      return { success: false, error: errMsg };
    }
  }

  /**
   * PROXY mode: Execute merge via Builder Relayer (gas-free)
   */
  private async mergeViaRelayer(
    conditionId: string,
    amount: number,
    isNegRisk: boolean = false,
  ): Promise<MergeResult> {
    // Route to direct execution if enabled
    if (this.useDirectExecution && this.directClient) {
      return this.mergeViaDirectExecution(conditionId, amount, isNegRisk);
    }

    if (!this.client) {
      return { success: false, error: "Relayer client not initialized" };
    }

    try {
      const formattedConditionId = conditionId.startsWith("0x")
        ? conditionId
        : `0x${conditionId}`;

      // Convert to 6 decimals (USDC precision) - shares are stored as 1e6
      const amountInWei = Math.floor(amount * 1_000_000);

      let mergeTx: SafeTransaction;
      if (isNegRisk) {
        // Sports markets use NegRiskAdapter with simpler interface
        mergeTx = {
          to: NEGRISK_ADAPTER,
          operation: OperationType.Call,
          data: this.negRiskInterface.encodeFunctionData("mergePositions", [
            formattedConditionId, // conditionId
            amountInWei, // amount
          ]),
          value: "0",
        };
      } else {
        // Standard CTF for crypto markets
        mergeTx = {
          to: CTF_CONTRACT,
          operation: OperationType.Call,
          data: this.ctfInterface.encodeFunctionData("mergePositions", [
            USDC_E, // collateralToken
            PARENT_COLLECTION_ID, // parentCollectionId
            formattedConditionId, // conditionId
            [1, 2], // indexSets: [YES=1, NO=2] for binary markets
            amountInWei, // amount
          ]),
          value: "0",
        };
      }

      // V36.1: Suppress ALL logs during merge execution (builder-relayer-client is very verbose)
      const originalLog = console.log;
      console.log = () => {};

      let response;
      try {
        response = await this.client.execute([mergeTx], "Merge positions");
      } finally {
        console.log = originalLog;
      }

      const contractType = isNegRisk
        ? "NegRiskAdapter (sports)"
        : "CTF (crypto)";
      console.log(
        `🔀 Merging ${amount} shares via relayer [${contractType}]...`,
      );

      const TIMEOUT_MS = 60000;
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error("RELAYER_TIMEOUT")), TIMEOUT_MS),
      );

      // V36.1: Also suppress logs during wait() - relayer logs "Waiting for transaction..."
      console.log = () => {};

      let result: any;
      try {
        result = await Promise.race([response.wait(), timeoutPromise]);
      } catch (error: any) {
        console.log = originalLog;
        if (error.message === "RELAYER_TIMEOUT") {
          console.log(`   ⚠️ Merge timeout - verify on-chain`);
          return {
            success: false,
            error: "RELAYER_TIMEOUT",
            amountMerged: 0,
          };
        }
        throw error;
      } finally {
        console.log = originalLog;
      }

      // Check if transaction actually succeeded (must have a valid tx hash)
      if (!result || !result.transactionHash) {
        console.log(`   ❌ Merge failed on-chain`);
        return {
          success: false,
          error: "TRANSACTION_FAILED_ONCHAIN",
        };
      }

      console.log(
        `   ✅ Merged → $${amount.toFixed(0)} USDC (tx: ${result.transactionHash.slice(0, 10)}...)`,
      );

      return {
        success: true,
        transactionHash: result.transactionHash,
        amountMerged: amount,
      };
    } catch (error: any) {
      // V36.1: Concise error logging
      const errMsg = error.message || "Unknown error";
      if (errMsg.includes("SafeMath: subtraction overflow")) {
        console.log(`   ❌ Merge failed: insufficient balance`);
        return { success: false, error: "INSUFFICIENT_BALANCE" };
      }
      if (errMsg.includes("ERC20: transfer amount exceeds balance")) {
        console.log(`   ❌ Merge failed: balance mismatch`);
        return { success: false, error: "BALANCE_MISMATCH" };
      }
      console.log(`   ❌ Merge failed: ${errMsg.slice(0, 50)}`);
      return { success: false, error: errMsg };
    }
  }
  /**
   * PROXY mode with DirectExecution: Execute merge via direct on-chain execTransaction()
   * Pays gas from EOA MATIC balance instead of using relayer quota
   */
  private async mergeViaDirectExecution(
    conditionId: string,
    amount: number,
    isNegRisk: boolean = false,
  ): Promise<MergeResult> {
    if (!this.directClient) {
      return { success: false, error: "DirectExecutionClient not initialized" };
    }

    try {
      const formattedConditionId = conditionId.startsWith("0x")
        ? conditionId
        : `0x${conditionId}`;

      // Convert to 6 decimals (USDC precision) - shares are stored as 1e6
      const amountInWei = Math.floor(amount * 1_000_000);

      let mergeTx: SafeTransaction;
      if (isNegRisk) {
        mergeTx = {
          to: NEGRISK_ADAPTER,
          operation: OperationType.Call,
          data: this.negRiskInterface.encodeFunctionData("mergePositions", [
            formattedConditionId,
            amountInWei,
          ]),
          value: "0",
        };
      } else {
        mergeTx = {
          to: CTF_CONTRACT,
          operation: OperationType.Call,
          data: this.ctfInterface.encodeFunctionData("mergePositions", [
            USDC_E,
            PARENT_COLLECTION_ID,
            formattedConditionId,
            [1, 2],
            amountInWei,
          ]),
          value: "0",
        };
      }

      const contractType = isNegRisk
        ? "NegRiskAdapter (sports)"
        : "CTF (crypto)";
      console.log(
        `🔀 Merging ${amount} shares via direct execution [${contractType}]...`,
      );

      // Execute via DirectExecutionClient (same SafeTransaction[] format)
      const result = await this.directClient.execute([mergeTx]);

      if (!result.success) {
        console.log(`   ❌ Direct merge failed: ${result.error}`);

        // Fall back to relayer if available
        if (this.client) {
          console.log(`   🔄 Falling back to relayer...`);
          return this.mergeViaRelayerFallback(conditionId, amount, isNegRisk);
        }

        return {
          success: false,
          error: result.error,
        };
      }

      console.log(
        `   ✅ Merged → $${amount.toFixed(0)} USDC (tx: ${result.transactionHash?.slice(0, 14)}..., gas: ${result.gasCostMatic} MATIC)`,
      );

      return {
        success: true,
        transactionHash: result.transactionHash,
        amountMerged: amount,
      };
    } catch (error: any) {
      const errMsg = error.message || "Unknown error";
      console.log(`   ❌ Direct merge failed: ${errMsg.slice(0, 50)}`);

      // Fall back to relayer if available
      if (this.client) {
        console.log(`   🔄 Falling back to relayer...`);
        return this.mergeViaRelayerFallback(conditionId, amount, isNegRisk);
      }

      return { success: false, error: errMsg };
    }
  }

  /**
   * Fallback: Execute merge via relayer when direct execution fails
   */
  private async mergeViaRelayerFallback(
    conditionId: string,
    amount: number,
    isNegRisk: boolean = false,
  ): Promise<MergeResult> {
    // Temporarily disable direct execution for this call
    const savedFlag = this.useDirectExecution;
    this.useDirectExecution = false;
    try {
      return await this.mergeViaRelayer(conditionId, amount, isNegRisk);
    } finally {
      this.useDirectExecution = savedFlag;
    }
  }
}

export default MergeClient;
