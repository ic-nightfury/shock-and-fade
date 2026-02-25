# Arbitrage Tick Data API

API for accessing order book tick data collected by the arbitrage monitor.

## Base URL

```
http://46.62.246.210:3001
```

---

## Endpoints

### 1. List All Markets

```
GET /api/arbitrage
```

Returns all markets with recorded tick data.

**Response:**
```json
[
  {
    "market_slug": "btc-updown-15m-1766754000",
    "tick_count": 1250,
    "latest_timestamp": 1765983455
  }
]
```

---

### 2. Get Ticks for a Market

```
GET /api/arbitrage/:slug?limit=1000&offset=0
```

**Parameters:**
| Param | Required | Default | Description |
|-------|----------|---------|-------------|
| `slug` | Yes | - | Market slug (e.g., `btc-updown-15m-1765981800`) |
| `limit` | No | 1000 | Number of ticks per page |
| `offset` | No | 0 | Pagination offset |

**Response:**
```json
{
  "market_slug": "btc-updown-15m-1765981800",
  "pagination": {
    "total": 5420,
    "limit": 1000,
    "offset": 0,
    "hasMore": true
  },
  "stats": {
    "total_ticks": 5420,
    "profitable_ticks": 2104,
    "avg_profit_margin": 0.85,
    "max_profit_margin": 2.34,
    "min_pair_cost": 0.9801
  },
  "latest": { ... },
  "ticks": [ ... ]
}
```

---

### 3. Get Latest Tick

```
GET /api/arbitrage/:slug/latest
```

Returns the most recent tick for a market.

---

### 4. Get Profitable Ticks Only

```
GET /api/arbitrage/:slug/profitable?limit=100
```

Returns only ticks where `pair_cost_ask < 1.0`.

---

## Tick Data Structure

Each tick represents an order book snapshot:

| Field | Type | Description |
|-------|------|-------------|
| `id` | number | Unique tick ID |
| `market_slug` | string | Market identifier |
| `timestamp` | number | Unix timestamp (seconds) |
| `up_bid` | number | Best bid for UP token |
| `up_ask` | number | Best ask for UP token |
| `up_spread` | number | UP spread (ask - bid) |
| `down_bid` | number | Best bid for DOWN token |
| `down_ask` | number | Best ask for DOWN token |
| `down_spread` | number | DOWN spread (ask - bid) |
| `pair_cost_bid` | number | up_bid + down_bid |
| `pair_cost_ask` | number | up_ask + down_ask |
| `is_profitable` | boolean | True if pair_cost_ask < 1.0 |
| `profit_margin` | number | (1 - pair_cost_ask) * 100 |
| `btc_price` | number | BTC/USDT price at tick time |
| `btc_ts` | number | BTC price timestamp |

---

## Key Metrics

### Pair Cost
- **`pair_cost_ask`** = `up_ask + down_ask`
- Cost to buy one pair (1 UP + 1 DOWN)
- Since UP + DOWN always settles to $1.00:
  - `pair_cost_ask < 1.0` = guaranteed profit
  - `pair_cost_ask = 0.98` = 2% profit locked

### Profit Margin
- Formula: `(1 - pair_cost_ask) * 100`
- Positive only when `pair_cost_ask < 1.0`

---

## Usage Examples

### cURL

```bash
# List all markets
curl "http://46.62.246.210:3001/api/arbitrage"

# Get ticks for a market (first page)
curl "http://46.62.246.210:3001/api/arbitrage/btc-updown-15m-1765981800?limit=100"

# Get latest tick
curl "http://46.62.246.210:3001/api/arbitrage/btc-updown-15m-1765981800/latest"

# Get profitable ticks only
curl "http://46.62.246.210:3001/api/arbitrage/btc-updown-15m-1765981800/profitable"
```

### JavaScript

```javascript
const API = "http://46.62.246.210:3001";

// Get all ticks with pagination
async function getAllTicks(slug) {
  let allTicks = [];
  let offset = 0;
  let hasMore = true;

  while (hasMore) {
    const res = await fetch(
      `${API}/api/arbitrage/${slug}?limit=1000&offset=${offset}`
    );
    const data = await res.json();

    allTicks = [...allTicks, ...data.ticks];
    hasMore = data.pagination.hasMore;
    offset += 1000;
  }

  return allTicks;
}

// Get latest tick
async function getLatest(slug) {
  const res = await fetch(`${API}/api/arbitrage/${slug}/latest`);
  return res.json();
}
```

### Python

```python
import requests

API = "http://46.62.246.210:3001"

def get_all_ticks(slug):
    all_ticks = []
    offset = 0

    while True:
        res = requests.get(f"{API}/api/arbitrage/{slug}",
                          params={"limit": 1000, "offset": offset})
        data = res.json()

        all_ticks.extend(data["ticks"])

        if not data["pagination"]["hasMore"]:
            break
        offset += 1000

    return all_ticks

def get_latest(slug):
    res = requests.get(f"{API}/api/arbitrage/{slug}/latest")
    return res.json()
```

---

## Market Slug Format

Slugs follow the pattern: `btc-updown-15m-{unix_timestamp}`

The timestamp is the market's settlement time (when the 15-minute window ends).

Example: `btc-updown-15m-1765981800` settles at Unix time 1765981800.
