import { TickDatabase } from './TickDatabase.js';
import { TradeRecorder } from './TradeRecorder.js';
import { TickAnalyzer } from './TickAnalyzer.js';
import { PennyPickScanner } from './PennyPickScanner.js';

export interface TickPollerConfig {
  pollIntervalMs: number;
  metricsUpdateIntervalMs: number;
  maxTokens: number;
  cleanupIntervalMs: number;
}

const DEFAULT_CONFIG: TickPollerConfig = {
  pollIntervalMs: 300000, // 5 minutes
  metricsUpdateIntervalMs: 60000, // 1 minute
  maxTokens: 50,
  cleanupIntervalMs: 86400000, // 24 hours
};

export class TickPollerService {
  private db: TickDatabase;
  private recorder: TradeRecorder;
  private analyzer: TickAnalyzer;
  private scanner: PennyPickScanner;
  private config: TickPollerConfig;
  
  private pollInterval?: NodeJS.Timeout;
  private metricsInterval?: NodeJS.Timeout;
  private cleanupInterval?: NodeJS.Timeout;
  private running = false;
  
  constructor(
    db: TickDatabase,
    config: Partial<TickPollerConfig> = {}
  ) {
    this.db = db;
    this.recorder = new TradeRecorder(db, { pollIntervalMs: config.pollIntervalMs });
    this.analyzer = new TickAnalyzer(db);
    this.scanner = new PennyPickScanner();
    this.config = { ...DEFAULT_CONFIG, ...config };
  }
  
  async start(): Promise<void> {
    if (this.running) {
      console.log('Tick poller already running');
      return;
    }
    
    this.running = true;
    console.log('🚀 Tick Poller Service started');
    console.log(`  Poll interval: ${this.config.pollIntervalMs / 1000}s`);
    console.log(`  Metrics update: ${this.config.metricsUpdateIntervalMs / 1000}s`);
    console.log(`  Max tokens: ${this.config.maxTokens}`);
    console.log();
    
    // Initial poll
    await this.pollCycle();
    
    // Start intervals
    this.pollInterval = setInterval(() => {
      this.pollCycle().catch(console.error);
    }, this.config.pollIntervalMs);
    
    this.metricsInterval = setInterval(() => {
      this.updateMetrics().catch(console.error);
    }, this.config.metricsUpdateIntervalMs);
    
    this.cleanupInterval = setInterval(() => {
      this.cleanup();
    }, this.config.cleanupIntervalMs);
  }
  
  stop(): void {
    if (!this.running) return;
    
    if (this.pollInterval) clearInterval(this.pollInterval);
    if (this.metricsInterval) clearInterval(this.metricsInterval);
    if (this.cleanupInterval) clearInterval(this.cleanupInterval);
    
    this.running = false;
    console.log('Tick Poller Service stopped');
  }
  
  private async pollCycle(): Promise<void> {
    try {
      // Get top penny picks to track
      const outcomes = await this.scanner.scan();
      const topOutcomes = outcomes
        .sort((a, b) => b.volume24h - a.volume24h)
        .slice(0, this.config.maxTokens);
      
      const tokenIds = topOutcomes.map(o => o.tokenId).filter(Boolean);
      
      if (tokenIds.length === 0) {
        console.log('No tokens to poll');
        return;
      }
      
      console.log(`[${new Date().toISOString()}] Polling ${tokenIds.length} tokens...`);
      
      // Record trades for all tokens
      const results = await this.recorder.recordMultiple(tokenIds);
      
      // Log results
      let totalInserted = 0;
      let totalFetched = 0;
      for (const [tokenId, result] of results) {
        totalInserted += result.inserted;
        totalFetched += result.total;
      }
      
      console.log(`  Fetched ${totalFetched} trades, inserted ${totalInserted} new`);
      
    } catch (err) {
      console.error('Error in poll cycle:', err);
    }
  }
  
  private async updateMetrics(): Promise<void> {
    try {
      // Get all tokens with trade data
      const outcomes = await this.scanner.scan();
      const topOutcomes = outcomes
        .sort((a, b) => b.volume24h - a.volume24h)
        .slice(0, this.config.maxTokens);
      
      const tokenIds = topOutcomes.map(o => o.tokenId).filter(Boolean);
      
      if (tokenIds.length === 0) return;
      
      // Calculate metrics for all tokens
      const metricsMap = this.analyzer.calculateAllMetrics(tokenIds);
      
      // Count successful calculations
      let calculated = 0;
      for (const [_tokenId, metrics] of metricsMap) {
        if (metrics) calculated++;
      }
      
      if (calculated > 0) {
        console.log(`[${new Date().toISOString()}] Updated metrics for ${calculated} tokens`);
      }
      
    } catch (err) {
      console.error('Error updating metrics:', err);
    }
  }
  
  private cleanup(): void {
    try {
      const deleted = this.db.cleanupOldTrades(7); // Keep 7 days
      if (deleted > 0) {
        console.log(`Cleaned up ${deleted} old trade records`);
      }
    } catch (err) {
      console.error('Error in cleanup:', err);
    }
  }
  
  getAnalyzer(): TickAnalyzer {
    return this.analyzer;
  }
  
  getDatabase(): TickDatabase {
    return this.db;
  }
}
