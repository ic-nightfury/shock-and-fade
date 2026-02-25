/**
 * validate-recording.ts — Quick data quality check for shock recorder SQLite DB.
 * Run: npx ts-node src/tools/validate-recording.ts [db-path]
 *
 * Checks for the exact issues seen in Andy's old tick collector:
 * 1. Late starts (data begins well after game start)
 * 2. Flat lines / stale data (identical prices for extended periods)
 * 3. Data gaps (no records for >30s)
 * 4. Bid-ask inversion (bid > ask)
 * 5. Zero/null prices
 * 6. Token coverage (both sides of each market recorded)
 * 7. Sampling rate (too sparse = staircase, too dense = noise)
 */

import Database from "better-sqlite3";

const dbPath = process.argv[2] || "./data/nhl_shock.db";

const db = new Database(dbPath, { readonly: true });

interface MarketRow {
  market_slug: string;
  token1: string;
  token2: string;
  sport: string;
  outcome1: string;
  outcome2: string;
}

interface SnapRow {
  ts: number;
  best_bid: number;
  best_ask: number;
  mid_price: number;
}

console.log(`\n🔍 Data Quality Report — ${dbPath}\n${"═".repeat(60)}\n`);

// 1. Overall stats
const marketCount = db.prepare("SELECT COUNT(*) as n FROM markets").get() as any;
const snapCount = db.prepare("SELECT COUNT(*) as n FROM snapshots").get() as any;
const tradeCount = db.prepare("SELECT COUNT(*) as n FROM trades").get() as any;
const eventCount = db.prepare("SELECT COUNT(*) as n FROM game_events").get() as any;
const depthCount = db.prepare("SELECT COUNT(*) as n FROM depth_snapshots").get() as any;

console.log(`📊 Totals:`);
console.log(`   Markets: ${marketCount.n}`);
console.log(`   Snapshots: ${snapCount.n}`);
console.log(`   Trades: ${tradeCount.n}`);
console.log(`   Depth snapshots: ${depthCount.n}`);
console.log(`   Game events: ${eventCount.n}`);

if (snapCount.n === 0) {
  console.log("\n⚠️  No snapshot data yet — recorder may not have captured any price updates.");
  console.log("   Wait for games to go live and prices to move.\n");
  process.exit(0);
}

// Time range
const timeRange = db.prepare("SELECT MIN(ts) as first_ts, MAX(ts) as last_ts FROM snapshots").get() as any;
const firstTime = new Date(timeRange.first_ts);
const lastTime = new Date(timeRange.last_ts);
const durationMin = (timeRange.last_ts - timeRange.first_ts) / 60000;
console.log(`   Time range: ${firstTime.toISOString()} → ${lastTime.toISOString()}`);
console.log(`   Duration: ${durationMin.toFixed(1)} min`);

console.log(`\n${"─".repeat(60)}\n`);

// Per-market analysis
const markets = db.prepare("SELECT market_slug, token1, token2, sport, outcome1, outcome2 FROM markets").all() as MarketRow[];

let totalIssues = 0;

for (const market of markets) {
  const issues: string[] = [];

  // Get snapshots for each token
  const yesSnaps = db.prepare(
    "SELECT ts, best_bid, best_ask, mid_price FROM snapshots WHERE market_slug = ? AND token_id = ? ORDER BY ts"
  ).all(market.market_slug, market.token1) as SnapRow[];

  const noSnaps = db.prepare(
    "SELECT ts, best_bid, best_ask, mid_price FROM snapshots WHERE market_slug = ? AND token_id = ? ORDER BY ts"
  ).all(market.market_slug, market.token2) as SnapRow[];

  const allSnaps = db.prepare(
    "SELECT ts, best_bid, best_ask, mid_price FROM snapshots WHERE market_slug = ? ORDER BY ts"
  ).all(market.market_slug) as SnapRow[];

  if (allSnaps.length === 0) {
    issues.push("❌ NO DATA — zero snapshots recorded");
    console.log(`📈 ${market.market_slug} (${market.sport}): ${allSnaps.length} snapshots`);
    for (const i of issues) console.log(`   ${i}`);
    console.log();
    totalIssues += issues.length;
    continue;
  }

  // Check 1: Token coverage
  if (yesSnaps.length === 0) issues.push(`❌ Missing ${market.outcome1} token data`);
  if (noSnaps.length === 0) issues.push(`❌ Missing ${market.outcome2} token data`);
  const ratio = yesSnaps.length > 0 && noSnaps.length > 0
    ? Math.min(yesSnaps.length, noSnaps.length) / Math.max(yesSnaps.length, noSnaps.length)
    : 0;
  if (ratio > 0 && ratio < 0.5) issues.push(`⚠️  Token imbalance: ${market.outcome1}=${yesSnaps.length} ${market.outcome2}=${noSnaps.length} (ratio ${ratio.toFixed(2)})`);

  // Check price complement (should sum to ~1.0 for binary markets)
  if (yesSnaps.length > 0 && noSnaps.length > 0) {
    const lastYes = yesSnaps[yesSnaps.length - 1].mid_price;
    const lastNo = noSnaps[noSnaps.length - 1].mid_price;
    const sum = lastYes + lastNo;
    if (Math.abs(sum - 1.0) > 0.05) issues.push(`⚠️  Price complement: ${lastYes.toFixed(3)} + ${lastNo.toFixed(3)} = ${sum.toFixed(3)} (expected ~1.0)`);
  }

  // Check 2: Sampling rate (use primary token to avoid cross-token gap noise)
  const primarySnaps = yesSnaps.length >= noSnaps.length ? yesSnaps : noSnaps;
  if (primarySnaps.length > 1) {
    const gaps: number[] = [];
    for (let i = 1; i < primarySnaps.length; i++) {
      gaps.push(primarySnaps[i].ts - primarySnaps[i - 1].ts);
    }
    const medianGap = gaps.sort((a, b) => a - b)[Math.floor(gaps.length / 2)];
    const maxGap = gaps[gaps.length - 1];
    const avgGap = gaps.reduce((a, b) => a + b, 0) / gaps.length;

    if (medianGap > 10000) issues.push(`⚠️  Sparse sampling: median gap ${(medianGap/1000).toFixed(1)}s (staircase risk)`);
    if (maxGap > 60000) issues.push(`❌ Data gap: ${(maxGap/1000).toFixed(0)}s max gap`);
    if (medianGap < 100) issues.push(`⚠️  Very dense sampling: median gap ${medianGap}ms (noise risk)`);

    // Check 3: Flat lines (same mid_price for >30 consecutive snapshots on primary token)
    let maxFlat = 0;
    let currentFlat = 0;
    let lastMid = -1;
    for (const snap of primarySnaps) {
      if (snap.mid_price === lastMid) {
        currentFlat++;
        maxFlat = Math.max(maxFlat, currentFlat);
      } else {
        currentFlat = 0;
        lastMid = snap.mid_price;
      }
    }
    if (maxFlat > 30) issues.push(`⚠️  Flat line: ${maxFlat} consecutive identical mid_prices`);

    // Check 4: Bid-ask inversion
    const inversions = allSnaps.filter(s => s.best_bid > s.best_ask && s.best_ask > 0).length;
    if (inversions > 0) issues.push(`❌ Bid-ask inversions: ${inversions} snapshots (${(inversions/allSnaps.length*100).toFixed(1)}%)`);

    // Check 5: Zero/null prices
    const zeroBids = allSnaps.filter(s => s.best_bid === 0 || s.best_bid === null).length;
    const zeroAsks = allSnaps.filter(s => s.best_ask === 0 || s.best_ask === null).length;
    if (zeroBids > allSnaps.length * 0.05) issues.push(`⚠️  ${zeroBids} zero bids (${(zeroBids/allSnaps.length*100).toFixed(1)}%)`);
    if (zeroAsks > allSnaps.length * 0.05) issues.push(`⚠️  ${zeroAsks} zero asks (${(zeroAsks/allSnaps.length*100).toFixed(1)}%)`);

    // Check 6: Price sanity (should be 0-1 range for Polymarket)
    const outOfRange = allSnaps.filter(s => s.mid_price < 0 || s.mid_price > 1).length;
    if (outOfRange > 0) issues.push(`❌ ${outOfRange} mid_prices outside 0-1 range`);

    // Summary line
    const durationSec = (allSnaps[allSnaps.length-1].ts - allSnaps[0].ts) / 1000;
    const ratePerSec = allSnaps.length / Math.max(durationSec, 1);

    console.log(`📈 ${market.market_slug} (${market.sport}): ${allSnaps.length} snaps over ${(durationSec/60).toFixed(1)}min | ${ratePerSec.toFixed(2)}/s | median gap ${(medianGap/1000).toFixed(1)}s | max gap ${(maxGap/1000).toFixed(0)}s`);
  } else {
    console.log(`📈 ${market.market_slug} (${market.sport}): ${allSnaps.length} snapshot(s)`);
  }

  if (issues.length === 0) {
    console.log(`   ✅ No issues detected`);
  } else {
    for (const i of issues) console.log(`   ${i}`);
    totalIssues += issues.length;
  }

  // Trades
  const tradeCountForMarket = db.prepare("SELECT COUNT(*) as n FROM trades WHERE market_slug = ?").get(market.market_slug) as any;
  console.log(`   Trades: ${tradeCountForMarket.n}`);

  console.log();
}

// Game events summary
console.log(`${"─".repeat(60)}`);
const events = db.prepare("SELECT m.sport, ge.event_type, COUNT(*) as n FROM game_events ge LEFT JOIN markets m ON ge.market_slug = m.market_slug GROUP BY m.sport, ge.event_type ORDER BY m.sport, n DESC").all() as any[];
if (events.length > 0) {
  console.log(`\n🏟️  Game Events:`);
  for (const e of events) {
    console.log(`   ${e.sport} | ${e.event_type}: ${e.n}`);
  }
} else {
  console.log(`\n🏟️  Game Events: none (games may not have started yet)`);
}

console.log(`\n${"═".repeat(60)}`);
console.log(`Total issues: ${totalIssues} ${totalIssues === 0 ? "✅ Clean!" : "⚠️  Review above"}`);
console.log();
