/**
 * run-spread-dashboard.ts — Runner for Spread Scanner Dashboard
 *
 * Starts the real-time spread scanner dashboard on http://localhost:3040
 *
 * Usage:
 *   npm run spread-dashboard
 *   npm run spread-dashboard -- --port=3041 --threshold=3 --sport=NBA
 */

import { SpreadScannerDashboard } from './dashboard/SpreadScannerDashboard';
import { PinnacleOddsClient, SupportedSport } from './services/PinnacleOddsClient';
import { SportsMarketDiscovery } from './services/SportsMarketDiscovery';
import dotenv from 'dotenv';

dotenv.config();

async function main() {
  const args = process.argv.slice(2);
  
  const port = parseInt(args.find(a => a.startsWith('--port='))?.split('=')[1] ?? '3040', 10);
  const threshold = parseInt(args.find(a => a.startsWith('--threshold='))?.split('=')[1] ?? '2', 10);
  const sportArg = args.find(a => a.startsWith('--sport='))?.split('=')[1];
  const updateInterval = parseInt(args.find(a => a.startsWith('--interval='))?.split('=')[1] ?? '30', 10) * 1000;

  // Default to all major US sports
  const sports: SupportedSport[] = sportArg
    ? [sportArg as SupportedSport]
    : ['NBA', 'NFL', 'NHL', 'MLB'];

  console.log('🚀 Starting Spread Scanner Dashboard...\n');
  console.log(`   Port: ${port}`);
  console.log(`   Threshold: ${threshold}¢`);
  console.log(`   Sports: ${sports.join(', ')}`);
  console.log(`   Update interval: ${updateInterval / 1000}s\n`);

  // Initialize services
  const pinnacle = new PinnacleOddsClient();
  const discovery = new SportsMarketDiscovery();

  // Start market discovery
  console.log('📡 Starting market discovery...');
  await discovery.start();
  
  // Wait for initial load
  await new Promise(resolve => setTimeout(resolve, 3000));
  console.log(`✅ Discovery loaded ${discovery.getMarkets().length} markets\n`);

  // Create and start dashboard
  const dashboard = new SpreadScannerDashboard(pinnacle, discovery, {
    port,
    threshold,
    sports,
    updateIntervalMs: updateInterval,
  });

  await dashboard.start();

  console.log(`\n🌐 Dashboard URL: http://localhost:${port}`);
  console.log('   Press Ctrl+C to stop\n');

  // Handle shutdown
  process.on('SIGINT', async () => {
    console.log('\n🛑 Shutting down...');
    await dashboard.stop();
    await discovery.stop();
    process.exit(0);
  });
}

if (require.main === module) {
  main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
}
