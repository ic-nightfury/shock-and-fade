#!/usr/bin/env npx tsx
/**
 * Entry point for Sports Tick Data Collector
 *
 * Collects real-time order book and trade data from live Polymarket sports markets.
 * Deploy to your server (65.108.219.235) for RQ-006/007 research.
 *
 * Usage:
 *   npx tsx src/run-sports-tick-collector.ts [--data-dir /path]
 *
 * Default data directory on server: /root/poly_arbitrage/sports_tick_data
 */

import { SportsTickCollector } from "./collectors/SportsTickCollector";

const DEFAULT_DATA_DIR = "/root/poly_arbitrage/sports_tick_data";

async function main() {
  const args = process.argv.slice(2);
  let dataDir = DEFAULT_DATA_DIR;

  // Parse CLI args
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--data-dir" || args[i] === "-d") {
      dataDir = args[++i];
    } else if (args[i] === "--help" || args[i] === "-h") {
      console.log(`
Sports Tick Data Collector

Usage:
  npx tsx src/run-sports-tick-collector.ts [options]

Options:
  --data-dir, -d <PATH>   Data directory. Default: ${DEFAULT_DATA_DIR}
  --help, -h              Show this help

Output:
  Data: <data-dir>/YYYY-MM-DD.jsonl
  Logs: <data-dir>/logs/sports_collector.log
      `);
      process.exit(0);
    }
  }

  console.log("Starting Sports Tick Data Collector...");
  console.log(`Data directory: ${dataDir}`);

  const collector = new SportsTickCollector(dataDir);
  await collector.start();
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
