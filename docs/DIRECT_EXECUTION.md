# Direct Execution: Bypass Builder Relayer, Pay Your Own Gas

## Problem

Polymarket's Builder Relayer provides gas-free on-chain transactions (split, merge, redeem, approvals) but enforces a **100 transactions/day quota** on unverified accounts. For active trading bots, this limit is hit quickly — each trading cycle needs at minimum 1 split + 1 merge = 2 quota units.

## Solution

Call the Gnosis Safe proxy contract's `execTransaction()` directly from the EOA (Externally Owned Account), paying Polygon gas instead of routing through the Builder Relayer. This gives you:

- **Same proxy wallet address** — all funds, tokens, and CLOB API keys remain unchanged
- **Unlimited transactions** — no daily quota
- **~$0.05/cycle** in gas costs (MATIC/POL)

## Architecture

### How Polymarket Wallets Work

```
┌─────────────────────────────────────────────────────────┐
│  EOA (your private key)                                 │
│  Address: 0xd6ed...31d1                                 │
│  Holds: MATIC/POL for gas                               │
│                                                         │
│  Controls ↓                                             │
│                                                         │
│  Proxy Wallet (Gnosis Safe smart contract)              │
│  Address: 0xEc21...52BB                                 │
│  Holds: USDC, CTF tokens (your trading funds)           │
│  Derived via CREATE2 from EOA + SafeFactory             │
└─────────────────────────────────────────────────────────┘
```

Your Polymarket "wallet" is actually a **Gnosis Safe** smart contract. The EOA is its owner. When you trade on polymarket.com, your browser signs transactions that the Builder Relayer submits to this Safe on your behalf (gas-free, quota-limited).

### Two Paths to Execute On-Chain Operations

```
Path A: Builder Relayer (default)
  EOA signs meta-tx → Relayer API → Relayer submits to Safe → Safe executes
  ✅ Gas-free  ❌ 100/day limit

Path B: Direct Execution (pay own gas)
  EOA signs tx → Submit directly to Polygon RPC → Safe executes
  ❌ Costs ~0.05-0.10 MATIC/tx  ✅ Unlimited
```

Both paths use the **same Safe contract**, **same address**, **same funds**.

## How It Works

### Step 1: Derive the Proxy Address

The proxy (Safe) address is deterministically derived from your EOA address:

```typescript
import { getCreate2Address, keccak256, encodeAbiParameters } from 'viem';

const SAFE_FACTORY = '0xaacFeEa03eb1561C4e67d661e40682Bd20E3541b';
const SAFE_INIT_CODE_HASH = '0x...'; // from @polymarket/builder-relayer-client

const proxyAddress = getCreate2Address({
  from: SAFE_FACTORY,
  salt: keccak256(encodeAbiParameters(
    [{ name: 'address', type: 'address' }],
    [eoaAddress]
  )),
  bytecodeHash: SAFE_INIT_CODE_HASH,
});
```

### Step 2: Build the Transaction

Construct the same `SafeTransaction` objects the relayer uses. For example, a CTF split:

```typescript
const splitData = negRiskInterface.encodeFunctionData('splitPosition', [
  conditionId,
  amount  // in USDC units (6 decimals)
]);

const transaction: SafeTransaction = {
  to: NEGRISK_ADAPTER,    // 0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296
  value: '0',
  data: splitData,
  operation: 0,            // 0 = CALL
};
```

For multiple operations (e.g., approve + split), batch them via the **SafeMultisend** contract:

```typescript
const SAFE_MULTISEND = '0xA238CBeb142c10Ef7Ad8442C6D1f9E89e07e7761';

// Encode each sub-transaction
const encoded = transactions.map(tx => {
  const data = Buffer.from(tx.data.slice(2), 'hex');
  return ethers.utils.solidityPack(
    ['uint8', 'address', 'uint256', 'uint256', 'bytes'],
    [tx.operation, tx.to, tx.value, data.length, data]
  );
});

const multiSendData = multisendInterface.encodeFunctionData('multiSend', [
  ethers.utils.concat(encoded.map(e => Buffer.from(e.slice(2), 'hex')))
]);

const batchTx: SafeTransaction = {
  to: SAFE_MULTISEND,
  value: '0',
  data: multiSendData,
  operation: 1,  // 1 = DELEGATECALL (required for multisend)
};
```

### Step 3: Sign with EIP-712

The Gnosis Safe requires an EIP-712 typed signature:

```typescript
const domain = {
  chainId: 137,                    // Polygon
  verifyingContract: proxyAddress,  // Your Safe address
};

const types = {
  SafeTx: [
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'data', type: 'bytes' },
    { name: 'operation', type: 'uint8' },
    { name: 'safeTxGas', type: 'uint256' },
    { name: 'baseGas', type: 'uint256' },
    { name: 'gasPrice', type: 'uint256' },
    { name: 'gasToken', type: 'address' },
    { name: 'refundReceiver', type: 'address' },
    { name: 'nonce', type: 'uint256' },
  ],
};

const values = {
  to: transaction.to,
  value: transaction.value,
  data: transaction.data,
  operation: transaction.operation,
  safeTxGas: 0,
  baseGas: 0,
  gasPrice: 0,
  gasToken: ethers.constants.AddressZero,
  refundReceiver: ethers.constants.AddressZero,
  nonce: currentNonce,  // Read from Safe contract on-chain
};

// Sign using ethers v5
const signature = await eoaWallet._signTypedData(domain, types, values);
```

### Step 4: Read Nonce from Safe Contract

The nonce must be read directly from the Safe contract on-chain (not from the relayer API):

```typescript
const safeContract = new ethers.Contract(proxyAddress, [
  'function nonce() view returns (uint256)',
], provider);

const nonce = await safeContract.nonce();
```

### Step 5: Call `execTransaction()`

```typescript
const safeContract = new ethers.Contract(proxyAddress, SAFE_ABI, eoaWallet);

// Pack signature: r (32 bytes) + s (32 bytes) + v (1 byte)
const sig = ethers.utils.splitSignature(signature);
const packedSig = ethers.utils.solidityPack(
  ['bytes32', 'bytes32', 'uint8'],
  [sig.r, sig.s, sig.v]
);

const tx = await safeContract.execTransaction(
  transaction.to,
  transaction.value,
  transaction.data,
  transaction.operation,
  0,                              // safeTxGas
  0,                              // baseGas
  0,                              // gasPrice
  ethers.constants.AddressZero,   // gasToken
  ethers.constants.AddressZero,   // refundReceiver
  packedSig,
  {
    gasLimit: estimatedGas * 1.2,  // 20% buffer
  }
);

const receipt = await tx.wait();
```

## Gas Costs (Polygon, measured Feb 2026)

| Operation | Gas Used | Cost (MATIC) | Cost (USD) |
|-----------|----------|-------------|------------|
| Split (approve + split) | ~214,000 | 0.063 | ~$0.03 |
| Merge | ~144,000 | 0.043 | ~$0.02 |
| CTF Approvals (3 contracts) | ~86,000 | 0.026 | ~$0.01 |
| **Full cycle (split + merge)** | **~358,000** | **0.106** | **~$0.05** |

With 44 MATIC on the EOA: **~420 full cycles** before needing a gas top-up.

## Key Constants (Polygon Mainnet)

```typescript
// Gnosis Safe infrastructure
const SAFE_FACTORY      = '0xaacFeEa03eb1561C4e67d661e40682Bd20E3541b';
const SAFE_MULTISEND    = '0xA238CBeb142c10Ef7Ad8442C6D1f9E89e07e7761';

// Polymarket contracts
const CTF_CONTRACT      = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045';
const NEGRISK_ADAPTER   = '0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296';
const USDC_E            = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
const CLOB_EXCHANGE     = '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E';
const NEG_RISK_EXCHANGE = '0xC5d563A36AE78145C45a50134d48A1215220f80a';

// Chain
const CHAIN_ID = 137;  // Polygon
```

## Polymarket UI Setting

Polymarket has a native toggle for this under **Account → Settings → Account**:

> **Pay your own gas**
> Use a custom RPC (must own $POL in your connected wallet)

Enabling this in the UI switches the web app to direct execution. The approach described here does the same thing programmatically for bots.

## Important Notes

1. **Signature format matters**: The Builder Relayer adjusts `v` by +4 (27→31) for its own protocol. For direct `execTransaction()`, use standard ECDSA `v` = 27 or 28.

2. **Nonce is sequential**: Each successful `execTransaction()` increments the Safe's nonce by 1. Read it fresh before each transaction.

3. **Gas estimation**: Use `ethers.estimateGas()` with a 20% buffer. Polygon gas is cheap but underestimation causes reverts.

4. **`ExecutionFailure` event**: The outer transaction can succeed (you pay gas) but the inner Safe execution can fail. Check for the `ExecutionFailure` event in the receipt to detect this.

5. **CLOB orders are separate**: Order placement (POST /order) goes through the CLOB API, not on-chain. Only split/merge/redeem/approvals are on-chain operations that need the relayer or direct execution.

6. **Fallback strategy**: Use direct execution as primary, keep Builder Relayer as fallback for when EOA runs out of MATIC.

## Dependencies

```json
{
  "ethers": "^5.7.0",
  "viem": "^2.0.0",
  "@polymarket/builder-relayer-client": "^0.1.0"
}
```

The `@polymarket/builder-relayer-client` package is used for the Safe ABI, multisend encoding, and address derivation utilities. The actual relayer API is not called.
