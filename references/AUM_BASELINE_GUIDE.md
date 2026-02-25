# AUM for Baseline Calculation Guide

This document describes how to calculate AUM (Assets Under Management) for baseline/high-water-mark tracking in a Polymarket trading bot.

## Formula

```
AUM for Baseline = USDC Balance + Active Positions (initialValue)
```

**Why use `initialValue` instead of `currentValue`?**
- Prevents baseline from fluctuating with unrealized P&L
- Baseline should only increase when profits are actually realized
- Avoids false high-water marks from temporary price spikes

## Components

### 1. USDC.e Balance (Polygon)

Query the on-chain USDC.e balance:

```typescript
import { ethers } from "ethers";

const USDC_ADDRESS = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";
const USDC_ABI = [
  "function balanceOf(address owner) view returns (uint256)",
  "function decimals() view returns (uint8)"
];

async function getUSDCBalance(walletAddress: string): Promise<number> {
  const provider = new ethers.providers.JsonRpcProvider("https://polygon-rpc.com");
  const usdcContract = new ethers.Contract(USDC_ADDRESS, USDC_ABI, provider);

  const balance = await usdcContract.balanceOf(walletAddress);
  const decimals = await usdcContract.decimals(); // 6 for USDC.e

  return parseFloat(ethers.utils.formatUnits(balance, decimals));
}
```

### 2. Active Positions (initialValue)

Fetch positions from Polymarket Data API and sum their cost basis:

```typescript
import axios from "axios";

async function getActivePositionsInitialValue(walletAddress: string): Promise<number> {
  const response = await axios.get('https://data-api.polymarket.com/positions', {
    params: {
      user: walletAddress,
      sizeThreshold: 0.01  // Filter dust positions
    }
  });

  const positions = response.data || [];
  let totalValue = 0;

  for (const pos of positions) {
    // Skip settled markets (money pending redemption)
    if (pos.redeemable) continue;

    // Skip already redeemed positions (money already in balance)
    if ((pos.realizedPnl || 0) > 0) continue;

    // Add cost basis (what was paid for the position)
    totalValue += pos.initialValue || 0;
  }

  return totalValue;
}
```

### 3. Complete AUM for Baseline

```typescript
async function getAUMForBaseline(walletAddress: string): Promise<number> {
  const balance = await getUSDCBalance(walletAddress);
  const activePositionsValue = await getActivePositionsInitialValue(walletAddress);

  return balance + activePositionsValue;
}
```

## Position Filtering Rules

When calculating AUM for baseline, apply these filters:

| Condition | Action | Reason |
|-----------|--------|--------|
| `redeemable = true` | Skip | Market ended, position awaiting redemption |
| `realizedPnl > 0` | Skip | Already redeemed, value is in USDC balance |
| Otherwise | Include `initialValue` | Active position, use cost basis |

## API Reference

### Polymarket Data API - Positions

```
GET https://data-api.polymarket.com/positions
```

**Query Parameters:**
- `user` (required): Wallet address
- `sizeThreshold` (optional): Minimum position size (default: 0.01)

**Response Fields Used:**
| Field | Type | Description |
|-------|------|-------------|
| `initialValue` | number | Cost basis (USD spent to acquire) |
| `redeemable` | boolean | True if market has settled |
| `realizedPnl` | number | Realized profit (>0 means redeemed) |
| `conditionId` | string | Unique market identifier |
| `size` | number | Number of shares held |
| `curPrice` | number | Current market price |

## Example Output

```
AUM for Baseline Calculation:
├── USDC.e Balance:        $500.00
├── Active Positions:
│   ├── Position 1 (initialValue): $50.00
│   └── Position 2 (initialValue): $25.00
├── Active Positions Total: $75.00
└── AUM for Baseline:       $575.00
```

## Dependencies

```json
{
  "dependencies": {
    "axios": "^1.4.0",
    "ethers": "^5.7.2"
  }
}
```

## Environment Variables

```env
RPC_URL=https://polygon-rpc.com
WALLET_ADDRESS=0x...
```

## Notes

- USDC.e on Polygon has 6 decimals
- The Data API may have slight delays (few seconds) after trades
- For real-time balance, consider using WebSocket subscription to Transfer events
- Always handle API errors gracefully with fallback values
