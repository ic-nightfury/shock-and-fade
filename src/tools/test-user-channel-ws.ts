/**
 * test-user-channel-ws.ts — Integration test for UserChannelWS fill detection.
 *
 * Tests:
 *   1. Connect to user channel WebSocket
 *   2. Split $5 → place a SELL limit order near market price (should fill quickly)
 *   3. Verify WS emits "orderFill" event
 *   4. Place another order far off-market, cancel it via API
 *   5. Verify WS emits "orderUpdate" (CANCELLATION) event
 *   6. Merge remaining shares back to USDC
 *
 * Run on Finland (CLOB POST works there):
 *   npx tsx src/tools/test-user-channel-ws.ts
 */

import dotenv from "dotenv";
dotenv.config();

import { UserChannelWS, OrderFillEvent, OrderUpdateEvent } from "../services/UserChannelWS";
import { SplitClient } from "../services/SplitClient";
import { MergeClient } from "../services/MergeClient";
import { PolymarketClient } from "../services/PolymarketClient";

// Use a liquid NBA market — find one that's active
// Fallback: Trump deportation market (always liquid)
const TEST_MARKET = {
  name: "Will Trump deport 750,000 or more people in 2025?",
  conditionId:
    "0x22ac5f75af18fdb453497fbf7ac0606a09a6fd55b78b2d08aace6b946ad62038",
  tokenYes:
    "97449340182256366014320155718265676486703217567849039806162053075113517266910",
  tokenNo:
    "59259495934562596318644973716893809974860301509869285036503555129962149752635",
  isNegRisk: false,
};

const SPLIT_AMOUNT = 5; // $5 — small test

async function timeOp<T>(
  name: string,
  fn: () => Promise<T>
): Promise<{ result: T; ms: number }> {
  const start = Date.now();
  const result = await fn();
  const ms = Date.now() - start;
  return { result, ms };
}

function waitForEvent<T>(
  emitter: UserChannelWS,
  event: string,
  timeoutMs: number,
  filter?: (data: T) => boolean
): Promise<{ data: T; ms: number }> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const timeout = setTimeout(() => {
      emitter.removeListener(event, handler);
      reject(
        new Error(`Timeout waiting for ${event} after ${timeoutMs}ms`)
      );
    }, timeoutMs);

    function handler(data: T) {
      if (filter && !filter(data)) return; // Not the event we're looking for
      clearTimeout(timeout);
      emitter.removeListener(event, handler);
      resolve({ data, ms: Date.now() - start });
    }

    emitter.on(event, handler);
  });
}

async function main() {
  console.log("=".repeat(60));
  console.log("🔌 USER CHANNEL WEBSOCKET TEST");
  console.log("=".repeat(60));
  console.log(`Market: ${TEST_MARKET.name}`);
  console.log(`Split: $${SPLIT_AMOUNT}`);
  console.log(`Auth: ${process.env.AUTH_MODE || "PROXY"}`);
  console.log(`Time: ${new Date().toISOString()}`);
  console.log("");

  const pk = process.env.POLYMARKET_PRIVATE_KEY!;
  if (!pk) {
    console.error("❌ POLYMARKET_PRIVATE_KEY not set");
    process.exit(1);
  }

  // ── Step 0: Initialize clients ──────────────────────────────────────
  console.log("📡 Step 0: Initializing clients...");

  const splitClient = new SplitClient(pk);
  const mergeClient = new MergeClient(pk);
  const polyClient = new PolymarketClient({
    host: process.env.POLYMARKET_HOST || "https://clob.polymarket.com",
    chainId: parseInt(process.env.POLYMARKET_CHAIN_ID || "137"),
    privateKey: pk,
    funderAddress: process.env.POLYMARKET_FUNDER,
    authMode: (process.env.AUTH_MODE || "PROXY") as "EOA" | "PROXY",
  });

  await polyClient.initialize();
  console.log("   ✅ PolymarketClient initialized");

  // ── Step 1: Connect UserChannelWS ──────────────────────────────────
  console.log("\n🔌 Step 1: Connecting UserChannelWS...");

  const apiCreds = await polyClient.getApiCreds();
  const userWS = new UserChannelWS({
    apiKey: apiCreds.key,
    secret: apiCreds.secret,
    passphrase: apiCreds.passphrase,
  });

  // Log all events for debugging
  userWS.on("orderFill", (fill: OrderFillEvent) => {
    console.log(
      `   📨 [WS] orderFill: orderId=${fill.orderId.slice(0, 16)}… price=${fill.price} size=${fill.size} status=${fill.status} side=${fill.side}`
    );
  });
  userWS.on("orderUpdate", (update: OrderUpdateEvent) => {
    console.log(
      `   📨 [WS] orderUpdate: orderId=${update.orderId.slice(0, 16)}… type=${update.type} matched=${update.sizeMatched}/${update.originalSize}`
    );
  });

  const { ms: connectMs } = await timeOp("connect", () => userWS.connect());
  console.log(`   ✅ Connected in ${connectMs}ms`);

  // Subscribe to the test market
  userWS.subscribe([TEST_MARKET.conditionId]);
  console.log(
    `   📡 Subscribed to ${TEST_MARKET.conditionId.slice(0, 16)}…`
  );

  // ── Step 2: Split USDC into tokens ─────────────────────────────────
  console.log(`\n💰 Step 2: Splitting $${SPLIT_AMOUNT}...`);

  const { result: splitResult, ms: splitMs } = await timeOp("split", () =>
    splitClient.split(
      TEST_MARKET.conditionId,
      SPLIT_AMOUNT,
      TEST_MARKET.isNegRisk
    )
  );

  if (!splitResult.success) {
    console.error(`   ❌ Split failed: ${splitResult.error}`);
    userWS.disconnect();
    process.exit(1);
  }
  console.log(`   ✅ Split in ${splitMs}ms`);

  // Wait a bit for chain confirmation
  await new Promise((r) => setTimeout(r, 3000));

  // ── Step 3: Get current market price ───────────────────────────────
  console.log("\n📊 Step 3: Getting market price...");

  let midPrice = 0.5; // fallback
  try {
    const book = await polyClient.getOrderBook(TEST_MARKET.tokenYes);
    if (book && book.bids && book.bids.length > 0) {
      const bestBid = parseFloat(book.bids[0].price);
      const bestAsk =
        book.asks && book.asks.length > 0
          ? parseFloat(book.asks[0].price)
          : bestBid + 0.02;
      midPrice = (bestBid + bestAsk) / 2;
      console.log(
        `   Best bid: ${(bestBid * 100).toFixed(1)}¢, Best ask: ${(bestAsk * 100).toFixed(1)}¢, Mid: ${(midPrice * 100).toFixed(1)}¢`
      );
    }
  } catch (e: any) {
    console.log(`   ⚠️ Could not get order book: ${e?.message}. Using 50¢`);
  }

  // ── Step 4: TEST FILL — place SELL at best bid (should fill fast) ──
  console.log("\n⚡ Step 4: TEST FILL — Placing SELL at best bid price...");

  // Sell YES token at the best bid (aggressive — should fill immediately or very fast)
  const sellPrice = Math.round(midPrice * 100 - 2) / 100; // 2¢ below mid to ensure fill
  const sellShares = SPLIT_AMOUNT;
  console.log(
    `   Placing SELL YES × ${sellShares} @ ${(sellPrice * 100).toFixed(1)}¢ (aggressive, should fill)...`
  );

  // Start listening for fill BEFORE placing the order
  const fillPromise = waitForEvent<OrderFillEvent>(
    userWS,
    "orderFill",
    30_000 // 30s timeout
  );

  const { result: sellResult, ms: sellMs } = await timeOp("sell", () =>
    polyClient.sellSharesGTC(
      TEST_MARKET.tokenYes,
      sellShares,
      sellPrice,
      TEST_MARKET.isNegRisk
    )
  );

  if (!sellResult?.orderID) {
    console.error(`   ❌ Order placement failed: ${JSON.stringify(sellResult)}`);
    // Still continue to test cancellation
  } else {
    console.log(
      `   📋 Order placed in ${sellMs}ms: ${sellResult.orderID.slice(0, 16)}…`
    );

    // Wait for WS fill event
    try {
      const { data: fill, ms: fillMs } = await fillPromise;
      console.log(
        `   ✅ WS FILL received in ${fillMs}ms! orderId=${fill.orderId.slice(0, 16)}… price=${fill.price} status=${fill.status}`
      );
      console.log(`   🎯 Fill latency: ${fillMs}ms (order placed → WS notification)`);
    } catch (e: any) {
      console.error(`   ❌ No WS fill received: ${e.message}`);
      console.log("   ℹ️  Order may not have filled (price too high). Checking via API...");

      // Check order status via polling as fallback
      try {
        const openOrders = await polyClient.getOpenOrders();
        const ourOrder = openOrders?.find(
          (o: any) => o.id === sellResult.orderID
        );
        if (ourOrder) {
          console.log(
            `   📋 Order still open: status=${ourOrder.status} filled=${ourOrder.size_matched}/${ourOrder.original_size}`
          );
          // Cancel it for cleanup
          await polyClient.cancelSingleOrder(sellResult.orderID);
          console.log("   🚫 Cancelled unfilled order");
        } else {
          console.log(
            "   ℹ️  Order not in open orders (may have filled silently or been rejected)"
          );
        }
      } catch (apiErr: any) {
        console.log(`   ⚠️ API check failed: ${apiErr?.message}`);
      }
    }
  }

  // ── Step 5: TEST CANCELLATION — place far off-market, then cancel ──
  console.log(
    "\n🚫 Step 5: TEST CANCELLATION — Placing order far off-market, then cancelling..."
  );

  // Place SELL NO at 99¢ (way above market, won't fill)
  const cancelTestPrice = 0.99;
  console.log(
    `   Placing SELL NO × ${SPLIT_AMOUNT} @ ${cancelTestPrice * 100}¢ (off-market, won't fill)...`
  );

  const { result: cancelTestOrder, ms: cancelPlaceMs } = await timeOp(
    "cancelTestPlace",
    () =>
      polyClient.sellSharesGTC(
        TEST_MARKET.tokenNo,
        SPLIT_AMOUNT,
        cancelTestPrice,
        TEST_MARKET.isNegRisk
      )
  );

  if (!cancelTestOrder?.orderID) {
    console.error(
      `   ❌ Cancel test order placement failed: ${JSON.stringify(cancelTestOrder)}`
    );
  } else {
    console.log(
      `   📋 Order placed in ${cancelPlaceMs}ms: ${cancelTestOrder.orderID.slice(0, 16)}…`
    );

    // Start listening for cancellation BEFORE cancelling
    const cancelPromise = waitForEvent<OrderUpdateEvent>(
      userWS,
      "orderUpdate",
      30_000,
      (update) =>
        update.orderId === cancelTestOrder.orderID &&
        update.type === "CANCELLATION"
    );

    // Wait a moment then cancel
    await new Promise((r) => setTimeout(r, 2000));
    console.log("   Cancelling order via API...");

    const { ms: cancelMs } = await timeOp("cancel", () =>
      polyClient.cancelSingleOrder(cancelTestOrder.orderID)
    );
    console.log(`   📡 Cancel API call: ${cancelMs}ms`);

    // Wait for WS cancellation event
    try {
      const { data: cancelEvt, ms: cancelWsMs } = await cancelPromise;
      console.log(
        `   ✅ WS CANCELLATION received in ${cancelWsMs}ms! orderId=${cancelEvt.orderId.slice(0, 16)}… type=${cancelEvt.type}`
      );
      console.log(
        `   🎯 Cancel detection latency: ${cancelWsMs}ms (cancel sent → WS notification)`
      );
    } catch (e: any) {
      console.error(`   ❌ No WS cancellation received: ${e.message}`);
    }
  }

  // ── Step 6: Cleanup — merge remaining shares ───────────────────────
  console.log("\n🔄 Step 6: Merging remaining shares...");

  try {
    // Cancel any remaining open orders first
    await polyClient.cancelAllOrders().catch(() => {});
    await new Promise((r) => setTimeout(r, 2000));

    const { result: mergeResult, ms: mergeMs } = await timeOp("merge", () =>
      mergeClient.merge(
        TEST_MARKET.conditionId,
        SPLIT_AMOUNT,
        TEST_MARKET.isNegRisk
      )
    );
    if (mergeResult.success) {
      console.log(`   ✅ Merged in ${mergeMs}ms`);
    } else {
      console.log(
        `   ⚠️ Merge failed: ${mergeResult.error} (some shares may have been sold)`
      );
    }
  } catch (e: any) {
    console.log(`   ⚠️ Merge error: ${e?.message} (cleanup manually if needed)`);
  }

  // ── Results ────────────────────────────────────────────────────────
  console.log("\n" + "=".repeat(60));
  console.log("📊 TEST RESULTS");
  console.log("=".repeat(60));
  console.log(`   WS Connect: ✅`);
  console.log(`   Fill Detection: check logs above`);
  console.log(`   Cancel Detection: check logs above`);
  console.log("=".repeat(60));

  // Cleanup
  userWS.disconnect();
  process.exit(0);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
