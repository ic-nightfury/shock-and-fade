#!/usr/bin/env node
import { PennyPickDashboard } from './dashboard/PennyPickDashboard.js';
import { TickDatabase } from './services/TickDatabase.js';
import { TickPollerService } from './services/TickPollerService.js';

const PORT = process.env.PENNY_DASHBOARD_PORT ? parseInt(process.env.PENNY_DASHBOARD_PORT) : 3041;
const SCAN_INTERVAL_MS = process.env.PENNY_SCAN_INTERVAL_MS ? parseInt(process.env.PENNY_SCAN_INTERVAL_MS) : 60000;
const POLL_INTERVAL_MS = process.env.PENNY_POLL_INTERVAL_MS ? parseInt(process.env.PENNY_POLL_INTERVAL_MS) : 300000; // 5 min

const MIN_PRICE = process.env.PENNY_MIN_PRICE ? parseFloat(process.env.PENNY_MIN_PRICE) : 0.005;
const MAX_PRICE = process.env.PENNY_MAX_PRICE ? parseFloat(process.env.PENNY_MAX_PRICE) : 0.10; // Updated from 0.05 based on validation
const MIN_VOLUME = process.env.PENNY_MIN_VOLUME ? parseFloat(process.env.PENNY_MIN_VOLUME) : 20000;
const MAX_SPREAD_PCT = process.env.PENNY_MAX_SPREAD_PCT ? parseFloat(process.env.PENNY_MAX_SPREAD_PCT) : 30;
const MIN_TICK_CROSS_RATE = process.env.PENNY_MIN_TICK_RATE ? parseFloat(process.env.PENNY_MIN_TICK_RATE) : 30; // New: 30% minimum

console.log('Starting Penny Pick Dashboard with Tick Database...');
console.log(`Port: ${PORT}`);
console.log(`Scan interval: ${SCAN_INTERVAL_MS / 1000}s`);
console.log(`Poll interval: ${POLL_INTERVAL_MS / 1000}s`);
console.log(`Price range: ${(MIN_PRICE * 100).toFixed(1)}¢ - ${(MAX_PRICE * 100).toFixed(1)}¢`);
console.log(`Min volume: $${(MIN_VOLUME / 1000).toFixed(0)}K`);
console.log(`Max spread: ${MAX_SPREAD_PCT}%`);
console.log(`Min tick-crossing rate: ${MIN_TICK_CROSS_RATE}%\n`);

(async () => {
  // Initialize tick database and poller
  const tickDb = new TickDatabase('./data/tick-database.db');
  const tickPoller = new TickPollerService(tickDb, {
    pollIntervalMs: POLL_INTERVAL_MS,
    metricsUpdateIntervalMs: 60000, // Update metrics every 1 minute
    maxTokens: 50,
  });

  // Start tick poller
  await tickPoller.start();

  // Initialize dashboard with tick analyzer
  const dashboard = new PennyPickDashboard({
    port: PORT,
    scanIntervalMs: SCAN_INTERVAL_MS,
    scannerConfig: {
      minPrice: MIN_PRICE,
      maxPrice: MAX_PRICE,
      minVolume24h: MIN_VOLUME,
      maxSpreadPct: MAX_SPREAD_PCT,
      minTickCrossRate: MIN_TICK_CROSS_RATE,
    },
    tickAnalyzer: tickPoller.getAnalyzer(),
  });

  await dashboard.start();

  // Graceful shutdown
  const shutdown = async () => {
    console.log('\nShutting down...');
    tickPoller.stop();
    await dashboard.stop();
    tickDb.close();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
})().catch((err) => {
  console.error('Failed to start:', err);
  process.exit(1);
});
