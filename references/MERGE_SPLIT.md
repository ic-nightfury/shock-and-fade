# Merge & Split Positions

Documentation for merging and splitting conditional token positions on Polymarket.

## Overview

| Operation | What It Does | Use Case |
|-----------|-------------|----------|
| **MERGE** | Combines UP + DOWN tokens → USDC | Exit locked position before settlement |
| **SPLIT** | Converts USDC → UP + DOWN tokens | Create balanced position from collateral |

## Why Merge?

**MERGE** is critical for capital efficiency:

1. **Immediate Exit**: Don't wait for market settlement (up to 15 mins for BTC markets, hours for sports)
2. **Capital Efficiency**: Recycle capital to next opportunity immediately
3. **Risk Reduction**: Locked profit is realized instantly
4. **Gas-Free**: Uses Polymarket's Builder Relayer (same as REDEEM)

### When to Merge

```
When you hold balanced positions (Team A qty ≈ Team B qty):
  - Profit is locked regardless of outcome
  - → MERGE the balanced portion back to USDC
  - → Capital available for next trade
  - → No need to wait for game settlement
```

## Contract Addresses (Polygon Mainnet)

```typescript
const CTF_CONTRACT = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045';      // ConditionalTokens
const NEGRISK_ADAPTER = '0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296';  // NegRisk Adapter
const USDC_E = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';          // USDC.e Collateral
const PARENT_COLLECTION_ID = '0x0000000000000000000000000000000000000000000000000000000000000000';
```

## Contract ABIs

### Standard Markets (CTF)

```solidity
// Merge: Combine outcome tokens back to collateral
function mergePositions(
    address collateralToken,      // USDC.e address
    bytes32 parentCollectionId,   // 0x00...00
    bytes32 conditionId,          // Market condition ID
    uint256[] partition,          // [1, 2] for YES/NO
    uint256 amount                // Amount to merge (6 decimals for USDC)
) external;

// Split: Convert collateral to outcome tokens
function splitPosition(
    address collateralToken,
    bytes32 parentCollectionId,
    bytes32 conditionId,
    uint256[] partition,
    uint256 amount
) external;
```

### Negative Risk Markets (NegRisk Adapter)

```solidity
// Merge
function mergePositions(
    bytes32 conditionId,
    uint256 amount          // 6 decimals
) external;

// Split
function splitPosition(
    bytes32 conditionId,
    uint256 amount
) external;
```

## Implementation (Relayer-Based)

Based on the existing `ProxyRedemptionClient` pattern:

```typescript
import { RelayClient, OperationType, SafeTransaction } from '@polymarket/builder-relayer-client';
import { Interface } from 'ethers/lib/utils';

// Contract interfaces
const ctfInterface = new Interface([
  'function mergePositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] indexSets, uint256 amount)',
  'function splitPosition(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] partition, uint256 amount)'
]);

const negRiskInterface = new Interface([
  'function mergePositions(bytes32 conditionId, uint256 amount)',
  'function splitPosition(bytes32 conditionId, uint256 amount)'
]);
```

### Merge Function (Gas-Free via Relayer)

```typescript
async function merge(
  conditionId: string,
  amount: number,           // Number of shares to merge
  isNegRisk: boolean = false
): Promise<{ success: boolean; txHash?: string; error?: string }> {

  const formattedConditionId = conditionId.startsWith('0x')
    ? conditionId
    : `0x${conditionId}`;

  // Convert to 6 decimals (USDC precision)
  const amountInWei = Math.floor(amount * 1_000_000);

  let mergeTx: SafeTransaction;

  if (isNegRisk) {
    // NegRisk market merge
    mergeTx = {
      to: NEGRISK_ADAPTER,
      operation: OperationType.Call,
      data: negRiskInterface.encodeFunctionData('mergePositions', [
        formattedConditionId,
        amountInWei
      ]),
      value: '0'
    };
  } else {
    // Standard market merge
    mergeTx = {
      to: CTF_CONTRACT,
      operation: OperationType.Call,
      data: ctfInterface.encodeFunctionData('mergePositions', [
        USDC_E,                    // collateralToken
        PARENT_COLLECTION_ID,     // parentCollectionId
        formattedConditionId,     // conditionId
        [1, 2],                   // partition (YES=1, NO=2)
        amountInWei               // amount
      ]),
      value: '0'
    };
  }

  console.log(`🔀 Merging ${amount} shares...`);

  const response = await relayClient.execute([mergeTx], 'Merge positions');
  const result = await response.wait();

  return {
    success: true,
    txHash: result.transactionHash
  };
}
```

### Split Function (Gas-Free via Relayer)

```typescript
async function split(
  conditionId: string,
  amount: number,           // USDC amount to split
  isNegRisk: boolean = false
): Promise<{ success: boolean; txHash?: string; error?: string }> {

  const formattedConditionId = conditionId.startsWith('0x')
    ? conditionId
    : `0x${conditionId}`;

  // Convert to 6 decimals (USDC precision)
  const amountInWei = Math.floor(amount * 1_000_000);

  let splitTx: SafeTransaction;

  if (isNegRisk) {
    splitTx = {
      to: NEGRISK_ADAPTER,
      operation: OperationType.Call,
      data: negRiskInterface.encodeFunctionData('splitPosition', [
        formattedConditionId,
        amountInWei
      ]),
      value: '0'
    };
  } else {
    splitTx = {
      to: CTF_CONTRACT,
      operation: OperationType.Call,
      data: ctfInterface.encodeFunctionData('splitPosition', [
        USDC_E,
        PARENT_COLLECTION_ID,
        formattedConditionId,
        [1, 2],
        amountInWei
      ]),
      value: '0'
    };
  }

  console.log(`🔀 Splitting ${amount} USDC into outcome tokens...`);

  const response = await relayClient.execute([splitTx], 'Split position');
  const result = await response.wait();

  return {
    success: true,
    txHash: result.transactionHash
  };
}
```

## Integration with Bilateral Strategy

### After Lock Execution

```typescript
// In BilateralStrategyV6.ts - after lock fills

async function handleProfitLocked(): Promise<void> {
  const { qtyUp, qtyDown } = this.engine.getState();
  const hedgedQty = Math.min(qtyUp, qtyDown);

  if (hedgedQty > 0) {
    console.log(`\n🔀 MERGING locked position: ${hedgedQty} shares`);

    const result = await this.mergeClient.merge(
      this.marketState.conditionId,
      hedgedQty,
      false  // not neg-risk for Up/Down markets
    );

    if (result.success) {
      console.log(`✅ Merged ${hedgedQty} shares → USDC`);
      console.log(`   TX: ${result.txHash}`);

      // Update engine state (subtract merged shares)
      this.engine.recordMerge(hedgedQty);

      // Capital now available for next cycle!
    }
  }
}
```

## Flow Diagram

```
LOCK EXECUTED
     │
     ▼
┌─────────────────────────────────────┐
│ Calculate hedgedQty                 │
│ hedgedQty = min(qtyUp, qtyDown)     │
└─────────────┬───────────────────────┘
              │
              ▼
┌─────────────────────────────────────┐
│ MERGE via Relayer (gas-free)        │
│ UP tokens + DOWN tokens → USDC      │
└─────────────┬───────────────────────┘
              │
              ▼
┌─────────────────────────────────────┐
│ USDC returned to wallet             │
│ Capital ready for next market!      │
└─────────────────────────────────────┘
```

## Key Differences: MERGE vs REDEEM

| Aspect | MERGE | REDEEM |
|--------|-------|--------|
| **When** | Anytime (before settlement) | After market settles |
| **Requires** | Equal UP + DOWN tokens | Winning side tokens |
| **Returns** | USDC (amount merged) | USDC (winning payout) |
| **Use Case** | Exit locked position early | Collect final winnings |

## Environment Variables

Same as REDEEM - uses Builder Relayer:

```bash
# Required for relayer-based operations
BUILDER_API_KEY=your_api_key
BUILDER_SECRET=your_secret
BUILDER_PASS_PHRASE=your_passphrase
RELAYER_URL=https://relayer.polymarket.com  # optional, this is default
RPC_URL=https://polygon-rpc.com             # optional, this is default
```

## Error Handling

```typescript
try {
  const result = await merge(conditionId, amount);
} catch (error) {
  if (error.message.includes('SafeMath: subtraction overflow')) {
    // Insufficient token balance
    console.log('Not enough tokens to merge');
  } else if (error.message.includes('ERC20: transfer amount exceeds balance')) {
    // Token balance mismatch
    console.log('Token balance issue');
  }
}
```

## References

- [Polymarket ts-merge-split-positions](https://github.com/Polymarket/ts-merge-split-positions)
- [Gnosis Conditional Tokens](https://docs.gnosis.io/conditionaltokens/)
- [Builder Relayer Client](https://github.com/Polymarket/builder-relayer-client)

---

## Summary

**MERGE** allows immediate exit from locked positions:

1. After lock → `hedgedQty = min(UP, DOWN)`
2. Merge hedgedQty shares → Get USDC back
3. Capital recycled → Ready for next market
4. No waiting for settlement!

This is the key to **capital efficiency** in balanced position trading - don't let capital sit idle waiting for settlement when profit is already locked.
