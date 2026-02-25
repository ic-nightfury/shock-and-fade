/**
 * PinnacleOddsClient - Fetches Pinnacle sportsbook moneyline odds via third-party APIs.
 *
 * Uses Pinnacle odds as a "fair value" anchor to validate Polymarket price shocks.
 * If Polymarket spikes to 75¢ but Pinnacle implies 68¢ → high-confidence fade (7¢ overshoot).
 * If Polymarket and Pinnacle both show 74¢ → shock is real → skip.
 *
 * Data sources (configurable):
 *   - The Odds API (the-odds-api.com) — primary, free tier 500 credits/mo
 *   - odds-api.io — secondary, paid only (£99/mo+)
 *
 * Key features:
 *   - 30-second cache to conserve API credits
 *   - Vig removal via multiplicative method
 *   - Fuzzy team name matching (Polymarket "Seahawks" ↔ Pinnacle "Seattle Seahawks")
 *   - Graceful degradation — logs warnings but never blocks trading
 */

// ============================================================================
// TYPES & INTERFACES
// ============================================================================

export interface PinnacleOdds {
  homeTeam: string;
  awayTeam: string;
  homeOdds: number; // decimal odds (e.g., 1.45)
  awayOdds: number; // decimal odds (e.g., 2.90)
  homeImplied: number; // implied probability 0-1 (with vig)
  awayImplied: number; // implied probability 0-1 (with vig)
  homeFair: number; // vig-removed fair probability 0-1
  awayFair: number; // vig-removed fair probability 0-1
  vig: number; // total overround (e.g., 0.025 = 2.5%)
  lastUpdate: Date;
  source: 'the-odds-api' | 'odds-api-io';
  sportKey: string; // e.g., 'basketball_nba'
  eventId: string; // upstream event identifier
  commenceTime: Date;
}

export type SupportedSport = 'NBA' | 'NFL' | 'NHL';

interface CachedOdds {
  data: PinnacleOdds[];
  fetchedAt: number;
}

interface OddsApiConfig {
  source: 'the-odds-api' | 'odds-api-io';
  apiKey: string;
  cacheTtlMs: number;
}

// ============================================================================
// SPORT KEY MAPPING
// ============================================================================

const SPORT_KEYS: Record<SupportedSport, string> = {
  NBA: 'basketball_nba',
  NFL: 'americanfootball_nfl',
  NHL: 'icehockey_nhl',
};

// ============================================================================
// TEAM NAME ALIASES (Polymarket short names → common variants)
// ============================================================================

const TEAM_ALIASES: Record<string, string[]> = {
  // NBA
  'Hawks': ['Atlanta Hawks', 'Hawks', 'ATL'],
  'Celtics': ['Boston Celtics', 'Celtics', 'BOS'],
  'Nets': ['Brooklyn Nets', 'Nets', 'BKN'],
  'Hornets': ['Charlotte Hornets', 'Hornets', 'CHA'],
  'Bulls': ['Chicago Bulls', 'Bulls', 'CHI'],
  'Cavaliers': ['Cleveland Cavaliers', 'Cavaliers', 'Cavs', 'CLE'],
  'Mavericks': ['Dallas Mavericks', 'Mavericks', 'Mavs', 'DAL'],
  'Nuggets': ['Denver Nuggets', 'Nuggets', 'DEN'],
  'Pistons': ['Detroit Pistons', 'Pistons', 'DET'],
  'Warriors': ['Golden State Warriors', 'Warriors', 'GSW', 'GS'],
  'Rockets': ['Houston Rockets', 'Rockets', 'HOU'],
  'Pacers': ['Indiana Pacers', 'Pacers', 'IND'],
  'Clippers': ['LA Clippers', 'Los Angeles Clippers', 'Clippers', 'LAC'],
  'Lakers': ['Los Angeles Lakers', 'LA Lakers', 'Lakers', 'LAL'],
  'Grizzlies': ['Memphis Grizzlies', 'Grizzlies', 'MEM'],
  'Heat': ['Miami Heat', 'Heat', 'MIA'],
  'Bucks': ['Milwaukee Bucks', 'Bucks', 'MIL'],
  'Timberwolves': ['Minnesota Timberwolves', 'Timberwolves', 'Wolves', 'MIN'],
  'Pelicans': ['New Orleans Pelicans', 'Pelicans', 'NOP', 'NO'],
  'Knicks': ['New York Knicks', 'Knicks', 'NYK', 'NY'],
  'Thunder': ['Oklahoma City Thunder', 'Thunder', 'OKC'],
  'Magic': ['Orlando Magic', 'Magic', 'ORL'],
  '76ers': ['Philadelphia 76ers', 'Sixers', '76ers', 'PHI'],
  'Suns': ['Phoenix Suns', 'Suns', 'PHX'],
  'Trail Blazers': ['Portland Trail Blazers', 'Trail Blazers', 'Blazers', 'POR'],
  'Kings': ['Sacramento Kings', 'Kings', 'SAC'],
  'Spurs': ['San Antonio Spurs', 'Spurs', 'SAS', 'SA'],
  'Raptors': ['Toronto Raptors', 'Raptors', 'TOR'],
  'Jazz': ['Utah Jazz', 'Jazz', 'UTA'],
  'Wizards': ['Washington Wizards', 'Wizards', 'WAS'],

  // NFL
  'Cardinals': ['Arizona Cardinals', 'Cardinals', 'ARI'],
  'Falcons': ['Atlanta Falcons', 'Falcons', 'ATL Falcons'],
  'Ravens': ['Baltimore Ravens', 'Ravens', 'BAL'],
  'Bills': ['Buffalo Bills', 'Bills', 'BUF'],
  'Panthers': ['Carolina Panthers', 'Panthers', 'CAR'],
  'Bears': ['Chicago Bears', 'Bears', 'CHI Bears'],
  'Bengals': ['Cincinnati Bengals', 'Bengals', 'CIN'],
  'Browns': ['Cleveland Browns', 'Browns', 'CLE Browns'],
  'Cowboys': ['Dallas Cowboys', 'Cowboys', 'DAL Cowboys'],
  'Broncos': ['Denver Broncos', 'Broncos', 'DEN Broncos'],
  'Lions': ['Detroit Lions', 'Lions', 'DET Lions'],
  'Packers': ['Green Bay Packers', 'Packers', 'GB'],
  'Texans': ['Houston Texans', 'Texans', 'HOU Texans'],
  'Colts': ['Indianapolis Colts', 'Colts', 'IND Colts'],
  'Jaguars': ['Jacksonville Jaguars', 'Jaguars', 'Jags', 'JAX'],
  'Chiefs': ['Kansas City Chiefs', 'Chiefs', 'KC'],
  'Raiders': ['Las Vegas Raiders', 'Raiders', 'LV'],
  'Chargers': ['Los Angeles Chargers', 'LA Chargers', 'Chargers', 'LAC Chargers'],
  'Rams': ['Los Angeles Rams', 'LA Rams', 'Rams', 'LAR'],
  'Dolphins': ['Miami Dolphins', 'Dolphins', 'MIA Dolphins'],
  'Vikings': ['Minnesota Vikings', 'Vikings', 'MIN Vikings'],
  'Patriots': ['New England Patriots', 'Patriots', 'Pats', 'NE'],
  'Saints': ['New Orleans Saints', 'Saints', 'NO Saints'],
  'Giants': ['New York Giants', 'Giants', 'NYG'],
  'Jets': ['New York Jets', 'Jets', 'NYJ'],
  'Eagles': ['Philadelphia Eagles', 'Eagles', 'PHI Eagles'],
  'Steelers': ['Pittsburgh Steelers', 'Steelers', 'PIT'],
  '49ers': ['San Francisco 49ers', '49ers', 'Niners', 'SF'],
  'Seahawks': ['Seattle Seahawks', 'Seahawks', 'SEA'],
  'Buccaneers': ['Tampa Bay Buccaneers', 'Buccaneers', 'Bucs', 'TB'],
  'Titans': ['Tennessee Titans', 'Titans', 'TEN'],
  'Commanders': ['Washington Commanders', 'Commanders', 'WSH', 'WAS Commanders'],

  // NHL
  'Ducks': ['Anaheim Ducks', 'Ducks', 'ANA'],
  'Coyotes': ['Arizona Coyotes', 'Utah Hockey Club', 'Coyotes', 'ARI Coyotes', 'Utah HC'],
  'Bruins': ['Boston Bruins', 'Bruins', 'BOS Bruins'],
  'Sabres': ['Buffalo Sabres', 'Sabres', 'BUF Sabres'],
  'Flames': ['Calgary Flames', 'Flames', 'CGY'],
  'Hurricanes': ['Carolina Hurricanes', 'Hurricanes', 'Canes', 'CAR'],
  'Blackhawks': ['Chicago Blackhawks', 'Blackhawks', 'CHI Blackhawks'],
  'Avalanche': ['Colorado Avalanche', 'Avalanche', 'Avs', 'COL'],
  'Blue Jackets': ['Columbus Blue Jackets', 'Blue Jackets', 'CBJ'],
  'Stars': ['Dallas Stars', 'Stars', 'DAL Stars'],
  'Red Wings': ['Detroit Red Wings', 'Red Wings', 'DET Red Wings'],
  'Oilers': ['Edmonton Oilers', 'Oilers', 'EDM'],
  'Panthers (NHL)': ['Florida Panthers', 'Panthers', 'FLA'],
  'Canadiens': ['Montreal Canadiens', 'Canadiens', 'Habs', 'MTL'],
  'Predators': ['Nashville Predators', 'Predators', 'Preds', 'NSH'],
  'Devils': ['New Jersey Devils', 'Devils', 'NJD', 'NJ'],
  'Islanders': ['New York Islanders', 'Islanders', 'NYI'],
  'Rangers': ['New York Rangers', 'Rangers', 'NYR'],
  'Senators': ['Ottawa Senators', 'Senators', 'Sens', 'OTT'],
  'Flyers': ['Philadelphia Flyers', 'Flyers', 'PHI Flyers'],
  'Penguins': ['Pittsburgh Penguins', 'Penguins', 'Pens', 'PIT Penguins'],
  'Sharks': ['San Jose Sharks', 'Sharks', 'SJS', 'SJ'],
  'Kraken': ['Seattle Kraken', 'Kraken', 'SEA Kraken'],
  'Blues': ['St Louis Blues', 'St. Louis Blues', 'Blues', 'STL'],
  'Lightning': ['Tampa Bay Lightning', 'Lightning', 'Bolts', 'TBL', 'TB Lightning'],
  'Maple Leafs': ['Toronto Maple Leafs', 'Maple Leafs', 'Leafs', 'TOR Leafs'],
  'Canucks': ['Vancouver Canucks', 'Canucks', 'VAN'],
  'Golden Knights': ['Vegas Golden Knights', 'Golden Knights', 'VGK'],
  'Capitals': ['Washington Capitals', 'Capitals', 'Caps', 'WSH Capitals'],
  'Jets (NHL)': ['Winnipeg Jets', 'Jets', 'WPG'],
  'Wild': ['Minnesota Wild', 'Wild', 'MIN Wild'],
};

// Build reverse lookup: any alias → canonical key
const ALIAS_REVERSE = new Map<string, string>();
for (const [canonical, aliases] of Object.entries(TEAM_ALIASES)) {
  for (const alias of aliases) {
    ALIAS_REVERSE.set(alias.toLowerCase(), canonical);
  }
  ALIAS_REVERSE.set(canonical.toLowerCase(), canonical);
}

// ============================================================================
// PINNACLE ODDS CLIENT
// ============================================================================

export class PinnacleOddsClient {
  private config: OddsApiConfig;
  private cache: Map<string, CachedOdds> = new Map();
  private requestCount = 0;
  private lastRequestTime = 0;

  constructor(config?: Partial<OddsApiConfig>) {
    this.config = {
      source: config?.source ?? 'the-odds-api',
      apiKey: config?.apiKey ?? process.env.THE_ODDS_API_KEY ?? '',
      cacheTtlMs: config?.cacheTtlMs ?? 30_000, // 30s default
    };

    if (!this.config.apiKey) {
      this.log('⚠️  No API key configured! Set THE_ODDS_API_KEY env var.');
      this.log('   Sign up at https://the-odds-api.com/#get-access (free tier: 500 credits/mo)');
    }
  }

  // ==========================================================================
  // PUBLIC API
  // ==========================================================================

  /**
   * Fetch current Pinnacle moneyline odds for a sport.
   * Returns vig-removed fair probabilities alongside raw odds.
   */
  async getMoneylineOdds(sport: SupportedSport): Promise<PinnacleOdds[]> {
    const sportKey = SPORT_KEYS[sport];
    const cacheKey = `moneyline:${sportKey}`;

    // Check cache
    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() - cached.fetchedAt < this.config.cacheTtlMs) {
      return cached.data;
    }

    // Fetch from API
    try {
      const odds = await this.fetchFromTheOddsApi(sportKey);
      this.cache.set(cacheKey, { data: odds, fetchedAt: Date.now() });
      return odds;
    } catch (err) {
      this.logError(`Failed to fetch ${sport} odds`, err);
      // Return stale cache if available
      if (cached) {
        this.log(`⚠️  Returning stale cache (${((Date.now() - cached.fetchedAt) / 1000).toFixed(0)}s old)`);
        return cached.data;
      }
      return [];
    }
  }

  /**
   * Find odds for a specific game via fuzzy team name matching.
   * Both homeTeam and awayTeam are matched against the odds data.
   */
  async getGameOdds(
    sport: SupportedSport,
    homeTeam: string,
    awayTeam: string,
  ): Promise<PinnacleOdds | null> {
    const allOdds = await this.getMoneylineOdds(sport);
    if (allOdds.length === 0) return null;

    // Try exact match first, then fuzzy
    for (const odds of allOdds) {
      if (
        this.teamsMatch(odds.homeTeam, homeTeam) &&
        this.teamsMatch(odds.awayTeam, awayTeam)
      ) {
        return odds;
      }
    }

    // Try reversed (in case home/away is swapped)
    for (const odds of allOdds) {
      if (
        this.teamsMatch(odds.homeTeam, awayTeam) &&
        this.teamsMatch(odds.awayTeam, homeTeam)
      ) {
        // Swap home/away to match caller's perspective
        return {
          ...odds,
          homeTeam: odds.awayTeam,
          awayTeam: odds.homeTeam,
          homeOdds: odds.awayOdds,
          awayOdds: odds.homeOdds,
          homeImplied: odds.awayImplied,
          awayImplied: odds.homeImplied,
          homeFair: odds.awayFair,
          awayFair: odds.homeFair,
        };
      }
    }

    // Single-team search as fallback (e.g., only know one team)
    for (const odds of allOdds) {
      if (
        this.teamsMatch(odds.homeTeam, homeTeam) ||
        this.teamsMatch(odds.awayTeam, awayTeam) ||
        this.teamsMatch(odds.homeTeam, awayTeam) ||
        this.teamsMatch(odds.awayTeam, homeTeam)
      ) {
        return odds;
      }
    }

    return null;
  }

  // ==========================================================================
  // STATIC MATH UTILITIES
  // ==========================================================================

  /**
   * Convert decimal odds to implied probability.
   * e.g., 1.50 → 0.6667 (66.67%)
   */
  static toImpliedProbability(decimalOdds: number): number {
    if (decimalOdds <= 1) return 1; // edge case
    return 1 / decimalOdds;
  }

  /**
   * Remove vig from raw implied probabilities using multiplicative method.
   * Pinnacle typically has 2-3% vig on moneylines.
   *
   * Example:
   *   Home implied: 0.690 (1.449 decimal)
   *   Away implied: 0.345 (2.900 decimal)
   *   Sum: 1.035 (3.5% vig)
   *   Home fair: 0.690 / 1.035 = 0.667
   *   Away fair: 0.345 / 1.035 = 0.333
   */
  static removeVig(
    homeImplied: number,
    awayImplied: number,
  ): { home: number; away: number; vig: number } {
    const total = homeImplied + awayImplied;
    if (total <= 0) return { home: 0.5, away: 0.5, vig: 0 };

    return {
      home: homeImplied / total,
      away: awayImplied / total,
      vig: total - 1, // overround
    };
  }

  /**
   * Compare Pinnacle fair value vs Polymarket price.
   * Returns overshoot in cents (positive = Polymarket overpriced vs Pinnacle).
   *
   * Example:
   *   Polymarket price: 0.75 (75¢)
   *   Pinnacle fair value: 0.68 (68%)
   *   Overshoot: (0.75 - 0.68) * 100 = +7¢ → great fade opportunity
   */
  static getOvershoot(polymarketPrice: number, pinnacleFairValue: number): number {
    return Math.round((polymarketPrice - pinnacleFairValue) * 100);
  }

  // ==========================================================================
  // API FETCHING
  // ==========================================================================

  private async fetchFromTheOddsApi(sportKey: string): Promise<PinnacleOdds[]> {
    if (!this.config.apiKey) {
      throw new Error('THE_ODDS_API_KEY not configured');
    }

    const url = new URL(`https://api.the-odds-api.com/v4/sports/${sportKey}/odds/`);
    url.searchParams.set('apiKey', this.config.apiKey);
    url.searchParams.set('regions', 'eu');
    url.searchParams.set('bookmakers', 'pinnacle');
    url.searchParams.set('markets', 'h2h');
    url.searchParams.set('oddsFormat', 'decimal');
    url.searchParams.set('dateFormat', 'iso');

    this.requestCount++;
    this.lastRequestTime = Date.now();

    const startMs = Date.now();
    const res = await fetch(url.toString());
    const elapsedMs = Date.now() - startMs;

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`The Odds API ${res.status}: ${body}`);
    }

    // Log quota usage from response headers
    const remaining = res.headers.get('x-requests-remaining');
    const used = res.headers.get('x-requests-used');
    const lastCost = res.headers.get('x-requests-last');
    if (remaining !== null) {
      this.log(`📊 API quota: ${used} used, ${remaining} remaining (last call cost: ${lastCost}) [${elapsedMs}ms]`);
    }

    const data: TheOddsApiEvent[] = await res.json();
    return this.parseTheOddsApiResponse(data, sportKey);
  }

  private parseTheOddsApiResponse(events: TheOddsApiEvent[], sportKey: string): PinnacleOdds[] {
    const results: PinnacleOdds[] = [];

    for (const event of events) {
      // Find Pinnacle bookmaker data
      const pinnacle = event.bookmakers?.find(
        (b) => b.key === 'pinnacle',
      );

      if (!pinnacle) continue;

      // Find h2h (moneyline) market
      const h2h = pinnacle.markets?.find((m) => m.key === 'h2h');
      if (!h2h || !h2h.outcomes || h2h.outcomes.length < 2) continue;

      // Extract home/away odds
      const homeOutcome = h2h.outcomes.find((o) => o.name === event.home_team);
      const awayOutcome = h2h.outcomes.find((o) => o.name === event.away_team);

      if (!homeOutcome || !awayOutcome) continue;

      const homeOdds = homeOutcome.price;
      const awayOdds = awayOutcome.price;

      const homeImplied = PinnacleOddsClient.toImpliedProbability(homeOdds);
      const awayImplied = PinnacleOddsClient.toImpliedProbability(awayOdds);
      const { home: homeFair, away: awayFair, vig } = PinnacleOddsClient.removeVig(homeImplied, awayImplied);

      results.push({
        homeTeam: event.home_team,
        awayTeam: event.away_team,
        homeOdds,
        awayOdds,
        homeImplied,
        awayImplied,
        homeFair,
        awayFair,
        vig,
        lastUpdate: new Date(pinnacle.last_update),
        source: 'the-odds-api',
        sportKey,
        eventId: event.id,
        commenceTime: new Date(event.commence_time),
      });
    }

    return results;
  }

  // ==========================================================================
  // FUZZY TEAM MATCHING
  // ==========================================================================

  /**
   * Check if two team names refer to the same team.
   * Handles: "Seahawks" vs "Seattle Seahawks", abbreviations, etc.
   */
  private teamsMatch(apiName: string, queryName: string): boolean {
    // Exact match (case-insensitive)
    if (apiName.toLowerCase() === queryName.toLowerCase()) return true;

    // Check if one contains the other
    const apiLower = apiName.toLowerCase();
    const queryLower = queryName.toLowerCase();
    if (apiLower.includes(queryLower) || queryLower.includes(apiLower)) return true;

    // Resolve both through alias table
    const apiCanonical = this.resolveTeamName(apiName);
    const queryCanonical = this.resolveTeamName(queryName);
    if (apiCanonical && queryCanonical && apiCanonical === queryCanonical) return true;

    // Last resort: check if any word in query matches last word of apiName
    // (e.g., "Seahawks" matches "Seattle Seahawks")
    const apiWords = apiName.split(/\s+/);
    const queryWords = queryName.split(/\s+/);
    const apiLast = apiWords[apiWords.length - 1].toLowerCase();
    const queryLast = queryWords[queryWords.length - 1].toLowerCase();
    if (apiLast === queryLast && apiLast.length > 2) return true;

    return false;
  }

  /**
   * Resolve a team name to its canonical key using the alias table.
   */
  private resolveTeamName(name: string): string | null {
    // Direct lookup
    const direct = ALIAS_REVERSE.get(name.toLowerCase());
    if (direct) return direct;

    // Try each word (for "Seattle Seahawks" → look up "seahawks")
    for (const word of name.split(/\s+/)) {
      const found = ALIAS_REVERSE.get(word.toLowerCase());
      if (found) return found;
    }

    return null;
  }

  // ==========================================================================
  // DIAGNOSTICS
  // ==========================================================================

  /** Get stats about this client instance */
  getStats(): {
    requestCount: number;
    cacheSize: number;
    lastRequestTime: number;
    apiKeyConfigured: boolean;
    source: string;
  } {
    return {
      requestCount: this.requestCount,
      cacheSize: this.cache.size,
      lastRequestTime: this.lastRequestTime,
      apiKeyConfigured: !!this.config.apiKey,
      source: this.config.source,
    };
  }

  /** Clear all cached data */
  clearCache(): void {
    this.cache.clear();
  }

  // ==========================================================================
  // LOGGING
  // ==========================================================================

  private log(message: string): void {
    const ts = new Date().toISOString();
    console.log(`${ts} [INFO] 📌 [PinnacleOdds] ${message}`);
  }

  private logError(message: string, err: unknown): void {
    const ts = new Date().toISOString();
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error(`${ts} [ERROR] 📌 [PinnacleOdds] ${message}: ${errMsg}`);
  }
}

// ============================================================================
// THE ODDS API RESPONSE TYPES
// ============================================================================

interface TheOddsApiEvent {
  id: string;
  sport_key: string;
  sport_title: string;
  commence_time: string;
  home_team: string;
  away_team: string;
  bookmakers: {
    key: string;
    title: string;
    last_update: string;
    markets: {
      key: string;
      last_update: string;
      outcomes: {
        name: string;
        price: number;
      }[];
    }[];
  }[];
}
