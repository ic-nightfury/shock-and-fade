# API Data Sources Documentation

This document tracks all API data sources used in the Polyburg backend system for position tracking, market data, and conviction scoring.

## Polymarket APIs

### 1. Trades API
**Endpoint:** `https://data-api.polymarket.com/trades`
**Purpose:** Fetch recent trader activity and trades
**Usage:** Monitor whale trades for alert generation

**Sample Request:**
```
GET https://data-api.polymarket.com/trades?limit=500&offset=0&takerOnly=true&side=BUY&user={trader_wallet}
```

**Response Fields Used:**
- `id`: Trade identifier
- `user`: Trader wallet address
- `market`: Market condition ID
- `outcome`: "Yes" or "No"
- `side`: "BUY" or "SELL"
- `size`: Number of shares
- `price`: Price per share
- `timestamp`: Unix timestamp
- `conditionId`: Market condition identifier
- `title`: Market title
- `slug`: Market slug
- `name`: Trader display name
- `pseudonym`: Trader pseudonym

### 2. Active Positions API
**Endpoint:** `https://data-api.polymarket.com/positions`
**Purpose:** Fetch current active positions for traders
**Usage:** Calculate correct position values for conviction scoring

**Sample Request:**
```
GET https://data-api.polymarket.com/positions?sizeThreshold=0.01&limit=100&sortBy=TOKENS&sortDirection=DESC&user={trader_wallet}&market={condition_id}
```

**Response Fields Used:**
- `proxyWallet`: Trader wallet address
- `asset`: Position asset identifier
- `conditionId`: Market condition ID
- `size`: Number of shares held
- `avgPrice`: Average entry price
- `initialValue`: **KEY FIELD** - Original USD investment amount
- `currentValue`: Current position value
- `cashPnl`: Unrealized profit/loss
- `percentPnl`: Percentage profit/loss
- `totalBought`: Total shares purchased
- `realizedPnl`: Realized profit/loss
- `curPrice`: Current market price
- `title`: Market title
- `slug`: Market slug
- `outcome`: "Yes" or "No"
- `outcomeIndex`: 0 for Yes, 1 for No
- `endDate`: Market end date

**Critical Note:** `initialValue` represents the actual USD amount invested and should be used for position sizing calculations.

### 3. Closed Positions API
**Endpoint:** `https://data-api.polymarket.com/closed-positions`
**Purpose:** Fetch historical closed positions for complete position calculation
**Usage:** Sum with active positions to get total trader exposure

**Sample Request:**
```
GET https://data-api.polymarket.com/closed-positions?limit=500&sortBy=REALIZEDPNL&sortDirection=DESC&user={trader_wallet}&market={condition_id}
```

**Response Fields Used:**
- `proxyWallet`: Trader wallet address
- `asset`: Position asset identifier
- `conditionId`: Market condition ID
- `avgPrice`: Average price paid
- `totalBought`: Total shares purchased
- `realizedPnl`: Realized profit/loss
- `curPrice`: Final settlement price (1 for win, 0 for loss)
- `title`: Market title
- `slug`: Market slug
- `outcome`: "Yes" or "No"
- `outcomeIndex`: 0 for Yes, 1 for No
- `endDate`: Market end date

**Calculation:** For closed positions, `initialValue = avgPrice * totalBought`

### 4. Market Gamma API (Market Data)

**Base Endpoint:** `https://gamma-api.polymarket.com/markets`

**Purpose:** Fetch comprehensive market information including metadata, volume, pricing, tags, and CLOB token IDs

**Usage:** Supports both single market queries and batch queries (up to 15 markets per request)

---

#### 4a. Single Market Query

**Endpoint Pattern:** `/markets/slug/{market_slug}`

**Sample Request:**
```bash
curl --request GET \
  --url 'https://gamma-api.polymarket.com/markets/slug/lal-ovi-bar-2025-09-25-ovi?include_tag=true'
```

**When to Use:**
- Fetching one specific market by slug
- Real-time single market lookups

**Response:** Single market object

---

#### 4b. Multiple Markets (Batch Query)

**Endpoint Pattern:** `/markets` with multiple `slug` parameters

**Parameters:**
- `slug`: Market slug (can be repeated up to 15 times)
- `limit`: Maximum number of markets to return (optional, recommend setting to number of slugs)
- `include_tag`: Set to `true` to include tag metadata (recommended)

**Sample Request:**
```bash
curl --request GET \
  --url 'https://gamma-api.polymarket.com/markets?slug=nfl-dal-lv-2025-11-17&slug=solana-up-or-down-november-17-7pm-et&limit=2&include_tag=true'
```

**When to Use:**
- Fetching 2-15 known market slugs in a single API call
- Reduces API calls: 15 markets = 1 request instead of 15 sequential requests
- Batch processing workflows

**Response:** Array of market objects (same structure as single query, but wrapped in array)

**Batch Limitations:**
- Maximum 15 markets per request
- For larger lists, process in chunks of 15 with 250ms delay between chunks

---

#### Common Response Fields

**Essential Fields:**
- `id`: Market ID (string)
- `question`: Market question/title
- `conditionId`: Market condition identifier (hex string, used for Data API queries)
- `slug`: Market slug (URL-friendly identifier)
- `endDate`: Market end date (ISO format)
- `outcomes`: Available outcomes array (e.g., `["Yes", "No"]` or `["Cowboys", "Raiders"]`)
- `outcomePrices`: Current prices array (e.g., `["0.65", "0.35"]`)
- `active`: Market status (boolean)
- `closed`: Market closed status (boolean)

**Volume Fields:**
- `volume`: Total lifetime volume (float)
- `volume24hr`: 24-hour volume (float)
- `volume1wk`: 1-week volume (float)
- `volume1mo`: 1-month volume (float)
- `volume1yr`: 1-year volume (float)

**CLOB Integration Fields (Important for Price History):**
- `clobTokenIds`: **Array of CLOB Token IDs** - Direct access to outcome token IDs for prices-history API
  - Format: `["24134241107503107560090410709041215062347712565742158477797402057735704712249", "101344774259650316724211209404599693908548325264700605600508921670126441643376"]`
  - Maps to `outcomes` by index: `outcomes[0]` → `clobTokenIds[0]`, `outcomes[1]` → `clobTokenIds[1]`
  - **Critical:** This eliminates the need to query Activity API to discover CLOB Token IDs for price history

**Metadata Fields:**
- `liquidity`: Market liquidity (float)
- `events`: Associated event data array (contains event details, series info, scores for sports)
- `tags`: Array of tag objects (when `include_tag=true`) - Used for categorization (Sports, Politics, Crypto, etc.)
- `description`: Market resolution rules and details
- `image`: Market image URL
- `icon`: Market icon URL

**Tag Object Structure:**
```json
{
  "id": "780",
  "label": "La Liga",
  "slug": "la-liga",
  "forceShow": false,
  "publishedAt": "2023-12-21 19:28:09.258+00",
  "createdAt": "2023-12-21T19:28:09.265Z",
  "updatedAt": "2024-09-27T04:23:47.749757Z"
}
```

---

#### Integration with CLOB Prices-History API

The `clobTokenIds` field provides **direct access** to outcome-specific token IDs needed for historical price queries:

**Simplified Workflow:**
```typescript
// 1. Fetch market (single or batch)
const response = await fetch('https://gamma-api.polymarket.com/markets?slug=bitcoin-100k-by-2025&include_tag=true')
const markets = await response.json()
const market = markets[0]

// 2. Access CLOB Token IDs directly (no Activity API needed!)
const outcomes = JSON.parse(market.outcomes) // ["Yes", "No"]
const tokenIds = JSON.parse(market.clobTokenIds) // ["token_id_1", "token_id_2"]

// 3. Map outcomes to token IDs
const outcomeToTokenId = {
  [outcomes[0]]: tokenIds[0], // "Yes" → token_id_1
  [outcomes[1]]: tokenIds[1]  // "No" → token_id_2
}

// 4. Fetch price history for "Yes" outcome
const yesTokenId = outcomeToTokenId["Yes"]
const priceHistory = await fetch(
  `https://clob.polymarket.com/prices-history?market=${yesTokenId}&interval=max&fidelity=60`
)
const { history } = await priceHistory.json()
```

**Old Workflow (Before `clobTokenIds`):**
1. Fetch market from Gamma API → get `conditionId`
2. Fetch activity from Data API using `conditionId` → extract `asset` field
3. Map `asset` (CLOB Token ID) to outcomes by `outcomeIndex`

**New Workflow (With `clobTokenIds`):**
1. Fetch market from Gamma API → get `clobTokenIds` directly
2. Use token IDs immediately for price history queries

---

#### Batch Query Example

**Fetching 5 markets in a single request:**
```bash
curl --request GET \
  --url 'https://gamma-api.polymarket.com/markets?slug=market1&slug=market2&slug=market3&slug=market4&slug=market5&limit=5&include_tag=true'
```

**Processing 50 markets (chunk into batches of 15):**
```typescript
const marketSlugs = ['market1', 'market2', /* ... 50 total ... */]
const chunkSize = 15
const allMarkets = []

for (let i = 0; i < marketSlugs.length; i += chunkSize) {
  const chunk = marketSlugs.slice(i, i + chunkSize)
  const slugParams = chunk.map(slug => `slug=${slug}`).join('&')

  const response = await fetch(
    `https://gamma-api.polymarket.com/markets?${slugParams}&limit=${chunk.length}&include_tag=true`
  )
  const markets = await response.json()
  allMarkets.push(...markets)

  // Rate limiting: 250ms delay between batches
  await new Promise(resolve => setTimeout(resolve, 250))
}

console.log(`Fetched ${allMarkets.length} markets in ${Math.ceil(marketSlugs.length / chunkSize)} API calls`)
```

---

#### Use Cases in PolyBurg

1. **Batch Alert Processing**: Fetch metadata for 15 markets simultaneously when processing conviction alerts
2. **Market Enrichment**: Bulk enrich markets with tags, volume, and CLOB token IDs
3. **Price History Setup**: Get CLOB token IDs for multiple markets to analyze historical price trends
4. **Volume Analysis**: Batch fetch volume metrics across multiple markets for comparative analysis
5. **Market Discovery**: Fetch multiple markets by known slugs for portfolio tracking

---

#### Best Practices

**Always Include Tags:**
```bash
?include_tag=true
```
Enables market categorization (Sports, Politics, Crypto, etc.)

**Batch Size:**
- Optimal: 15 markets per request (API maximum)
- For lists > 15: Process in chunks with 250ms delays

**Rate Limiting:**
- Single query: 250ms delay between requests
- Batch query: Counts as 1 API call (not 15), still apply 250ms delay between batches

**Field Parsing:**
- `outcomes`, `outcomePrices`, `clobTokenIds` may be JSON strings - use `JSON.parse()`
- Check response format and parse accordingly

**Error Handling:**
- Invalid slug: That market will be omitted from response array
- All invalid slugs: Returns empty array `[]`
- Partial success: Returns only valid markets (no error thrown)

## Internal APIs

### 5. Conviction Score API
**Endpoint:** `http://localhost:3338/api/calculate_confidence_score`
**Purpose:** Calculate trader conviction scores based on position size and trading history
**Usage:** Determine alert priority and trader confidence levels

**Sample Request:**
```json
POST http://localhost:3338/api/calculate_confidence_score
{
  "trader_id": "0xa1d73a7bb263ca09b268e218a9257d3425f5a70c",
  "current_trade_size": 1250.50
}
```

**Response Fields:**
- `confidence_score`: Conviction score (0-10)
- `trader_id`: Trader wallet address
- `current_trade_size`: Position size analyzed
- `trader_stats`: Trading statistics
  - `avg_position_size`: **KEY** - Average historical position size
  - `total_positions`: Total number of positions
  - `min_position_size`: Minimum position size
  - `max_position_size`: Maximum position size
  - `stddev_position_size`: Standard deviation
  - `roi_percentage`: Return on investment percentage
- `analysis`: Detailed analysis factors
  - `position_size_factor`: Position size analysis
  - `historical_performance`: Performance analysis
  - `market_conditions`: Market condition assessment
  - `risk_assessment`: Risk evaluation

**Critical Usage:** `avg_position_size` is used to calculate size multiplier for "x than usual" display in alerts.

## Database APIs

### 6. PostgreSQL - Main Database
**Database:** `polyburg`
**Purpose:** Store application data, alerts, users, markets
**Tables Used:**
- `alert_with_conviction`: Conviction-based alerts
- `markets`: Market information and metadata
- `users`: Telegram users and preferences
- `smart_wallets`: Tracked whale traders

### 7. PostgreSQL - Analytics Database
**Database:** `polymarket_analytics`
**Purpose:** Store trader analytics and scoring data
**Tables Used:**
- `trader_scores`: Top trader rankings and statistics

## Rate Limiting

All external API calls implement rate limiting:
- **Polymarket APIs**: 250ms delay between calls
- **Conviction API**: 250ms delay between calls
- **Batch Operations**: Process in chunks of 15 markets

## Error Handling

- API failures fall back to database lookups where possible
- Conviction API failures use calculated fallback scores
- Position API failures skip that trader/market combination
- All errors are logged with context for debugging

## Data Validation

- Position values validated against reasonable ranges
- Conviction scores clamped to 0-10 range
- Timestamps converted to proper DateTime objects
- Market end dates parsed with multiple format support

## Performance Optimization

- Batch API calls where possible
- Cache frequently accessed data
- Use appropriate rate limiting
- Implement request timeouts
- Deduplicate API requests by asset ID

## Security Considerations

- No API keys required for public Polymarket endpoints
- Internal conviction API runs on localhost only
- Database credentials stored in environment variables
- No sensitive data logged in API calls



### 8. Activity API (All Types)

**Endpoint**: `https://data-api.polymarket.com/activity`

**Purpose**: Fetches all activity types for a trader including TRADE, SPLIT, REDEEM, MERGE, and other blockchain events. Returns comprehensive activity history across all markets.

**Parameters**:
- `user`: Trader wallet address (required)
- `market`: Condition ID of the market (optional), can be multiple conditionIds separated by comma
- `type`: Activity type filter (optional) - values: "TRADE", "SPLIT", "REDEEM", "MERGE"
- `limit`: Maximum number of results (default: 100, max: 500)
- `sortBy`: Sort field (TIMESTAMP, SIZE, etc.)
- `sortDirection`: ASC or DESC

**Activity Types**:
- `TRADE`: Buy/Sell transactions on markets
- `SPLIT`: Converting USDC into outcome tokens (initial investment)
- `REDEEM`: Claiming winnings from resolved markets
- `MERGE`: Combining outcome tokens back to USDC

**Example URLs**:

**All Activity Types (No Filter)**:
```
https://data-api.polymarket.com/activity?limit=3&sortBy=TIMESTAMP&sortDirection=DESC&user=0x134DE7d07004124762086357903a0171542E5a16
```

**SPLIT Activities Only**:
```
https://data-api.polymarket.com/activity?limit=100&sortBy=TIMESTAMP&sortDirection=DESC&type=SPLIT&user=0x134DE7d07004124762086357903a0171542E5a16&market=0x557eb4e8486bc22e5b5395201e8e3612231494f97533f3c6e46b33ab0c814f44
```

**TRADE Activities Only**:
```
https://data-api.polymarket.com/activity?limit=100&sortBy=TIMESTAMP&sortDirection=DESC&type=TRADE&user=0x134DE7d07004124762086357903a0171542E5a16
```

**Example Response (Mixed Activity Types)**:
```json
[
  {
    "proxyWallet": "0x134de7d07004124762086357903a0171542e5a16",
    "timestamp": 1759458185,
    "conditionId": "0xc8761147389535d28583a71eab365841f36f1cc7ee689fbd32a384e3879a5b7c",
    "type": "TRADE",
    "size": 20,
    "usdcSize": 3,
    "transactionHash": "0xc2ee85546e0fd2296fcdc966dc992b29860edabe46cc5b84b508c2271a8958e9",
    "price": 0.15,
    "asset": "113169259226134431152838745958605113475709202189344707220996974617795381207465",
    "side": "BUY",
    "outcomeIndex": 0,
    "title": "Will the New York Yankees win the 2025 World Series?",
    "slug": "will-the-new-york-yankees-win-the-2025-world-series",
    "icon": "https://polymarket-upload.s3.us-east-2.amazonaws.com/will-the-new-york-yankees-win-the-world-series-AMHIDydQWzZ0.png",
    "eventSlug": "world-series-champion-2025",
    "outcome": "Yes",
    "name": "ic-nightfury",
    "pseudonym": "Colossal-Measurement",
    "bio": "",
    "profileImage": "",
    "profileImageOptimized": ""
  },
  {
    "proxyWallet": "0x134de7d07004124762086357903a0171542e5a16",
    "timestamp": 1759431565,
    "conditionId": "0xf4f51e9e4e8439e32f64dc0e659828af7564f9cbc323d4f7442f2c590a2ea07d",
    "type": "TRADE",
    "size": 12.5,
    "usdcSize": 2,
    "transactionHash": "0xe2a677bb6b5445de7654eef96c21c5131d8ea8714b30440720db1532f39b90ff",
    "price": 0.16,
    "asset": "44305836174662659056360031599221289950024907383706896555756948878751959775782",
    "side": "BUY",
    "outcomeIndex": 0,
    "title": "Taylor Swift pregnant in 2025?",
    "slug": "taylor-swift-pregnant-in-2025",
    "icon": "https://polymarket-upload.s3.us-east-2.amazonaws.com/taylor-swift-pregnant-in-2025-5cpC3Ir4u5Pd.jpg",
    "eventSlug": "taylor-swift-pregnant-in-2025",
    "outcome": "Yes",
    "name": "ic-nightfury",
    "pseudonym": "Colossal-Measurement",
    "bio": "",
    "profileImage": "",
    "profileImageOptimized": ""
  },
  {
    "proxyWallet": "0x134de7d07004124762086357903a0171542e5a16",
    "timestamp": 1759430901,
    "conditionId": "0x245dea0b918a46bef95ce778f2373851da11130d4c5c95803f881b1a3019ae17",
    "type": "REDEEM",
    "size": 3.278687,
    "usdcSize": 3.278687,
    "transactionHash": "0x4ba961a2be1d9b2fa4a160c985a126a7194d4d56874ed1d8bf42f8d21d1082a7",
    "price": 0,
    "asset": "",
    "side": "",
    "outcomeIndex": 999,
    "title": "Ethereum Up or Down - October 2, 10AM ET",
    "slug": "ethereum-up-or-down-october-2-10am-et",
    "icon": "https://polymarket-upload.s3.us-east-2.amazonaws.com/ETH+fullsize.jpg",
    "eventSlug": "ethereum-up-or-down-october-2-10am-et",
    "outcome": "",
    "name": "ic-nightfury",
    "pseudonym": "Colossal-Measurement",
    "bio": "",
    "profileImage": "",
    "profileImageOptimized": ""
  }
]
```

**Key Fields by Activity Type**:

**Common Fields (All Types)**:
- `proxyWallet`: Trader wallet address
- `timestamp`: Unix timestamp of the activity
- `conditionId`: Market identifier
- `type`: Activity type (TRADE, SPLIT, REDEEM, MERGE)
- `size`: Token/share amount involved
- `usdcSize`: USDC value of the activity
- `transactionHash`: Unique blockchain transaction identifier
- `title`: Market title
- `slug`: Market slug
- `icon`: Market icon URL
- `eventSlug`: Event slug
- `name`: Trader display name
- `pseudonym`: Trader pseudonym

**TRADE-Specific Fields**:
- `price`: Price per share (e.g., 0.15 = 15 cents per share)
- `asset`: Asset/token identifier (long hex string)
- `side`: "BUY" or "SELL"
- `outcomeIndex`: 0 for Yes, 1 for No
- `outcome`: "Yes" or "No"

**SPLIT-Specific Fields**:
- `price`: Always 0.5 (converting USDC to equal amounts of YES/NO tokens)
- `usdcSize`: Amount of USDC invested (initial investment amount)
- `outcomeIndex`: Always 999 (not outcome-specific)
- `asset`: Usually empty
- `side`: Usually empty
- `outcome`: Usually empty

**REDEEM-Specific Fields**:
- `price`: Always 0 (redemption doesn't have a price)
- `usdcSize`: Amount of USDC received from redemption
- `outcomeIndex`: Always 999 (redeeming winning position)
- `asset`: Usually empty
- `side`: Usually empty
- `outcome`: Usually empty

**Important Calculations**:
- **Total SPLIT Investment**: SUM(usdcSize) for all SPLIT activities in a market
- **Trade Cost**: `usdcSize` (actual USDC spent/received)
- **Trade Shares**: `size` (number of outcome tokens)
- **Redemption Profit**: `usdcSize` from REDEEM activities

### 9. User PnL API

**Endpoint**: `https://user-pnl-api.polymarket.com/user-pnl`

**Purpose**: Fetches historical PnL (Profit and Loss) time series data for a specific user. Returns data points showing cumulative PnL over time at specified intervals.

**Parameters**:
- `user_address`: Trader wallet address (required)
- `interval`: Time range for data (options: `max`, `1y`, `6m`, `3m`, `1m`, `1w`)
- `fidelity`: Data point granularity (options: `1d` for daily, `1h` for hourly, `15m` for 15-minute intervals)

**Example URL**:
```
https://user-pnl-api.polymarket.com/user-pnl?user_address=0x8b5a7da2fdf239b51b9c68a2a1a35bb156d200f2&interval=max&fidelity=1d
```

**Example Response**:
```json
[
  {
    "t": 1732752000,
    "p": 447507.8
  },
  {
    "t": 1732838400,
    "p": 450123.45
  },
  {
    "t": 1732924800,
    "p": 455890.2
  },
  {
    "t": 1733011200,
    "p": 462345.67
  }
]
```

**Response Fields**:
- `t`: Unix timestamp (integer) - Point in time for this PnL snapshot
- `p`: PnL value (float) - Cumulative profit/loss in USD at this timestamp

**Sample Response Characteristics**:
- Returns array of time-series data points
- Timestamps are Unix epoch seconds
- PnL values are cumulative (not incremental)
- Data points align with requested fidelity (e.g., daily snapshots for `1d`)
- Typical response size: 300+ data points for `interval=max` with `fidelity=1d`

**Use Cases**:
- Historical performance tracking for traders
- PnL chart visualization over time
- Performance comparison across different time periods
- Calculating daily/weekly/monthly returns

**Interval Options**:
- `max`: All available historical data
- `all`: All available historical data (alias for max)
- `1m`: Last 30 days
- `1w`: Last 7 days
- `1d`: Last 24 hours
- `12h`: Last 12 hours
- `6h`: Last 6 hours

**Fidelity Options**:
- `1d`: Daily data points (one per day)
- `1h`: Hourly data points (24 per day)
- `15m`: 15-minute intervals (96 per day)

**Example: Calculate Recent Performance**:
```typescript
// Fetch last 30 days with daily fidelity
const response = await fetch(
  'https://user-pnl-api.polymarket.com/user-pnl?user_address=0x8b5a7da2fdf239b51b9c68a2a1a35bb156d200f2&interval=1m&fidelity=1d'
)
const data = await response.json()

// Calculate 30-day return
const firstDay = data[0]
const lastDay = data[data.length - 1]
const monthlyReturn = lastDay.p - firstDay.p
const monthlyReturnPercent = ((lastDay.p - firstDay.p) / firstDay.p) * 100

console.log(`30-day PnL: $${monthlyReturn.toFixed(2)}`)
console.log(`30-day Return: ${monthlyReturnPercent.toFixed(2)}%`)
```

**Note**: PnL values are cumulative totals, not daily changes. To calculate daily PnL change, subtract consecutive data points.

### 10. CLOB Prices-History API (Outcome Token Price History)

**Endpoint**: `https://clob.polymarket.com/prices-history`

**Purpose**: Fetch historical price snapshots for specific outcome tokens with configurable time intervals and granularity. Essential for analyzing price movements, volatility, and trader entry/exit timing.

**Parameters**:
- `market`: CLOB Token ID (required) - Unique identifier for the specific outcome token
- `interval`: Time range (required) - Options: `max`, `1y`, `6m`, `3m`, `1m`, `1w`, `1d`
- `fidelity`: Data point granularity (required) - Specified in **minutes** (e.g., `1` = 1-minute candles, `60` = hourly, `1440` = daily)

**Sample Request**:
```
GET https://clob.polymarket.com/prices-history?interval=max&fidelity=1&market=24134241107503107560090410709041215062347712565742158477797402057735704712249
```

**Example Response**:
```json
{
  "history": [
    {
      "t": 1762755008,
      "p": 0.63
    },
    {
      "t": 1762755608,
      "p": 0.63
    },
    {
      "t": 1762756211,
      "p": 0.63
    },
    {
      "t": 1762759812,
      "p": 0.625
    },
    {
      "t": 1762762807,
      "p": 0.635
    }
  ]
}
```

**Response Structure**:
- Root object contains `history` array
- Each history entry contains:
  - `t`: Unix timestamp (integer, seconds) - Point in time for this price snapshot
  - `p`: Price (float) - Market price at this timestamp (0.0 - 1.0 range, representing probability)

**Understanding CLOB Token IDs**:

CLOB Token IDs are **outcome-specific** identifiers that differ from `conditionId`. Markets have multiple outcomes (e.g., "Yes"/"No"), and each outcome has its own unique CLOB Token ID.

**How to Obtain CLOB Token IDs**:

**✅ Recommended Method (Direct from Market Gamma API):**

The Market Gamma API now directly provides `clobTokenIds` field - **no need for Activity API lookups!**

1. **Get Market from Gamma API with `include_tag=true`**:
   ```bash
   GET https://gamma-api.polymarket.com/markets?slug={market_slug}&include_tag=true
   ```

2. **Extract CLOB Token IDs directly**:
   - Response includes `clobTokenIds` array: `["token_id_1", "token_id_2"]`
   - Maps to `outcomes` by index: `outcomes[0]` → `clobTokenIds[0]`, `outcomes[1]` → `clobTokenIds[1]`
   - Example: For `outcomes: ["Yes", "No"]`, the first token ID is for "Yes", second is for "No"

3. **Fetch Price History Using CLOB Token ID**:
   ```bash
   GET https://clob.polymarket.com/prices-history?market={CLOB_TOKEN_ID}&interval=max&fidelity=60
   ```

**📖 See Section 4 (Market Gamma API) for complete integration examples.**

---

**⚠️ Alternative Method (Legacy - via Activity API):**

If `clobTokenIds` is not available or you need to verify token IDs:

1. Get `conditionId` from Market Gamma API
2. Fetch Activity API: `GET https://data-api.polymarket.com/activity?limit=100&market={conditionId}`
3. Extract `asset` field (CLOB Token ID) and map by `outcomeIndex`

**Interval Options**:
- `max`: All available historical data (recommended for backtesting)
- `1y`: Last 365 days
- `6m`: Last 6 months
- `3m`: Last 3 months
- `1m`: Last 30 days
- `1w`: Last 7 days
- `1d`: Last 24 hours

**Fidelity Options (in minutes)**:
- `1`: 1-minute intervals (~1440 data points per day) - High granularity for intraday analysis
- `5`: 5-minute intervals (~288 data points per day) - Common for short-term trading
- `15`: 15-minute intervals (~96 data points per day) - Medium granularity
- `60`: 1-hour intervals (~24 data points per day) - Popular for trend analysis
- `240`: 4-hour intervals (~6 data points per day) - Longer-term patterns
- `1440`: 1-day intervals (1 data point per day) - Daily price movements

**Example: Complete Workflow (Using Direct Method)**:
```typescript
// 1. Get market data with CLOB Token IDs
const response = await fetch('https://gamma-api.polymarket.com/markets?slug=will-bitcoin-hit-100k-by-2025&include_tag=true')
const markets = await response.json()
const market = markets[0]

// 2. Parse outcomes and CLOB Token IDs
const outcomes = JSON.parse(market.outcomes) // ["Yes", "No"]
const tokenIds = JSON.parse(market.clobTokenIds) // ["token_id_yes", "token_id_no"]

// 3. Map outcomes to token IDs
const outcomeToTokenId = {
  [outcomes[0]]: tokenIds[0], // "Yes" → token_id_yes
  [outcomes[1]]: tokenIds[1]  // "No" → token_id_no
}

// 4. Fetch price history for "Yes" outcome
const yesTokenId = outcomeToTokenId["Yes"]
const priceHistory = await fetch(
  `https://clob.polymarket.com/prices-history?market=${yesTokenId}&interval=1m&fidelity=60`
)
const data = await priceHistory.json()

// 5. Analyze price movements
const history = data.history
const latestPrice = history[history.length - 1]
console.log(`Current price: ${latestPrice.p}`)
console.log(`24h high: ${Math.max(...history.slice(-1440).map(h => h.p))}`) // 1440 minutes = 24 hours
console.log(`24h low: ${Math.min(...history.slice(-1440).map(h => h.p))}`)
```

**Old Workflow (Legacy - before `clobTokenIds` was available)**:
- Required Activity API lookups to extract CLOB Token IDs from `asset` fields
- More API calls and complexity
- See "Alternative Method" above for legacy approach

**Use Cases in PolyBurg**:
1. **Price Trend Analysis**: Track how whale trades affect outcome prices over time
2. **Entry Point Detection**: Compare trader entry prices against historical price movements
3. **Volatility Calculation**: Calculate price volatility and standard deviation for risk assessment
4. **Performance Backtesting**: Analyze if following whale signals would have been profitable based on price changes
5. **Market Impact Analysis**: Measure price impact of large whale positions by comparing before/after prices
6. **Timing Analysis**: Identify optimal entry/exit timing based on historical price patterns
7. **Price Change Detection**: Calculate percentage price changes over specific time windows

**Rate Limiting**:
- Recommended delay: 250ms between CLOB API calls
- Same rate limit bucket as other CLOB endpoints (orderbook, markets)

**Error Handling**:
- **Invalid CLOB Token ID**: Returns HTTP 404 or empty array
- **Solution**: Refetch token IDs from Activity API with recent data
- **Unsupported interval/fidelity**: API returns empty array or 400 error
- **No data available**: Returns empty array `[]` for newly created markets

**Performance Optimization**:
- Cache CLOB Token IDs by `conditionId` to avoid repeated Activity API calls
- Use higher fidelity values (e.g., 60, 1440) for historical analysis to reduce data size
- Limit interval to relevant time period (e.g., `1m` for recent trends vs `max` for backtesting)

**Data Validation**:
- Response must have `history` array at root level
- Prices (`p`) should be in range 0.0 - 1.0 (0% - 100% probability)
- Timestamps (`t`) should be sequential and generally aligned with fidelity (may have gaps)
- Each history entry must have both `t` and `p` fields
- Price changes between consecutive entries should be reasonable (large jumps may indicate volatility or data issues)