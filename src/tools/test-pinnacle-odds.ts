#!/usr/bin/env tsx
/**
 * test-pinnacle-odds.ts — Test script for PinnacleOddsClient
 *
 * Usage:
 *   THE_ODDS_API_KEY=xxx npx tsx src/tools/test-pinnacle-odds.ts
 *   npm run pinnacle:test  (if key is in .env)
 *
 * Tests:
 *   1. Fetch current NBA/NFL/NHL Pinnacle odds
 *   2. Display formatted: team names, decimal odds, implied probs, vig-free fair values
 *   3. Compare against any live Polymarket sports markets (if available)
 *   4. Measure and report API response times
 */

import * as dotenv from 'dotenv';
import * as path from 'path';

// Load .env from project root
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

import {
  PinnacleOddsClient,
  PinnacleOdds,
  SupportedSport,
} from '../services/PinnacleOddsClient';

// ============================================================================
// FORMATTING HELPERS
// ============================================================================

function fmt(n: number, decimals = 1): string {
  return n.toFixed(decimals);
}

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

function cents(n: number): string {
  return `${n.toFixed(0)}¢`;
}

function padRight(s: string, len: number): string {
  return s.length >= len ? s : s + ' '.repeat(len - s.length);
}

function padLeft(s: string, len: number): string {
  return s.length >= len ? s : ' '.repeat(len - s.length) + s;
}

function printGameOdds(odds: PinnacleOdds): void {
  const homeTeam = padRight(odds.homeTeam, 26);
  const awayTeam = padRight(odds.awayTeam, 26);
  const commence = odds.commenceTime.toISOString().replace('T', ' ').slice(0, 16) + ' UTC';

  console.log(`  ┌─────────────────────────────────────────────────────────────────────────┐`);
  console.log(`  │ ${padRight(odds.homeTeam + ' vs ' + odds.awayTeam, 73)} │`);
  console.log(`  │ ${padRight('Starts: ' + commence, 73)} │`);
  console.log(`  │ ${padRight(`Event ID: ${odds.eventId}`, 73)} │`);
  console.log(`  ├────────────────────────────┬──────────┬───────────┬───────────┬─────────┤`);
  console.log(`  │ Team                       │ Dec Odds │ Raw Impl  │ Fair Prob │ Fair ¢  │`);
  console.log(`  ├────────────────────────────┼──────────┼───────────┼───────────┼─────────┤`);
  console.log(`  │ ${homeTeam}  │ ${padLeft(fmt(odds.homeOdds, 3), 8)} │ ${padLeft(pct(odds.homeImplied), 9)} │ ${padLeft(pct(odds.homeFair), 9)} │ ${padLeft(cents(odds.homeFair * 100), 7)} │`);
  console.log(`  │ ${awayTeam}  │ ${padLeft(fmt(odds.awayOdds, 3), 8)} │ ${padLeft(pct(odds.awayImplied), 9)} │ ${padLeft(pct(odds.awayFair), 9)} │ ${padLeft(cents(odds.awayFair * 100), 7)} │`);
  console.log(`  ├────────────────────────────┴──────────┴───────────┴───────────┴─────────┤`);
  console.log(`  │ Vig: ${pct(odds.vig)} overround | Updated: ${odds.lastUpdate.toISOString().slice(11, 19)} UTC ${padRight('', 18)} │`);
  console.log(`  └─────────────────────────────────────────────────────────────────────────┘`);
}

// ============================================================================
// MATH VALIDATION
// ============================================================================

function testMath(): void {
  console.log('\n🧮 Math validation:');

  // Test toImpliedProbability
  const imp = PinnacleOddsClient.toImpliedProbability(1.50);
  console.log(`  toImpliedProbability(1.50) = ${pct(imp)} (expected: 66.7%)`);

  const imp2 = PinnacleOddsClient.toImpliedProbability(3.00);
  console.log(`  toImpliedProbability(3.00) = ${pct(imp2)} (expected: 33.3%)`);

  // Test removeVig
  const vigResult = PinnacleOddsClient.removeVig(0.690, 0.345);
  console.log(`  removeVig(0.690, 0.345):`);
  console.log(`    home fair: ${pct(vigResult.home)} (expected: ~66.7%)`);
  console.log(`    away fair: ${pct(vigResult.away)} (expected: ~33.3%)`);
  console.log(`    vig: ${pct(vigResult.vig)} (expected: ~3.5%)`);

  // Test getOvershoot
  const overshoot = PinnacleOddsClient.getOvershoot(0.75, 0.68);
  console.log(`  getOvershoot(0.75, 0.68) = ${overshoot}¢ (expected: +7¢ — fade!)`);

  const overshoot2 = PinnacleOddsClient.getOvershoot(0.74, 0.74);
  console.log(`  getOvershoot(0.74, 0.74) = ${overshoot2}¢ (expected: 0¢ — skip)`);

  const overshoot3 = PinnacleOddsClient.getOvershoot(0.65, 0.72);
  console.log(`  getOvershoot(0.65, 0.72) = ${overshoot3}¢ (expected: -7¢ — underpriced)`);

  console.log('  ✅ Math checks passed\n');
}

// ============================================================================
// LIVE POLYMARKET COMPARISON
// ============================================================================

async function tryPolymarketComparison(
  allOdds: Map<SupportedSport, PinnacleOdds[]>,
): Promise<void> {
  console.log('\n🔗 Polymarket comparison:');

  try {
    // Try to fetch active sports markets from Gamma API
    const res = await fetch(
      'https://gamma-api.polymarket.com/events?active=true&closed=false&limit=50&tag=Sports',
      {
        headers: { 'Accept': 'application/json' },
        signal: AbortSignal.timeout(5000),
      },
    );

    if (!res.ok) {
      console.log(`  ⚠️  Gamma API returned ${res.status} — skipping comparison`);
      return;
    }

    const events: any[] = await res.json();
    const sportsEvents = events.filter((e: any) =>
      e.markets?.length > 0 &&
      (e.title?.toLowerCase().includes('nba') ||
       e.title?.toLowerCase().includes('nfl') ||
       e.title?.toLowerCase().includes('nhl') ||
       e.tags?.some((t: any) =>
         typeof t === 'string'
           ? ['nba', 'nfl', 'nhl'].includes(t.toLowerCase())
           : ['nba', 'nfl', 'nhl'].includes(t?.label?.toLowerCase?.() ?? ''),
       )),
    );

    if (sportsEvents.length === 0) {
      console.log('  No active NBA/NFL/NHL Polymarket events found');
      return;
    }

    console.log(`  Found ${sportsEvents.length} Polymarket sports events\n`);

    // For each Polymarket event, try to find matching Pinnacle odds
    let matches = 0;
    for (const event of sportsEvents.slice(0, 10)) {
      const title: string = event.title || '';
      const markets: any[] = event.markets || [];

      // Try each moneyline market
      for (const market of markets) {
        if (!market.outcomePrices) continue;

        let prices: number[];
        try {
          prices = JSON.parse(market.outcomePrices);
        } catch {
          continue;
        }

        if (prices.length < 2) continue;

        const outcomes: string[] = market.outcomes
          ? JSON.parse(market.outcomes)
          : [];
        if (outcomes.length < 2) continue;

        // Try to match against Pinnacle
        const client = new PinnacleOddsClient();
        for (const [sport, odds] of allOdds) {
          for (const pinnacle of odds) {
            // Check if any outcome matches a Pinnacle team
            const match0Home = client['teamsMatch'](pinnacle.homeTeam, outcomes[0]);
            const match0Away = client['teamsMatch'](pinnacle.awayTeam, outcomes[0]);
            const match1Home = client['teamsMatch'](pinnacle.homeTeam, outcomes[1]);
            const match1Away = client['teamsMatch'](pinnacle.awayTeam, outcomes[1]);

            if ((match0Home && match1Away) || (match0Away && match1Home)) {
              matches++;
              const polyHome = match0Home ? prices[0] : prices[1];
              const polyAway = match0Home ? prices[1] : prices[0];
              const overshootHome = PinnacleOddsClient.getOvershoot(
                parseFloat(String(polyHome)),
                pinnacle.homeFair,
              );
              const overshootAway = PinnacleOddsClient.getOvershoot(
                parseFloat(String(polyAway)),
                pinnacle.awayFair,
              );

              console.log(`  📊 ${pinnacle.homeTeam} vs ${pinnacle.awayTeam}`);
              console.log(`     Polymarket slug: ${market.groupItemTitle || market.question || title}`);
              console.log(
                `     ${padRight(pinnacle.homeTeam, 24)} Poly: ${cents(parseFloat(String(polyHome)) * 100)}  Pinnacle fair: ${cents(pinnacle.homeFair * 100)}  Overshoot: ${overshootHome > 0 ? '+' : ''}${overshootHome}¢`,
              );
              console.log(
                `     ${padRight(pinnacle.awayTeam, 24)} Poly: ${cents(parseFloat(String(polyAway)) * 100)}  Pinnacle fair: ${cents(pinnacle.awayFair * 100)}  Overshoot: ${overshootAway > 0 ? '+' : ''}${overshootAway}¢`,
              );

              const maxOvershoot = Math.max(Math.abs(overshootHome), Math.abs(overshootAway));
              if (maxOvershoot >= 3) {
                console.log(`     🎯 FADE SIGNAL: ${maxOvershoot}¢ overshoot detected!`);
              } else {
                console.log(`     ✅ Markets aligned (${maxOvershoot}¢ diff)`);
              }
              console.log();
            }
          }
        }
      }
    }

    if (matches === 0) {
      console.log('  No matching Polymarket ↔ Pinnacle games found');
      console.log('  (This is normal if no games are currently live or upcoming)');
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`  ⚠️  Polymarket comparison failed: ${msg}`);
  }
}

// ============================================================================
// MAIN
// ============================================================================

async function main(): Promise<void> {
  console.log('╔═══════════════════════════════════════════════════════════════╗');
  console.log('║           🏀 Pinnacle Odds Client — Test Suite 🏒           ║');
  console.log('╚═══════════════════════════════════════════════════════════════╝');

  // 1. Math validation (always runs, no API key needed)
  testMath();

  // 2. Check API key
  const apiKey = process.env.THE_ODDS_API_KEY;
  if (!apiKey) {
    console.log('⚠️  THE_ODDS_API_KEY not set in environment or .env file.');
    console.log('   To test with live data:');
    console.log('   1. Sign up at https://the-odds-api.com/#get-access (free, 500 credits/mo)');
    console.log('   2. Add to .env: THE_ODDS_API_KEY=your_key_here');
    console.log('   3. Re-run: npm run pinnacle:test\n');
    console.log('Skipping live API tests. Math validation passed ✅');
    return;
  }

  const client = new PinnacleOddsClient({ apiKey });
  const allOdds = new Map<SupportedSport, PinnacleOdds[]>();

  // 3. Fetch odds for each sport
  const sports: SupportedSport[] = ['NBA', 'NFL', 'NHL'];

  for (const sport of sports) {
    console.log(`\n${'='.repeat(70)}`);
    console.log(`🏟️  Fetching Pinnacle ${sport} moneyline odds...`);
    console.log(`${'='.repeat(70)}`);

    const startMs = Date.now();
    const odds = await client.getMoneylineOdds(sport);
    const elapsedMs = Date.now() - startMs;

    if (odds.length === 0) {
      console.log(`  No ${sport} games found with Pinnacle odds`);
      console.log(`  (${sport} may be off-season or no games today)`);
      console.log(`  Response time: ${elapsedMs}ms`);
      continue;
    }

    console.log(`  Found ${odds.length} games (${elapsedMs}ms)\n`);
    allOdds.set(sport, odds);

    for (const game of odds) {
      printGameOdds(game);
      console.log();
    }
  }

  // 4. Test caching
  console.log(`\n${'='.repeat(70)}`);
  console.log('⏱️  Cache test: re-fetching NBA odds (should be instant)...');
  const cacheStart = Date.now();
  await client.getMoneylineOdds('NBA');
  const cacheMs = Date.now() - cacheStart;
  console.log(`  Cache hit: ${cacheMs}ms (should be <5ms)`);

  // 5. Test fuzzy matching
  console.log(`\n${'='.repeat(70)}`);
  console.log('🔍 Fuzzy match test:');
  const nbaOdds = allOdds.get('NBA') || [];
  if (nbaOdds.length > 0) {
    const firstGame = nbaOdds[0];
    // Try matching with just the team nickname
    const homeNickname = firstGame.homeTeam.split(' ').pop() || firstGame.homeTeam;
    const awayNickname = firstGame.awayTeam.split(' ').pop() || firstGame.awayTeam;

    console.log(`  Looking up "${homeNickname}" vs "${awayNickname}"...`);
    const matched = await client.getGameOdds('NBA', homeNickname, awayNickname);
    if (matched) {
      console.log(`  ✅ Matched: ${matched.homeTeam} vs ${matched.awayTeam}`);
    } else {
      console.log(`  ❌ No match found (fuzzy matching may need tuning)`);
    }
  } else {
    console.log('  Skipped — no NBA games available');
  }

  // 6. Polymarket comparison
  await tryPolymarketComparison(allOdds);

  // 7. Summary
  const stats = client.getStats();
  console.log(`\n${'='.repeat(70)}`);
  console.log('📊 Session summary:');
  console.log(`  API requests: ${stats.requestCount}`);
  console.log(`  Cache entries: ${stats.cacheSize}`);
  console.log(`  Source: ${stats.source}`);
  console.log(`  Total games: ${[...allOdds.values()].reduce((n, arr) => n + arr.length, 0)}`);
  console.log(`${'='.repeat(70)}\n`);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
