import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

export interface Position {
  id?: number;
  market_slug: string;
  condition_id: string;
  token_id: string;
  entry_price: number;
  shares: number;
  entry_time: number;
  market_end_time: number;
  exit_price?: number | null;
  exit_time?: number | null;
  exit_reason?: string | null;
  pnl?: number | null;
  pnl_synced: number;  // 1 when PNL has been added to martingale state
  redeemed: number;
  created_at?: string;
}

// Note: MartingaleState interface removed - now using AUM-based tracking via capital_baseline

export interface CapitalBaseline {
  id: number;
  baseline: number;
  last_updated: number;
  recovery_attempts: number;
}

export interface TradeLog {
  id?: number;
  position_id?: number | null;
  event_type: string;
  details?: string | null;
  timestamp: number;
}

export interface SignalState {
  id?: number;
  timestamp: number;       // Unix timestamp from external system (seconds)
  state: string;           // T1ENTRY, T2ENTRY, etc.
  market_start: number;    // Start of 15-min window (ms)
  received_at: number;     // When we received it (ms)
}

// ============ Arbitrage Types ============

export interface ArbitragePosition {
  id?: number;
  market_slug: string;
  condition_id: string;
  up_token_id: string;
  down_token_id: string;
  qty_up: number;
  qty_down: number;
  cost_up: number;
  cost_down: number;
  pair_cost: number | null;
  hedged_qty: number | null;
  guaranteed_profit: number | null;
  profit_locked: number;  // 0 or 1
  created_at: number;
  settled_at: number | null;
  settlement_pnl: number | null;
  up_redeemed: number;    // 0 or 1 - whether UP side has been redeemed
  down_redeemed: number;  // 0 or 1 - whether DOWN side has been redeemed
}

export interface ArbitrageTrade {
  id?: number;
  position_id: number;
  order_id: string | null;
  side: 'UP' | 'DOWN';
  price: number;
  quantity: number;
  cost: number;
  timestamp: number;
}

// ============ Dashboard Monitoring Types ============

export interface PriceHistory {
  id?: number;
  market_slug: string;
  condition_id: string;
  timestamp: number;
  up_bid: number;
  up_ask: number;
  down_bid: number;
  down_ask: number;
}

export interface UserFill {
  id?: number;
  market_slug: string;
  condition_id: string;
  order_id: string;
  side: 'UP' | 'DOWN';
  price: number;
  size: number;
  timestamp: number;
}

// ============ Scalping Types ============

export interface ScalpOrder {
  id?: number;
  order_id: string;
  condition_id: string;
  token_id: string;
  side: 'UP' | 'DOWN';
  type: 'BUY' | 'SELL';
  price: number;
  shares: number;
  status: 'OPEN' | 'FILLED' | 'CANCELLED' | 'PARTIAL';
  filled_shares: number;
  linked_buy_id: string | null;  // For sells, reference to buy order
  created_at: string;
  filled_at: string | null;
  pnl: number | null;  // For sells, profit/loss
}

export class DatabaseService {
  private db: Database.Database;

  /** Get raw database instance for custom queries */
  getDb(): Database.Database {
    return this.db;
  }

  constructor(dbPath?: string) {
    const dataDir = path.join(process.cwd(), 'data');
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }

    const finalPath = dbPath || path.join(dataDir, 'trading.db');
    this.db = new Database(finalPath);
    this.db.pragma('journal_mode = WAL');
    this.initSchema();
  }

  private initSchema(): void {
    // Positions table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS positions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        market_slug TEXT NOT NULL,
        condition_id TEXT NOT NULL,
        token_id TEXT NOT NULL,
        entry_price REAL NOT NULL,
        shares REAL NOT NULL,
        entry_time INTEGER NOT NULL,
        market_end_time INTEGER NOT NULL,
        exit_price REAL,
        exit_time INTEGER,
        exit_reason TEXT,
        pnl REAL,
        pnl_synced INTEGER DEFAULT 0,
        redeemed INTEGER DEFAULT 0,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Add pnl_synced column if it doesn't exist (migration for existing databases)
    try {
      this.db.exec(`ALTER TABLE positions ADD COLUMN pnl_synced INTEGER DEFAULT 0`);
    } catch (e) {
      // Column already exists, ignore
    }

    // Note: martingale_state table deprecated - now using capital_baseline for AUM-based tracking
    // Keeping the table for backward compatibility but not actively used

    // Trade log table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS trade_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        position_id INTEGER,
        event_type TEXT NOT NULL,
        details TEXT,
        timestamp INTEGER NOT NULL,
        FOREIGN KEY (position_id) REFERENCES positions(id)
      );
    `);

    // Note: martingale_state initialization removed - now using capital_baseline for AUM-based tracking

    // Capital baseline table (single row) - AUM-based PNL tracking
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS capital_baseline (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        baseline REAL NOT NULL,
        last_updated INTEGER NOT NULL,
        recovery_attempts INTEGER DEFAULT 0
      );
    `);

    // Add recovery_attempts column if it doesn't exist (migration for existing databases)
    try {
      this.db.exec(`ALTER TABLE capital_baseline ADD COLUMN recovery_attempts INTEGER DEFAULT 0`);
    } catch (e) {
      // Column already exists, ignore
    }

    // Signal state table - stores incoming signals from external system
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS signal_state (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp INTEGER NOT NULL,
        state TEXT NOT NULL,
        market_start INTEGER NOT NULL,
        received_at INTEGER NOT NULL,
        UNIQUE(market_start)
      );
    `);

    // Redemption tracking table - tracks redemption attempts per condition
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS redemption_tracking (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        condition_id TEXT NOT NULL,
        market_slug TEXT NOT NULL,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        last_attempt_at INTEGER,
        last_tx_hash TEXT,
        last_success INTEGER DEFAULT 0,
        created_at INTEGER NOT NULL
      );
    `);

    // Create indexes
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_positions_market_slug ON positions(market_slug);
      CREATE INDEX IF NOT EXISTS idx_positions_condition_id ON positions(condition_id);
      CREATE INDEX IF NOT EXISTS idx_positions_redeemed ON positions(redeemed);
      CREATE INDEX IF NOT EXISTS idx_trade_log_position ON trade_log(position_id);
      CREATE INDEX IF NOT EXISTS idx_trade_log_event ON trade_log(event_type);
      CREATE INDEX IF NOT EXISTS idx_signal_state_market ON signal_state(market_start);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_redemption_tracking_condition ON redemption_tracking(condition_id);
    `);

    // ============ Arbitrage Tables ============

    // Arbitrage positions (per market)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS arbitrage_positions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        market_slug TEXT NOT NULL,
        condition_id TEXT NOT NULL UNIQUE,
        up_token_id TEXT NOT NULL,
        down_token_id TEXT NOT NULL,
        qty_up REAL DEFAULT 0,
        qty_down REAL DEFAULT 0,
        cost_up REAL DEFAULT 0,
        cost_down REAL DEFAULT 0,
        pair_cost REAL,
        hedged_qty REAL,
        guaranteed_profit REAL,
        profit_locked INTEGER DEFAULT 0,
        created_at INTEGER NOT NULL,
        settled_at INTEGER,
        settlement_pnl REAL
      );
    `);

    // Arbitrage trades (individual fills)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS arbitrage_trades (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        position_id INTEGER NOT NULL,
        order_id TEXT,
        side TEXT NOT NULL,
        price REAL NOT NULL,
        quantity REAL NOT NULL,
        cost REAL NOT NULL,
        timestamp INTEGER NOT NULL,
        FOREIGN KEY (position_id) REFERENCES arbitrage_positions(id)
      );
    `);

    // Arbitrage indexes
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_arb_positions_condition ON arbitrage_positions(condition_id);
      CREATE INDEX IF NOT EXISTS idx_arb_positions_profit_locked ON arbitrage_positions(profit_locked);
      CREATE INDEX IF NOT EXISTS idx_arb_trades_position ON arbitrage_trades(position_id);
    `);

    // Migration: Add per-side redemption tracking columns
    try {
      this.db.exec(`ALTER TABLE arbitrage_positions ADD COLUMN up_redeemed INTEGER DEFAULT 0`);
    } catch (e) { /* Column already exists */ }

    try {
      this.db.exec(`ALTER TABLE arbitrage_positions ADD COLUMN down_redeemed INTEGER DEFAULT 0`);
    } catch (e) { /* Column already exists */ }

    // ============ Scalping Tables ============

    // Scalp orders (individual GTC orders for scalping strategy)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS scalp_orders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        order_id TEXT UNIQUE NOT NULL,
        condition_id TEXT NOT NULL,
        token_id TEXT NOT NULL,
        side TEXT NOT NULL,
        type TEXT NOT NULL,
        price REAL NOT NULL,
        shares INTEGER NOT NULL,
        status TEXT DEFAULT 'OPEN',
        filled_shares INTEGER DEFAULT 0,
        linked_buy_id TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        filled_at TEXT,
        pnl REAL
      );
    `);

    // Scalping indexes
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_scalp_orders_status ON scalp_orders(status);
      CREATE INDEX IF NOT EXISTS idx_scalp_orders_condition ON scalp_orders(condition_id);
      CREATE INDEX IF NOT EXISTS idx_scalp_orders_order_id ON scalp_orders(order_id);
      CREATE INDEX IF NOT EXISTS idx_scalp_orders_linked ON scalp_orders(linked_buy_id);
    `);

    // ============ Dashboard Monitoring Tables ============

    // Price history table (for dashboard charts)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS price_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        market_slug TEXT NOT NULL,
        condition_id TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        up_bid REAL NOT NULL,
        up_ask REAL NOT NULL,
        down_bid REAL NOT NULL,
        down_ask REAL NOT NULL
      );
    `);

    // User fills table (real user trades from UserChannelWS)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS user_fills (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        market_slug TEXT NOT NULL,
        condition_id TEXT NOT NULL,
        order_id TEXT NOT NULL,
        side TEXT NOT NULL,
        price REAL NOT NULL,
        size REAL NOT NULL,
        timestamp INTEGER NOT NULL
      );
    `);

    // Dashboard monitoring indexes
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_price_history_cond_ts ON price_history(condition_id, timestamp);
      CREATE INDEX IF NOT EXISTS idx_user_fills_cond ON user_fills(condition_id);
      CREATE INDEX IF NOT EXISTS idx_user_fills_timestamp ON user_fills(timestamp);
    `);
  }

  // ============ Position Methods ============

  insertPosition(position: Omit<Position, 'id' | 'created_at' | 'redeemed' | 'pnl_synced'>): number {
    const stmt = this.db.prepare(`
      INSERT INTO positions (market_slug, condition_id, token_id, entry_price, shares, entry_time, market_end_time, pnl_synced, redeemed)
      VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0)
    `);
    const result = stmt.run(
      position.market_slug,
      position.condition_id,
      position.token_id,
      position.entry_price,
      position.shares,
      position.entry_time,
      position.market_end_time
    );
    return result.lastInsertRowid as number;
  }

  getPositionById(id: number): Position | undefined {
    return this.db.prepare('SELECT * FROM positions WHERE id = ?').get(id) as Position | undefined;
  }

  getPositionByMarketSlug(marketSlug: string): Position | undefined {
    return this.db.prepare('SELECT * FROM positions WHERE market_slug = ?').get(marketSlug) as Position | undefined;
  }

  getPositionByConditionId(conditionId: string): Position | undefined {
    return this.db.prepare('SELECT * FROM positions WHERE condition_id = ?').get(conditionId) as Position | undefined;
  }

  getActivePosition(): Position | undefined {
    return this.db.prepare(`
      SELECT * FROM positions
      WHERE exit_time IS NULL AND redeemed = 0
      ORDER BY entry_time DESC LIMIT 1
    `).get() as Position | undefined;
  }

  getUnredeemedPositions(): Position[] {
    return this.db.prepare(`
      SELECT * FROM positions
      WHERE redeemed = 0 AND exit_time IS NOT NULL
    `).all() as Position[];
  }

  getUnredeemedClosedPositions(): Position[] {
    return this.db.prepare(`
      SELECT * FROM positions
      WHERE redeemed = 0 AND market_end_time < ?
    `).all(Date.now()) as Position[];
  }

  updatePositionExit(id: number, exitPrice: number, exitReason: string, pnl: number): void {
    this.db.prepare(`
      UPDATE positions
      SET exit_price = ?, exit_time = ?, exit_reason = ?, pnl = ?
      WHERE id = ?
    `).run(exitPrice, Date.now(), exitReason, pnl, id);
  }

  updatePositionPnl(id: number, pnl: number): void {
    this.db.prepare(`
      UPDATE positions SET pnl = ? WHERE id = ?
    `).run(pnl, id);
  }

  markPositionRedeemed(id: number): void {
    this.db.prepare(`
      UPDATE positions SET redeemed = 1 WHERE id = ?
    `).run(id);
  }

  /**
   * Sync database with on-chain state
   * Marks positions as redeemed if they no longer exist on-chain
   * @param activeConditionIds - condition IDs that still have active positions on-chain
   * @returns number of positions marked as redeemed
   */
  syncWithOnChainState(activeConditionIds: string[]): number {
    // Get all unredeemed positions (including active ones)
    const unredeemed = this.db.prepare(`
      SELECT * FROM positions WHERE redeemed = 0
    `).all() as Position[];

    let syncedCount = 0;

    for (const position of unredeemed) {
      // If position not in active list on-chain, mark as redeemed
      if (!activeConditionIds.includes(position.condition_id)) {
        this.markPositionRedeemed(position.id!);
        syncedCount++;
      }
    }

    return syncedCount;
  }

  markPositionPnlSynced(id: number): void {
    this.db.prepare(`
      UPDATE positions SET pnl_synced = 1 WHERE id = ?
    `).run(id);
  }

  getPositionsNeedingPnlSync(): Position[] {
    // Positions where market has ended but PNL not yet synced to martingale state
    return this.db.prepare(`
      SELECT * FROM positions
      WHERE market_end_time < ? AND pnl_synced = 0
      ORDER BY market_end_time ASC
    `).all(Date.now()) as Position[];
  }

  getAllPositions(limit: number = 100): Position[] {
    return this.db.prepare(`
      SELECT * FROM positions ORDER BY entry_time DESC LIMIT ?
    `).all(limit) as Position[];
  }

  // ============ Martingale State Methods (DEPRECATED) ============
  // Note: These methods are kept for backward compatibility but are no longer used.
  // The system now uses AUM-based tracking via capital_baseline table.
  // PNL = AUM - baseline (where baseline is the high water mark)

  // ============ Trade Log Methods ============

  logTrade(log: Omit<TradeLog, 'id'>): number {
    const stmt = this.db.prepare(`
      INSERT INTO trade_log (position_id, event_type, details, timestamp)
      VALUES (?, ?, ?, ?)
    `);
    const result = stmt.run(
      log.position_id ?? null,
      log.event_type,
      log.details ?? null,
      log.timestamp
    );
    return result.lastInsertRowid as number;
  }

  getTradeLogsByPosition(positionId: number): TradeLog[] {
    return this.db.prepare(`
      SELECT * FROM trade_log WHERE position_id = ? ORDER BY timestamp ASC
    `).all(positionId) as TradeLog[];
  }

  getRecentLogs(limit: number = 50): TradeLog[] {
    return this.db.prepare(`
      SELECT * FROM trade_log ORDER BY timestamp DESC LIMIT ?
    `).all(limit) as TradeLog[];
  }

  // ============ Statistics Methods ============

  getStats(): {
    totalTrades: number;
    wins: number;
    losses: number;
    totalPnl: number;
    winRate: number;
  } {
    const stats = this.db.prepare(`
      SELECT
        COUNT(*) as totalTrades,
        SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) as wins,
        SUM(CASE WHEN pnl < 0 THEN 1 ELSE 0 END) as losses,
        COALESCE(SUM(pnl), 0) as totalPnl
      FROM positions
      WHERE pnl IS NOT NULL
    `).get() as { totalTrades: number; wins: number; losses: number; totalPnl: number };

    return {
      ...stats,
      winRate: stats.totalTrades > 0 ? (stats.wins / stats.totalTrades) * 100 : 0
    };
  }

  // ============ Capital Baseline Methods ============

  getBaseline(): number {
    const row = this.db.prepare('SELECT baseline FROM capital_baseline WHERE id = 1').get() as CapitalBaseline | undefined;
    return row?.baseline ?? 0;
  }

  setBaseline(value: number): void {
    const existing = this.db.prepare('SELECT * FROM capital_baseline WHERE id = 1').get();
    if (existing) {
      this.db.prepare(`
        UPDATE capital_baseline SET baseline = ?, last_updated = ? WHERE id = 1
      `).run(value, Date.now());
    } else {
      this.db.prepare(`
        INSERT INTO capital_baseline (id, baseline, last_updated) VALUES (1, ?, ?)
      `).run(value, Date.now());
    }
  }

  initializeBaseline(value: number): void {
    // Only set if not exists
    const existing = this.db.prepare('SELECT * FROM capital_baseline WHERE id = 1').get();
    if (!existing) {
      this.db.prepare(`
        INSERT INTO capital_baseline (id, baseline, last_updated) VALUES (1, ?, ?)
      `).run(value, Date.now());
    }
  }

  getBaselineInfo(): CapitalBaseline | null {
    const row = this.db.prepare('SELECT * FROM capital_baseline WHERE id = 1').get() as CapitalBaseline | undefined;
    return row ?? null;
  }

  // ============ Recovery Attempts Methods ============

  getRecoveryAttempts(): number {
    const row = this.db.prepare('SELECT recovery_attempts FROM capital_baseline WHERE id = 1').get() as { recovery_attempts: number } | undefined;
    return row?.recovery_attempts ?? 0;
  }

  incrementRecoveryAttempts(): void {
    this.db.prepare(`
      UPDATE capital_baseline SET recovery_attempts = recovery_attempts + 1, last_updated = ? WHERE id = 1
    `).run(Date.now());
  }

  resetRecoveryAttempts(): void {
    this.db.prepare(`
      UPDATE capital_baseline SET recovery_attempts = 0, last_updated = ? WHERE id = 1
    `).run(Date.now());
  }

  // ============ Signal State Methods ============

  /**
   * Calculate the market start timestamp for a given timestamp
   * Markets run on 15-minute windows aligned to the hour
   */
  private calculateMarketStart(timestampSeconds: number): number {
    const timestampMs = timestampSeconds * 1000;
    const fifteenMinutesMs = 15 * 60 * 1000;
    return Math.floor(timestampMs / fifteenMinutesMs) * fifteenMinutesMs;
  }

  /**
   * Insert or update a signal for a market window
   * Uses REPLACE to handle the UNIQUE constraint on market_start
   */
  insertSignal(timestampSeconds: number, state: string): { marketStart: number; id: number } {
    const marketStart = this.calculateMarketStart(timestampSeconds);
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO signal_state (timestamp, state, market_start, received_at)
      VALUES (?, ?, ?, ?)
    `);
    const result = stmt.run(timestampSeconds, state, marketStart, Date.now());
    return { marketStart, id: result.lastInsertRowid as number };
  }

  /**
   * Get signal for a specific market window
   * @param marketStartMs - Market start timestamp in milliseconds
   */
  getSignalForMarket(marketStartMs: number): SignalState | undefined {
    return this.db.prepare(`
      SELECT * FROM signal_state WHERE market_start = ?
    `).get(marketStartMs) as SignalState | undefined;
  }

  /**
   * Get the most recent signal
   */
  getLatestSignal(): SignalState | undefined {
    return this.db.prepare(`
      SELECT * FROM signal_state ORDER BY received_at DESC LIMIT 1
    `).get() as SignalState | undefined;
  }

  /**
   * Clean up old signals (older than specified timestamp)
   * @param olderThanMs - Timestamp in milliseconds
   */
  cleanOldSignals(olderThanMs: number): number {
    const result = this.db.prepare(`
      DELETE FROM signal_state WHERE market_start < ?
    `).run(olderThanMs);
    return result.changes;
  }

  // ============ Redemption Tracking Methods ============

  /**
   * Get the number of redemption attempts for a condition
   * @returns attempt count (0 if not in DB)
   */
  getRedemptionAttempts(conditionId: string): number {
    const row = this.db.prepare(`
      SELECT attempt_count FROM redemption_tracking WHERE condition_id = ?
    `).get(conditionId) as { attempt_count: number } | undefined;
    return row?.attempt_count ?? 0;
  }

  /**
   * Record a redemption attempt (insert or update, increment attempt_count)
   */
  recordRedemptionAttempt(conditionId: string, marketSlug: string, success: boolean, txHash?: string): void {
    const existing = this.db.prepare(`
      SELECT * FROM redemption_tracking WHERE condition_id = ?
    `).get(conditionId);

    if (existing) {
      this.db.prepare(`
        UPDATE redemption_tracking
        SET attempt_count = attempt_count + 1,
            last_attempt_at = ?,
            last_tx_hash = ?,
            last_success = ?
        WHERE condition_id = ?
      `).run(Date.now(), txHash ?? null, success ? 1 : 0, conditionId);
    } else {
      this.db.prepare(`
        INSERT INTO redemption_tracking (condition_id, market_slug, attempt_count, last_attempt_at, last_tx_hash, last_success, created_at)
        VALUES (?, ?, 1, ?, ?, ?, ?)
      `).run(conditionId, marketSlug, Date.now(), txHash ?? null, success ? 1 : 0, Date.now());
    }
  }

  /**
   * Check if we should attempt redemption (returns false if attempt_count >= 2)
   */
  shouldAttemptRedemption(conditionId: string): boolean {
    const attempts = this.getRedemptionAttempts(conditionId);
    return attempts < 2;
  }

  // ============ Arbitrage Position Methods ============

  createArbitragePosition(
    marketSlug: string,
    conditionId: string,
    upTokenId: string,
    downTokenId: string
  ): number {
    const stmt = this.db.prepare(`
      INSERT INTO arbitrage_positions (market_slug, condition_id, up_token_id, down_token_id, created_at)
      VALUES (?, ?, ?, ?, ?)
    `);
    const result = stmt.run(marketSlug, conditionId, upTokenId, downTokenId, Date.now());
    return result.lastInsertRowid as number;
  }

  getArbitragePosition(conditionId: string): ArbitragePosition | undefined {
    return this.db.prepare(`
      SELECT * FROM arbitrage_positions WHERE condition_id = ?
    `).get(conditionId) as ArbitragePosition | undefined;
  }

  getArbitragePositionById(id: number): ArbitragePosition | undefined {
    return this.db.prepare(`
      SELECT * FROM arbitrage_positions WHERE id = ?
    `).get(id) as ArbitragePosition | undefined;
  }

  getActiveArbitragePosition(): ArbitragePosition | undefined {
    return this.db.prepare(`
      SELECT * FROM arbitrage_positions
      WHERE settled_at IS NULL
      ORDER BY created_at DESC LIMIT 1
    `).get() as ArbitragePosition | undefined;
  }

  getUnsettledArbitragePositions(): ArbitragePosition[] {
    return this.db.prepare(`
      SELECT * FROM arbitrage_positions
      WHERE settled_at IS NULL
      ORDER BY created_at ASC
    `).all() as ArbitragePosition[];
  }

  updateArbitragePosition(
    conditionId: string,
    update: {
      qtyUp: number;
      qtyDown: number;
      costUp: number;
      costDown: number;
      pairCost: number;
      hedgedQty: number;
      guaranteedProfit: number;
    }
  ): void {
    this.db.prepare(`
      UPDATE arbitrage_positions
      SET qty_up = ?, qty_down = ?, cost_up = ?, cost_down = ?,
          pair_cost = ?, hedged_qty = ?, guaranteed_profit = ?
      WHERE condition_id = ?
    `).run(
      update.qtyUp,
      update.qtyDown,
      update.costUp,
      update.costDown,
      update.pairCost,
      update.hedgedQty,
      update.guaranteedProfit,
      conditionId
    );
  }

  markArbitrageProfitLocked(conditionId: string): void {
    this.db.prepare(`
      UPDATE arbitrage_positions SET profit_locked = 1 WHERE condition_id = ?
    `).run(conditionId);
  }

  markArbitrageSettled(conditionId: string, settlementPnl: number): void {
    this.db.prepare(`
      UPDATE arbitrage_positions SET settled_at = ?, settlement_pnl = ? WHERE condition_id = ?
    `).run(Date.now(), settlementPnl, conditionId);
  }

  markArbitrageSideRedeemed(conditionId: string, side: 'UP' | 'DOWN'): void {
    const column = side === 'UP' ? 'up_redeemed' : 'down_redeemed';
    this.db.prepare(`
      UPDATE arbitrage_positions SET ${column} = 1 WHERE condition_id = ?
    `).run(conditionId);
  }

  // ============ Arbitrage Trade Methods ============

  logArbitrageTrade(trade: Omit<ArbitrageTrade, 'id'>): number {
    const stmt = this.db.prepare(`
      INSERT INTO arbitrage_trades (position_id, order_id, side, price, quantity, cost, timestamp)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const result = stmt.run(
      trade.position_id,
      trade.order_id,
      trade.side,
      trade.price,
      trade.quantity,
      trade.cost,
      trade.timestamp
    );
    return result.lastInsertRowid as number;
  }

  getArbitrageTradesForPosition(positionId: number): ArbitrageTrade[] {
    return this.db.prepare(`
      SELECT * FROM arbitrage_trades WHERE position_id = ? ORDER BY timestamp ASC
    `).all(positionId) as ArbitrageTrade[];
  }

  getRecentArbitrageTrades(limit: number = 50): ArbitrageTrade[] {
    return this.db.prepare(`
      SELECT * FROM arbitrage_trades ORDER BY timestamp DESC LIMIT ?
    `).all(limit) as ArbitrageTrade[];
  }

  // ============ Arbitrage Statistics ============

  getArbitrageStats(): {
    totalPositions: number;
    profitLockedCount: number;
    settledCount: number;
    totalSettlementPnl: number;
    avgPairCost: number;
  } {
    const stats = this.db.prepare(`
      SELECT
        COUNT(*) as totalPositions,
        SUM(CASE WHEN profit_locked = 1 THEN 1 ELSE 0 END) as profitLockedCount,
        SUM(CASE WHEN settled_at IS NOT NULL THEN 1 ELSE 0 END) as settledCount,
        COALESCE(SUM(settlement_pnl), 0) as totalSettlementPnl,
        COALESCE(AVG(pair_cost), 0) as avgPairCost
      FROM arbitrage_positions
    `).get() as {
      totalPositions: number;
      profitLockedCount: number;
      settledCount: number;
      totalSettlementPnl: number;
      avgPairCost: number;
    };

    return stats;
  }

  // ============ Scalping Order Methods ============

  createScalpOrder(order: Omit<ScalpOrder, 'id' | 'created_at' | 'filled_at' | 'status' | 'filled_shares' | 'pnl'>): number {
    const stmt = this.db.prepare(`
      INSERT INTO scalp_orders (order_id, condition_id, token_id, side, type, price, shares, linked_buy_id, status, filled_shares)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'OPEN', 0)
    `);
    const result = stmt.run(
      order.order_id,
      order.condition_id,
      order.token_id,
      order.side,
      order.type,
      order.price,
      order.shares,
      order.linked_buy_id ?? null
    );
    return result.lastInsertRowid as number;
  }

  getScalpOrderByOrderId(orderId: string): ScalpOrder | undefined {
    return this.db.prepare(`
      SELECT * FROM scalp_orders WHERE order_id = ?
    `).get(orderId) as ScalpOrder | undefined;
  }

  getOpenScalpOrders(conditionId?: string): ScalpOrder[] {
    if (conditionId) {
      return this.db.prepare(`
        SELECT * FROM scalp_orders WHERE status = 'OPEN' AND condition_id = ? ORDER BY created_at ASC
      `).all(conditionId) as ScalpOrder[];
    }
    return this.db.prepare(`
      SELECT * FROM scalp_orders WHERE status = 'OPEN' ORDER BY created_at ASC
    `).all() as ScalpOrder[];
  }

  getOpenScalpBuyOrders(conditionId: string, side: 'UP' | 'DOWN'): ScalpOrder[] {
    return this.db.prepare(`
      SELECT * FROM scalp_orders
      WHERE status = 'OPEN' AND condition_id = ? AND side = ? AND type = 'BUY'
      ORDER BY price DESC
    `).all(conditionId, side) as ScalpOrder[];
  }

  getOpenScalpSellOrders(conditionId: string, side: 'UP' | 'DOWN'): ScalpOrder[] {
    return this.db.prepare(`
      SELECT * FROM scalp_orders
      WHERE status = 'OPEN' AND condition_id = ? AND side = ? AND type = 'SELL'
      ORDER BY price ASC
    `).all(conditionId, side) as ScalpOrder[];
  }

  updateScalpOrderFill(orderId: string, filledShares: number, pnl?: number): void {
    const order = this.getScalpOrderByOrderId(orderId);
    if (!order) return;

    const newFilledShares = order.filled_shares + filledShares;
    const status = newFilledShares >= order.shares ? 'FILLED' : 'PARTIAL';

    this.db.prepare(`
      UPDATE scalp_orders
      SET filled_shares = ?, status = ?, filled_at = ?, pnl = COALESCE(pnl, 0) + COALESCE(?, 0)
      WHERE order_id = ?
    `).run(newFilledShares, status, new Date().toISOString(), pnl ?? null, orderId);
  }

  cancelScalpOrder(orderId: string): void {
    this.db.prepare(`
      UPDATE scalp_orders SET status = 'CANCELLED' WHERE order_id = ?
    `).run(orderId);
  }

  cancelAllOpenScalpOrders(conditionId?: string): number {
    if (conditionId) {
      return this.db.prepare(`
        UPDATE scalp_orders SET status = 'CANCELLED' WHERE status = 'OPEN' AND condition_id = ?
      `).run(conditionId).changes;
    }
    return this.db.prepare(`
      UPDATE scalp_orders SET status = 'CANCELLED' WHERE status = 'OPEN'
    `).run().changes;
  }

  getScalpingStats(): {
    totalOrders: number;
    filledBuys: number;
    filledSells: number;
    totalPnl: number;
    winRate: number;
  } {
    const stats = this.db.prepare(`
      SELECT
        COUNT(*) as totalOrders,
        SUM(CASE WHEN type = 'BUY' AND status = 'FILLED' THEN 1 ELSE 0 END) as filledBuys,
        SUM(CASE WHEN type = 'SELL' AND status = 'FILLED' THEN 1 ELSE 0 END) as filledSells,
        COALESCE(SUM(CASE WHEN type = 'SELL' THEN pnl ELSE 0 END), 0) as totalPnl,
        SUM(CASE WHEN type = 'SELL' AND pnl > 0 THEN 1 ELSE 0 END) as wins
      FROM scalp_orders
    `).get() as { totalOrders: number; filledBuys: number; filledSells: number; totalPnl: number; wins: number };

    return {
      totalOrders: stats.totalOrders,
      filledBuys: stats.filledBuys,
      filledSells: stats.filledSells,
      totalPnl: stats.totalPnl,
      winRate: stats.filledSells > 0 ? (stats.wins / stats.filledSells) * 100 : 0
    };
  }

  getRecentScalpOrders(limit: number = 50): ScalpOrder[] {
    return this.db.prepare(`
      SELECT * FROM scalp_orders ORDER BY created_at DESC LIMIT ?
    `).all(limit) as ScalpOrder[];
  }

  purgeScalpingData(): { ordersDeleted: number } {
    const ordersDeleted = this.db.prepare(`DELETE FROM scalp_orders`).run().changes;
    console.log(`🗑️  Purged ${ordersDeleted} scalp orders`);
    return { ordersDeleted };
  }

  // ============ Price History Methods (Dashboard) ============

  insertPriceHistory(data: Omit<PriceHistory, 'id'>): number {
    const stmt = this.db.prepare(`
      INSERT INTO price_history (market_slug, condition_id, timestamp, up_bid, up_ask, down_bid, down_ask)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const result = stmt.run(
      data.market_slug,
      data.condition_id,
      data.timestamp,
      data.up_bid,
      data.up_ask,
      data.down_bid,
      data.down_ask
    );
    return result.lastInsertRowid as number;
  }

  getPriceHistory(conditionId: string, limit: number = 900): PriceHistory[] {
    return this.db.prepare(`
      SELECT * FROM price_history
      WHERE condition_id = ?
      ORDER BY timestamp DESC
      LIMIT ?
    `).all(conditionId, limit) as PriceHistory[];
  }

  getLatestPriceHistory(conditionId: string): PriceHistory | undefined {
    return this.db.prepare(`
      SELECT * FROM price_history
      WHERE condition_id = ?
      ORDER BY timestamp DESC
      LIMIT 1
    `).get(conditionId) as PriceHistory | undefined;
  }

  cleanOldPriceHistory(olderThanMs: number): number {
    const result = this.db.prepare(`
      DELETE FROM price_history WHERE timestamp < ?
    `).run(olderThanMs);
    return result.changes;
  }

  // ============ User Fills Methods (Dashboard) ============

  insertUserFill(data: Omit<UserFill, 'id'>): number {
    const stmt = this.db.prepare(`
      INSERT INTO user_fills (market_slug, condition_id, order_id, side, price, size, timestamp)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const result = stmt.run(
      data.market_slug,
      data.condition_id,
      data.order_id,
      data.side,
      data.price,
      data.size,
      data.timestamp
    );
    return result.lastInsertRowid as number;
  }

  getUserFills(conditionId: string, limit: number = 100): UserFill[] {
    return this.db.prepare(`
      SELECT * FROM user_fills
      WHERE condition_id = ?
      ORDER BY timestamp DESC
      LIMIT ?
    `).all(conditionId, limit) as UserFill[];
  }

  getRecentUserFills(limit: number = 50): UserFill[] {
    return this.db.prepare(`
      SELECT * FROM user_fills
      ORDER BY timestamp DESC
      LIMIT ?
    `).all(limit) as UserFill[];
  }

  cleanOldUserFills(olderThanMs: number): number {
    const result = this.db.prepare(`
      DELETE FROM user_fills WHERE timestamp < ?
    `).run(olderThanMs);
    return result.changes;
  }

  // ============ Simulation Tables & Methods ============

  private initSimulationSchema(): void {
    // Simulation runs table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS simulation_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        market_slug TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        ended_at INTEGER,
        initial_balance REAL NOT NULL,
        final_balance REAL,
        total_pnl REAL,
        hedged_qty REAL,
        pair_cost REAL
      );
    `);

    // Simulation trades table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS simulation_trades (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id INTEGER NOT NULL,
        timestamp INTEGER NOT NULL,
        minute REAL NOT NULL,
        side TEXT NOT NULL,
        order_type TEXT NOT NULL,
        price REAL NOT NULL,
        size REAL NOT NULL,
        cost REAL NOT NULL,
        up_qty REAL NOT NULL,
        down_qty REAL NOT NULL,
        up_avg REAL NOT NULL,
        down_avg REAL NOT NULL,
        hedged REAL NOT NULL,
        FOREIGN KEY (run_id) REFERENCES simulation_runs(id)
      );
    `);

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_sim_trades_run ON simulation_trades(run_id);
      CREATE INDEX IF NOT EXISTS idx_sim_trades_timestamp ON simulation_trades(timestamp);
    `);
  }

  createSimulationRun(marketSlug: string, initialBalance: number): number {
    this.initSimulationSchema();
    const stmt = this.db.prepare(`
      INSERT INTO simulation_runs (market_slug, started_at, initial_balance)
      VALUES (?, ?, ?)
    `);
    const result = stmt.run(marketSlug, Date.now(), initialBalance);
    return result.lastInsertRowid as number;
  }

  logSimulationTrade(trade: {
    runId: number;
    timestamp: number;
    minute: number;
    side: 'UP' | 'DOWN';
    orderType: string;
    price: number;
    size: number;
    cost: number;
    upQty: number;
    downQty: number;
    upAvg: number;
    downAvg: number;
    hedged: number;
  }): number {
    const stmt = this.db.prepare(`
      INSERT INTO simulation_trades (run_id, timestamp, minute, side, order_type, price, size, cost, up_qty, down_qty, up_avg, down_avg, hedged)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const result = stmt.run(
      trade.runId,
      trade.timestamp,
      trade.minute,
      trade.side,
      trade.orderType,
      trade.price,
      trade.size,
      trade.cost,
      trade.upQty,
      trade.downQty,
      trade.upAvg,
      trade.downAvg,
      trade.hedged
    );
    return result.lastInsertRowid as number;
  }

  endSimulationRun(runId: number, finalBalance: number, totalPnl: number, hedgedQty: number, pairCost: number): void {
    this.db.prepare(`
      UPDATE simulation_runs
      SET ended_at = ?, final_balance = ?, total_pnl = ?, hedged_qty = ?, pair_cost = ?
      WHERE id = ?
    `).run(Date.now(), finalBalance, totalPnl, hedgedQty, pairCost, runId);
  }

  getSimulationRuns(limit: number = 20): any[] {
    this.initSimulationSchema();
    return this.db.prepare(`
      SELECT * FROM simulation_runs ORDER BY started_at DESC LIMIT ?
    `).all(limit);
  }

  getSimulationTrades(runId: number): any[] {
    return this.db.prepare(`
      SELECT * FROM simulation_trades WHERE run_id = ? ORDER BY timestamp ASC
    `).all(runId);
  }

  getLatestSimulationRun(): any {
    this.initSimulationSchema();
    return this.db.prepare(`
      SELECT * FROM simulation_runs ORDER BY started_at DESC LIMIT 1
    `).get();
  }

  // ============ Utility Methods ============

  close(): void {
    this.db.close();
  }

  /**
   * Purge all arbitrage data (positions and trades)
   * Use with caution - this is irreversible!
   */
  purgeArbitrageData(): { positionsDeleted: number; tradesDeleted: number } {
    const tradesDeleted = this.db.prepare(`DELETE FROM arbitrage_trades`).run().changes;
    const positionsDeleted = this.db.prepare(`DELETE FROM arbitrage_positions`).run().changes;

    console.log(`🗑️  Purged ${positionsDeleted} positions and ${tradesDeleted} trades`);

    return { positionsDeleted, tradesDeleted };
  }
}
