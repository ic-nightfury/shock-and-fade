# Pinnacle Fair-Value Integration

Use Pinnacle sportsbook odds as a **fair-value anchor** to validate Polymarket price shocks before trading.

**Core idea:** If Polymarket spikes to 75¢ but Pinnacle implies 68¢ → high-confidence fade (7¢ overshoot). If both agree at 74¢ → shock is real → skip.

---

## 1. Getting API Keys

### The Odds API (Primary — recommended)

| | |
|---|---|
| **Website** | https://the-odds-api.com |
| **Signup** | https://the-odds-api.com/#get-access |
| **Free tier** | 500 credits/month |
| **Paid tier** | $30/mo for 20K credits |

**Steps:**
1. Go to https://the-odds-api.com/#get-access
2. Click "START" under the free tier
3. Enter your email address
4. API key is sent to your email immediately
5. Add to `.env`: `THE_ODDS_API_KEY=your_key_here`
6. Test: `npm run pinnacle:test`

**Key details:**
- Pinnacle is under the `eu` region (`regions=eu&bookmakers=pinnacle`)
- Moneyline market key: `h2h`
- Sport keys: `basketball_nba`, `americanfootball_nfl`, `icehockey_nhl`
- The `/sports` endpoint is free (doesn't cost credits)
- Each odds call costs 1 credit per region per market

### odds-api.io (Secondary — paid only)

| | |
|---|---|
| **Website** | https://odds-api.io |
| **Cheapest plan** | £99/mo (~$125) for 5 bookmakers, 5K req/hr |
| **Free tier** | None |

**Not recommended for our use case.** The Odds API's free tier is sufficient for development/testing, and their $30/mo plan covers unlimited production usage. Only consider odds-api.io if you need sub-150ms latency or The Odds API is unreliable.

---

## 2. Configuration

### Environment Variables

```bash
# Required — The Odds API key
THE_ODDS_API_KEY=your_key_here

# Optional — override cache TTL (default 30s)
# PINNACLE_CACHE_TTL_MS=30000
```

Add to your `.env` file in the project root.

### Code Configuration

```typescript
import { PinnacleOddsClient } from './services/PinnacleOddsClient';

// Default: reads THE_ODDS_API_KEY from env, 30s cache
const client = new PinnacleOddsClient();

// Custom config
const client = new PinnacleOddsClient({
  apiKey: 'explicit_key',
  cacheTtlMs: 15_000,     // 15s cache for live trading
  source: 'the-odds-api', // only supported source currently
});
```

---

## 3. Integration with ShockFadeLive.ts

### Where it hooks in

```
ShockFadeDetector.on('shock') →
  [NEW] PinnacleOddsClient.getGameOdds() →
  [NEW] Calculate overshoot →
  Decision: trade / skip / reduce size →
  OrderExecutor.placeLadder()
```

### Decision logic

```typescript
// In ShockFadeLive's shock handler (pseudo-code):

async function handleShock(shock: ShockEvent) {
  // 1. Existing: wait for game event classification
  const classification = await classifyShock(shock);
  if (classification !== 'single_event') return; // existing logic

  // 2. NEW: Check Pinnacle fair value
  const pinnacleOdds = await pinnacleClient.getGameOdds(sport, homeTeam, awayTeam);

  if (pinnacleOdds) {
    // Determine which side we're fading
    const fairValue = shock.direction === 'up'
      ? pinnacleOdds.homeFair   // price spiked up, check if overpriced
      : pinnacleOdds.awayFair;

    const overshoot = PinnacleOddsClient.getOvershoot(shock.currentPrice, fairValue);

    if (overshoot >= 5) {
      // HIGH CONFIDENCE: Polymarket 5+¢ above Pinnacle fair value
      // → Trade full size
      placeLadder(shock, sizeMultiplier: 1.0);

    } else if (overshoot >= 3) {
      // MEDIUM CONFIDENCE: 3-5¢ overshoot
      // → Trade reduced size
      placeLadder(shock, sizeMultiplier: 0.6);

    } else if (overshoot >= 0) {
      // LOW CONFIDENCE: <3¢ overshoot, markets roughly agree
      // → Skip trade
      log(`Skipping: Pinnacle agrees with Polymarket (${overshoot}¢ overshoot)`);
      return;

    } else {
      // NEGATIVE overshoot: Polymarket UNDERPRICED vs Pinnacle
      // → Definitely skip (the shock may be real or even understated)
      log(`Skipping: Polymarket underpriced vs Pinnacle (${overshoot}¢)`);
      return;
    }

  } else {
    // 3. FALLBACK: Pinnacle data unavailable
    // → Fall back to z-score only (current behavior)
    log('Pinnacle data unavailable, using z-score only');
    placeLadder(shock, sizeMultiplier: 0.5); // reduced confidence
  }
}
```

### Overshoot thresholds (tunable)

| Overshoot | Confidence | Action | Size Multiplier |
|-----------|-----------|--------|----------------|
| ≥ 5¢ | High | Trade | 1.0x |
| 3-5¢ | Medium | Trade | 0.6x |
| 0-3¢ | Low | Skip | 0x |
| < 0¢ | None | Skip | 0x |

These thresholds should be backtested and tuned. Start conservative (only trade ≥5¢ overshoot), then loosen as you collect data.

---

## 4. Credit Usage Estimation

### How credits work (The Odds API)

- 1 credit per API call per region per market
- We use: 1 region (`eu`) × 1 market (`h2h`) = **1 credit per call**
- The `/sports` endpoint is free

### Usage scenarios

| Scenario | Calls | Credits/session | Sessions/month (free) |
|----------|-------|-----------------|----------------------|
| **Reactive only** (on shock detection) | ~5-20 per session | 5-20 | 25-100 |
| **Polling every 30s** (3hr NBA session, 10 games) | 360 | 360 | 1.3 |
| **Polling every 60s** (3hr session) | 180 | 180 | 2.7 |
| **Polling every 30s** (paid $30/mo, 20K credits) | 360 | 360 | 55 (unlimited) |

### Recommendation

**Start with reactive mode:** Only call Pinnacle on shock detection (saves credits massively).

```
Free tier (500/mo): 
  - Reactive mode → 25-100 sessions/month (more than enough)
  - Polling mode → 1-2 sessions/month (tight)

$30/mo tier (20K/mo):
  - Any mode → unlimited for our usage
```

For live trading, reactive mode is ideal anyway — you only need Pinnacle's opinion when a shock is detected, not continuously. The 30-second cache handles rapid re-checks within the same shock window.

### Optimizing credit usage

1. **Cache aggressively:** 30s default, increase to 60s if credits are scarce
2. **Reactive-only mode:** Don't poll — only fetch on shock detection
3. **Pre-fetch on market open:** When subscribing to a new market, fetch odds once. Then only re-fetch on shocks.
4. **Batch sports:** If monitoring NBA + NHL simultaneously, each sport is a separate call. But with reactive mode this is minimal.

---

## 5. Files

| File | Description |
|------|-------------|
| `src/services/PinnacleOddsClient.ts` | Main client — fetching, caching, vig removal, fuzzy matching |
| `src/tools/test-pinnacle-odds.ts` | Test script — run with `npm run pinnacle:test` |
| `docs/PINNACLE_INTEGRATION.md` | This file |

---

## 6. Future Enhancements

- [ ] **odds-api.io support** — Add as secondary source for redundancy
- [ ] **Live odds WebSocket** — Some providers offer streaming; would eliminate polling
- [ ] **Multi-bookmaker consensus** — Use sharp book consensus (Pinnacle + Circa + Betcris) for even more accurate fair value
- [ ] **Historical overshoot tracking** — Log all Pinnacle-vs-Polymarket comparisons to tune thresholds
- [ ] **Draw/tie support** — NHL has draws in regulation; add 3-way market support for more accurate vig removal
- [ ] **Spread/totals markets** — Could use Pinnacle spreads to validate non-moneyline Polymarket markets
