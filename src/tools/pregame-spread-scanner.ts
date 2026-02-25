/**
 * pregame-spread-scanner.ts — Pre-Game Spread Scanner (Polymarket vs Pinnacle)
 *
 * Monitors upcoming sports games and alerts when Polymarket prices deviate from
 * Pinnacle fair value by a configured threshold (default: 2¢).
 *
 * Strategy (from Polymarket MM interview):
 *   - Use Pinnacle as "fair value" oracle
 *   - When Polymarket < Pinnacle fair by ≥2¢ → BUY on Polymarket (underpriced)
 *   - When Polymarket > Pinnacle fair by ≥2¢ → SELL on Polymarket (overpriced)
 *   - Hedge on sportsbook if exposure gets too large
 *
 * Example:
 *   Pinnacle fair value: Chiefs 64.5¢
 *   Polymarket best bid: 62¢
 *   Spread: -2.5¢ → BUY Chiefs on Polymarket (underpriced)
 *
 * Usage:
 *   npm run spread-scanner
 *   npm run spread-scanner -- --threshold=3 --sport=NBA --continuous
 */

import { PinnacleOddsClient, SupportedSport, PinnacleOdds } from '../services/PinnacleOddsClient';
import { OrderBookWS } from '../services/OrderBookWS';
import { SportsMarketDiscovery, SportsMarket, MarketState } from '../services/SportsMarketDiscovery';
import axios from 'axios';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

// ============================================================================
// TYPES
// ============================================================================

interface SpreadAlert {
  marketSlug: string;
  homeTeam: string;
  awayTeam: string;
  sport: SupportedSport;
  polymarketHome: number; // mid price 0-1
  polymarketAway: number; // mid price 0-1
  pinnacleFairHome: number; // 0-1
  pinnacleFairAway: number; // 0-1
  homeSpread: number; // cents (Polymarket - Pinnacle)
  awaySpread: number; // cents
  recommendation: 'BUY_HOME' | 'BUY_AWAY' | 'SELL_HOME' | 'SELL_AWAY' | 'NO_EDGE';
  edge: number; // absolute cents
  commenceTime: Date;
  lastUpdate: Date;
}

interface ScannerConfig {
  threshold: number; // minimum spread in cents (default: 2)
  sports: SupportedSport[]; // sports to monitor
  updateIntervalMs: number; // how often to scan (default: 60s)
  continuous: boolean; // keep running or one-shot
  minTimeToGameMin: number; // ignore games starting in < X minutes (default: 10)
  maxTimeToGameHours: number; // ignore games starting in > X hours (default: 48)
  verbose: boolean; // enable debug logging (default: false)
}

// ============================================================================
// SCANNER CLASS
// ============================================================================

export class PregameSpreadScanner {
  private pinnacle: PinnacleOddsClient;
  private discovery: SportsMarketDiscovery;
  private config: ScannerConfig;
  private isRunning = false;
  private scanCount = 0;
  private marketCache: Map<string, SportsMarket> = new Map();

  constructor(
    pinnacle: PinnacleOddsClient,
    discovery: SportsMarketDiscovery,
    config?: Partial<ScannerConfig>,
  ) {
    this.pinnacle = pinnacle;
    this.discovery = discovery;
    this.config = {
      threshold: config?.threshold ?? 2,
      sports: config?.sports ?? ['NBA', 'NFL', 'NHL'],
      updateIntervalMs: config?.updateIntervalMs ?? 60_000,
      continuous: config?.continuous ?? false,
      minTimeToGameMin: config?.minTimeToGameMin ?? 10,
      maxTimeToGameHours: config?.maxTimeToGameHours ?? 48,
      verbose: config?.verbose ?? false,
    };
  }

  // ==========================================================================
  // PUBLIC API
  // ==========================================================================

  async start(): Promise<void> {
    this.isRunning = true;
    this.log(`🚀 Starting pre-game spread scanner...`);
    this.log(`   Threshold: ${this.config.threshold}¢`);
    this.log(`   Sports: ${this.config.sports.join(', ')}`);
    this.log(`   Update interval: ${this.config.updateIntervalMs / 1000}s`);
    this.log(`   Continuous: ${this.config.continuous}`);

    while (this.isRunning) {
      await this.runScan();
      this.scanCount++;

      if (!this.config.continuous) break;

      await this.sleep(this.config.updateIntervalMs);
    }

    this.log('🛑 Scanner stopped');
  }

  stop(): void {
    this.isRunning = false;
  }

  // ==========================================================================
  // SCANNING LOGIC
  // ==========================================================================

  private async runScan(): Promise<void> {
    const startMs = Date.now();
    this.log(`📊 Scan #${this.scanCount + 1} started...`);

    const alerts: SpreadAlert[] = [];

    for (const sport of this.config.sports) {
      try {
        const sportAlerts = await this.scanSport(sport);
        alerts.push(...sportAlerts);
      } catch (err) {
        this.logError(`Failed to scan ${sport}`, err);
      }
    }

    const elapsedMs = Date.now() - startMs;
    this.log(`✅ Scan complete (${elapsedMs}ms) — found ${alerts.length} opportunities`);

    if (alerts.length > 0) {
      this.displayAlerts(alerts);
    }
  }

  private async scanSport(sport: SupportedSport): Promise<SpreadAlert[]> {
    // 1. Fetch Pinnacle odds for all upcoming games
    const pinnacleOdds = await this.pinnacle.getMoneylineOdds(sport);
    if (pinnacleOdds.length === 0) {
      this.log(`⚠️  No ${sport} odds from Pinnacle`);
      return [];
    }

    this.log(`📌 Pinnacle: ${pinnacleOdds.length} ${sport} games`);

    // 2. Filter by time window
    const now = Date.now();
    const minTime = now + this.config.minTimeToGameMin * 60_000;
    const maxTime = now + this.config.maxTimeToGameHours * 60 * 60_000;

    const upcoming = pinnacleOdds.filter((odds) => {
      const commenceMs = odds.commenceTime.getTime();
      return commenceMs >= minTime && commenceMs <= maxTime;
    });

    this.log(`   └─ ${upcoming.length} games in time window (${this.config.minTimeToGameMin}min - ${this.config.maxTimeToGameHours}h)`);

    // Get Polymarket markets for comparison
    const markets = this.discovery.getMarketsByState(MarketState.DISCOVERED);
    const sportMarkets = markets.filter(m => m.sport.toLowerCase() === sport.toLowerCase());
    this.log(`   └─ ${sportMarkets.length} Polymarket ${sport} markets`);

    // 3. For each game, fetch Polymarket orderbook and compare
    const alerts: SpreadAlert[] = [];

    for (const pinnOdds of upcoming) {
      try {
        const alert = await this.checkGame(sport, pinnOdds);
        if (alert) alerts.push(alert);
      } catch (err) {
        // Log errors in verbose mode (for debugging)
        // Uncomment to debug matching issues:
        // this.logError(`Failed to check ${pinnOdds.homeTeam} vs ${pinnOdds.awayTeam}`, err);
      }
    }

    return alerts;
  }

  private async checkGame(sport: SupportedSport, pinnOdds: PinnacleOdds): Promise<SpreadAlert | null> {
    // Find Polymarket market via team names + get token index mapping
    const result = await this.findPolymarketMarket(sport, pinnOdds.homeTeam, pinnOdds.awayTeam);
    if (!result) return null;

    const { market, homeTokenIndex, awayTokenIndex } = result;

    // Use market's current prices from Gamma API (last traded price)
    // NOT orderbook mid - sports markets trade via market orders, orderbook is misleading
    if (!market.outcomePrices || market.outcomePrices.length < 2) {
      if (this.config.verbose) {
        this.log(`⚠️  Market ${market.marketSlug} missing outcome prices`);
      }
      return null;
    }

    // Map to home/away using the token indices we determined earlier
    const homePrice = market.outcomePrices[homeTokenIndex];
    const awayPrice = market.outcomePrices[awayTokenIndex];

    if (isNaN(homePrice) || isNaN(awayPrice)) {
      if (this.config.verbose) {
        this.log(`⚠️  Invalid prices for ${market.marketSlug}: home=${homePrice}, away=${awayPrice}`);
      }
      return null;
    }

    // Skip if prices are obviously wrong (sum should be ~1.0)
    const priceSum = homePrice + awayPrice;
    if (priceSum < 0.95 || priceSum > 1.05) {
      if (this.config.verbose) {
        this.log(`⚠️  Invalid price sum for ${market.marketSlug}: ${priceSum.toFixed(2)} (expected ~1.0)`);
      }
      return null;
    }

    // Log prices in verbose mode
    if (this.config.verbose) {
      this.log(`📊 ${market.marketSlug}: Home ${pinnOdds.homeTeam} ${(homePrice * 100).toFixed(1)}¢, Away ${pinnOdds.awayTeam} ${(awayPrice * 100).toFixed(1)}¢`);
    }

    const homeMid = homePrice;
    const awayMid = awayPrice;

    // Compare to Pinnacle fair value
    const homeSpread = Math.round((homeMid - pinnOdds.homeFair) * 100);
    const awaySpread = Math.round((awayMid - pinnOdds.awayFair) * 100);

    // Determine if there's an edge
    let recommendation: SpreadAlert['recommendation'] = 'NO_EDGE';
    let edge = 0;

    if (homeSpread <= -this.config.threshold) {
      recommendation = 'BUY_HOME'; // Polymarket underpriced
      edge = Math.abs(homeSpread);
    } else if (homeSpread >= this.config.threshold) {
      recommendation = 'SELL_HOME'; // Polymarket overpriced
      edge = Math.abs(homeSpread);
    } else if (awaySpread <= -this.config.threshold) {
      recommendation = 'BUY_AWAY';
      edge = Math.abs(awaySpread);
    } else if (awaySpread >= this.config.threshold) {
      recommendation = 'SELL_AWAY';
      edge = Math.abs(awaySpread);
    }

    if (recommendation === 'NO_EDGE') return null;

    return {
      marketSlug: market.marketSlug,
      homeTeam: pinnOdds.homeTeam,
      awayTeam: pinnOdds.awayTeam,
      sport,
      polymarketHome: homeMid,
      polymarketAway: awayMid,
      pinnacleFairHome: pinnOdds.homeFair,
      pinnacleFairAway: pinnOdds.awayFair,
      homeSpread,
      awaySpread,
      recommendation,
      edge,
      commenceTime: pinnOdds.commenceTime,
      lastUpdate: new Date(),
    };
  }

  // ==========================================================================
  // POLYMARKET MARKET DISCOVERY
  // ==========================================================================

  /**
   * Find Polymarket market for a given Pinnacle game.
   * Uses cached SportsMarket data from discovery service.
   * Matches via market outcomes (team names).
   * 
   * Returns market + token index mapping (which outcome index = home vs away)
   */
  private async findPolymarketMarket(
    sport: SupportedSport,
    homeTeam: string,
    awayTeam: string,
  ): Promise<{ market: SportsMarket; homeTokenIndex: number; awayTokenIndex: number } | null> {
    // Get all pre-game (DISCOVERED) markets from discovery
    const markets = this.discovery.getMarketsByState(MarketState.DISCOVERED);
    
    // Filter by sport
    const sportLower = sport.toLowerCase();
    const sportMarkets = markets.filter(m => m.sport.toLowerCase() === sportLower);

    // Normalize Pinnacle team names (remove city, keep mascot)
    const homeNorm = this.normalizeTeamName(homeTeam);
    const awayNorm = this.normalizeTeamName(awayTeam);

    if (this.config.verbose) {
      this.log(`🔍 Searching for: ${homeTeam} (${homeNorm}) vs ${awayTeam} (${awayNorm})`);
    }

    // Try to match via outcomes (team names)
    for (const market of sportMarkets) {
      // Polymarket outcomes are like ["Bulls", "Nets"] or ["Phoenix Suns", "Dallas Mavericks"]
      if (market.outcomes.length < 2) continue;

      const outcome1 = market.outcomes[0];
      const outcome2 = market.outcomes[1];

      if (this.config.verbose) {
        this.log(`   Checking: ${market.marketSlug} → [${outcome1}, ${outcome2}]`);
      }

      // Check if outcomes match (in either order)
      const match1 = this.teamsMatch(homeNorm, outcome1) && this.teamsMatch(awayNorm, outcome2);
      const match2 = this.teamsMatch(homeNorm, outcome2) && this.teamsMatch(awayNorm, outcome1);

      if (match1) {
        // Home = outcome1 (index 0), Away = outcome2 (index 1)
        if (this.config.verbose) {
          this.log(`   ✅ MATCH: ${market.marketSlug} (home=${outcome1}[0], away=${outcome2}[1])`);
        }
        this.marketCache.set(market.marketSlug, market);
        return { market, homeTokenIndex: 0, awayTokenIndex: 1 };
      } else if (match2) {
        // Home = outcome2 (index 1), Away = outcome1 (index 0)
        if (this.config.verbose) {
          this.log(`   ✅ MATCH: ${market.marketSlug} (home=${outcome2}[1], away=${outcome1}[0])`);
        }
        this.marketCache.set(market.marketSlug, market);
        return { market, homeTokenIndex: 1, awayTokenIndex: 0 };
      }
    }

    if (this.config.verbose) {
      this.log(`   ❌ No match found`);
    }

    return null;
  }

  /**
   * Normalize team name: extract mascot/last word.
   * "Seattle Seahawks" → "seahawks"
   * "Los Angeles Lakers" → "lakers"
   * "Phoenix Suns" → "suns"
   */
  private normalizeTeamName(name: string): string {
    // Take last word (usually the mascot)
    const words = name.split(/\s+/);
    const lastWord = words[words.length - 1];
    return lastWord.toLowerCase().replace(/[^a-z]/g, '');
  }

  /**
   * Check if two normalized team names match.
   * Handles partial matches (e.g., "lakers" matches "lakers", "lal", "la lakers").
   */
  private teamsMatch(pinnacleNorm: string, polymarketOutcome: string): boolean {
    const pmLower = polymarketOutcome.toLowerCase();
    
    // Exact match
    if (pmLower === pinnacleNorm) return true;
    
    // Polymarket outcome contains Pinnacle mascot
    if (pmLower.includes(pinnacleNorm)) return true;
    
    // Pinnacle mascot contains Polymarket outcome (e.g., "suns" contains "sun")
    if (pinnacleNorm.includes(pmLower)) return true;
    
    // Check if any word in Polymarket outcome matches
    const pmWords = pmLower.split(/\s+/);
    if (pmWords.some(w => w === pinnacleNorm || pinnacleNorm.includes(w) || w.includes(pinnacleNorm))) {
      return true;
    }
    
    return false;
  }

  /**
   * Fetch orderbooks for both tokens in a market.
   * Returns [homeBook, awayBook] or [null, null] if fetch fails.
   */
  private async fetchOrderbooks(marketSlug: string): Promise<[any, any]> {
    const market = this.marketCache.get(marketSlug);
    if (!market || market.tokenIds.length < 2) {
      return [null, null];
    }

    try {
      // Fetch orderbook snapshots from CLOB API
      const [homeBook, awayBook] = await Promise.all([
        this.fetchOrderbook(market.tokenIds[0]),
        this.fetchOrderbook(market.tokenIds[1]),
      ]);

      return [homeBook, awayBook];
    } catch (err) {
      this.logError(`Failed to fetch orderbooks for ${marketSlug}`, err);
      return [null, null];
    }
  }

  /**
   * Fetch orderbook snapshot for a single token.
   */
  private async fetchOrderbook(tokenId: string): Promise<{ bids: { price: number }[]; asks: { price: number }[] }> {
    const url = `https://clob.polymarket.com/book?token_id=${tokenId}`;
    const res = await axios.get(url);
    
    const bids = (res.data.bids || []).map((b: any) => ({ price: parseFloat(b.price) }));
    const asks = (res.data.asks || []).map((a: any) => ({ price: parseFloat(a.price) }));
    
    return { bids, asks };
  }

  // ==========================================================================
  // DISPLAY
  // ==========================================================================

  private displayAlerts(alerts: SpreadAlert[]): void {
    console.log('\n' + '='.repeat(80));
    console.log('🎯 SPREAD OPPORTUNITIES');
    console.log('='.repeat(80));

    // Sort by edge (highest first)
    const sorted = alerts.sort((a, b) => b.edge - a.edge);

    for (const alert of sorted) {
      const action = this.getActionEmoji(alert.recommendation);
      const timeToGame = this.getTimeToGame(alert.commenceTime);
      const polymarketUrl = `https://polymarket.com/event/${alert.marketSlug}`;

      console.log(`\n${action} ${alert.sport} — ${alert.homeTeam} vs ${alert.awayTeam}`);
      console.log(`   Edge: ${alert.edge}¢ (${alert.recommendation.replace('_', ' ')})`);
      console.log(`   Polymarket: Home ${(alert.polymarketHome * 100).toFixed(1)}¢ / Away ${(alert.polymarketAway * 100).toFixed(1)}¢`);
      console.log(`   Pinnacle:   Home ${(alert.pinnacleFairHome * 100).toFixed(1)}¢ / Away ${(alert.pinnacleFairAway * 100).toFixed(1)}¢`);
      console.log(`   Spread:     Home ${alert.homeSpread >= 0 ? '+' : ''}${alert.homeSpread}¢ / Away ${alert.awaySpread >= 0 ? '+' : ''}${alert.awaySpread}¢`);
      console.log(`   Game time:  ${timeToGame}`);
      console.log(`   Market:     ${alert.marketSlug}`);
      console.log(`   Link:       ${polymarketUrl}`);
    }

    console.log('\n' + '='.repeat(80) + '\n');
  }

  private getActionEmoji(rec: SpreadAlert['recommendation']): string {
    switch (rec) {
      case 'BUY_HOME':
      case 'BUY_AWAY':
        return '🟢 BUY';
      case 'SELL_HOME':
      case 'SELL_AWAY':
        return '🔴 SELL';
      default:
        return '⚪';
    }
  }

  private getTimeToGame(commenceTime: Date): string {
    const now = Date.now();
    const diffMs = commenceTime.getTime() - now;
    const diffMin = Math.floor(diffMs / 60_000);
    const diffHours = Math.floor(diffMin / 60);

    if (diffMin < 60) return `${diffMin} minutes`;
    if (diffHours < 24) return `${diffHours} hours`;
    return `${Math.floor(diffHours / 24)} days`;
  }

  // ==========================================================================
  // UTILS
  // ==========================================================================

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private log(message: string): void {
    const ts = new Date().toISOString();
    console.log(`${ts} [INFO] 📡 [SpreadScanner] ${message}`);
  }

  private logError(message: string, err: unknown): void {
    const ts = new Date().toISOString();
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error(`${ts} [ERROR] 📡 [SpreadScanner] ${message}: ${errMsg}`);
  }
}

// ============================================================================
// CLI
// ============================================================================

async function main() {
  const args = process.argv.slice(2);
  const threshold = parseInt(args.find((a) => a.startsWith('--threshold='))?.split('=')[1] ?? '2', 10);
  const sportArg = args.find((a) => a.startsWith('--sport='))?.split('=')[1];
  const continuous = args.includes('--continuous');
  const verbose = args.includes('--verbose');

  // Default to all major US sports (NBA, NFL, NHL) - user can override with --sport=X
  const sports: SupportedSport[] = sportArg
    ? [sportArg as SupportedSport]
    : ['NBA', 'NFL', 'NHL'];

  console.log('🚀 Initializing services...');
  console.log('⚠️  Spread scanner uses ISOLATED market discovery (does NOT affect shock-and-fade settings)');

  const pinnacle = new PinnacleOddsClient();
  
  // Create isolated discovery instance with ALL sports enabled
  // This is completely separate from shock-and-fade's discovery (which uses config file)
  const allSports = ['NBA', 'NFL', 'NHL', 'MLB', 'CBB', 'CFB', 'EPL', 'UCL', 'LAL', 'BUN', 'SEA', 'FL1'];
  const discovery = new SportsMarketDiscovery(
    5 * 60 * 1000, // 5 minute polling
    { enabled_sports: allSports } // Config override - completely isolated from shock-and-fade
  );

  // Start market discovery (this populates the market cache)
  console.log(`📡 Starting market discovery for spread scanner...`);
  console.log(`   Sports tracked: ${allSports.join(', ')}`);
  await discovery.start();
  
  // Wait a moment for initial markets to load
  await new Promise(resolve => setTimeout(resolve, 5000));
  console.log(`✅ Discovery loaded ${discovery.getMarkets().length} total markets (${discovery.getMarketsByState(MarketState.DISCOVERED).length} pre-game)\n`);

  const scanner = new PregameSpreadScanner(pinnacle, discovery, {
    threshold,
    sports,
    continuous,
    verbose,
  });

  // Handle Ctrl+C
  process.on('SIGINT', async () => {
    console.log('\n🛑 Stopping scanner...');
    scanner.stop();
    await discovery.stop();
    process.exit(0);
  });

  await scanner.start();
}

if (require.main === module) {
  main().catch((err) => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
}
