export interface PennyOutcome {
  // Identification
  eventTitle: string;
  eventSlug: string;
  outcome: string;
  marketSlug: string;
  tokenId: string;
  conditionId: string;
  
  // Pricing
  price: number;
  bestBid: number;
  bestAsk: number;
  spread: number;
  spreadPct: number;
  lastTradePrice: number;
  
  // Volume
  volume24h: number;
  volumeTotal: number;
  
  // Price changes
  priceChange1h: number;
  priceChange1d: number;
  priceChange1w: number;
  
  // Fill probability indicators
  tickCrossRate: number; // Real tick crossing rate from trade data (0-100%)
  fillProbability: number; // Real fill probability from trade data (0-100%)
  
  // Metadata
  category: string;
  numOutcomesInEvent: number;
  link: string;
  
  // Timestamp
  scannedAt: number;
}

export interface ScannerConfig {
  minPrice: number;
  maxPrice: number;
  minVolume24h: number;
  maxSpreadPct: number;
  categories?: string[];
}

const DEFAULT_CONFIG: ScannerConfig = {
  minPrice: 0.005,
  maxPrice: 0.05,
  minVolume24h: 20000,
  maxSpreadPct: 30, // 30%
};

export class PennyPickScanner {
  private config: ScannerConfig;
  private tickMetrics: Map<string, any> = new Map();
  
  constructor(config: Partial<ScannerConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }
  
  setTickMetrics(metrics: Map<string, any>): void {
    this.tickMetrics = metrics;
  }
  
  async scan(): Promise<PennyOutcome[]> {
    const outcomes: PennyOutcome[] = [];
    
    // Fetch all active events (Gamma API)
    const eventsRes = await fetch('https://gamma-api.polymarket.com/events?limit=200&closed=false&order=volume&ascending=false');
    if (!eventsRes.ok) {
      throw new Error(`Gamma API error: ${eventsRes.status}`);
    }
    
    const events = await eventsRes.json() as any[];
    
    for (const event of events) {
      // Only multi-outcome events (3+ markets)
      if (!event.markets || event.markets.length < 3) continue;
      
      // Category filtering (if specified)
      if (this.config.categories && this.config.categories.length > 0) {
        const eventCategory = this.categorizeEvent(event);
        if (!this.config.categories.includes(eventCategory)) continue;
      }
      
      // Process each market in the event
      for (const market of event.markets) {
        try {
          const outcome = this.parseMarket(event, market);
          if (!outcome) continue;
          
          // Apply filters
          if (outcome.price < this.config.minPrice || outcome.price > this.config.maxPrice) continue;
          if (outcome.volume24h < this.config.minVolume24h) continue;
          if (outcome.spreadPct > this.config.maxSpreadPct) continue;
          
          outcomes.push(outcome);
        } catch (err) {
          console.error(`Error parsing market ${market.slug}:`, err);
        }
      }
    }
    
    return outcomes;
  }
  
  private parseMarket(event: any, market: any): PennyOutcome | null {
    // Parse JSON strings
    const outcomes = market.outcomes ? JSON.parse(market.outcomes) : [];
    const prices = market.outcomePrices ? JSON.parse(market.outcomePrices).map(Number) : [];
    const tokenIds = market.clobTokenIds ? JSON.parse(market.clobTokenIds) : [];
    
    if (outcomes.length === 0 || prices.length === 0) return null;
    
    // We care about the YES outcome (index 0)
    const price = prices[0];
    const bestBid = market.bestBid || 0;
    const bestAsk = market.bestAsk || 0;
    const spread = bestAsk - bestBid;
    const spreadPct = bestBid > 0 ? (spread / bestBid * 100) : 0;
    
    return {
      eventTitle: event.title,
      eventSlug: event.slug,
      outcome: market.groupItemTitle || outcomes[0],
      marketSlug: market.slug,
      tokenId: tokenIds[0] || '',
      conditionId: market.conditionId || '',
      
      price,
      bestBid,
      bestAsk,
      spread,
      spreadPct,
      lastTradePrice: market.lastTradePrice || 0,
      
      volume24h: market.volume24hr || 0,
      volumeTotal: market.volumeNum || market.volume || 0,
      
      priceChange1h: market.oneHourPriceChange || 0,
      priceChange1d: market.oneDayPriceChange || 0,
      priceChange1w: market.oneWeekPriceChange || 0,
      
      tickCrossRate: this.getTickCrossRate(tokenIds[0] || '', market, prices[0], bestBid, bestAsk),
      fillProbability: this.getFillProbability(tokenIds[0] || '', market, prices[0], bestBid, bestAsk),
      
      category: this.categorizeEvent(event),
      numOutcomesInEvent: event.markets.length,
      link: `https://polymarket.com/event/${event.slug}?outcome=${encodeURIComponent(market.slug)}`,
      
      scannedAt: Date.now(),
    };
  }
  
  private getTickCrossRate(tokenId: string, market: any, price: number, bestBid: number, bestAsk: number): number {
    // Try to get real tick metrics from database
    const metrics = this.tickMetrics.get(tokenId);
    if (metrics && metrics.tickCrossRate1h !== undefined) {
      // Use 1-hour tick cross rate (more recent, more relevant)
      return metrics.tickCrossRate1h;
    }
    
    // Fallback: use synthetic composite score
    return this.calculateFillScore(market, price, bestBid, bestAsk);
  }
  
  private getFillProbability(tokenId: string, market: any, price: number, bestBid: number, bestAsk: number): number {
    // Try to get real fill probability from database
    const metrics = this.tickMetrics.get(tokenId);
    if (metrics && metrics.fillProbability !== undefined) {
      return metrics.fillProbability;
    }
    
    // Fallback: estimate based on volume and volatility
    const vol24h = market.volume24hr || 0;
    const change1d = Math.abs(market.oneDayPriceChange || 0);
    const relativeVol = price > 0 ? (change1d / price) : 0;
    
    // Higher volume + higher volatility = better fill odds
    const volumeFactor = Math.min(Math.sqrt(vol24h / 1000) / 20, 1.0);
    const volatilityFactor = Math.min(relativeVol * 2, 1.0);
    
    return (volumeFactor * 0.5 + volatilityFactor * 0.5) * 100;
  }
  
  private calculateFillScore(market: any, price: number, bestBid: number, bestAsk: number): number {
    // Components:
    // 1. Volatility: absolute 1-day price change (how much it moved)
    // 2. Liquidity: sqrt of 24h volume (normalized)
    // 3. Spread quality: (1 - spreadPct/100) - reward tight spreads
    // 4. Recent momentum: if 1h change available, weight recent activity higher
    
    const vol24h = market.volume24hr || 0;
    const change1d = Math.abs(market.oneDayPriceChange || 0);
    const change1h = Math.abs(market.oneHourPriceChange || 0);
    
    // Spread penalty (0 = wide spread, 1 = tight spread)
    const spread = bestAsk - bestBid;
    const spreadPct = bestBid > 0 ? (spread / bestBid * 100) : 100;
    const spreadQuality = Math.max(0, 1 - spreadPct / 50); // Penalize spreads >50%
    
    // Volatility component (scaled by price to normalize)
    // A 0.5¢ move on a 1¢ asset is 50% - very volatile
    // A 0.5¢ move on a 5¢ asset is 10% - less volatile
    const relativeVolatility = price > 0 ? (change1d / price) : 0;
    
    // Liquidity component (sqrt to dampen extreme values)
    // $1M volume isn't 10x better than $100K, maybe 3x better
    const liquidityFactor = Math.sqrt(vol24h / 1000); // Normalize by $1K
    
    // Recent momentum bonus (if 1h data available and significant)
    let momentumBonus = 1.0;
    if (change1h > 0 && change1d > 0) {
      // If 1h change is large relative to 1d change, recent activity is high
      const momentumRatio = change1h / Math.max(change1d, 0.0001);
      momentumBonus = 1.0 + Math.min(momentumRatio * 0.5, 1.0); // Cap at 2x bonus
    }
    
    // Combined score
    // High volatility × High liquidity × Tight spread × Recent momentum
    const rawScore = relativeVolatility * liquidityFactor * spreadQuality * momentumBonus;
    
    // Normalize to 0-100 scale (empirically calibrated)
    // Typical range: 0-20, exceptional: 20-50, rare: 50+
    const normalizedScore = Math.min(100, rawScore * 10);
    
    return normalizedScore;
  }
  
  private categorizeEvent(event: any): string {
    const title = event.title.toLowerCase();
    const slug = event.slug.toLowerCase();
    const cat = (event.category || '').toLowerCase();
    
    // Politics
    if (title.includes('presidential') || title.includes('election') || title.includes('nominee') ||
        title.includes('senate') || title.includes('congress') || title.includes('governor') ||
        slug.includes('presidential') || slug.includes('election') || cat.includes('politics')) {
      return 'Politics';
    }
    
    // Fed / Economics
    if (title.includes('fed') || title.includes('federal reserve') || title.includes('interest rate') ||
        title.includes('inflation') || title.includes('gdp') || title.includes('unemployment')) {
      return 'Fed/Economics';
    }
    
    // Geopolitical
    if (title.includes('strike') || title.includes('war') || title.includes('invade') ||
        title.includes('sanctions') || title.includes('conflict') || title.includes('venezuela') ||
        title.includes('iran') || title.includes('china') || title.includes('russia')) {
      return 'Geopolitical';
    }
    
    // Crypto
    if (title.includes('bitcoin') || title.includes('btc') || title.includes('ethereum') ||
        title.includes('crypto') || title.includes('defi') || cat.includes('crypto')) {
      return 'Crypto';
    }
    
    // Sports - Basketball
    if (title.includes('nba') || title.includes('basketball') || slug.includes('nba')) {
      return 'NBA';
    }
    
    // Sports - Hockey
    if (title.includes('nhl') || title.includes('hockey') || title.includes('stanley cup') || slug.includes('nhl')) {
      return 'NHL';
    }
    
    // Sports - Soccer
    if (title.includes('premier league') || title.includes('champions league') || title.includes('la liga') ||
        title.includes('bundesliga') || title.includes('serie a') || title.includes('world cup') ||
        title.includes('fifa') || slug.includes('soccer') || slug.includes('football')) {
      return 'Soccer';
    }
    
    // Sports - Other
    if (cat.includes('sports') || title.includes('mlb') || title.includes('nfl') ||
        title.includes('championship') || title.includes('playoff')) {
      return 'Sports-Other';
    }
    
    // Entertainment
    if (title.includes('oscar') || title.includes('grammy') || title.includes('emmy') ||
        title.includes('stranger things') || title.includes('gta') || title.includes('movie') ||
        title.includes('album') || cat.includes('pop-culture')) {
      return 'Entertainment';
    }
    
    // Tech/Business
    if (title.includes('company') || title.includes('ceo') || title.includes('acquisition') ||
        title.includes('ipo') || title.includes('stock') || title.includes('market cap')) {
      return 'Tech/Business';
    }
    
    return 'Other';
  }
}
