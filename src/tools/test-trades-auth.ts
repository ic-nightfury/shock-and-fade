#!/usr/bin/env tsx
/**
 * Test fetching trades with proper CLOB API authentication
 */

import { PolymarketClient } from '../services/PolymarketClient.js';
import dotenv from 'dotenv';

dotenv.config();

async function testTradesAuth() {
  const privateKey = process.env.POLYMARKET_PRIVATE_KEY;
  const host = process.env.POLYMARKET_HOST || "https://clob.polymarket.com";
  const funderAddress = process.env.POLYMARKET_FUNDER;
  const chainId = 137;
  
  if (!privateKey || !funderAddress) {
    console.error('Missing POLYMARKET_PRIVATE_KEY or POLYMARKET_FUNDER in .env');
    process.exit(1);
  }
  
  console.log('=== INITIALIZING POLYMARKET CLIENT ===');
  
  const polyClient = new PolymarketClient({
    host,
    chainId,
    privateKey,
    funderAddress,
    authMode: 'PROXY',
  });
  
  await polyClient.initialize();
  console.log('✓ Client initialized\n');
  
  // Get API credentials
  const apiCreds = await polyClient.getApiCreds();
  console.log('API Credentials:');
  console.log('  Key:', apiCreds.key.substring(0, 20) + '...');
  console.log('  Secret:', apiCreds.secret.substring(0, 20) + '...');
  console.log('  Passphrase:', apiCreds.passphrase || '(none)');
  console.log();
  
  // Get test market
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
  console.log('Current price:', JSON.parse(market.outcomePrices)[0], '(YES)');
  console.log('24h volume: $' + (market.volume24hr / 1000).toFixed(1) + 'K');
  console.log();
  
  // Test fetching trades
  console.log('=== FETCHING TRADES ===');
  const tradesUrl = `${host}/trades?asset_id=${tokenId}&limit=100`;
  
  try {
    const res = await fetch(tradesUrl, {
      headers: {
        'Authorization': apiCreds.key,
        'POLY-API-KEY': apiCreds.key,
        'POLY-SECRET': apiCreds.secret,
        'POLY-PASSPHRASE': apiCreds.passphrase || '',
      }
    });
    
    console.log('Status:', res.status);
    
    if (!res.ok) {
      const error = await res.text();
      console.log('Error:', error);
      
      // Try alternative header format
      console.log('\nTrying alternative header format...');
      const res2 = await fetch(tradesUrl, {
        headers: {
          'POLY_API_KEY': apiCreds.key,
          'POLY_SECRET': apiCreds.secret,
          'POLY_PASSPHRASE': apiCreds.passphrase || '',
        }
      });
      
      console.log('Status:', res2.status);
      if (!res2.ok) {
        console.log('Error:', await res2.text());
        return;
      }
      
      const trades = await res2.json();
      console.log('✓ Success with alternative headers!');
      analyzeTrades(trades);
    } else {
      const trades = await res.json();
      console.log('✓ Success!');
      analyzeTrades(trades);
    }
  } catch (err: any) {
    console.error('✗ Error:', err.message);
  }
}

function analyzeTrades(trades: any) {
  if (!Array.isArray(trades)) {
    console.log('Unexpected response type:', typeof trades);
    console.log('Response:', JSON.stringify(trades).substring(0, 200));
    return;
  }
  
  console.log(`\n✓ Got ${trades.length} trades`);
  
  if (trades.length === 0) {
    console.log('No trades found');
    return;
  }
  
  console.log('\n=== SAMPLE TRADES (first 10) ===');
  trades.slice(0, 10).forEach((t: any, i: number) => {
    const price = (parseFloat(t.price) * 100).toFixed(2);
    const size = parseFloat(t.size).toFixed(0);
    const timestamp = new Date(t.match_time * 1000).toISOString().substring(11, 19);
    console.log(`${i+1}. ${price}¢ x ${size} shares @ ${timestamp}`);
  });
  
  // Analyze tick crossings
  const now = Math.floor(Date.now() / 1000);
  const oneHourAgo = now - 3600;
  const recentTrades = trades.filter(t => t.match_time >= oneHourAgo);
  
  console.log(`\n=== TICK CROSSING ANALYSIS (last 1 hour) ===`);
  console.log(`Trades in last hour: ${recentTrades.length}`);
  
  if (recentTrades.length === 0) {
    console.log('No trades in last hour');
    
    // Try last 24 hours
    const oneDayAgo = now - 86400;
    const dayTrades = trades.filter(t => t.match_time >= oneDayAgo);
    console.log(`Trades in last 24 hours: ${dayTrades.length}`);
    
    if (dayTrades.length > 0) {
      analyzePeriod(dayTrades, '24 hours');
    }
    return;
  }
  
  analyzePeriod(recentTrades, '1 hour');
  
  // Database size estimate
  console.log(`\n=== DATABASE SIZE ESTIMATE ===`);
  const tradesPerHour = recentTrades.length;
  const tradesPerDay = tradesPerHour * 24;
  const bytesPerTrade = 150; // JSON record ~150 bytes
  const marketsToTrack = 50;
  
  const mbPerDay = (tradesPerDay * bytesPerTrade * marketsToTrack / 1024 / 1024).toFixed(1);
  const mbPerWeek = (parseFloat(mbPerDay) * 7).toFixed(0);
  const gbPerMonth = (parseFloat(mbPerDay) * 30 / 1000).toFixed(2);
  
  console.log(`For this market: ${tradesPerHour} trades/hour → ${tradesPerDay} trades/day`);
  console.log(`For 50 markets:`);
  console.log(`  Per day: ${mbPerDay} MB`);
  console.log(`  Per week: ${mbPerWeek} MB`);
  console.log(`  Per month: ${gbPerMonth} GB`);
  console.log();
  console.log('Recommendation: Store aggregated stats (hourly), not raw trades');
}

function analyzePeriod(trades: any[], period: string) {
  const prices = trades.map(t => parseFloat(t.price));
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  const range = max - min;
  const tickSize = 0.001; // 0.1¢
  
  console.log(`Price range: ${(min * 100).toFixed(2)}¢ - ${(max * 100).toFixed(2)}¢`);
  console.log(`Oscillation: ${(range * 100).toFixed(2)}¢`);
  console.log(`Ticks crossed: ${Math.floor(range / tickSize)}`);
  
  // Count tick crossings
  let upCrossings = 0;
  let downCrossings = 0;
  for (let i = 1; i < trades.length; i++) {
    const prevPrice = parseFloat(trades[i-1].price);
    const currPrice = parseFloat(trades[i].price);
    const diff = currPrice - prevPrice;
    if (diff >= tickSize) upCrossings++;
    if (diff <= -tickSize) downCrossings++;
  }
  
  console.log(`Upward crossings: ${upCrossings}`);
  console.log(`Downward crossings: ${downCrossings}`);
  console.log(`Total crossings: ${upCrossings + downCrossings}`);
  console.log(`Crossing rate: ${((upCrossings + downCrossings) / (trades.length - 1) * 100).toFixed(0)}% of trades`);
  
  // Calculate avg time between crossings
  const periodSeconds = period === '1 hour' ? 3600 : 86400;
  const avgTimeBetweenTrades = (periodSeconds / trades.length).toFixed(0);
  const avgTimeBetweenCrossings = trades.length > 1 
    ? (periodSeconds / (upCrossings + downCrossings)).toFixed(0) 
    : 'N/A';
  
  console.log(`Avg time between trades: ${avgTimeBetweenTrades}s`);
  console.log(`Avg time between crossings: ${avgTimeBetweenCrossings}s`);
  
  // Fill probability estimate
  const currentPrice = prices[0]; // Most recent
  const higherTrades = trades.filter(t => parseFloat(t.price) > currentPrice).length;
  const fillProbability = (higherTrades / trades.length * 100).toFixed(1);
  console.log(`Fill probability (1 tick above current): ${fillProbability}%`);
}

testTradesAuth().catch(console.error);
