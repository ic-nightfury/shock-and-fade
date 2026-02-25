#!/usr/bin/env tsx
/**
 * Test CLOB /trades endpoint with proper authentication
 */

import { ClobClient } from "@polymarket/clob-client";
import { Wallet } from "@ethersproject/wallet";
import dotenv from 'dotenv';

dotenv.config();

async function testClobTrades() {
  const privateKey = process.env.POLYMARKET_PRIVATE_KEY;
  const host = process.env.POLYMARKET_HOST || "https://clob.polymarket.com";
  const chainId = 137; // Polygon
  
  if (!privateKey) {
    console.error('POLYMARKET_PRIVATE_KEY not found in .env');
    process.exit(1);
  }
  
  console.log('=== INITIALIZING CLOB CLIENT ===');
  console.log('Host:', host);
  console.log('Chain ID:', chainId);
  console.log();
  
  const signer = new Wallet(privateKey);
  
  // Step 1: Create API key credentials
  console.log('Creating API key credentials...');
  const tempClient = new ClobClient(host, chainId, signer);
  const apiCreds = await tempClient.createOrDeriveApiKey();
  console.log('✓ API key created');
  console.log('  API Key:', apiCreds.apiKey.substring(0, 20) + '...');
  console.log('  Secret:', apiCreds.secret.substring(0, 20) + '...');
  console.log();
  
  // Step 2: Initialize authenticated client
  console.log('Initializing authenticated client...');
  const client = new ClobClient(host, chainId, signer, apiCreds);
  console.log('✓ Client initialized');
  console.log();
  
  // Step 3: Get a test market
  console.log('=== FETCHING TEST MARKET ===');
  const gammaRes = await fetch('https://gamma-api.polymarket.com/markets?slug=will-chelsea-clinton-win-the-2028-democratic-presidential-nomination');
  const markets = await gammaRes.json();
  
  if (!Array.isArray(markets) || markets.length === 0) {
    console.error('Failed to fetch test market');
    return;
  }
  
  const market = markets[0];
  const tokenIds = JSON.parse(market.clobTokenIds);
  const tokenId = tokenIds[0];
  
  console.log('Market:', market.question);
  console.log('Token ID:', tokenId);
  console.log('Current price:', market.outcomePrices);
  console.log('24h volume:', market.volume24hr);
  console.log();
  
  // Step 4: Try fetching trades via authenticated API
  console.log('=== TESTING TRADES API (Method 1: Direct HTTP with auth headers) ===');
  try {
    const tradesUrl = `${host}/trades?asset_id=${tokenId}&limit=100`;
    console.log('URL:', tradesUrl);
    
    // The API key should be in headers
    const authHeaders = {
      'POLY-ADDRESS': signer.address,
      'POLY-SIGNATURE': apiCreds.apiKey,
      'POLY-TIMESTAMP': Date.now().toString(),
    };
    
    const res = await fetch(tradesUrl, {
      headers: authHeaders
    });
    
    console.log('Status:', res.status);
    
    if (res.ok) {
      const trades = await res.json();
      console.log('✓ Success! Got', Array.isArray(trades) ? trades.length : 'N/A', 'trades');
      
      if (Array.isArray(trades) && trades.length > 0) {
        console.log('\nSample trades (first 5):');
        trades.slice(0, 5).forEach((t: any, i: number) => {
          const price = (parseFloat(t.price) * 100).toFixed(2);
          const size = parseFloat(t.size).toFixed(0);
          const timestamp = new Date(t.match_time * 1000).toISOString();
          console.log(`  ${i+1}. ${price}¢ x ${size} shares @ ${timestamp}`);
        });
      }
    } else {
      const error = await res.text();
      console.log('✗ Failed:', error);
    }
  } catch (err: any) {
    console.error('✗ Error:', err.message);
  }
  
  console.log();
  
  // Step 5: Try using CLOB client method (if exists)
  console.log('=== TESTING TRADES API (Method 2: CLOB Client) ===');
  try {
    // Check if client has a getTrades or similar method
    const clientMethods = Object.getOwnPropertyNames(Object.getPrototypeOf(client));
    console.log('Available methods:', clientMethods.filter(m => m.includes('trade') || m.includes('Trade')).join(', ') || 'none');
    
    // Try direct API call via client's internal axios instance (if accessible)
    if ((client as any).api) {
      console.log('Client has .api property, attempting direct call...');
      const tradesRes = await (client as any).api.get(`/trades?asset_id=${tokenId}&limit=100`);
      console.log('✓ Success via client.api! Got', tradesRes.data.length, 'trades');
    } else {
      console.log('No .api property found on client');
    }
  } catch (err: any) {
    console.error('✗ Error:', err.message);
  }
  
  console.log();
  
  // Step 6: Manual authenticated request with proper signing
  console.log('=== TESTING TRADES API (Method 3: Signed request) ===');
  try {
    const timestamp = Date.now().toString();
    const message = `${signer.address}${timestamp}`;
    const signature = await signer.signMessage(message);
    
    const tradesUrl = `${host}/trades?asset_id=${tokenId}&limit=100`;
    const res = await fetch(tradesUrl, {
      headers: {
        'POLY-ADDRESS': signer.address,
        'POLY-SIGNATURE': signature,
        'POLY-TIMESTAMP': timestamp,
        'POLY-API-KEY': apiCreds.apiKey,
        'POLY-PASSPHRASE': apiCreds.apiPassphrase || '',
      }
    });
    
    console.log('Status:', res.status);
    
    if (res.ok) {
      const trades = await res.json();
      console.log('✓ Success! Got', Array.isArray(trades) ? trades.length : 'N/A', 'trades');
      
      if (Array.isArray(trades) && trades.length > 0) {
        console.log('\nAnalyzing tick crossings...');
        analyzeTrades(trades);
      }
    } else {
      const error = await res.text();
      console.log('✗ Failed:', error);
    }
  } catch (err: any) {
    console.error('✗ Error:', err.message);
  }
}

function analyzeTrades(trades: any[]) {
  const now = Math.floor(Date.now() / 1000);
  const oneHourAgo = now - 3600;
  
  const recentTrades = trades.filter(t => t.match_time >= oneHourAgo);
  console.log(`Trades in last hour: ${recentTrades.length}`);
  
  if (recentTrades.length === 0) {
    console.log('No trades in last hour');
    return;
  }
  
  const prices = recentTrades.map(t => parseFloat(t.price));
  const minPrice = Math.min(...prices);
  const maxPrice = Math.max(...prices);
  const priceRange = maxPrice - minPrice;
  const tickSize = 0.001; // 0.1¢
  
  console.log(`Price range: ${(minPrice * 100).toFixed(2)}¢ - ${(maxPrice * 100).toFixed(2)}¢`);
  console.log(`Oscillation: ${(priceRange * 100).toFixed(2)}¢`);
  console.log(`Ticks crossed: ${Math.floor(priceRange / tickSize)}`);
  
  // Count tick crossings
  let upCrossings = 0;
  let downCrossings = 0;
  for (let i = 1; i < recentTrades.length; i++) {
    const prevPrice = parseFloat(recentTrades[i-1].price);
    const currPrice = parseFloat(recentTrades[i].price);
    const diff = currPrice - prevPrice;
    if (diff >= tickSize) upCrossings++;
    if (diff <= -tickSize) downCrossings++;
  }
  
  console.log(`Upward crossings: ${upCrossings}`);
  console.log(`Downward crossings: ${downCrossings}`);
  console.log(`Total crossings: ${upCrossings + downCrossings}`);
  console.log(`Avg time between trades: ${(3600 / recentTrades.length).toFixed(0)}s`);
  
  // Estimate fill probability
  const currentPrice = prices[0];
  const higherTrades = recentTrades.filter(t => parseFloat(t.price) > currentPrice).length;
  const fillProbability = (higherTrades / recentTrades.length * 100).toFixed(1);
  console.log(`Fill probability (1 tick above current): ${fillProbability}%`);
}

testClobTrades().catch(console.error);
