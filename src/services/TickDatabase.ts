import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

export interface TradeRecord {
  id?: number;
  tokenId: string;
  timestamp: number;
  price: number;
  size: number;
  side: 'BUY' | 'SELL';
  recordedAt: number;
}

export interface TickMetrics {
  tokenId: string;
  tickCrossRate1h: number;  // % of time price crossed +1 tick in last hour
  tickCrossRate24h: number; // % of time price crossed +1 tick in last 24h
  avgTimeBetweenCrossings: number; // seconds
  fillProbability: number; // % chance of filling 1 tick above current
  lastUpdated: number;
}

export class TickDatabase {
  private db: Database.Database;
  
  constructor(dbPath: string = './data/tick-database.db') {
    // Ensure directory exists
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.initTables();
  }
  
  private initTables() {
    // Trades table - stores raw trade data
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS trades (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tokenId TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        price REAL NOT NULL,
        size REAL NOT NULL,
        side TEXT NOT NULL,
        recordedAt INTEGER NOT NULL,
        UNIQUE(tokenId, timestamp, price, size)
      );
      
      CREATE INDEX IF NOT EXISTS idx_trades_token_time 
        ON trades(tokenId, timestamp DESC);
      
      CREATE INDEX IF NOT EXISTS idx_trades_recorded 
        ON trades(recordedAt);
    `);
    
    // Metrics cache table - stores calculated tick metrics
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tick_metrics (
        tokenId TEXT PRIMARY KEY,
        tickCrossRate1h REAL,
        tickCrossRate24h REAL,
        avgTimeBetweenCrossings REAL,
        fillProbability REAL,
        lastUpdated INTEGER NOT NULL
      );
    `);
    
    // Polling state table - tracks last poll time per token
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS poll_state (
        tokenId TEXT PRIMARY KEY,
        lastPollTime INTEGER NOT NULL,
        lastTradeTimestamp INTEGER
      );
    `);
  }
  
  insertTrades(trades: TradeRecord[]): number {
    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO trades (tokenId, timestamp, price, size, side, recordedAt)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    
    const recordedAt = Date.now();
    let inserted = 0;
    
    const insert = this.db.transaction((trades: TradeRecord[]) => {
      for (const trade of trades) {
        const result = stmt.run(
          trade.tokenId,
          trade.timestamp,
          trade.price,
          trade.size,
          trade.side,
          recordedAt
        );
        if (result.changes > 0) inserted++;
      }
    });
    
    insert(trades);
    return inserted;
  }
  
  getTradesSince(tokenId: string, sinceTimestamp: number): TradeRecord[] {
    const stmt = this.db.prepare(`
      SELECT * FROM trades
      WHERE tokenId = ? AND timestamp >= ?
      ORDER BY timestamp DESC
    `);
    
    return stmt.all(tokenId, sinceTimestamp) as TradeRecord[];
  }
  
  getRecentTrades(tokenId: string, limit: number = 200): TradeRecord[] {
    const stmt = this.db.prepare(`
      SELECT * FROM trades
      WHERE tokenId = ?
      ORDER BY timestamp DESC
      LIMIT ?
    `);
    
    return stmt.all(tokenId, limit) as TradeRecord[];
  }
  
  updateMetrics(tokenId: string, metrics: Omit<TickMetrics, 'tokenId'>): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO tick_metrics 
        (tokenId, tickCrossRate1h, tickCrossRate24h, avgTimeBetweenCrossings, fillProbability, lastUpdated)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    
    stmt.run(
      tokenId,
      metrics.tickCrossRate1h,
      metrics.tickCrossRate24h,
      metrics.avgTimeBetweenCrossings,
      metrics.fillProbability,
      metrics.lastUpdated
    );
  }
  
  getMetrics(tokenId: string): TickMetrics | null {
    const stmt = this.db.prepare(`
      SELECT * FROM tick_metrics WHERE tokenId = ?
    `);
    
    return stmt.get(tokenId) as TickMetrics | null;
  }
  
  getAllMetrics(): TickMetrics[] {
    const stmt = this.db.prepare(`SELECT * FROM tick_metrics`);
    return stmt.all() as TickMetrics[];
  }
  
  updatePollState(tokenId: string, lastPollTime: number, lastTradeTimestamp?: number): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO poll_state (tokenId, lastPollTime, lastTradeTimestamp)
      VALUES (?, ?, ?)
    `);
    
    stmt.run(tokenId, lastPollTime, lastTradeTimestamp || null);
  }
  
  getPollState(tokenId: string): { lastPollTime: number; lastTradeTimestamp: number | null } | null {
    const stmt = this.db.prepare(`SELECT * FROM poll_state WHERE tokenId = ?`);
    return stmt.get(tokenId) as any;
  }
  
  // Cleanup old trades (keep last 7 days)
  cleanupOldTrades(daysToKeep: number = 7): number {
    const cutoffTime = Math.floor(Date.now() / 1000) - (daysToKeep * 86400);
    const stmt = this.db.prepare(`DELETE FROM trades WHERE timestamp < ?`);
    const result = stmt.run(cutoffTime);
    return result.changes;
  }
  
  close(): void {
    this.db.close();
  }
}
