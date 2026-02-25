import { TickDatabase, TradeRecord } from './TickDatabase.js';

export interface TradeRecorderConfig {
  pollIntervalMs: number;
  maxTradesPerPoll: number;
}

const DEFAULT_CONFIG: TradeRecorderConfig = {
  pollIntervalMs: 300000, // 5 minutes
  maxTradesPerPoll: 200,
};

export class TradeRecorder {
  private db: TickDatabase;
  private config: TradeRecorderConfig;
  
  constructor(db: TickDatabase, config: Partial<TradeRecorderConfig> = {}) {
    this.db = db;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }
  
  async recordTrades(tokenId: string): Promise<{ inserted: number; total: number }> {
    try {
      // Fetch recent trades from Data API
      const url = `https://data-api.polymarket.com/trades?id=${tokenId}&limit=${this.config.maxTradesPerPoll}`;
      const res = await fetch(url);
      
      if (!res.ok) {
        console.error(`Failed to fetch trades for ${tokenId}: ${res.status}`);
        return { inserted: 0, total: 0 };
      }
      
      const apiTrades = await res.json();
      
      if (!Array.isArray(apiTrades) || apiTrades.length === 0) {
        return { inserted: 0, total: 0 };
      }
      
      // Convert to TradeRecord format
      const trades: TradeRecord[] = apiTrades.map(t => ({
        tokenId,
        timestamp: t.timestamp,
        price: parseFloat(t.price),
        size: parseFloat(t.size),
        side: t.side === 'BUY' ? 'BUY' : 'SELL',
        recordedAt: Date.now(),
      }));
      
      // Insert into database (UNIQUE constraint prevents duplicates)
      const inserted = this.db.insertTrades(trades);
      
      // Update poll state
      const lastTradeTimestamp = trades[0]?.timestamp;
      this.db.updatePollState(tokenId, Date.now(), lastTradeTimestamp);
      
      return { inserted, total: trades.length };
      
    } catch (err) {
      console.error(`Error recording trades for ${tokenId}:`, err);
      return { inserted: 0, total: 0 };
    }
  }
  
  async recordMultiple(tokenIds: string[]): Promise<Map<string, { inserted: number; total: number }>> {
    const results = new Map();
    
    for (const tokenId of tokenIds) {
      const result = await this.recordTrades(tokenId);
      results.set(tokenId, result);
      
      // Small delay between requests to be polite
      await new Promise(r => setTimeout(r, 100));
    }
    
    return results;
  }
}
