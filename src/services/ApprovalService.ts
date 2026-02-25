/**
 * ApprovalService - Handles Polymarket contract approvals for vault initialization
 *
 * Before a wallet can trade on Polymarket, it must approve:
 * 1. USDC.e (ERC-20) - For placing buy orders
 * 2. CTF (ERC-1155) - For selling outcome shares
 *
 * For 3 Polymarket contracts = 6 total approvals
 */

import { ethers } from 'ethers';

// Polygon Mainnet Contract Addresses
const USDC_ADDRESS = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';  // USDC.e (bridged)
const CTF_ADDRESS = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045';   // Conditional Token Framework

// Polymarket Contracts (Spenders)
const CONTRACTS_TO_APPROVE = [
  { name: 'Main Exchange', address: '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E' },
  { name: 'Neg Risk CTF', address: '0xC5d563A36AE78145C45a50134d48A1215220f80a' },
  { name: 'Neg Risk Adapter', address: '0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296' },
];

// ABIs
const ERC20_ABI = [
  'function approve(address spender, uint256 amount) public returns (bool)',
  'function allowance(address owner, address spender) public view returns (uint256)',
  'function balanceOf(address owner) view returns (uint256)',
  'function decimals() view returns (uint8)',
];

const ERC1155_ABI = [
  'function setApprovalForAll(address operator, bool approved) public',
  'function isApprovedForAll(address account, address operator) public view returns (bool)',
];

export interface ApprovalStatus {
  hasAllApprovals: boolean;
  usdcApprovals: Record<string, boolean>;
  ctfApprovals: Record<string, boolean>;
}

export interface ApprovalResult {
  success: boolean;
  txHash?: string;
  error?: string;
}

export class ApprovalService {
  private provider: ethers.providers.JsonRpcProvider;
  private wallet: ethers.Wallet;
  private walletAddress: string;

  constructor(privateKey: string, rpcUrl?: string) {
    this.provider = new ethers.providers.JsonRpcProvider(
      rpcUrl || process.env.RPC_URL || 'https://polygon-rpc.com'
    );
    this.wallet = new ethers.Wallet(privateKey, this.provider);
    this.walletAddress = this.wallet.address;
  }

  /**
   * Get the wallet address being initialized
   */
  getWalletAddress(): string {
    return this.walletAddress;
  }

  /**
   * Check POL balance for gas
   */
  async getPolBalance(): Promise<number> {
    const balance = await this.provider.getBalance(this.walletAddress);
    return parseFloat(ethers.utils.formatEther(balance));
  }

  /**
   * Get USDC.e balance
   */
  async getUsdcBalance(): Promise<number> {
    const usdcContract = new ethers.Contract(USDC_ADDRESS, ERC20_ABI, this.provider);
    const balance = await usdcContract.balanceOf(this.walletAddress);
    const decimals = await usdcContract.decimals();
    return parseFloat(ethers.utils.formatUnits(balance, decimals));
  }

  /**
   * Check all approval statuses
   */
  async checkApprovals(): Promise<ApprovalStatus> {
    const usdcContract = new ethers.Contract(USDC_ADDRESS, ERC20_ABI, this.provider);
    const ctfContract = new ethers.Contract(CTF_ADDRESS, ERC1155_ABI, this.provider);

    const usdcApprovals: Record<string, boolean> = {};
    const ctfApprovals: Record<string, boolean> = {};

    for (const contract of CONTRACTS_TO_APPROVE) {
      // Check USDC allowance (> 1M USDC considered "approved")
      const allowance = await usdcContract.allowance(this.walletAddress, contract.address);
      usdcApprovals[contract.name] = allowance.gt(ethers.utils.parseUnits('1000000', 6));

      // Check CTF approval
      ctfApprovals[contract.name] = await ctfContract.isApprovedForAll(
        this.walletAddress,
        contract.address
      );
    }

    const hasAllApprovals =
      Object.values(usdcApprovals).every((v) => v) &&
      Object.values(ctfApprovals).every((v) => v);

    return { hasAllApprovals, usdcApprovals, ctfApprovals };
  }

  /**
   * Approve USDC.e for a specific contract
   */
  async approveUsdc(contractAddress: string): Promise<ApprovalResult> {
    const usdcContract = new ethers.Contract(USDC_ADDRESS, ERC20_ABI, this.wallet);

    try {
      // Check current allowance
      const allowance = await usdcContract.allowance(this.walletAddress, contractAddress);
      if (allowance.gt(ethers.utils.parseUnits('1000000', 6))) {
        return { success: true, txHash: 'already-approved' };
      }

      // Get gas price with 20% buffer
      const gasPrice = await this.provider.getGasPrice();
      const bufferedGasPrice = gasPrice.mul(120).div(100);

      // Approve maximum amount
      const tx = await usdcContract.approve(contractAddress, ethers.constants.MaxUint256, {
        gasPrice: bufferedGasPrice,
        gasLimit: 100000,
      });
      const receipt = await tx.wait();

      return { success: true, txHash: receipt.transactionHash };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }

  /**
   * Approve CTF for a specific contract
   */
  async approveCTF(contractAddress: string): Promise<ApprovalResult> {
    const ctfContract = new ethers.Contract(CTF_ADDRESS, ERC1155_ABI, this.wallet);

    try {
      // Check if already approved
      const isApproved = await ctfContract.isApprovedForAll(this.walletAddress, contractAddress);
      if (isApproved) {
        return { success: true, txHash: 'already-approved' };
      }

      // Get gas price with 20% buffer
      const gasPrice = await this.provider.getGasPrice();
      const bufferedGasPrice = gasPrice.mul(120).div(100);

      // Approve operator
      const tx = await ctfContract.setApprovalForAll(contractAddress, true, {
        gasPrice: bufferedGasPrice,
        gasLimit: 100000,
      });
      const receipt = await tx.wait();

      return { success: true, txHash: receipt.transactionHash };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }

  /**
   * Set all approvals for Polymarket trading
   * Returns summary of all approval transactions
   */
  async setAllApprovals(onProgress?: (message: string) => void): Promise<{
    success: boolean;
    results: Array<{ contract: string; token: string; result: ApprovalResult }>;
    error?: string;
  }> {
    const results: Array<{ contract: string; token: string; result: ApprovalResult }> = [];

    // Check POL balance for gas
    const polBalance = await this.getPolBalance();
    if (polBalance < 0.01) {
      return {
        success: false,
        results,
        error: `Insufficient POL for gas: ${polBalance.toFixed(4)} POL (need ~0.01 POL)`,
      };
    }

    // Approve USDC for each contract
    for (const contract of CONTRACTS_TO_APPROVE) {
      onProgress?.(`Approving USDC.e for ${contract.name}...`);
      const result = await this.approveUsdc(contract.address);
      results.push({ contract: contract.name, token: 'USDC.e', result });

      if (!result.success) {
        return {
          success: false,
          results,
          error: `Failed to approve USDC.e for ${contract.name}: ${result.error}`,
        };
      }
    }

    // Approve CTF for each contract
    for (const contract of CONTRACTS_TO_APPROVE) {
      onProgress?.(`Approving CTF for ${contract.name}...`);
      const result = await this.approveCTF(contract.address);
      results.push({ contract: contract.name, token: 'CTF', result });

      if (!result.success) {
        return {
          success: false,
          results,
          error: `Failed to approve CTF for ${contract.name}: ${result.error}`,
        };
      }
    }

    return { success: true, results };
  }

  /**
   * Get contract list for display
   */
  static getContractList(): typeof CONTRACTS_TO_APPROVE {
    return CONTRACTS_TO_APPROVE;
  }

  /**
   * Get token addresses for display
   */
  static getTokenAddresses(): { usdc: string; ctf: string } {
    return { usdc: USDC_ADDRESS, ctf: CTF_ADDRESS };
  }
}
