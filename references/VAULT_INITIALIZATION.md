# Vault Initialization & Polymarket Approvals

This document explains how to initialize a trading vault for Polymarket, including the required on-chain token approvals.

## Overview

Before a wallet can trade on Polymarket, it must approve Polymarket's smart contracts to:
1. **Spend USDC.e** - For placing buy orders
2. **Transfer CTF tokens** - For selling outcome shares

This requires **6 total approvals** (2 tokens × 3 contracts).

## Contract Addresses (Polygon Mainnet)

### Tokens

| Token | Address | Standard | Purpose |
|-------|---------|----------|---------|
| USDC.e | `0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174` | ERC-20 | Payment token (6 decimals) |
| CTF | `0x4D97DCd97eC945f40cF65F87097ACe5EA0476045` | ERC-1155 | Conditional Token Framework (outcome shares) |

> **CRITICAL**: Use USDC.e (bridged USDC), NOT native USDC (`0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359`). Polymarket only accepts USDC.e.

### Polymarket Contracts (Spenders)

| Contract | Address | Purpose |
|----------|---------|---------|
| Main Exchange | `0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E` | Core order book and trading |
| Neg Risk CTF | `0xC5d563A36AE78145C45a50134d48A1215220f80a` | Negative risk market positions |
| Neg Risk Adapter | `0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296` | Adapter for neg risk operations |

## Approval Types

### 1. USDC.e Approval (ERC-20)

**Function**: `approve(address spender, uint256 amount)`

```solidity
// ABI
function approve(address spender, uint256 amount) public returns (bool)
function allowance(address owner, address spender) public view returns (uint256)
```

**Implementation**:
```typescript
import { ethers } from 'ethers';

const USDC_ADDRESS = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
const ERC20_ABI = [
  'function approve(address spender, uint256 amount) public returns (bool)',
  'function allowance(address owner, address spender) public view returns (uint256)',
];

async function approveUSDC(
  wallet: ethers.Wallet,
  spenderAddress: string
): Promise<ethers.ContractTransaction> {
  const usdcContract = new ethers.Contract(USDC_ADDRESS, ERC20_ABI, wallet);

  // Check if already approved
  const currentAllowance = await usdcContract.allowance(wallet.address, spenderAddress);
  if (currentAllowance.gt(ethers.utils.parseUnits('1000000', 6))) {
    console.log('Already approved');
    return;
  }

  // Approve maximum amount
  const tx = await usdcContract.approve(spenderAddress, ethers.constants.MaxUint256);
  await tx.wait();

  return tx;
}
```

### 2. CTF Approval (ERC-1155)

**Function**: `setApprovalForAll(address operator, bool approved)`

```solidity
// ABI
function setApprovalForAll(address operator, bool approved) public
function isApprovedForAll(address account, address operator) public view returns (bool)
```

**Implementation**:
```typescript
const CTF_ADDRESS = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045';
const ERC1155_ABI = [
  'function setApprovalForAll(address operator, bool approved) public',
  'function isApprovedForAll(address account, address operator) public view returns (bool)',
];

async function approveCTF(
  wallet: ethers.Wallet,
  operatorAddress: string
): Promise<ethers.ContractTransaction> {
  const ctfContract = new ethers.Contract(CTF_ADDRESS, ERC1155_ABI, wallet);

  // Check if already approved
  const isApproved = await ctfContract.isApprovedForAll(wallet.address, operatorAddress);
  if (isApproved) {
    console.log('Already approved');
    return;
  }

  // Approve operator
  const tx = await ctfContract.setApprovalForAll(operatorAddress, true);
  await tx.wait();

  return tx;
}
```

## Complete Approval Flow

### Step-by-Step Process

```
┌─────────────────────────────────────────────────────────────┐
│                    VAULT INITIALIZATION                      │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  1. Load wallet from private key                             │
│     └─> ethers.Wallet(privateKey, provider)                  │
│                                                              │
│  2. Check POL balance for gas                                │
│     └─> Minimum ~0.01 POL recommended                        │
│                                                              │
│  3. Check existing approvals                                 │
│     ├─> USDC.allowance() for each contract                   │
│     └─> CTF.isApprovedForAll() for each contract             │
│                                                              │
│  4. Set missing USDC approvals (up to 3 transactions)        │
│     ├─> approve(MainExchange, MaxUint256)                    │
│     ├─> approve(NegRiskCTF, MaxUint256)                      │
│     └─> approve(NegRiskAdapter, MaxUint256)                  │
│                                                              │
│  5. Set missing CTF approvals (up to 3 transactions)         │
│     ├─> setApprovalForAll(MainExchange, true)                │
│     ├─> setApprovalForAll(NegRiskCTF, true)                  │
│     └─> setApprovalForAll(NegRiskAdapter, true)              │
│                                                              │
│  6. Query USDC.e balance                                     │
│     └─> USDC.balanceOf(walletAddress)                        │
│                                                              │
│  7. Initialize vault in database                             │
│     ├─> Save wallet address                                  │
│     └─> Set initial AUM from balance                         │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

### Full Implementation

```typescript
import { ethers } from 'ethers';

// Addresses
const USDC_ADDRESS = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
const CTF_ADDRESS = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045';

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

interface ApprovalStatus {
  hasAllApprovals: boolean;
  usdcApprovals: Record<string, boolean>;
  ctfApprovals: Record<string, boolean>;
}

async function checkApprovals(
  provider: ethers.providers.Provider,
  walletAddress: string
): Promise<ApprovalStatus> {
  const usdcContract = new ethers.Contract(USDC_ADDRESS, ERC20_ABI, provider);
  const ctfContract = new ethers.Contract(CTF_ADDRESS, ERC1155_ABI, provider);

  const usdcApprovals: Record<string, boolean> = {};
  const ctfApprovals: Record<string, boolean> = {};

  for (const contract of CONTRACTS_TO_APPROVE) {
    // Check USDC allowance (> 1M USDC considered "approved")
    const allowance = await usdcContract.allowance(walletAddress, contract.address);
    usdcApprovals[contract.name] = allowance.gt(ethers.utils.parseUnits('1000000', 6));

    // Check CTF approval
    ctfApprovals[contract.name] = await ctfContract.isApprovedForAll(
      walletAddress,
      contract.address
    );
  }

  const hasAllApprovals =
    Object.values(usdcApprovals).every((v) => v) &&
    Object.values(ctfApprovals).every((v) => v);

  return { hasAllApprovals, usdcApprovals, ctfApprovals };
}

async function setAllApprovals(privateKey: string): Promise<void> {
  const provider = new ethers.providers.JsonRpcProvider(
    process.env.POLYGON_RPC_URL || 'https://polygon-rpc.com'
  );
  const wallet = new ethers.Wallet(privateKey, provider);

  console.log(`Setting approvals for ${wallet.address}`);

  // Check POL balance for gas
  const polBalance = await provider.getBalance(wallet.address);
  if (polBalance.lt(ethers.utils.parseEther('0.01'))) {
    console.warn('Warning: Low POL balance for gas fees');
  }

  const usdcContract = new ethers.Contract(USDC_ADDRESS, ERC20_ABI, wallet);
  const ctfContract = new ethers.Contract(CTF_ADDRESS, ERC1155_ABI, wallet);

  // Get current gas price with 20% buffer
  const gasPrice = await provider.getGasPrice();
  const bufferedGasPrice = gasPrice.mul(120).div(100);

  const txOptions = {
    gasPrice: bufferedGasPrice,
    gasLimit: 100000,
  };

  // Approve USDC for each contract
  for (const contract of CONTRACTS_TO_APPROVE) {
    const allowance = await usdcContract.allowance(wallet.address, contract.address);

    if (allowance.lt(ethers.utils.parseUnits('1000000', 6))) {
      console.log(`Approving USDC for ${contract.name}...`);
      const tx = await usdcContract.approve(
        contract.address,
        ethers.constants.MaxUint256,
        txOptions
      );
      await tx.wait();
      console.log(`  TX: ${tx.hash}`);
    } else {
      console.log(`USDC already approved for ${contract.name}`);
    }
  }

  // Approve CTF for each contract
  for (const contract of CONTRACTS_TO_APPROVE) {
    const isApproved = await ctfContract.isApprovedForAll(wallet.address, contract.address);

    if (!isApproved) {
      console.log(`Approving CTF for ${contract.name}...`);
      const tx = await ctfContract.setApprovalForAll(contract.address, true, txOptions);
      await tx.wait();
      console.log(`  TX: ${tx.hash}`);
    } else {
      console.log(`CTF already approved for ${contract.name}`);
    }
  }

  console.log('All approvals set successfully!');
}

async function getUSDCBalance(
  provider: ethers.providers.Provider,
  walletAddress: string
): Promise<number> {
  const usdcContract = new ethers.Contract(USDC_ADDRESS, ERC20_ABI, provider);
  const balance = await usdcContract.balanceOf(walletAddress);
  const decimals = await usdcContract.decimals();
  return parseFloat(ethers.utils.formatUnits(balance, decimals));
}
```

## Environment Variables Required

```env
# Polygon RPC (optional, defaults to public RPC)
POLYGON_RPC_URL=https://polygon-rpc.com

# Vault private keys (required)
HEDGE_VAULT_PRIVATE_KEY=0x...
PROXY_WALLET_PRIVATE_KEY=0x...

# Wallet addresses (required for PROXY_WALLET)
PROXY_WALLET=0x...
```

## Gas Costs

Approximate gas costs per approval on Polygon:

| Transaction Type | Gas Limit | Approx. Cost |
|-----------------|-----------|--------------|
| ERC-20 approve | ~46,000 | ~0.001 POL |
| ERC-1155 setApprovalForAll | ~46,000 | ~0.001 POL |
| **Total (6 approvals)** | ~276,000 | ~0.006 POL |

> Recommendation: Keep at least 0.01 POL in wallet for gas buffer.

## Error Handling

### Common Errors

| Error | Cause | Solution |
|-------|-------|----------|
| `insufficient funds for gas` | Not enough POL | Fund wallet with POL |
| `nonce too low` | Transaction already processed | Wait and retry |
| `replacement transaction underpriced` | Gas price too low | Increase gas price buffer |
| `execution reverted` | Contract error | Check allowance/approval state |

### Retry Logic

```typescript
async function approveWithRetry(
  fn: () => Promise<ethers.ContractTransaction>,
  maxRetries: number = 3
): Promise<ethers.ContractTransaction> {
  let lastError: Error;

  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      console.log(`Attempt ${i + 1} failed, retrying...`);
      await new Promise((r) => setTimeout(r, 2000 * (i + 1)));
    }
  }

  throw lastError;
}
```

## Verification

After setting approvals, verify on Polygonscan:

1. Go to: `https://polygonscan.com/address/{WALLET_ADDRESS}#tokentxns`
2. Check for 6 approval transactions
3. Or query allowances directly:

```bash
# Check USDC allowance
cast call 0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174 \
  "allowance(address,address)(uint256)" \
  {WALLET_ADDRESS} \
  0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E \
  --rpc-url https://polygon-rpc.com
```

## Database Integration

After approvals, initialize the vault in the database:

```typescript
// Update wallet address
await VaultService.updateWalletAddress(vaultName, walletAddress);

// Query on-chain balance
const balance = await getUSDCBalance(provider, walletAddress);

// Initialize AUM
await VaultService.initializeAUM(vaultName, balance);
```

## Usage

```bash
# Initialize all configured vaults
npm run vault:init

# Initialize only PROXY_WALLET (skips approval check)
npm run vault:init-proxy

# Check vault status after initialization
npm run vault:status
```

## Related Files

- `src/services/ApprovalService.ts` - Approval logic implementation
- `src/views/examples/initialize-vaults.ts` - Initialization script
- `src/services/VaultService.ts` - Vault AUM management
