import { TickDatabase, TradeRecord, TickMetrics } from './TickDatabase.js';

export class TickAnalyzer {
  private db: TickDatabase;
  
  constructor(db: TickDatabase) {
    this.db = db;
  }
  
  /**
   * Get the correct tick size for a given price following Polymarket's structure:
   * - [0.00, 0.04): 0.001 (0.1¢)
   * - [0.04, 0.96]: 0.01  (1.0¢)
   * - (0.96, 1.00]: 0.001 (0.1¢)
   */
  private getTickSize(price: number): number {
    if (price < 0.04 || price > 0.96) {
      return 0.001; // 0.1¢ ticks at extremes
    }
    return 0.01; // 1¢ ticks in middle range
  }
  
  /**
   * Check if two prices differ by at least one valid tick.
   * Uses the smaller of the two tick sizes when crossing boundaries.
   */
  private isTickCrossing(price1: number, price2: number): boolean {
    const diff = Math.abs(price1 - price2);
    const tick1 = this.getTickSize(price1);
    const tick2 = this.getTickSize(price2);
    const minTick = Math.min(tick1, tick2);
    return diff >= minTick * 0.99; // 0.99 to account for floating point imprecision
  }
  
  calculateMetrics(tokenId: string): TickMetrics | null {
    const now = Math.floor(Date.now() / 1000);
    
    // Get trades from last 24 hours
    const oneDayAgo = now - 86400;
    const trades24h = this.db.getTradesSince(tokenId, oneDayAgo);
    
    if (trades24h.length < 5) {
      // Not enough data yet
      return null;
    }
    
    // Get trades from last hour
    const oneHourAgo = now - 3600;
    const trades1h = trades24h.filter(t => t.timestamp >= oneHourAgo);
    
    // Calculate metrics
    const tickCrossRate1h = this.calculateTickCrossRate(trades1h);
    const tickCrossRate24h = this.calculateTickCrossRate(trades24h);
    const avgTimeBetweenCrossings = this.calculateAvgTimeBetweenCrossings(trades1h.length > 0 ? trades1h : trades24h);
    const fillProbability = this.calculateFillProbability(trades1h.length > 0 ? trades1h : trades24h);
    
    const metrics: TickMetrics = {
      tokenId,
      tickCrossRate1h: tickCrossRate1h * 100, // Convert to percentage
      tickCrossRate24h: tickCrossRate24h * 100,
      avgTimeBetweenCrossings,
      fillProbability: fillProbability * 100,
      lastUpdated: Date.now(),
    };
    
    // Save to database
    this.db.updateMetrics(tokenId, metrics);
    
    return metrics;
  }
  
  private calculateTickCrossRate(trades: TradeRecord[]): number {
    if (trades.length < 2) return 0;
    
    let crossings = 0;
    
    for (let i = 1; i < trades.length; i++) {
      const prevPrice = trades[i - 1].price;
      const currPrice = trades[i].price;
      
      if (this.isTickCrossing(prevPrice, currPrice)) {
        crossings++;
      }
    }
    
    return crossings / (trades.length - 1);
  }
  
  private calculateAvgTimeBetweenCrossings(trades: TradeRecord[]): number {
    if (trades.length < 2) return 0;
    
    const crossingTimes: number[] = [];
    let lastCrossingTime = trades[0].timestamp;
    
    for (let i = 1; i < trades.length; i++) {
      const prevPrice = trades[i - 1].price;
      const currPrice = trades[i].price;
      
      if (this.isTickCrossing(prevPrice, currPrice)) {
        const timeSinceLast = trades[i].timestamp - lastCrossingTime;
        crossingTimes.push(timeSinceLast);
        lastCrossingTime = trades[i].timestamp;
      }
    }
    
    if (crossingTimes.length === 0) return 0;
    
    const avgTime = crossingTimes.reduce((sum, t) => sum + t, 0) / crossingTimes.length;
    return avgTime;
  }
  
  private calculateFillProbability(trades: TradeRecord[]): number {
    if (trades.length < 2) return 0;
    
    // Most recent trade is first (DESC order from DB)
    const currentPrice = trades[0].price;
    
    // For penny picks, we care about +1¢ moves (not just +1 tick)
    // This is the meaningful profit target
    const targetPrice = currentPrice + 0.01; // +1¢
    
    // Count trades that reached or exceeded the target
    const higherTrades = trades.filter(t => t.price >= targetPrice).length;
    
    return higherTrades / trades.length;
  }
  
  calculateAllMetrics(tokenIds: string[]): Map<string, TickMetrics | null> {
    const results = new Map();
    
    for (const tokenId of tokenIds) {
      const metrics = this.calculateMetrics(tokenId);
      results.set(tokenId, metrics);
    }
    
    return results;
  }
  
  getMetrics(tokenId: string): TickMetrics | null {
    return this.db.getMetrics(tokenId);
  }
  
  getAllMetrics(): Map<string, TickMetrics> {
    const metrics = this.db.getAllMetrics();
    const map = new Map();
    for (const m of metrics) {
      map.set(m.tokenId, m);
    }
    return map;
  }
}
