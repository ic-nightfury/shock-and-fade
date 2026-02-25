#!/usr/bin/env npx ts-node
/**
 * Emergency Stop CLI - US-407
 *
 * Gracefully stops live trading and cleans up all positions:
 * 1. Sends SIGTERM to running ASSV2_Live process
 * 2. Fetches current token balances
 * 3. MERGEs all pairs (min of UP, DOWN)
 * 4. SELLs remaining imbalance at market price
 * 5. Reports final state
 *
 * Usage:
 *   npx ts-node src/cli/emergency-stop.ts --market btc-updown-15m-1769393700
 *   npx ts-node src/cli/emergency-stop.ts --market all
 *   npx ts-node src/cli/emergency-stop.ts --market all --dry-run
 *   npx ts-node src/cli/emergency-stop.ts --market all --force
 */

import * as fs from "fs";
import * as path from "path";
import { execSync } from "child_process";
import axios from "axios";
import { ethers } from "ethers";
import dotenv from "dotenv";

// Load environment
dotenv.config();

import { PolymarketClient } from "../services/PolymarketClient";
import { MergeClient } from "../services/MergeClient";

// =============================================================================
// Configuration
// =============================================================================

interface CLIArgs {
  market: string; // Market slug or "all"
  dryRun: boolean;
  force: boolean;
  help: boolean;
}

const GAMMA_API = "https://gamma-api.polymarket.com";
const CLOB_API = "https://clob.polymarket.com";

// =============================================================================
// Logging
// =============================================================================

const logFile = `emergency_stop_${Date.now()}.log`;
const logPath = path.join(process.cwd(), logFile);

function log(message: string): void {
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] ${message}`;
  console.log(line);
  fs.appendFileSync(logPath, line + "\n");
}

function logError(message: string): void {
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] ERROR: ${message}`;
  console.error(line);
  fs.appendFileSync(logPath, line + "\n");
}

// =============================================================================
// Argument Parsing
// =============================================================================

function parseArgs(): CLIArgs {
  const args: CLIArgs = {
    market: "",
    dryRun: false,
    force: false,
    help: false,
  };

  const argv = process.argv.slice(2);

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (arg === "--help" || arg === "-h") {
      args.help = true;
    } else if (arg === "--dry-run") {
      args.dryRun = true;
    } else if (arg === "--force" || arg === "-f") {
      args.force = true;
    } else if (arg === "--market" || arg === "-m") {
      args.market = argv[++i] || "";
    }
  }

  return args;
}

function printHelp(): void {
  console.log(`
Emergency Stop CLI - Gracefully stop trading and clean up positions

Usage:
  npx ts-node src/cli/emergency-stop.ts [options]

Options:
  --market, -m <slug>  Market slug to clean up, or "all" for all active markets
  --dry-run            Show what would happen without executing
  --force, -f          Skip confirmation prompt
  --help, -h           Show this help message

Examples:
  # Clean up specific market
  npx ts-node src/cli/emergency-stop.ts --market btc-updown-15m-1769393700

  # Clean up all active 15-min markets
  npx ts-node src/cli/emergency-stop.ts --market all

  # Preview actions without executing
  npx ts-node src/cli/emergency-stop.ts --market all --dry-run

  # Skip confirmation
  npx ts-node src/cli/emergency-stop.ts --market all --force
`);
}

// =============================================================================
// Process Management
// =============================================================================

function findAndStopProcess(): boolean {
  log("Step 1: Looking for running ASSV2 processes...");

  try {
    // Find processes matching our pattern
    const result = execSync(
      "ps aux | grep -E 'ass-v2-live|ASSV2_Live' | grep -v grep || true",
      { encoding: "utf-8" },
    );

    if (!result.trim()) {
      log("  No running ASSV2_Live processes found");
      return true;
    }

    log(`  Found processes:\n${result}`);

    // Extract PIDs
    const lines = result.trim().split("\n");
    const pids: number[] = [];

    for (const line of lines) {
      const parts = line.trim().split(/\s+/);
      if (parts.length >= 2) {
        const pid = parseInt(parts[1], 10);
        if (!isNaN(pid)) {
          pids.push(pid);
        }
      }
    }

    if (pids.length === 0) {
      log("  Could not extract PIDs");
      return true;
    }

    log(`  Sending SIGTERM to PIDs: ${pids.join(", ")}`);

    for (const pid of pids) {
      try {
        process.kill(pid, "SIGTERM");
        log(`  Sent SIGTERM to PID ${pid}`);
      } catch (e: any) {
        if (e.code === "ESRCH") {
          log(`  PID ${pid} already terminated`);
        } else {
          logError(`Failed to kill PID ${pid}: ${e.message}`);
        }
      }
    }

    // Wait a moment for graceful shutdown
    log("  Waiting 3 seconds for graceful shutdown...");
    execSync("sleep 3");

    return true;
  } catch (e: any) {
    logError(`Failed to find/stop processes: ${e.message}`);
    return false;
  }
}

// =============================================================================
// Market Discovery
// =============================================================================

interface MarketInfo {
  slug: string;
  conditionId: string;
  upTokenId: string;
  downTokenId: string;
  endDate: string;
}

async function getActiveMarkets(): Promise<MarketInfo[]> {
  const assets = ["btc", "eth", "sol", "xrp"];
  const markets: MarketInfo[] = [];
  const now = Math.floor(Date.now() / 1000);

  for (const asset of assets) {
    // Get current window
    const windowDuration = 15 * 60;
    const currentWindowStart =
      Math.floor(now / windowDuration) * windowDuration;
    const slug = `${asset}-updown-15m-${currentWindowStart}`;

    try {
      const response = await axios.get(`${GAMMA_API}/markets?slug=${slug}`);
      if (response.data && response.data.length > 0) {
        const market = response.data[0];
        const tokenIds = JSON.parse(market.clobTokenIds);

        markets.push({
          slug: market.slug,
          conditionId: market.conditionId,
          upTokenId: tokenIds[0],
          downTokenId: tokenIds[1],
          endDate: market.endDate,
        });
      }
    } catch (e: any) {
      // Market might not exist, skip
    }
  }

  return markets;
}

async function getMarketBySlug(slug: string): Promise<MarketInfo | null> {
  try {
    const response = await axios.get(`${GAMMA_API}/markets?slug=${slug}`);
    if (response.data && response.data.length > 0) {
      const market = response.data[0];
      const tokenIds = JSON.parse(market.clobTokenIds);

      return {
        slug: market.slug,
        conditionId: market.conditionId,
        upTokenId: tokenIds[0],
        downTokenId: tokenIds[1],
        endDate: market.endDate,
      };
    }
  } catch (e: any) {
    logError(`Failed to fetch market ${slug}: ${e.message}`);
  }
  return null;
}

// =============================================================================
// Position Cleanup
// =============================================================================

async function getTokenBalance(
  clobClient: any,
  tokenId: string,
): Promise<number> {
  try {
    const result = await clobClient.getBalanceAllowance({
      asset_type: 1, // CONDITIONAL
      token_id: tokenId,
    });
    return parseFloat(result.balance) || 0;
  } catch (e: any) {
    logError(`Failed to get balance for token ${tokenId}: ${e.message}`);
    return 0;
  }
}

async function getBookPrice(
  tokenId: string,
): Promise<{ bid: number; ask: number }> {
  try {
    const response = await axios.get(`${CLOB_API}/book?token_id=${tokenId}`);
    const book = response.data;

    const bids = book.bids || [];
    const asks = book.asks || [];

    // Best bid is last in ascending sorted array
    const bestBid =
      bids.length > 0 ? parseFloat(bids[bids.length - 1].price) : 0;
    // Best ask is first in ascending sorted array
    const bestAsk = asks.length > 0 ? parseFloat(asks[0].price) : 1;

    return { bid: bestBid, ask: bestAsk };
  } catch (e: any) {
    logError(`Failed to get book for token ${tokenId}: ${e.message}`);
    return { bid: 0, ask: 1 };
  }
}

async function cleanupMarket(
  market: MarketInfo,
  client: PolymarketClient,
  mergeClient: MergeClient,
  clobClient: any,
  dryRun: boolean,
): Promise<{
  merged: number;
  soldUp: number;
  soldDown: number;
  usdcRecovered: number;
}> {
  const result = { merged: 0, soldUp: 0, soldDown: 0, usdcRecovered: 0 };

  log(`\n=== Cleaning up ${market.slug} ===`);

  // Step 2: Get token balances
  log("Step 2: Fetching token balances...");
  const upBalance = await getTokenBalance(clobClient, market.upTokenId);
  const downBalance = await getTokenBalance(clobClient, market.downTokenId);

  log(`  UP tokens: ${upBalance.toFixed(2)}`);
  log(`  DOWN tokens: ${downBalance.toFixed(2)}`);

  if (upBalance === 0 && downBalance === 0) {
    log("  No tokens to clean up");
    return result;
  }

  // Step 3: MERGE pairs
  const pairsToMerge = Math.floor(Math.min(upBalance, downBalance));
  if (pairsToMerge > 0) {
    log(
      `Step 3: MERGE ${pairsToMerge} pairs → $${pairsToMerge.toFixed(2)} USDC`,
    );

    if (dryRun) {
      log("  [DRY RUN] Would merge pairs");
      result.merged = pairsToMerge;
      result.usdcRecovered += pairsToMerge;
    } else {
      try {
        const mergeResult = await mergeClient.merge(
          market.conditionId,
          pairsToMerge,
        );
        if (mergeResult.success) {
          log(
            `  MERGE success: ${pairsToMerge} pairs → tx: ${mergeResult.transactionHash}`,
          );
          result.merged = pairsToMerge;
          result.usdcRecovered += pairsToMerge;
        } else {
          logError(`  MERGE failed: ${mergeResult.error}`);
        }
      } catch (e: any) {
        logError(`  MERGE error: ${e.message}`);
      }
    }
  } else {
    log("Step 3: No pairs to merge (imbalanced position)");
  }

  // Step 4: SELL remaining imbalance
  const remainingUp = upBalance - pairsToMerge;
  const remainingDown = downBalance - pairsToMerge;

  if (remainingUp > 0) {
    log(`Step 4a: SELL ${remainingUp.toFixed(2)} UP tokens at market price`);

    const { bid } = await getBookPrice(market.upTokenId);
    log(`  Current UP BID: $${bid.toFixed(4)}`);

    if (bid <= 0) {
      logError("  No bid available, cannot sell");
    } else if (dryRun) {
      const estimatedRevenue = remainingUp * bid;
      log(
        `  [DRY RUN] Would sell ${remainingUp.toFixed(2)} UP @ $${bid.toFixed(4)} = $${estimatedRevenue.toFixed(2)}`,
      );
      result.soldUp = remainingUp;
      result.usdcRecovered += estimatedRevenue;
    } else {
      try {
        // Use FAK (Fill-And-Kill) for immediate market execution
        const sellResult = await client.sellSharesIOC(
          market.upTokenId,
          remainingUp,
          bid - 0.01, // Slightly below bid to ensure fill
        );
        if (sellResult.success) {
          const filledShares =
            sellResult.filledShares ||
            sellResult.details?.shares ||
            remainingUp;
          const filledPrice =
            sellResult.filledPrice || sellResult.details?.pricePerShare || bid;
          const totalCost =
            sellResult.details?.totalCost || filledShares * filledPrice;
          log(
            `  SELL UP success: ${filledShares.toFixed(2)} @ $${filledPrice.toFixed(4)} = $${totalCost.toFixed(2)}`,
          );
          result.soldUp = filledShares;
          result.usdcRecovered += totalCost;
        } else {
          logError(`  SELL UP failed: ${sellResult.error}`);
        }
      } catch (e: any) {
        logError(`  SELL UP error: ${e.message}`);
      }
    }
  }

  if (remainingDown > 0) {
    log(
      `Step 4b: SELL ${remainingDown.toFixed(2)} DOWN tokens at market price`,
    );

    const { bid } = await getBookPrice(market.downTokenId);
    log(`  Current DOWN BID: $${bid.toFixed(4)}`);

    if (bid <= 0) {
      logError("  No bid available, cannot sell");
    } else if (dryRun) {
      const estimatedRevenue = remainingDown * bid;
      log(
        `  [DRY RUN] Would sell ${remainingDown.toFixed(2)} DOWN @ $${bid.toFixed(4)} = $${estimatedRevenue.toFixed(2)}`,
      );
      result.soldDown = remainingDown;
      result.usdcRecovered += estimatedRevenue;
    } else {
      try {
        const sellResult = await client.sellSharesIOC(
          market.downTokenId,
          remainingDown,
          bid - 0.01,
        );
        if (sellResult.success) {
          const filledShares =
            sellResult.filledShares ||
            sellResult.details?.shares ||
            remainingDown;
          const filledPrice =
            sellResult.filledPrice || sellResult.details?.pricePerShare || bid;
          const totalCost =
            sellResult.details?.totalCost || filledShares * filledPrice;
          log(
            `  SELL DOWN success: ${filledShares.toFixed(2)} @ $${filledPrice.toFixed(4)} = $${totalCost.toFixed(2)}`,
          );
          result.soldDown = filledShares;
          result.usdcRecovered += totalCost;
        } else {
          logError(`  SELL DOWN failed: ${sellResult.error}`);
        }
      } catch (e: any) {
        logError(`  SELL DOWN error: ${e.message}`);
      }
    }
  }

  return result;
}

// =============================================================================
// Main
// =============================================================================

async function main(): Promise<void> {
  const args = parseArgs();

  if (args.help) {
    printHelp();
    process.exit(0);
  }

  if (!args.market) {
    console.error("Error: --market is required. Use --help for usage.");
    process.exit(1);
  }

  log("╔══════════════════════════════════════════════════════════════╗");
  log("║           EMERGENCY STOP - ASS-V2 POSITION CLEANUP           ║");
  log("╚══════════════════════════════════════════════════════════════╝");
  log(`Log file: ${logPath}`);
  log(`Mode: ${args.dryRun ? "DRY RUN (no changes)" : "LIVE EXECUTION"}`);
  log(`Market: ${args.market}`);

  // Confirmation
  if (!args.force && !args.dryRun) {
    console.log(
      "\n⚠️  WARNING: This will stop trading and liquidate positions!",
    );
    console.log("Press Ctrl+C within 5 seconds to abort...\n");
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }

  // Initialize clients
  const privateKey =
    process.env.PRIVATE_KEY || process.env.POLYMARKET_PRIVATE_KEY;
  const funderAddress =
    process.env.FUNDER_ADDRESS || process.env.POLYMARKET_FUNDER;

  if (!privateKey || !funderAddress) {
    logError("Missing PRIVATE_KEY or FUNDER_ADDRESS in environment");
    process.exit(1);
  }

  log("\nInitializing clients...");
  const client = new PolymarketClient({
    privateKey,
    funderAddress,
    host: "https://clob.polymarket.com",
    chainId: 137,
  });
  await client.initialize();

  const mergeClient = new MergeClient(privateKey);
  const clobClient = (client as any).clobClient;

  // Step 1: Stop running processes
  if (!args.dryRun) {
    findAndStopProcess();
  } else {
    log("Step 1: [DRY RUN] Would stop running ASSV2 processes");
  }

  // Get markets to clean up
  let markets: MarketInfo[] = [];

  if (args.market === "all") {
    log("\nDiscovering active markets...");
    markets = await getActiveMarkets();
    log(`Found ${markets.length} active markets`);
  } else {
    const market = await getMarketBySlug(args.market);
    if (market) {
      markets = [market];
    } else {
      logError(`Market not found: ${args.market}`);
      process.exit(1);
    }
  }

  if (markets.length === 0) {
    log("No markets to clean up");
    process.exit(0);
  }

  // Process each market
  let totalMerged = 0;
  let totalSoldUp = 0;
  let totalSoldDown = 0;
  let totalRecovered = 0;

  for (const market of markets) {
    const result = await cleanupMarket(
      market,
      client,
      mergeClient,
      clobClient,
      args.dryRun,
    );
    totalMerged += result.merged;
    totalSoldUp += result.soldUp;
    totalSoldDown += result.soldDown;
    totalRecovered += result.usdcRecovered;
  }

  // Step 5: Final report
  log("\n" + "=".repeat(60));
  log("EMERGENCY STOP COMPLETE");
  log("=".repeat(60));

  // Get final USDC balance
  const finalBalance = await client.getBalance();
  log(`\nFinal USDC Balance: $${finalBalance?.toFixed(2) || "unknown"}`);
  log(`\nRecovery Summary:`);
  log(`  Pairs merged: ${totalMerged}`);
  log(`  UP tokens sold: ${totalSoldUp.toFixed(2)}`);
  log(`  DOWN tokens sold: ${totalSoldDown.toFixed(2)}`);
  log(`  USDC recovered: $${totalRecovered.toFixed(2)}`);

  if (args.dryRun) {
    log("\n[DRY RUN] No actual changes were made");
  }

  log(`\nFull log saved to: ${logPath}`);
}

main().catch((e) => {
  logError(`Fatal error: ${e.message}`);
  console.error(e);
  process.exit(1);
});
