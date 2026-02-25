/**
 * SplitClient
 * Handles splitting USDC collateral into conditional token positions via Polymarket's Builder Relayer (gas-free for PROXY)
 * or direct on-chain execution (for EOA mode)
 * SPLIT: Converts USDC into equal UP + DOWN tokens
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

// Polymarket Exchange Contracts that need CTF approval for selling
const CLOB_EXCHANGE = "0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E"; // Main Exchange
const NEG_RISK_CTF_EXCHANGE = "0xC5d563A36AE78145C45a50134d48A1215220f80a"; // Neg Risk CTF Exchange

export interface SplitResult {
  success: boolean;
  transactionHash?: string;
  error?: string;
  amountSplit?: number;
}

export interface ApprovalResult {
  success: boolean;
  transactionHash?: string;
  error?: string;
  alreadyApproved?: boolean;
}

export class SplitClient {
  private client: RelayClient | null = null;
  private directClient: DirectExecutionClient | null = null;
  private useDirectExecution: boolean = false;
  private eoaWallet: ethers.Wallet | null = null;
  private authMode: "EOA" | "PROXY";
  private ctfInterface: Interface;
  private negRiskInterface: Interface;
  private erc20Interface: Interface;
  private erc1155Interface: Interface;
  private walletAddress: string;
  private ctfApprovalsSet: boolean = false; // Track if we've set approvals this session

  constructor(privateKey: string) {
    const formattedPk = privateKey.startsWith("0x")
      ? privateKey
      : `0x${privateKey}`;
    this.authMode = (process.env.AUTH_MODE || "PROXY") as "EOA" | "PROXY";

    // CTF splitPosition signature (for crypto markets)
    this.ctfInterface = new Interface([
      "function splitPosition(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] partition, uint256 amount)",
    ]);

    // NegRiskAdapter splitPosition signature (for sports markets - simpler interface)
    this.negRiskInterface = new Interface([
      "function splitPosition(bytes32 conditionId, uint256 amount)",
    ]);

    // ERC20 approve signature (needed before split)
    this.erc20Interface = new Interface([
      "function approve(address spender, uint256 amount)",
    ]);

    // ERC1155 setApprovalForAll signature (needed for selling tokens)
    this.erc1155Interface = new Interface([
      "function setApprovalForAll(address operator, bool approved)",
      "function isApprovedForAll(address account, address operator) view returns (bool)",
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
        `🔧 SplitClient initialized [EOA] for wallet: ${this.walletAddress}`,
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
          `🔧 SplitClient initialized [PROXY → DirectExecution] for wallet: ${this.walletAddress}`,
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
          `🔧 SplitClient initialized [PROXY] for wallet: ${this.walletAddress}`,
        );
      }
    }
  }

  /**
   * Split USDC into UP + DOWN tokens
   * @param conditionId - Market condition ID
   * @param amount - Amount of USDC to split (creates equal UP and DOWN tokens)
   * @param isNegRisk - If true, use NegRiskAdapter (for sports markets). Default false for crypto markets.
   */
  async split(
    conditionId: string,
    amount: number,
    isNegRisk: boolean = false,
  ): Promise<SplitResult> {
    // Route based on AUTH_MODE and market type
    if (this.authMode === "EOA") {
      return this.splitDirectOnChain(conditionId, amount, isNegRisk);
    } else {
      return this.splitViaRelayer(conditionId, amount, isNegRisk);
    }
  }

  /**
   * EOA mode: Execute split directly on-chain
   * Requires MATIC for gas fees
   */
  private async splitDirectOnChain(
    conditionId: string,
    amount: number,
    isNegRisk: boolean = false,
  ): Promise<SplitResult> {
    if (!this.eoaWallet) {
      return { success: false, error: "EOA wallet not initialized" };
    }

    try {
      const formattedConditionId = conditionId.startsWith("0x")
        ? conditionId
        : `0x${conditionId}`;

      // Convert to 6 decimals (USDC precision)
      const amountInWei = Math.floor(amount * 1_000_000);

      // Determine target contract for approval
      const targetContract = isNegRisk ? NEGRISK_ADAPTER : CTF_CONTRACT;

      // First, approve target contract to spend USDC
      const usdcContract = new ethers.Contract(
        USDC_E,
        [
          "function approve(address spender, uint256 amount)",
          "function allowance(address owner, address spender) view returns (uint256)",
        ],
        this.eoaWallet,
      );

      // Check current allowance
      const currentAllowance = await usdcContract.allowance(
        this.walletAddress,
        targetContract,
      );

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

      if (currentAllowance.lt(amountInWei)) {
        console.log(
          `   📤 Approving USDC spend for ${isNegRisk ? "NegRiskAdapter" : "CTF"}...`,
        );
        const approveTx = await usdcContract.approve(
          targetContract,
          ethers.constants.MaxUint256,
          gasOverrides,
        );
        await approveTx.wait();
        console.log(`   ✅ USDC approved`);
      }

      let tx;
      if (isNegRisk) {
        // Sports markets use NegRiskAdapter with simpler interface
        const negRiskContract = new ethers.Contract(
          NEGRISK_ADAPTER,
          ["function splitPosition(bytes32 conditionId, uint256 amount)"],
          this.eoaWallet,
        );

        console.log(
          `🔀 Splitting $${amount} via NegRiskAdapter (sports market)...`,
        );
        console.log(`   📤 Sending split tx...`);

        tx = await negRiskContract.splitPosition(
          formattedConditionId, // conditionId
          amountInWei, // amount
          gasOverrides,
        );
      } else {
        // Standard CTF for crypto markets
        const ctfContract = new ethers.Contract(
          CTF_CONTRACT,
          [
            "function splitPosition(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] partition, uint256 amount)",
          ],
          this.eoaWallet,
        );

        console.log(
          `🔀 Splitting $${amount} into UP + DOWN tokens on-chain...`,
        );
        console.log(`   📤 Sending split tx...`);

        tx = await ctfContract.splitPosition(
          USDC_E, // collateralToken
          PARENT_COLLECTION_ID, // parentCollectionId
          formattedConditionId, // conditionId
          [1, 2], // partition: [YES=1, NO=2] for binary markets
          amountInWei, // amount
          gasOverrides,
        );
      }

      console.log(
        `   ⏳ Waiting for confirmation (tx: ${tx.hash.slice(0, 10)}...)`,
      );
      const receipt = await tx.wait();

      if (receipt.status === 0) {
        console.log(`   ❌ Split failed on-chain`);
        return {
          success: false,
          error: "TRANSACTION_REVERTED",
        };
      }

      console.log(
        `   ✅ Split $${amount} → ${amount} tokens each side (tx: ${receipt.transactionHash.slice(0, 10)}...)`,
      );
      return {
        success: true,
        transactionHash: receipt.transactionHash,
        amountSplit: amount,
      };
    } catch (error: any) {
      const errMsg = error.message || "Unknown error";
      if (errMsg.includes("ERC20: transfer amount exceeds balance")) {
        console.log(`   ❌ Split failed: insufficient USDC balance`);
        return { success: false, error: "INSUFFICIENT_BALANCE" };
      }
      if (errMsg.includes("insufficient funds")) {
        console.log(`   ❌ Insufficient MATIC for gas`);
        return { success: false, error: "INSUFFICIENT_GAS" };
      }
      console.log(`   ❌ Split failed: ${errMsg.slice(0, 50)}`);
      return { success: false, error: errMsg };
    }
  }

  /**
   * PROXY mode: Execute split via Builder Relayer (gas-free)
   */
  private async splitViaRelayer(
    conditionId: string,
    amount: number,
    isNegRisk: boolean = false,
  ): Promise<SplitResult> {
    // Route to direct execution if enabled
    if (this.useDirectExecution && this.directClient) {
      return this.splitViaDirectExecution(conditionId, amount, isNegRisk);
    }

    if (!this.client) {
      return { success: false, error: "Relayer client not initialized" };
    }

    try {
      const formattedConditionId = conditionId.startsWith("0x")
        ? conditionId
        : `0x${conditionId}`;

      // Convert to 6 decimals (USDC precision)
      const amountInWei = Math.floor(amount * 1_000_000);

      // Determine target contract
      const targetContract = isNegRisk ? NEGRISK_ADAPTER : CTF_CONTRACT;

      // For PROXY mode, we need to approve and split in a batch transaction
      // The relayer handles the approval automatically, but we include it for safety
      const approveTx: SafeTransaction = {
        to: USDC_E,
        operation: OperationType.Call,
        data: this.erc20Interface.encodeFunctionData("approve", [
          targetContract,
          amountInWei,
        ]),
        value: "0",
      };

      let splitTx: SafeTransaction;
      if (isNegRisk) {
        // Sports markets use NegRiskAdapter with simpler interface
        splitTx = {
          to: NEGRISK_ADAPTER,
          operation: OperationType.Call,
          data: this.negRiskInterface.encodeFunctionData("splitPosition", [
            formattedConditionId, // conditionId
            amountInWei, // amount
          ]),
          value: "0",
        };
      } else {
        // Standard CTF for crypto markets
        splitTx = {
          to: CTF_CONTRACT,
          operation: OperationType.Call,
          data: this.ctfInterface.encodeFunctionData("splitPosition", [
            USDC_E, // collateralToken
            PARENT_COLLECTION_ID, // parentCollectionId
            formattedConditionId, // conditionId
            [1, 2], // partition: [YES=1, NO=2] for binary markets
            amountInWei, // amount
          ]),
          value: "0",
        };
      }

      // Suppress verbose logs during execution
      const originalLog = console.log;
      console.log = () => {};

      let response;
      try {
        response = await this.client.execute(
          [approveTx, splitTx],
          "Split position",
        );
      } finally {
        console.log = originalLog;
      }

      const contractType = isNegRisk
        ? "NegRiskAdapter (sports)"
        : "CTF (crypto)";
      console.log(`🔀 Splitting $${amount} via relayer [${contractType}]...`);

      const TIMEOUT_MS = 60000;
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error("RELAYER_TIMEOUT")), TIMEOUT_MS),
      );

      // Suppress logs during wait()
      console.log = () => {};

      let result: any;
      try {
        result = await Promise.race([response.wait(), timeoutPromise]);
      } catch (error: any) {
        console.log = originalLog;
        if (error.message === "RELAYER_TIMEOUT") {
          console.log(`   ⚠️ Split timeout - verify on-chain`);
          return {
            success: false,
            error: "RELAYER_TIMEOUT",
            amountSplit: 0,
          };
        }
        throw error;
      } finally {
        console.log = originalLog;
      }

      // Check if transaction actually succeeded
      if (!result || !result.transactionHash) {
        console.log(`   ❌ Split failed on-chain`);
        return {
          success: false,
          error: "TRANSACTION_FAILED_ONCHAIN",
        };
      }

      console.log(
        `   ✅ Split $${amount} → ${amount} tokens each side (tx: ${result.transactionHash.slice(0, 10)}...)`,
      );

      return {
        success: true,
        transactionHash: result.transactionHash,
        amountSplit: amount,
      };
    } catch (error: any) {
      const errMsg = error.message || "Unknown error";
      if (errMsg.includes("ERC20: transfer amount exceeds balance")) {
        console.log(`   ❌ Split failed: insufficient USDC balance`);
        return { success: false, error: "INSUFFICIENT_BALANCE" };
      }
      console.log(`   ❌ Split failed: ${errMsg.slice(0, 50)}`);
      return { success: false, error: errMsg };
    }
  }

  /**
   * PROXY mode with DirectExecution: Execute split via direct on-chain execTransaction()
   * Pays gas from EOA MATIC balance instead of using relayer quota
   */
  private async splitViaDirectExecution(
    conditionId: string,
    amount: number,
    isNegRisk: boolean = false,
  ): Promise<SplitResult> {
    if (!this.directClient) {
      return { success: false, error: "DirectExecutionClient not initialized" };
    }

    try {
      const formattedConditionId = conditionId.startsWith("0x")
        ? conditionId
        : `0x${conditionId}`;

      // Convert to 6 decimals (USDC precision)
      const amountInWei = Math.floor(amount * 1_000_000);

      // Determine target contract
      const targetContract = isNegRisk ? NEGRISK_ADAPTER : CTF_CONTRACT;

      // Build the same SafeTransaction[] that we'd send to the relayer
      const approveTx: SafeTransaction = {
        to: USDC_E,
        operation: OperationType.Call,
        data: this.erc20Interface.encodeFunctionData("approve", [
          targetContract,
          amountInWei,
        ]),
        value: "0",
      };

      let splitTx: SafeTransaction;
      if (isNegRisk) {
        splitTx = {
          to: NEGRISK_ADAPTER,
          operation: OperationType.Call,
          data: this.negRiskInterface.encodeFunctionData("splitPosition", [
            formattedConditionId,
            amountInWei,
          ]),
          value: "0",
        };
      } else {
        splitTx = {
          to: CTF_CONTRACT,
          operation: OperationType.Call,
          data: this.ctfInterface.encodeFunctionData("splitPosition", [
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
        `🔀 Splitting $${amount} via direct execution [${contractType}]...`,
      );

      // Execute via DirectExecutionClient (same SafeTransaction[] format)
      const result = await this.directClient.execute([approveTx, splitTx]);

      if (!result.success) {
        console.log(`   ❌ Direct split failed: ${result.error}`);

        // Fall back to relayer if available
        if (this.client) {
          console.log(`   🔄 Falling back to relayer...`);
          return this.splitViaRelayerFallback(conditionId, amount, isNegRisk);
        }

        return {
          success: false,
          error: result.error,
        };
      }

      console.log(
        `   ✅ Split $${amount} → ${amount} tokens each side (tx: ${result.transactionHash?.slice(0, 14)}..., gas: ${result.gasCostMatic} MATIC)`,
      );

      return {
        success: true,
        transactionHash: result.transactionHash,
        amountSplit: amount,
      };
    } catch (error: any) {
      const errMsg = error.message || "Unknown error";
      console.log(`   ❌ Direct split failed: ${errMsg.slice(0, 50)}`);

      // Fall back to relayer if available
      if (this.client) {
        console.log(`   🔄 Falling back to relayer...`);
        return this.splitViaRelayerFallback(conditionId, amount, isNegRisk);
      }

      return { success: false, error: errMsg };
    }
  }

  /**
   * Fallback: Execute split via relayer when direct execution fails
   */
  private async splitViaRelayerFallback(
    conditionId: string,
    amount: number,
    isNegRisk: boolean = false,
  ): Promise<SplitResult> {
    // Temporarily disable direct execution for this call
    const savedFlag = this.useDirectExecution;
    this.useDirectExecution = false;
    try {
      return await this.splitViaRelayer(conditionId, amount, isNegRisk);
    } finally {
      this.useDirectExecution = savedFlag;
    }
  }

  /**
   * Ensure CTF (ERC-1155) approvals are set for the Polymarket exchange contracts.
   * This is required before selling tokens on the CLOB.
   *
   * In PROXY mode, executes via Builder Relayer (gas-free).
   * In EOA mode, executes direct on-chain transactions.
   *
   * @returns ApprovalResult with success status
   */
  async ensureCTFApprovals(): Promise<ApprovalResult> {
    // Skip if already set this session
    if (this.ctfApprovalsSet) {
      return { success: true, alreadyApproved: true };
    }

    console.log(`🔐 Setting up CTF approvals for CLOB trading...`);

    if (this.authMode === "PROXY") {
      if (this.useDirectExecution && this.directClient) {
        return this.setCTFApprovalsViaDirectExecution();
      }
      return this.setCTFApprovalsViaRelayer();
    } else {
      return this.setCTFApprovalsEOA();
    }
  }

  /**
   * PROXY mode with DirectExecution: Set CTF approvals via direct on-chain execTransaction()
   */
  private async setCTFApprovalsViaDirectExecution(): Promise<ApprovalResult> {
    if (!this.directClient) {
      return { success: false, error: "DirectExecutionClient not initialized" };
    }

    try {
      const approvalTxs: SafeTransaction[] = [
        {
          to: CTF_CONTRACT,
          operation: OperationType.Call,
          data: this.erc1155Interface.encodeFunctionData("setApprovalForAll", [
            CLOB_EXCHANGE,
            true,
          ]),
          value: "0",
        },
        {
          to: CTF_CONTRACT,
          operation: OperationType.Call,
          data: this.erc1155Interface.encodeFunctionData("setApprovalForAll", [
            NEG_RISK_CTF_EXCHANGE,
            true,
          ]),
          value: "0",
        },
        {
          to: CTF_CONTRACT,
          operation: OperationType.Call,
          data: this.erc1155Interface.encodeFunctionData("setApprovalForAll", [
            NEGRISK_ADAPTER,
            true,
          ]),
          value: "0",
        },
      ];

      const result = await this.directClient.execute(approvalTxs);

      if (!result.success) {
        console.log(
          `   ❌ CTF approval via direct execution failed: ${result.error}`,
        );
        // Fall back to relayer if available
        if (this.client) {
          console.log(`   🔄 Falling back to relayer for approvals...`);
          return this.setCTFApprovalsViaRelayer();
        }
        return { success: false, error: result.error };
      }

      console.log(
        `   ✅ CTF approvals set via direct execution (tx: ${result.transactionHash?.slice(0, 14)}..., gas: ${result.gasCostMatic} MATIC)`,
      );
      this.ctfApprovalsSet = true;

      return {
        success: true,
        transactionHash: result.transactionHash,
      };
    } catch (error: any) {
      const errMsg = error.message || "Unknown error";
      console.log(`   ❌ CTF approval failed: ${errMsg.slice(0, 50)}`);
      // Fall back to relayer if available
      if (this.client) {
        console.log(`   🔄 Falling back to relayer for approvals...`);
        return this.setCTFApprovalsViaRelayer();
      }
      return { success: false, error: errMsg };
    }
  }

  /**
   * PROXY mode: Set CTF approvals via Builder Relayer (gas-free)
   */
  private async setCTFApprovalsViaRelayer(): Promise<ApprovalResult> {
    if (!this.client) {
      return { success: false, error: "Relayer client not initialized" };
    }

    try {
      // Build approval transactions for both exchange contracts
      const approvalTxs: SafeTransaction[] = [
        // Approve Main CLOB Exchange
        {
          to: CTF_CONTRACT,
          operation: OperationType.Call,
          data: this.erc1155Interface.encodeFunctionData("setApprovalForAll", [
            CLOB_EXCHANGE,
            true,
          ]),
          value: "0",
        },
        // Approve Neg Risk CTF Exchange
        {
          to: CTF_CONTRACT,
          operation: OperationType.Call,
          data: this.erc1155Interface.encodeFunctionData("setApprovalForAll", [
            NEG_RISK_CTF_EXCHANGE,
            true,
          ]),
          value: "0",
        },
        // Also approve Neg Risk Adapter (for sports markets)
        {
          to: CTF_CONTRACT,
          operation: OperationType.Call,
          data: this.erc1155Interface.encodeFunctionData("setApprovalForAll", [
            NEGRISK_ADAPTER,
            true,
          ]),
          value: "0",
        },
      ];

      // Suppress verbose logs during execution
      const originalLog = console.log;
      console.log = () => {};

      let response;
      try {
        response = await this.client.execute(approvalTxs, "Set CTF approvals");
      } finally {
        console.log = originalLog;
      }

      const TIMEOUT_MS = 60000;
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error("APPROVAL_TIMEOUT")), TIMEOUT_MS),
      );

      // Suppress logs during wait()
      console.log = () => {};

      let result: any;
      try {
        result = await Promise.race([response.wait(), timeoutPromise]);
      } catch (error: any) {
        console.log = originalLog;
        if (error.message === "APPROVAL_TIMEOUT") {
          console.log(`   ⚠️ CTF approval timeout - verify on-chain`);
          return { success: false, error: "APPROVAL_TIMEOUT" };
        }
        throw error;
      } finally {
        console.log = originalLog;
      }

      if (!result || !result.transactionHash) {
        console.log(`   ❌ CTF approval failed on-chain`);
        return { success: false, error: "APPROVAL_FAILED_ONCHAIN" };
      }

      console.log(
        `   ✅ CTF approvals set for CLOB exchanges (tx: ${result.transactionHash.slice(0, 10)}...)`,
      );
      this.ctfApprovalsSet = true;

      return {
        success: true,
        transactionHash: result.transactionHash,
      };
    } catch (error: any) {
      const errMsg = error.message || "Unknown error";
      console.log(`   ❌ CTF approval failed: ${errMsg.slice(0, 50)}`);
      return { success: false, error: errMsg };
    }
  }

  /**
   * EOA mode: Set CTF approvals via direct on-chain transactions
   */
  private async setCTFApprovalsEOA(): Promise<ApprovalResult> {
    if (!this.eoaWallet) {
      return { success: false, error: "EOA wallet not initialized" };
    }

    try {
      const ctfContract = new ethers.Contract(
        CTF_CONTRACT,
        [
          "function setApprovalForAll(address operator, bool approved)",
          "function isApprovedForAll(address account, address operator) view returns (bool)",
        ],
        this.eoaWallet,
      );

      const exchanges = [
        { name: "CLOB Exchange", address: CLOB_EXCHANGE },
        { name: "Neg Risk CTF", address: NEG_RISK_CTF_EXCHANGE },
        { name: "Neg Risk Adapter", address: NEGRISK_ADAPTER },
      ];

      let lastTxHash: string | undefined;

      for (const exchange of exchanges) {
        // Check if already approved
        const isApproved = await ctfContract.isApprovedForAll(
          this.walletAddress,
          exchange.address,
        );
        if (isApproved) {
          console.log(`   ✅ ${exchange.name} already approved`);
          continue;
        }

        console.log(`   🔐 Approving ${exchange.name}...`);
        const tx = await ctfContract.setApprovalForAll(exchange.address, true);
        const receipt = await tx.wait();
        lastTxHash = receipt.transactionHash;
        console.log(
          `   ✅ ${exchange.name} approved (tx: ${lastTxHash!.slice(0, 10)}...)`,
        );
      }

      this.ctfApprovalsSet = true;
      return {
        success: true,
        transactionHash: lastTxHash,
        alreadyApproved: !lastTxHash, // If no tx, all were already approved
      };
    } catch (error: any) {
      const errMsg = error.message || "Unknown error";
      console.log(`   ❌ CTF approval failed: ${errMsg.slice(0, 50)}`);
      return { success: false, error: errMsg };
    }
  }

  /**
   * Get the wallet address (signer address in PROXY mode)
   */
  getWalletAddress(): string {
    return this.walletAddress;
  }

  /**
   * Check if we're in PROXY or EOA mode
   */
  getAuthMode(): "EOA" | "PROXY" {
    return this.authMode;
  }
}

export default SplitClient;
