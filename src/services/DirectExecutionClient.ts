/**
 * DirectExecutionClient
 *
 * Drop-in replacement for RelayClient.execute() that bypasses the Builder Relayer
 * by calling execTransaction() on the Gnosis Safe proxy contract directly.
 *
 * The EOA pays Polygon gas (MATIC) instead of using the relayer's quota (100/day).
 *
 * Architecture:
 *   1. Takes the same SafeTransaction[] that RelayClient.execute() accepts
 *   2. Aggregates multiple txns via SafeMultisend (same as relayer)
 *   3. Builds EIP-712 typed data hash (SafeTx domain)
 *   4. Signs with EOA private key using eth_signTypedData_v4
 *   5. Packs signature into Gnosis format (r + s + v, 65 bytes)
 *   6. Calls execTransaction() on the proxy contract directly
 *   7. Waits for receipt and returns result
 */

import { ethers } from "ethers";
import {
  SafeTransaction,
  OperationType,
} from "@polymarket/builder-relayer-client";

// ─── Constants ────────────────────────────────────────────────────────────────

const POLYGON_CHAIN_ID = 137;

// Polymarket Safe infrastructure addresses (same on Polygon mainnet and Amoy)
const SAFE_FACTORY = "0xaacFeEa03eb1561C4e67d661e40682Bd20E3541b";
const SAFE_MULTISEND = "0xA238CBeb142c10Ef7Ad8442C6D1f9E89e07e7761";
const SAFE_INIT_CODE_HASH =
  "0x2bce2127ff07fb632d16c8347c4ebf501f4841168bed00d9e6ef715ddb6fcecf";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

// Minimal Gnosis Safe ABI — only the functions we need
const SAFE_ABI = [
  "function nonce() view returns (uint256)",
  "function getOwners() view returns (address[])",
  "function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address payable refundReceiver, bytes signatures) payable returns (bool)",
];

// Multisend ABI
const MULTISEND_ABI = [
  "function multiSend(bytes transactions) payable",
];

// EIP-712 types for SafeTx (Gnosis Safe standard)
const EIP712_SAFE_TX_TYPES = {
  SafeTx: [
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "data", type: "bytes" },
    { name: "operation", type: "uint8" },
    { name: "safeTxGas", type: "uint256" },
    { name: "baseGas", type: "uint256" },
    { name: "gasPrice", type: "uint256" },
    { name: "gasToken", type: "address" },
    { name: "refundReceiver", type: "address" },
    { name: "nonce", type: "uint256" },
  ],
};

// ─── Types ────────────────────────────────────────────────────────────────────

export interface DirectExecutionResult {
  success: boolean;
  transactionHash?: string;
  error?: string;
  gasUsed?: string;
  gasCostMatic?: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Derive the Gnosis Safe proxy address from the EOA address and SafeFactory.
 * Uses CREATE2: address = keccak256(0xff ++ factory ++ salt ++ initCodeHash)[12:]
 * where salt = keccak256(abi.encode(eoaAddress))
 */
function deriveSafeAddress(eoaAddress: string): string {
  const salt = ethers.utils.keccak256(
    ethers.utils.defaultAbiCoder.encode(["address"], [eoaAddress])
  );
  return ethers.utils.getCreate2Address(SAFE_FACTORY, salt, SAFE_INIT_CODE_HASH);
}

/**
 * Aggregate multiple SafeTransactions into a single transaction.
 * If only 1 txn, returns it directly.
 * If multiple, encodes them via SafeMultisend with DELEGATECALL.
 *
 * The multisend encoding packs each sub-transaction as:
 *   uint8 operation | address to | uint256 value | uint256 dataLength | bytes data
 * All concatenated into a single bytes blob, then passed to multiSend().
 */
function aggregateTransactions(
  txns: SafeTransaction[]
): { to: string; value: string; data: string; operation: number } {
  if (txns.length === 1) {
    return {
      to: txns[0].to,
      value: txns[0].value,
      data: txns[0].data,
      operation: txns[0].operation,
    };
  }

  // Encode each sub-txn for multisend
  const packedTxns = txns.map((tx) => {
    const dataBytes = ethers.utils.arrayify(tx.data);
    return ethers.utils.solidityPack(
      ["uint8", "address", "uint256", "uint256", "bytes"],
      [tx.operation, tx.to, tx.value, dataBytes.length, dataBytes]
    );
  });

  // Concatenate all packed transactions
  const concatenated = ethers.utils.hexConcat(packedTxns);

  // Encode the multiSend call
  const multisendInterface = new ethers.utils.Interface(MULTISEND_ABI);
  const data = multisendInterface.encodeFunctionData("multiSend", [
    concatenated,
  ]);

  return {
    to: SAFE_MULTISEND,
    value: "0",
    data: data,
    operation: OperationType.DelegateCall, // Multisend is always DELEGATECALL
  };
}

// ─── Client ───────────────────────────────────────────────────────────────────

export class DirectExecutionClient {
  private wallet: ethers.Wallet;
  private provider: ethers.providers.JsonRpcProvider;
  private proxyAddress: string;
  private safeContract: ethers.Contract;

  constructor(privateKey: string, rpcUrl?: string) {
    const formattedPk = privateKey.startsWith("0x")
      ? privateKey
      : `0x${privateKey}`;

    const rpc =
      rpcUrl ||
      process.env.RPC_URL ||
      process.env.POLYGON_RPC_URL ||
      "https://polygon-rpc.com";

    this.provider = new ethers.providers.JsonRpcProvider(rpc);
    this.wallet = new ethers.Wallet(formattedPk, this.provider);

    // Derive proxy address from EOA using CREATE2 (same as builder package)
    this.proxyAddress = deriveSafeAddress(this.wallet.address);

    // Create contract instance for the proxy
    this.safeContract = new ethers.Contract(
      this.proxyAddress,
      SAFE_ABI,
      this.wallet // connected to our EOA signer so we pay gas
    );

    console.log(
      `⚡ DirectExecutionClient initialized`
    );
    console.log(
      `   EOA: ${this.wallet.address}`
    );
    console.log(
      `   Proxy (Safe): ${this.proxyAddress}`
    );
  }

  /**
   * Get the derived proxy (Safe) address
   */
  getProxyAddress(): string {
    return this.proxyAddress;
  }

  /**
   * Get the EOA address
   */
  getEOAAddress(): string {
    return this.wallet.address;
  }

  /**
   * Read the current nonce from the proxy contract on-chain
   */
  async getNonce(): Promise<number> {
    const nonce = await this.safeContract.nonce();
    return nonce.toNumber();
  }

  /**
   * Get MATIC balance of the EOA (for gas estimation)
   */
  async getMaticBalance(): Promise<string> {
    const balance = await this.provider.getBalance(this.wallet.address);
    return ethers.utils.formatEther(balance);
  }

  /**
   * Drop-in replacement for RelayClient.execute()
   *
   * Takes the same SafeTransaction[] array, signs with EIP-712,
   * and calls execTransaction() on the Gnosis Safe proxy directly.
   */
  async execute(txns: SafeTransaction[]): Promise<DirectExecutionResult> {
    try {
      if (txns.length === 0) {
        return { success: false, error: "No transactions to execute" };
      }

      // 1. Aggregate transactions (single or multisend batch)
      const aggregated = aggregateTransactions(txns);

      // 2. Read on-chain nonce from proxy
      const nonce = await this.getNonce();

      // 3. Build EIP-712 domain and values
      const domain = {
        chainId: POLYGON_CHAIN_ID,
        verifyingContract: this.proxyAddress,
      };

      const values = {
        to: aggregated.to,
        value: aggregated.value,
        data: aggregated.data,
        operation: aggregated.operation,
        safeTxGas: 0,
        baseGas: 0,
        gasPrice: 0,
        gasToken: ZERO_ADDRESS,
        refundReceiver: ZERO_ADDRESS,
        nonce: nonce,
      };

      // 4. Sign with EIP-712 (_signTypedData in ethers.js v5)
      const signature = await this.wallet._signTypedData(
        domain,
        EIP712_SAFE_TX_TYPES,
        values
      );

      // 5. Pack signature into Gnosis Safe format (r + s + v, 65 bytes)
      // ethers returns compact sig, we need to split and repack
      const sig = ethers.utils.splitSignature(signature);
      // Gnosis Safe expects v = 27 or 28 for ECDSA signatures
      const packedSignature = ethers.utils.solidityPack(
        ["bytes32", "bytes32", "uint8"],
        [sig.r, sig.s, sig.v]
      );

      // 6. Estimate gas with buffer
      let gasEstimate: ethers.BigNumber;
      try {
        gasEstimate = await this.safeContract.estimateGas.execTransaction(
          aggregated.to,
          aggregated.value,
          aggregated.data,
          aggregated.operation,
          0, // safeTxGas
          0, // baseGas
          0, // gasPrice
          ZERO_ADDRESS, // gasToken
          ZERO_ADDRESS, // refundReceiver
          packedSignature
        );
      } catch (estimateError: any) {
        // If gas estimation fails, the transaction would revert
        const reason = estimateError.reason || estimateError.message || "Unknown";
        console.error(
          `   ❌ Gas estimation failed (tx would revert): ${reason.slice(0, 100)}`
        );
        return {
          success: false,
          error: `GAS_ESTIMATION_FAILED: ${reason.slice(0, 200)}`,
        };
      }

      // Add 20% gas buffer for safety
      const gasLimit = gasEstimate.mul(120).div(100);

      // 7. Get gas price params (EIP-1559)
      const feeData = await this.provider.getFeeData();
      const minPriorityFee = ethers.utils.parseUnits("30", "gwei");
      const minMaxFee = ethers.utils.parseUnits("100", "gwei");

      const maxPriorityFeePerGas =
        feeData.maxPriorityFeePerGas &&
        feeData.maxPriorityFeePerGas.gt(minPriorityFee)
          ? feeData.maxPriorityFeePerGas
          : minPriorityFee;

      const maxFeePerGas =
        feeData.maxFeePerGas && feeData.maxFeePerGas.gt(minMaxFee)
          ? feeData.maxFeePerGas
          : minMaxFee;

      // 8. Send the execTransaction call
      console.log(
        `   📤 Sending execTransaction (nonce=${nonce}, gasLimit=${gasLimit.toString()}, txns=${txns.length})...`
      );

      const tx = await this.safeContract.execTransaction(
        aggregated.to,
        aggregated.value,
        aggregated.data,
        aggregated.operation,
        0, // safeTxGas
        0, // baseGas
        0, // gasPrice
        ZERO_ADDRESS, // gasToken
        ZERO_ADDRESS, // refundReceiver
        packedSignature,
        {
          gasLimit,
          maxPriorityFeePerGas,
          maxFeePerGas,
        }
      );

      // 9. Wait for receipt
      console.log(
        `   ⏳ Waiting for confirmation (tx: ${tx.hash.slice(0, 14)}...)...`
      );
      const receipt = await tx.wait();

      if (receipt.status === 0) {
        console.error(`   ❌ Transaction reverted on-chain`);
        return {
          success: false,
          error: "TRANSACTION_REVERTED",
          transactionHash: receipt.transactionHash,
          gasUsed: receipt.gasUsed.toString(),
        };
      }

      // Check for ExecutionFailure event (Safe can succeed as tx but fail internally)
      const executionFailureTopic = ethers.utils.id(
        "ExecutionFailure(bytes32,uint256)"
      );
      const hasFailure = receipt.logs.some(
        (log: any) => log.topics[0] === executionFailureTopic
      );

      if (hasFailure) {
        console.error(
          `   ❌ Safe execTransaction succeeded but inner transaction failed`
        );
        return {
          success: false,
          error: "SAFE_EXECUTION_FAILURE",
          transactionHash: receipt.transactionHash,
          gasUsed: receipt.gasUsed.toString(),
        };
      }

      const gasCost = receipt.gasUsed.mul(receipt.effectiveGasPrice);

      console.log(
        `   ✅ Direct execution succeeded (tx: ${receipt.transactionHash.slice(0, 14)}..., gas: ${receipt.gasUsed.toString()}, cost: ${ethers.utils.formatEther(gasCost)} MATIC)`
      );

      return {
        success: true,
        transactionHash: receipt.transactionHash,
        gasUsed: receipt.gasUsed.toString(),
        gasCostMatic: ethers.utils.formatEther(gasCost),
      };
    } catch (error: any) {
      const errMsg = error.message || "Unknown error";

      if (errMsg.includes("insufficient funds")) {
        console.error(`   ❌ Insufficient MATIC for gas`);
        return { success: false, error: "INSUFFICIENT_MATIC_FOR_GAS" };
      }
      if (errMsg.includes("nonce")) {
        console.error(`   ❌ Nonce error: ${errMsg.slice(0, 100)}`);
        return { success: false, error: `NONCE_ERROR: ${errMsg.slice(0, 100)}` };
      }

      console.error(
        `   ❌ Direct execution failed: ${errMsg.slice(0, 100)}`
      );
      return { success: false, error: errMsg.slice(0, 500) };
    }
  }
}

export default DirectExecutionClient;
