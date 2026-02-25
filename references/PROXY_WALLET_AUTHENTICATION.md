# PROXY_WALLET Authentication Guide

## Overview

The PROXY_WALLET uses **Signature Type 2 (POLY_GNOSIS_SAFE)** for authentication with Polymarket's CLOB API. This is fundamentally different from the standard EOA (Externally Owned Account) authentication used by HEDGE_VAULT.

**Key Concept**: The PROXY_WALLET operates with a **signer vs funder** pattern:
- **Signer**: Private key that signs transactions (PROXY_WALLET_PRIVATE_KEY)
- **Funder**: Proxy wallet address that holds USDC.e funds (PROXY_WALLET)

This architecture enables **gas-free trading and redemptions** via Polymarket's Builder Relayer system.

---

## Authentication Architecture

### 1. Two-Step Client Initialization

The PROXY_WALLET authentication happens in **two distinct steps**:

#### Step 1: Create API Keys (No Signature Type)
```typescript
// ProxyPolymarketClient.ts constructor
const tempClient = new ClobClient(
  config.host,
  config.chainId,
  this.signer  // Wallet from PROXY_WALLET_PRIVATE_KEY
);

this.creds = tempClient.createOrDeriveApiKey();
```

**What Happens**:
- Creates default ClobClient with signer wallet
- Generates/derives API credentials (ApiKeyCreds)
- **No signature type specified** at this stage
- Credentials stored for Step 2

#### Step 2: Create POLY_GNOSIS_SAFE Trading Client
```typescript
// ProxyPolymarketClient.initialize()
const apiCreds = await this.creds;

this.clobClient = new ClobClient(
  this.config.host,
  this.config.chainId,
  this.signer,
  apiCreds,                         // From Step 1
  SignatureType.POLY_GNOSIS_SAFE,   // Type 2 - CRITICAL
  this.config.funderAddress         // PROXY_WALLET address
);
```

**What Happens**:
- Uses API credentials from Step 1
- Creates new client with **SignatureType.POLY_GNOSIS_SAFE (2)**
- Specifies `funderAddress` as the proxy wallet
- This client executes all trades

### 2. Signature Type Comparison

| Vault | Signature Type | Value | Private Key Owns | Funds Held In |
|-------|----------------|-------|------------------|---------------|
| **HEDGE_VAULT** | EOA | 0 | Wallet address | Same wallet |
| **PROXY_WALLET** | POLY_GNOSIS_SAFE | 2 | Signer address | Proxy wallet (funder) |

**Why This Matters**:
- EOA: Private key directly owns the wallet holding funds
- POLY_GNOSIS_SAFE: Private key signs for a separate proxy wallet that holds funds
- Proxy pattern enables gas-free operations via Builder Relayer

---

## Configuration

### Environment Variables

```bash
# Proxy Wallet Authentication
PROXY_WALLET=0x...                    # Proxy wallet address (holds USDC.e)
PROXY_WALLET_PRIVATE_KEY=0x...        # Signer private key

# Builder Relayer (Gas-Free Redemptions)
BUILDER_API_KEY=your-builder-key
BUILDER_SECRET=your-builder-secret
BUILDER_PASS_PHRASE=your-builder-passphrase
RELAYER_URL=https://relayer.polymarket.com

# Polymarket API (Shared with HEDGE_VAULT)
POLYMARKET_HOST=https://clob.polymarket.com
POLYMARKET_CHAIN_ID=137

# USDC.e Token (Bridged USDC on Polygon)
USDC_ADDRESS=0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174
```

### Critical Requirements

1. **USDC.e Token**: MUST use bridged USDC (`0x2791Bca...`), NOT native USDC
2. **Token Approvals**: Must be set manually via Polymarket web interface
3. **Builder Credentials**: Required for gas-free redemptions
4. **Signer Key**: Must be authorized to sign for the proxy wallet

---

## Setup Process

### 1. Initialize Proxy Wallet

**Command**:
```bash
npm run vault:init-proxy
```

**What It Does**:
- Creates/updates `proxy_wallet` database record
- Sets initial AUM from on-chain balance
- Creates initial rebase record
- **Does NOT set token approvals** (manual step required)

**Script Location**: `src/views/examples/initialize-proxy-wallet.ts`

**Key Code**:
```typescript
console.log('\n📋 Token Approvals...');
console.log('   PROXY_WALLET uses browser wallet (Metamask)');
console.log('   Approvals should be set via Polymarket web interface');
console.log('   Skipping automatic approval (set manually on web)');
```

**Why Manual Approvals**:
- Browser wallets (Metamask/WalletConnect) handle approvals
- Requires user interaction with Polymarket web UI
- Cannot be automated via private key

### 2. Set Token Approvals (Manual)

1. Connect to Polymarket with PROXY_WALLET address
2. Navigate to any market
3. Attempt a trade to trigger approval prompts
4. Approve USDC.e for:
   - Exchange contract
   - Conditional Token Framework (CTF)
   - NegRisk CTF adapter

### 3. Verify Setup

**Command**:
```bash
npm run vault:status
```

**Expected Output**:
```
📊 PROXY_WALLET (Polyburg Integration)
   Address: 0x...
   Current AUM: $1,000.00
   Initial Balance: $1,000.00
   Active Positions: 0
   Total Positions: 0
   Total Profit: $0.00
```

---

## Trade Execution Flow

### ProxyTradingExecutor Workflow

**File**: `src/services/ProxyTradingExecutor.ts`

```typescript
// 1. Initialize client with POLY_GNOSIS_SAFE
const client = new ProxyPolymarketClient({
  host: process.env.POLYMARKET_HOST!,
  chainId: parseInt(process.env.POLYMARKET_CHAIN_ID!),
  privateKey: process.env.PROXY_WALLET_PRIVATE_KEY!,
  funderAddress: process.env.PROXY_WALLET!,  // Proxy wallet
});

await client.initialize();  // Two-step auth happens here

// 2. Calculate position size (0.1% AUM)
const positionSize = await VaultService.calculatePositionSize('proxy_wallet');

// 3. Execute trade
const result = await client.buy(
  tokenId,
  positionSize,
  {
    tickSize: market.tickSize,
    negRisk: market.negRisk,
  }
);

// 4. Record position
await PositionService.createPosition({
  vault_id: proxyWallet.id,
  market_slug: marketSlug,
  token_id: tokenId,
  outcome: outcome,
  side: 'BUY',
  amount: positionSize,
  shares: result.shares,
  entry_price: result.avgPrice,
  order_id: result.orderId,
  metadata: trade_metadata,
  status: 'open',
});
```

### Authentication During Trade

**Step-by-Step**:

1. **Client Creation**: ProxyPolymarketClient constructor called
   - Signer wallet created from PROXY_WALLET_PRIVATE_KEY
   - Temp ClobClient generates API keys

2. **Initialization**: `await client.initialize()`
   - API credentials retrieved
   - POLY_GNOSIS_SAFE client created with funderAddress

3. **Order Creation**: `client.buy()` called
   - CLOB API receives order signed by signer
   - Order executes using PROXY_WALLET funds

4. **Settlement**: Gas-free via Builder Relayer
   - No manual transaction submission required
   - Relayer handles on-chain settlement

---

## Redemption System

### Gas-Free Redemption via Builder Relayer

**File**: `src/services/ProxyRedemptionClient.ts`

```typescript
constructor(privateKey: string) {
  const wallet = new Wallet(privateKey);

  const builderCreds: BuilderApiKeyCreds = {
    key: process.env.BUILDER_API_KEY!,
    secret: process.env.BUILDER_SECRET!,
    passphrase: process.env.BUILDER_PASS_PHRASE!,
  };

  this.client = new RelayClient(
    process.env.RELAYER_URL || 'https://relayer.polymarket.com',
    POLYGON_CHAIN_ID,
    wallet,
    builderConfig
  );
}
```

### Redemption Process

**Command**:
```bash
npm run vault:redeem
```

**Script Location**: `src/views/examples/redeem-proxy-positions.ts`

**Workflow**:

1. **Fetch Settled Positions**: Query database for `status = 'settled'`
2. **Categorize by CTF Type**: Separate NegRisk vs Regular markets
3. **Build Redemption Payloads**:
   - NegRisk: Uses `NegRiskAdapter` ABI, includes both outcome token IDs
   - Regular: Uses standard `CTF` ABI, single index ID
4. **Submit to Relayer**: Gas-free submission via Builder credentials
5. **Wait for Settlement**: Relayer handles on-chain execution
6. **Update Database**: Mark positions as `status = 'redeemed'`

### NegRisk vs Regular CTF

**NegRisk Markets** (negRisk: true):
```typescript
{
  abi: NegRiskAdapterAbi,
  functionName: 'redeemPositions',
  args: [
    USDC_ADDRESS,
    market.parentCollectionId,
    market.conditionId,
    [outcomeTokenIds]  // Array of both outcome token IDs
  ]
}
```

**Regular Markets** (negRisk: false):
```typescript
{
  abi: CTFAbi,
  functionName: 'redeemPositions',
  args: [
    USDC_ADDRESS,
    market.parentCollectionId,
    market.conditionId,
    [indexSetId]  // Single index set
  ]
}
```

**Why Different ABIs**:
- NegRisk requires both outcome token IDs for redemption
- Regular CTF uses index set to identify positions
- Both support gas-free execution via relayer

---

## CLI Commands

### vault:status

**Command**: `npm run vault:status`

**Script**: `src/views/vault-status.ts`

**What It Shows**:
```typescript
// PROXY_WALLET section
console.log('📊 PROXY_WALLET (Polyburg Integration)');
console.log(`   Address: ${proxyWallet.wallet_address}`);
console.log(`   Current AUM: $${proxyWallet.current_aum}`);
console.log(`   Active Positions: ${proxyWallet.active_positions}`);
```

**Authentication**: None required (read-only database query)

### vault:redeem

**Command**: `npm run vault:redeem`

**Script**: `src/views/examples/redeem-proxy-positions.ts`

**What It Does**:
1. Initializes ProxyRedemptionClient with PROXY_WALLET_PRIVATE_KEY
2. Fetches all settled positions from database
3. Categorizes by NegRisk vs Regular
4. Submits redemption payloads to Builder Relayer
5. Waits for on-chain settlement
6. Updates positions to `status = 'redeemed'`

**Authentication**:
- Builder API credentials (BUILDER_API_KEY, BUILDER_SECRET, BUILDER_PASS_PHRASE)
- Signer private key (PROXY_WALLET_PRIVATE_KEY)

### vault:init-proxy

**Command**: `npm run vault:init-proxy`

**Script**: `src/views/examples/initialize-proxy-wallet.ts`

**What It Does**:
1. Connects to database
2. Fetches on-chain USDC.e balance for PROXY_WALLET
3. Creates/updates `proxy_wallet` record
4. Sets initial AUM = on-chain balance
5. Creates rebase history record

**Authentication**:
- RPC provider (reads on-chain balance)
- No private key required for initialization

---

## Comparison: HEDGE_VAULT vs PROXY_WALLET

| Aspect | HEDGE_VAULT | PROXY_WALLET |
|--------|-------------|--------------|
| **Signature Type** | EOA (0) | POLY_GNOSIS_SAFE (2) |
| **Private Key Owns** | Wallet directly | Signer only |
| **Funds Location** | Same wallet | Proxy wallet (funder) |
| **Gas Fees** | Paid by wallet | Gas-free (relayer) |
| **Token Approvals** | Script-based | Manual (web interface) |
| **Client Class** | PolymarketClient.ts | ProxyPolymarketClient.ts |
| **Executor Class** | TradingExecutor.ts | ProxyTradingExecutor.ts |
| **Redemption** | Manual or relayer | ProxyRedemptionClient.ts |
| **AUM Rebase** | Daily 00:00 UTC | Same schedule |
| **Position Sizing** | 0.1% AUM | Same (0.1% AUM) |
| **Copy Trading** | Supports | **Primary vault for Polyburg** |

---

## Troubleshooting

### "Insufficient allowance" Error

**Cause**: Token approvals not set for PROXY_WALLET

**Fix**:
1. Connect PROXY_WALLET to Polymarket via browser wallet
2. Navigate to any market
3. Attempt a trade to trigger approval prompts
4. Approve USDC.e for Exchange and CTF contracts

### "Invalid signature" Error

**Cause**: Wrong signature type or funder address

**Check**:
```typescript
// ProxyPolymarketClient.ts - Verify signature type
this.clobClient = new ClobClient(
  this.config.host,
  this.config.chainId,
  this.signer,
  apiCreds,
  SignatureType.POLY_GNOSIS_SAFE,  // Must be 2
  this.config.funderAddress        // Must match PROXY_WALLET
);
```

### "Builder credentials invalid" Error

**Cause**: Missing or incorrect BUILDER_* environment variables

**Fix**:
```bash
# Verify all three credentials are set
echo $BUILDER_API_KEY
echo $BUILDER_SECRET
echo $BUILDER_PASS_PHRASE
```

### "Wallet not found" During Redemption

**Cause**: Database record not initialized

**Fix**:
```bash
npm run vault:init-proxy
```

### "Redemption failed - position not settled" Error

**Cause**: Trying to redeem position before market resolves

**Check**:
```sql
-- View position status
SELECT market_slug, status, created_at
FROM positions
WHERE vault_id = (SELECT id FROM vaults WHERE name = 'proxy_wallet');
```

**Wait for**: Market to resolve and position status to update to 'settled'

---

## Security Best Practices

### 1. Private Key Storage

**DO**:
- Store PROXY_WALLET_PRIVATE_KEY in .env file
- Add .env to .gitignore
- Use environment-specific .env files (.env.production, .env.development)

**DON'T**:
- Commit private keys to version control
- Share .env files
- Log private keys in console output

### 2. Builder Credentials

**DO**:
- Rotate credentials periodically
- Use separate credentials for dev/prod
- Monitor relayer API usage

**DON'T**:
- Share Builder credentials across teams
- Use production credentials in development
- Commit credentials to git

### 3. Proxy Wallet Access

**DO**:
- Verify signer is authorized to sign for proxy wallet
- Monitor on-chain proxy wallet activity
- Set up alerts for large redemptions

**DON'T**:
- Share signer private key
- Use same signer for multiple proxy wallets
- Ignore unauthorized transaction attempts

---

## Related Documentation

- **Copy Trading Rules**: `docs/design/COPY_TRADING_RULES.md` - Polyburg signal integration
- **Martingale System**: `docs/MARTINGALE_SYSTEM.md` - Low-price trade behavior
- **API Integration**: `docs/POLYBURG_API_INTEGRATION.md` - External signal endpoints
- **Critical Issues**: `docs/CRITICAL_USDC_TOKEN_ISSUE.md` - USDC.e vs native USDC
- **Infrastructure**: `infra.md` - Server and deployment details

---

## Technical References

### File Locations

**Authentication**:
- `src/services/ProxyPolymarketClient.ts` - POLY_GNOSIS_SAFE client initialization
- `src/services/ProxyRedemptionClient.ts` - Builder Relayer integration

**Trading**:
- `src/services/ProxyTradingExecutor.ts` - Trade execution orchestrator
- `src/services/ProxyTradingService.ts` - Trade service wrapper

**Initialization**:
- `src/views/examples/initialize-proxy-wallet.ts` - Vault setup
- `src/views/examples/redeem-proxy-positions.ts` - Redemption script
- `src/views/vault-status.ts` - Status display

**ABI Definitions**:
- `src/abis/ConditionalTokensAbi.ts` - Standard CTF ABI
- `src/abis/NegRiskAdapterAbi.ts` - NegRisk CTF ABI

### Environment Variables Reference

```bash
# Required for Authentication
PROXY_WALLET=                      # Proxy wallet address (funder)
PROXY_WALLET_PRIVATE_KEY=          # Signer private key

# Required for Trading
POLYMARKET_HOST=                   # CLOB API endpoint
POLYMARKET_CHAIN_ID=137            # Polygon mainnet

# Required for Redemptions
BUILDER_API_KEY=                   # Builder Relayer key
BUILDER_SECRET=                    # Builder Relayer secret
BUILDER_PASS_PHRASE=               # Builder Relayer passphrase
RELAYER_URL=                       # Relayer endpoint

# Required for Token Operations
USDC_ADDRESS=0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174  # USDC.e
```

---

## Summary

The PROXY_WALLET authentication system uses a **two-step initialization process** with **Signature Type 2 (POLY_GNOSIS_SAFE)** to enable gas-free trading and redemptions. The key architectural pattern is **signer vs funder**, where:

1. **Signer** (PROXY_WALLET_PRIVATE_KEY) signs transactions
2. **Funder** (PROXY_WALLET address) holds USDC.e funds
3. **Builder Relayer** handles gas-free on-chain settlement

This design enables seamless integration with Polyburg's AI signal system while maintaining secure, cost-efficient operations.
