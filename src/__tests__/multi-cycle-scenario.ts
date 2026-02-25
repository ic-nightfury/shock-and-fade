/**
 * multi-cycle-scenario.ts — Manual scenario walkthrough for multi-cycle refactor.
 *
 * Simulates:
 * 1. Shock #1 → ladder orders placed, TP created
 * 2. Price updates → L1 fills for shock #1
 * 3. Shock #2 → second set of ladder orders, second TP
 * 4. Price updates → L1 fills for shock #2
 * 5. Verifies both TPs are independent
 * 6. Adverse event for shock #1 only → cycle 1 exits, cycle 2 holds
 * 7. TP hit for cycle 2 → cycle 2 exits cleanly
 */

import { EventEmitter } from "events";
import * as path from "path";
import * as os from "os";
import { ShockFadeLive, CumulativeTP } from "../strategies/ShockFadeLive";
import { ShockEvent } from "../strategies/ShockFadeDetector";
import { SportsMarket, MarketState } from "../services/SportsMarketDiscovery";

// ── Mocks ──────────────────────────────────────────────────────────

class MockWS extends EventEmitter {
  simulatePriceUpdate(tokenId: string, bid: number, ask: number) {
    this.emit("priceUpdate", { tokenId, bid, ask, timestamp: Date.now() });
  }
  connect() { return Promise.resolve(); }
  disconnect() {}
  addTokens(_ids: string[]) {}
}

class MockPolyClient {
  async sellSharesGTC(_t: string, _s: number, _p: number, _n: boolean) {
    return { success: true, orderID: `mock_${Date.now()}_${Math.random().toString(36).slice(2, 6)}` };
  }
  async sellShares(_t: string, s: number, p: number, _n: boolean) {
    return { success: true, filledShares: s, filledPrice: p };
  }
  async cancelSingleOrder(_id: string) { return { success: true }; }
  async getOpenOrders(_c: string) { return { success: true, orders: [] }; }
  async getTokenBalance(_t: string) { return 200; }
  async getBalance() { return 5000; }
}

class MockSplitClient {
  async split(_c: string, _a: number, _n: boolean) { return { success: true, transactionHash: "0x" }; }
  async ensureCTFApprovals() { return { success: true, alreadyApproved: true }; }
}

class MockMergeClient {
  async merge(_c: string, _a: number, _n: boolean) { return { success: true, transactionHash: "0x" }; }
}

// ── Constants ──────────────────────────────────────────────────────

const TOKEN_A = "0xaaaa_warriors_token";
const TOKEN_B = "0xbbbb_lakers_token";
const MARKET = "nba-gsw-lal-2026-02-09";
const CONDITION = "0xcondition_test";

// ── Helpers ────────────────────────────────────────────────────────

function printState(label: string, trader: ShockFadeLive) {
  console.log(`\n${"═".repeat(60)}`);
  console.log(`  📸 STATE: ${label}`);
  console.log(`${"═".repeat(60)}`);

  const tps = trader.getCumulativeTPs();
  console.log(`  CumulativeTPs: ${tps.length}`);
  for (const tp of tps) {
    console.log(`    [${tp.shockId.slice(0, 20)}…]`);
    console.log(`      market: ${tp.marketSlug}`);
    console.log(`      status: ${tp.status}`);
    console.log(`      shares: ${tp.totalEntryShares} total, ${tp.filledTPShares} TP'd, ${tp.tpShares} remaining`);
    console.log(`      blended entry: ${(tp.blendedEntryPrice * 100).toFixed(1)}¢`);
    console.log(`      TP price: ${(tp.tpPrice * 100).toFixed(1)}¢`);
    console.log(`      shockTeam: ${tp.shockTeam || "unknown"}`);
  }

  const openPos = trader.getOpenPositions();
  console.log(`  Open Positions: ${openPos.length}`);
  for (const p of openPos) {
    console.log(`    ${p.id.slice(0, 20)}… — ${p.soldShares}sh @ ${(p.soldPrice * 100).toFixed(1)}¢ [shock: ${p.shockId.slice(0, 16)}…]`);
  }

  const restingOrders = trader.getActiveOrders();
  console.log(`  Resting Orders: ${restingOrders.length}`);
  for (const o of restingOrders) {
    console.log(`    L${o.level} ${o.shares}sh @ ${(o.price * 100).toFixed(1)}¢ [shock: ${o.shockId.slice(0, 16)}…]`);
  }

  const stats = trader.getStats();
  console.log(`  Stats: ${stats.totalPnL >= 0 ? "+" : ""}$${stats.totalPnL.toFixed(4)} P&L, ${stats.winCount}W/${stats.lossCount}L`);

  const inv = trader.getInventory(MARKET);
  if (inv) {
    console.log(`  Inventory: ${inv.sharesA}A / ${inv.sharesB}B`);
  }
  console.log();
}

// ── Main Scenario ──────────────────────────────────────────────────

async function main() {
  console.log("🧪 Multi-Cycle Scenario Walkthrough");
  console.log("====================================\n");

  const ws = new MockWS();
  const statePath = path.join(os.tmpdir(), `scenario-${Date.now()}.json`);
  const trader = new ShockFadeLive(
    ws as any,
    new MockSplitClient() as any,
    new MockMergeClient() as any,
    new MockPolyClient() as any,
    {
      dryRun: true,
      maxPerGame: 200,
      maxConcurrentGames: 3,
      maxCyclesPerGame: 2,
      maxConsecutiveLosses: 10,
      maxSessionLoss: 100,
      ladderSizes: [5, 10, 15],
      ladderLevels: 3,
      ladderSpacing: 0.03,
      fadeTargetCents: 3,
      sigmaThreshold: 3.0,
      minAbsoluteMove: 0.03,
      rollingWindowMs: 60000,
      fadeWindowMs: 600000,
      maxPositionSize: 100,
      cooldownMs: 30000,
      targetPriceRange: [0.07, 0.91] as [number, number],
    },
    statePath,
  );

  const market: SportsMarket = {
    marketSlug: MARKET,
    conditionId: CONDITION,
    tokenIds: [TOKEN_A, TOKEN_B],
    outcomes: ["Warriors", "Lakers"],
    outcomePrices: [0.5, 0.5],
    negRisk: false,
    sport: "NBA",
    state: MarketState.ACTIVE,
    volume: 50000,
    question: "Will Warriors beat Lakers?",
    startDate: new Date().toISOString(),
    endDate: new Date(Date.now() + 86400000).toISOString(),
  } as SportsMarket;

  trader.registerTokenPair(market);
  trader.start();
  await trader.preSplitForMarket(MARKET);

  printState("After pre-split", trader);

  // ── Step 1: Shock #1 (Warriors spike to 60¢) ──
  console.log("⚡ STEP 1: Shock #1 — Warriors spike to 60¢");
  const shock1: ShockEvent & { shockTeam?: string | null } = {
    type: "shock",
    tokenId: TOKEN_A,
    marketSlug: MARKET,
    direction: "up",
    magnitude: 0.10,
    zScore: 5.0,
    preShockPrice: 0.50,
    currentPrice: 0.60,
    timestamp: Date.now(),
    shockTeam: "GSW",
  };
  await trader.handleShock(shock1);
  printState("After Shock #1", trader);

  // ── Step 2: Price rises, L1 fills for shock #1 ──
  console.log("📈 STEP 2: Price rises → L1 fills for shock #1");
  ws.simulatePriceUpdate(TOKEN_A, 0.64, 0.65);
  await new Promise(r => setTimeout(r, 50));
  printState("After L1 fill (shock #1)", trader);

  // ── Step 3: Shock #2 (Warriors spike again to 68¢, different event) ──
  console.log("⚡ STEP 3: Shock #2 — Warriors spike to 68¢");
  const shock2: ShockEvent & { shockTeam?: string | null } = {
    type: "shock",
    tokenId: TOKEN_A,
    marketSlug: MARKET,
    direction: "up",
    magnitude: 0.08,
    zScore: 4.0,
    preShockPrice: 0.60,
    currentPrice: 0.68,
    timestamp: Date.now() + 5000,
    shockTeam: "GSW",
  };
  await trader.handleShock(shock2);
  printState("After Shock #2", trader);

  // ── Step 4: Price rises more, L1 fills for shock #2 ──
  console.log("📈 STEP 4: Price rises → L1 fills for shock #2");
  ws.simulatePriceUpdate(TOKEN_A, 0.72, 0.73);
  await new Promise(r => setTimeout(r, 50));
  printState("After L1 fill (shock #2)", trader);

  // ── Step 5: Verify independence ──
  console.log("🔍 STEP 5: Verify TPs are independent");
  const tps = trader.getCumulativeTPs();
  console.log(`  TPs: ${tps.length}`);
  if (tps.length === 2) {
    console.log(`  ✅ Two independent TPs with different shockIds`);
    console.log(`    TP1 blended: ${(tps[0].blendedEntryPrice * 100).toFixed(1)}¢, TP price: ${(tps[0].tpPrice * 100).toFixed(1)}¢`);
    console.log(`    TP2 blended: ${(tps[1].blendedEntryPrice * 100).toFixed(1)}¢, TP price: ${(tps[1].tpPrice * 100).toFixed(1)}¢`);
    console.log(`    Independent: ${tps[0].blendedEntryPrice !== tps[1].blendedEntryPrice ? "YES ✅" : "NO ❌"}`);
  } else {
    console.log(`  ❌ Expected 2 TPs, got ${tps.length}`);
  }

  // ── Step 6: Adverse event for shock #1 (GSW scores again) ──
  console.log("\n🏟️ STEP 6: Adverse event — GSW scores again");
  console.log("  → Cycle 1 (shockTeam=GSW) should exit, Cycle 2 (shockTeam=GSW) should ALSO exit (same team)");
  console.log("  → Actually, both cycles have shockTeam=GSW, so both would be adverse.");
  console.log("  → Let's change shock2's team to LAL to test proper per-cycle exit.");

  // Patch shock2's team to LAL for the test
  const tpsBeforeEvent = trader.getCumulativeTPs();
  if (tpsBeforeEvent.length >= 2) {
    // Manually set shock2's team to LAL (in real code this comes from classification)
    (tpsBeforeEvent[1] as any).shockTeam = "LAL";
  }

  await trader.handleGameEvent(MARKET, "GSW");
  printState("After adverse event (GSW scores → cycle 1 exits, cycle 2 holds)", trader);

  const tpsAfterEvent = trader.getCumulativeTPs();
  if (tpsAfterEvent.length === 1) {
    console.log(`  ✅ Only 1 cycle remains (the LAL shock team cycle)`);
    console.log(`    Remaining: shockTeam=${tpsAfterEvent[0].shockTeam}, status=${tpsAfterEvent[0].status}`);
  } else if (tpsAfterEvent.length === 0) {
    console.log(`  ⚠️ Both cycles exited (both had shockTeam=GSW before patch)`);
  } else {
    console.log(`  ❌ Unexpected: ${tpsAfterEvent.length} TPs remain`);
  }

  // ── Step 7: TP hit for remaining cycle ──
  if (tpsAfterEvent.length > 0) {
    console.log("\n💰 STEP 7: TP hit for remaining cycle");
    const remainingTP = tpsAfterEvent[0];
    ws.simulatePriceUpdate(remainingTP.heldTokenId, remainingTP.tpPrice + 0.01, remainingTP.tpPrice + 0.02);
    await new Promise(r => setTimeout(r, 50));
    printState("After TP hit (cycle 2 exits)", trader);

    const finalTPs = trader.getCumulativeTPs();
    if (finalTPs.length === 0) {
      console.log("  ✅ All cycles complete — clean state");
    }
  }

  // Final stats
  const stats = trader.getStats();
  console.log("\n📊 FINAL STATS:");
  console.log(`  Total P&L: ${stats.totalPnL >= 0 ? "+" : ""}$${stats.totalPnL.toFixed(4)}`);
  console.log(`  Wins/Losses: ${stats.winCount}/${stats.lossCount}`);
  console.log(`  Positions opened: ${stats.totalPositionsOpened}, closed: ${stats.totalPositionsClosed}`);
  console.log(`  Orders placed: ${stats.totalOrdersPlaced}, filled: ${stats.totalOrdersFilled}`);

  trader.stop();
  console.log("\n✅ Scenario complete!");
  process.exit(0);
}

main().catch(err => {
  console.error("❌ Scenario failed:", err);
  process.exit(1);
});
