/**
 * User Channel WebSocket Monitor
 *
 * Subscribes to Polymarket user channel to monitor order events.
 * Place manual limit orders and watch this to see fill/cancel/expire events.
 *
 * Usage: npm run userwss
 */

import dotenv from 'dotenv';
import WebSocket from 'ws';
import { ClobClient } from '@polymarket/clob-client';
import { Wallet } from '@ethersproject/wallet';

dotenv.config();

const WS_URL = 'wss://ws-subscriptions-clob.polymarket.com/ws/user';

async function main() {
  // Validate private key
  const privateKey = process.env.POLYMARKET_PRIVATE_KEY;
  if (!privateKey) {
    console.error('Missing POLYMARKET_PRIVATE_KEY in .env');
    process.exit(1);
  }

  console.log('═══════════════════════════════════════════════════════════');
  console.log('   User Channel WebSocket Monitor');
  console.log('═══════════════════════════════════════════════════════════');
  console.log('');
  console.log('Deriving API credentials from private key...');

  // Derive CLOB API credentials (same as PolymarketClient)
  const signer = new Wallet(privateKey);
  const tempClient = new ClobClient(
    'https://clob.polymarket.com',
    137,
    signer
  );

  const creds = await tempClient.createOrDeriveApiKey();

  console.log('');
  console.log('Credentials derived:');
  console.log(`   API Key: ${creds.key.slice(0, 8)}...`);
  console.log(`   Secret:  ${creds.secret.slice(0, 8)}...`);
  console.log('');
  console.log('Connecting to User Channel...');

  const ws = new WebSocket(WS_URL);
  let pingInterval: NodeJS.Timeout | null = null;

  ws.on('open', () => {
    console.log('✅ Connected to User Channel WebSocket');
    console.log('');

    // Subscribe with auth (empty markets array = all markets for this user)
    const subscribeMsg = {
      type: 'user',
      markets: [],  // Empty = all markets
      auth: {
        apiKey: creds.key,
        secret: creds.secret,
        passphrase: creds.passphrase,
      },
    };

    ws.send(JSON.stringify(subscribeMsg));
    console.log('📡 Subscribed to user channel (all markets)');
    console.log('');
    console.log('Waiting for order events...');
    console.log('Place a limit order on Polymarket to see events here.');
    console.log('');
    console.log('─────────────────────────────────────────────────────────────');

    // CRITICAL: Send "PING" string every 10 seconds
    pingInterval = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send('PING');
      }
    }, 10000);
  });

  ws.on('message', (data: Buffer) => {
    const text = data.toString();

    // Skip PONG responses
    if (text === 'PONG' || text === 'pong') {
      return;
    }

    // Skip non-JSON messages
    if (!text.startsWith('{') && !text.startsWith('[')) {
      console.log(`[RAW] ${text}`);
      return;
    }

    try {
      const msg = JSON.parse(text);
      const timestamp = new Date().toISOString().slice(11, 23);

      if (msg.event_type === 'trade') {
        // ═══════════════════════════════════════════════════════════
        // TRADE EVENT - FAK/taker fills
        // CRITICAL: Actual fill is in maker_orders[].matched_amount
        // ═══════════════════════════════════════════════════════════
        console.log(`\n[${timestamp}] ═══ TRADE EVENT (${msg.trader_side}) ═══`);
        console.log(`  Trade ID:       ${msg.id}`);
        console.log(`  Taker Order ID: ${msg.taker_order_id}`);
        console.log(`  Status:         ${msg.status}`);
        console.log(`  Side:           ${msg.side}`);
        console.log(`  Outcome:        ${msg.outcome}`);
        console.log(`  Asset ID:       ${msg.asset_id?.slice(0, 20)}...`);

        // CRITICAL: Show the difference between 'size' (requested) vs actual fill
        console.log(`  ──── SIZE COMPARISON ────`);
        console.log(`  ⚠️  size (REQUESTED):     ${msg.size} shares`);
        console.log(`  ⚠️  price (taker price):  $${msg.price}`);

        // Calculate ACTUAL fill from maker_orders
        const makerOrders = msg.maker_orders || [];
        let actualFill = 0;
        console.log(`  ──── MAKER ORDERS (ACTUAL FILLS) ────`);
        for (let i = 0; i < makerOrders.length; i++) {
          const maker = makerOrders[i];
          const matchedAmount = parseFloat(maker.matched_amount || '0');
          actualFill += matchedAmount;
          console.log(`  [${i}] matched_amount: ${maker.matched_amount} @ $${maker.price} (${maker.outcome})`);
        }

        console.log(`  ──── ACTUAL FILL (sum of matched_amount) ────`);
        console.log(`  ✅ ACTUAL FILL: ${actualFill} shares`);
        console.log(`  ✅ Taker Price: $${msg.price}`);

        // What our code will use
        console.log(`  ──── UserChannelWS.ts WILL EMIT ────`);
        console.log(`  orderId: ${msg.taker_order_id}`);
        console.log(`  size:    ${actualFill} (from sum of matched_amount)`);
        console.log(`  price:   ${parseFloat(msg.price || '0')}`);
        console.log(`  status:  ${msg.status}`);

        console.log('═══════════════════════════════════════\n');

      } else if (msg.event_type === 'order') {
        // ═══════════════════════════════════════════════════════════
        // ORDER EVENT - GTC order lifecycle
        // For GTC orders: size_matched is the actual fill
        // ═══════════════════════════════════════════════════════════
        console.log(`\n[${timestamp}] ═══ ORDER EVENT ═══`);
        console.log(`  Order ID:     ${msg.id}`);
        console.log(`  Status:       ${msg.status}`);
        console.log(`  Side:         ${msg.side}`);
        console.log(`  Order Type:   ${msg.order_type || msg.type || 'N/A'}`);
        console.log(`  Asset ID:     ${msg.asset_id?.slice(0, 20)}...`);
        console.log(`  Market:       ${msg.market?.slice(0, 20)}...`);

        // CRITICAL FIELDS FOR GTC FILL DETECTION
        console.log(`  ──── FILL DATA ────`);
        console.log(`  Size Matched: ${msg.size_matched} shares`);
        console.log(`  Price:        $${msg.price}`);
        console.log(`  Original:     ${msg.original_size || 'N/A'}`);

        // Parsed values
        const parsedSizeMatched = parseFloat(msg.size_matched || '0');
        const parsedPrice = parseFloat(msg.price || '0');
        console.log(`  ──── UserChannelWS.ts WILL EMIT ────`);
        console.log(`  orderId: ${msg.id}`);
        console.log(`  size:    ${parsedSizeMatched} (from size_matched)`);
        console.log(`  price:   ${parsedPrice}`);
        console.log(`  status:  ${msg.status}`);

        // Validation warnings
        if (msg.status === 'MATCHED' && parsedSizeMatched <= 0) {
          console.log(`  ⚠️  WARNING: MATCHED event with size_matched <= 0 (spurious event)`);
        }

        console.log('═══════════════════════════════════════\n');

      } else if (msg.event_type) {
        // Other event types
        console.log(`[${timestamp}] 📨 ${msg.event_type.toUpperCase()}`);
        console.log(`   ${JSON.stringify(msg, null, 2)}`);
        console.log('');
      } else {
        // Unknown format
        console.log(`[${timestamp}] 📨 Message:`);
        console.log(`   ${JSON.stringify(msg, null, 2)}`);
        console.log('');
      }
    } catch (error) {
      console.log(`[PARSE ERROR] ${text}`);
    }
  });

  ws.on('error', (error) => {
    console.error('❌ WebSocket error:', error.message);
  });

  ws.on('close', (code, reason) => {
    console.log(`\n❌ WebSocket closed (code: ${code}, reason: ${reason})`);
    if (pingInterval) clearInterval(pingInterval);
    process.exit(0);
  });

  // Graceful shutdown
  process.on('SIGINT', () => {
    console.log('\n\nShutting down...');
    if (pingInterval) clearInterval(pingInterval);
    ws.close();
    process.exit(0);
  });

  console.log('Press Ctrl+C to exit');
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
