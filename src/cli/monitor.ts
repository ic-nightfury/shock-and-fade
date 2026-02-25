#!/usr/bin/env ts-node
/**
 * CLI: Real-time Position & Trade Monitor
 *
 * Usage:
 *   npm run monitor              # Monitor current market positions/trades
 *   npm run monitor -- --all     # Show all activity (not just current market)
 *
 * Displays:
 * - Current BTC 15-min market info
 * - Active positions (UP/DOWN shares, costs, PNL)
 * - Pending orders (GTC orders on book)
 * - Recent trades/activity
 *
 * Refreshes every 2 seconds. Respects AUTH_MODE for wallet selection.
 */

import dotenv from 'dotenv';
import { ethers } from 'ethers';
import Database from 'better-sqlite3';
import path from 'path';
import { PolymarketClient } from '../services/PolymarketClient';
import { PolymarketConfig } from '../types';

dotenv.config();

// APIs
const GAMMA_API = 'https://gamma-api.polymarket.com/markets';
const POSITIONS_API = 'https://data-api.polymarket.com/positions';
const ACTIVITY_API = 'https://data-api.polymarket.com/activity';

// Refresh interval
const REFRESH_INTERVAL_MS = 2000;

// Parse args
const SHOW_ALL = process.argv.includes('--all');

// Database path
const DB_PATH = process.env.DATABASE_PATH || './data/trading.db';

interface MarketInfo {
  slug: string;
  question: string;
  conditionId: string;
  endDate: string;
  outcomes: string[];
  outcomePrices: string[];
  clobTokenIds: string[];
  volume24hr: number;
  liquidity: number;
}

interface Position {
  proxyWallet: string;
  asset: string;
  conditionId: string;
  size: number;
  avgPrice: number;
  initialValue: number;
  currentValue: number;
  cashPnl: number;
  realizedPnl: number;
  curPrice: number;
  title: string;
  slug: string;
  outcome: string;
  outcomeIndex: number;
}

interface Activity {
  proxyWallet: string;
  timestamp: number;
  conditionId: string;
  type: string;
  size: number;
  usdcSize: number;
  transactionHash: string;
  price: number;
  asset: string;
  side: string;
  outcomeIndex: number;
  title: string;
  slug: string;
  outcome: string;
}

interface OpenOrder {
  id: string;
  market: string;
  asset_id: string;
  side: 'BUY' | 'SELL';
  price: string;
  original_size: string;
  size_matched: string;
  outcome: string;
  created_at: number;
}

// Database for storing trades
class MonitorDatabase {
  private db: Database.Database;

  constructor(dbPath: string) {
    // Ensure directory exists
    const dir = path.dirname(dbPath);
    const fs = require('fs');
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    this.db = new Database(dbPath);
    this.initSchema();
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS monitor_trades (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        transaction_hash TEXT UNIQUE,
        timestamp INTEGER NOT NULL,
        condition_id TEXT NOT NULL,
        type TEXT NOT NULL,
        side TEXT,
        outcome TEXT,
        size REAL NOT NULL,
        usdc_size REAL NOT NULL,
        price REAL,
        slug TEXT,
        created_at INTEGER DEFAULT (strftime('%s', 'now'))
      );

      CREATE INDEX IF NOT EXISTS idx_monitor_trades_condition ON monitor_trades(condition_id);
      CREATE INDEX IF NOT EXISTS idx_monitor_trades_timestamp ON monitor_trades(timestamp DESC);
    `);
  }

  recordTrade(activity: Activity): boolean {
    try {
      const stmt = this.db.prepare(`
        INSERT OR IGNORE INTO monitor_trades
        (transaction_hash, timestamp, condition_id, type, side, outcome, size, usdc_size, price, slug)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const result = stmt.run(
        activity.transactionHash,
        activity.timestamp,
        activity.conditionId,
        activity.type,
        activity.side || null,
        activity.outcome || null,
        activity.size,
        activity.usdcSize,
        activity.price || null,
        activity.slug
      );
      return result.changes > 0;
    } catch {
      return false;
    }
  }

  getRecentTrades(conditionId: string, limit: number = 20): any[] {
    const stmt = this.db.prepare(`
      SELECT * FROM monitor_trades
      WHERE condition_id = ?
      ORDER BY timestamp DESC
      LIMIT ?
    `);
    return stmt.all(conditionId, limit);
  }

  close(): void {
    this.db.close();
  }
}

async function findCurrentMarket(): Promise<MarketInfo | null> {
  const now = Math.floor(Date.now() / 1000);
  const windowStart = Math.floor(now / 900) * 900;

  // Try current window
  let slug = `btc-updown-15m-${windowStart}`;
  let market = await fetchMarket(slug);
  if (market) return market;

  // Try next window
  const nextWindowStart = windowStart + 900;
  slug = `btc-updown-15m-${nextWindowStart}`;
  market = await fetchMarket(slug);

  return market;
}

async function fetchMarket(slug: string): Promise<MarketInfo | null> {
  try {
    const response = await fetch(`${GAMMA_API}?slug=${slug}&include_tag=true`);
    if (!response.ok) return null;

    const markets = await response.json() as any[];
    if (!markets || markets.length === 0) return null;

    const m = markets[0];
    return {
      slug: m.slug,
      question: m.question,
      conditionId: m.conditionId,
      endDate: m.endDate,
      outcomes: typeof m.outcomes === 'string' ? JSON.parse(m.outcomes) : m.outcomes || [],
      outcomePrices: typeof m.outcomePrices === 'string' ? JSON.parse(m.outcomePrices) : m.outcomePrices || [],
      clobTokenIds: typeof m.clobTokenIds === 'string' ? JSON.parse(m.clobTokenIds) : m.clobTokenIds || [],
      volume24hr: parseFloat(m.volume24hr) || 0,
      liquidity: parseFloat(m.liquidity) || 0,
    };
  } catch {
    return null;
  }
}

async function fetchPositions(wallet: string, conditionId?: string): Promise<Position[]> {
  try {
    let url = `${POSITIONS_API}?sizeThreshold=0.01&limit=100&user=${wallet}`;
    if (conditionId) {
      url += `&market=${conditionId}`;
    }

    const response = await fetch(url);
    if (!response.ok) return [];

    return await response.json() as Position[];
  } catch {
    return [];
  }
}

async function fetchActivity(wallet: string, conditionId?: string, limit: number = 20): Promise<Activity[]> {
  try {
    let url = `${ACTIVITY_API}?limit=${limit}&sortBy=TIMESTAMP&sortDirection=DESC&user=${wallet}`;
    if (conditionId) {
      url += `&market=${conditionId}`;
    }

    const response = await fetch(url);
    if (!response.ok) return [];

    return await response.json() as Activity[];
  } catch {
    return [];
  }
}

function clearScreen(): void {
  process.stdout.write('\x1B[2J\x1B[0f');
}

function formatTime(timestamp: number): string {
  const date = new Date(timestamp * 1000);
  return date.toLocaleTimeString('en-US', { hour12: false });
}

function formatTimeRemaining(endDate: string): string {
  const end = new Date(endDate).getTime();
  const now = Date.now();
  const remaining = end - now;

  if (remaining <= 0) return 'ENDED';

  const minutes = Math.floor(remaining / 60000);
  const seconds = Math.floor((remaining % 60000) / 1000);

  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

function formatPrice(price: number): string {
  return `$${price.toFixed(3)}`;
}

function formatPnl(pnl: number): string {
  const sign = pnl >= 0 ? '+' : '';
  const color = pnl >= 0 ? '\x1b[32m' : '\x1b[31m';
  const reset = '\x1b[0m';
  return `${color}${sign}$${pnl.toFixed(2)}${reset}`;
}

async function displayMonitor(
  wallet: string,
  market: MarketInfo | null,
  db: MonitorDatabase,
  client: PolymarketClient
): Promise<void> {
  clearScreen();

  const now = new Date().toLocaleTimeString('en-US', { hour12: false });

  console.log('═══════════════════════════════════════════════════════════');
  console.log('                 POSITION & TRADE MONITOR');
  console.log('═══════════════════════════════════════════════════════════');
  console.log(`   Last Update: ${now}   |   Refresh: ${REFRESH_INTERVAL_MS / 1000}s`);
  console.log(`   Wallet: ${wallet.substring(0, 10)}...${wallet.substring(wallet.length - 8)}`);

  if (!market) {
    console.log('\n   ⚠️  No active BTC 15-min market found');
    console.log('   Waiting for next market...');
    return;
  }

  // Market info
  console.log('\n───────────────────────────────────────────────────────────');
  console.log('CURRENT MARKET');
  console.log('───────────────────────────────────────────────────────────');
  console.log(`   ${market.slug}`);
  console.log(`   Remaining: ${formatTimeRemaining(market.endDate)}`);

  // Prices
  const upPrice = parseFloat(market.outcomePrices[0] || '0');
  const downPrice = parseFloat(market.outcomePrices[1] || '0');
  const upBar = '█'.repeat(Math.round(upPrice * 20));
  const downBar = '█'.repeat(Math.round(downPrice * 20));

  console.log(`\n   UP:   ${formatPrice(upPrice)} ${upBar}`);
  console.log(`   DOWN: ${formatPrice(downPrice)} ${downBar}`);
  console.log(`\n   Volume 24h: $${(market.volume24hr || 0).toFixed(0)}   Liquidity: $${(market.liquidity || 0).toFixed(0)}`);

  // Fetch positions for this market
  const positions = await fetchPositions(wallet, SHOW_ALL ? undefined : market.conditionId);

  // Filter to current market if not showing all
  const marketPositions = SHOW_ALL
    ? positions
    : positions.filter(p => p.conditionId === market.conditionId);

  console.log('\n───────────────────────────────────────────────────────────');
  console.log('POSITIONS');
  console.log('───────────────────────────────────────────────────────────');

  if (marketPositions.length === 0) {
    console.log('   No active positions');
  } else {
    let totalCost = 0;
    let totalValue = 0;

    for (const pos of marketPositions) {
      const pnl = pos.currentValue - pos.initialValue;
      totalCost += pos.initialValue;
      totalValue += pos.currentValue;

      const outcomeIcon = pos.outcome === 'Up' ? '🟢' : '🔴';
      console.log(`\n   ${outcomeIcon} ${pos.outcome.toUpperCase()}`);
      console.log(`      Shares: ${pos.size.toFixed(2)} @ avg ${formatPrice(pos.avgPrice)}`);
      console.log(`      Cost: $${pos.initialValue.toFixed(2)} | Value: $${pos.currentValue.toFixed(2)}`);
      console.log(`      PNL: ${formatPnl(pnl)} (${((pnl / pos.initialValue) * 100).toFixed(1)}%)`);

      if (SHOW_ALL && pos.slug !== market.slug) {
        console.log(`      Market: ${pos.slug}`);
      }
    }

    if (marketPositions.length > 0) {
      const totalPnl = totalValue - totalCost;
      console.log(`\n   ─────────────────────────────────────`);
      console.log(`   TOTAL: Cost $${totalCost.toFixed(2)} | Value $${totalValue.toFixed(2)} | PNL ${formatPnl(totalPnl)}`);
    }
  }

  // Fetch pending orders
  console.log('\n───────────────────────────────────────────────────────────');
  console.log('PENDING ORDERS');
  console.log('───────────────────────────────────────────────────────────');

  try {
    const ordersResult = await client.getOpenOrders(market.conditionId);

    if (!ordersResult.success || !ordersResult.orders || ordersResult.orders.length === 0) {
      console.log('   No pending orders');
    } else {
      for (const order of ordersResult.orders as OpenOrder[]) {
        const side = order.side;
        const sideIcon = side === 'BUY' ? '🟢' : '🔴';
        const sideColor = side === 'BUY' ? '\x1b[32m' : '\x1b[31m';
        const reset = '\x1b[0m';

        const price = parseFloat(order.price);
        const originalSize = parseFloat(order.original_size);
        const sizeMatched = parseFloat(order.size_matched || '0');
        const remaining = originalSize - sizeMatched;
        const totalValue = remaining * price;

        // Determine outcome from asset_id by matching with market clobTokenIds
        let outcome = 'Unknown';
        if (market.clobTokenIds && market.clobTokenIds.length >= 2) {
          if (order.asset_id === market.clobTokenIds[0]) {
            outcome = market.outcomes[0] || 'Up';
          } else if (order.asset_id === market.clobTokenIds[1]) {
            outcome = market.outcomes[1] || 'Down';
          }
        }

        console.log(
          `   ${sideIcon} ${sideColor}${side}${reset} ${outcome} ` +
          `${remaining.toFixed(2)} @ ${formatPrice(price)} = $${totalValue.toFixed(2)}`
        );

        if (sizeMatched > 0) {
          console.log(`      Filled: ${sizeMatched.toFixed(2)}/${originalSize.toFixed(2)}`);
        }
      }
    }
  } catch (error: any) {
    console.log(`   ⚠️ Could not fetch orders: ${error.message}`);
  }

  // Fetch recent activity
  const activity = await fetchActivity(wallet, SHOW_ALL ? undefined : market.conditionId, 10);

  // Store new trades
  let newTrades = 0;
  for (const act of activity) {
    if (db.recordTrade(act)) {
      newTrades++;
    }
  }

  console.log('\n───────────────────────────────────────────────────────────');
  console.log(`RECENT ACTIVITY${newTrades > 0 ? ` (+${newTrades} new)` : ''}`);
  console.log('───────────────────────────────────────────────────────────');

  if (activity.length === 0) {
    console.log('   No recent activity');
  } else {
    for (const act of activity.slice(0, 8)) {
      const time = formatTime(act.timestamp);
      const typeIcon = getTypeIcon(act.type);
      const sideColor = act.side === 'BUY' ? '\x1b[32m' : act.side === 'SELL' ? '\x1b[31m' : '\x1b[33m';
      const reset = '\x1b[0m';

      if (act.type === 'TRADE') {
        console.log(
          `   ${time} ${typeIcon} ${sideColor}${act.side}${reset} ${act.outcome || ''} ` +
          `${act.size.toFixed(2)} @ ${formatPrice(act.price)} = $${act.usdcSize.toFixed(2)}`
        );
      } else {
        console.log(
          `   ${time} ${typeIcon} ${sideColor}${act.type}${reset} $${act.usdcSize.toFixed(2)}`
        );
      }

      if (SHOW_ALL && act.slug !== market.slug) {
        console.log(`         └─ ${act.slug}`);
      }
    }
  }

  console.log('\n───────────────────────────────────────────────────────────');
  console.log('   Press Ctrl+C to exit');
  console.log('═══════════════════════════════════════════════════════════');
}

function getTypeIcon(type: string): string {
  switch (type) {
    case 'TRADE': return '📊';
    case 'SPLIT': return '🔀';
    case 'MERGE': return '🔗';
    case 'REDEEM': return '💰';
    default: return '📝';
  }
}

async function main() {
  // Validate environment
  const privateKey = process.env.POLYMARKET_PRIVATE_KEY;
  const authMode = (process.env.AUTH_MODE || 'PROXY') as 'EOA' | 'PROXY';
  const funderAddress = process.env.POLYMARKET_FUNDER;

  if (!privateKey) {
    console.error('❌ Missing POLYMARKET_PRIVATE_KEY');
    process.exit(1);
  }

  // Determine target wallet based on AUTH_MODE
  let targetWallet: string;
  if (authMode === 'EOA') {
    const wallet = new ethers.Wallet(privateKey);
    targetWallet = wallet.address;
  } else {
    if (!funderAddress) {
      console.error('❌ Missing POLYMARKET_FUNDER (required in PROXY mode)');
      console.error('   Set AUTH_MODE=EOA to use signer as funder');
      process.exit(1);
    }
    targetWallet = funderAddress;
  }

  // Initialize database
  const db = new MonitorDatabase(DB_PATH);

  // Handle graceful shutdown
  process.on('SIGINT', () => {
    console.log('\n\n👋 Monitor stopped');
    db.close();
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    db.close();
    process.exit(0);
  });

  console.log('Starting monitor...');
  console.log(`Mode: ${authMode}`);
  console.log(`Wallet: ${targetWallet}`);
  console.log(`Showing: ${SHOW_ALL ? 'All markets' : 'Current market only'}`);

  // Initialize PolymarketClient for fetching orders
  const config: PolymarketConfig = {
    host: process.env.POLYMARKET_HOST || 'https://clob.polymarket.com',
    chainId: parseInt(process.env.POLYMARKET_CHAIN_ID || '137'),
    privateKey,
    funderAddress: targetWallet,
    authMode,
  };
  const client = new PolymarketClient(config);
  await client.initialize();

  // Initial display
  let market = await findCurrentMarket();
  await displayMonitor(targetWallet, market, db, client);

  // Refresh loop
  setInterval(async () => {
    try {
      market = await findCurrentMarket();
      await displayMonitor(targetWallet, market, db, client);
    } catch (error: any) {
      console.error(`\n❌ Error: ${error.message}`);
    }
  }, REFRESH_INTERVAL_MS);
}

main().catch((error) => {
  console.error('❌ Error:', error.message);
  process.exit(1);
});
