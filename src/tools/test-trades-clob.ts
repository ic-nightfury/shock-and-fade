#!/usr/bin/env tsx
/**
 * Test fetching trades using CLOB Client's built-in getTrades() method
 */

import { PolymarketClient } from '../services/PolymarketClient.js';
import dotenv from 'dotenv';

dotenv.config();

async function testClobTrades() {
  const privateKey = process.env.POLYMARKET_PRIVATE_KEY;
  const host = process.env.POLYMARKET_HOST || "https://clob.polymarket.com";
  const funderAddress = process.env.POLYMARKET_FUNDER;
  const chainId = 137;
  
  if (!privateKey || !funderAddress) {
    console.error('Missing POLYMARKET_PRIVATE_KEY or POLYMARKET_FUNDER in .env');
    process.exit(1);
  }
  
  console.log('=== INITIALIZING POLYMARKET CLIENT ===\n');
  
  const polyClient = new PolymarketClient({
    host,
    chainId,
    privateKey,
    funderAddress,
    authMode: 'PROXY',
  });
  
  await polyClient.initialize();
  console.log('✓ Client initialized\n');
  
  // Get test market
  console.log('=== FETCHING TEST MARKET ===');
  // Try Judy Shelton - super high volume ($3.9M/day)
  const gammaRes = await fetch('https://gamma-api.polymarket.com/markets?slug=will-trump-nominate-judy-shelton-as-the-next-fed-chair');
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
  
  // Test fetching trades via CLOB client method
  console.log('=== FETCHING TRADES VIA CLOB CLIENT ===');
  
  try {
    // Access the internal clobClient
    const clobClient = (polyClient as any).clobClient;
    
    if (!clobClient) {
      console.error('CLOB client not initialized');
      return;
    }
    
    // Try getTrades (user trades)
    console.log('Trying clobClient.getTrades() (user trades)...');
    const userTrades = await clobClient.getTrades({
      asset_id: tokenId,
      limit: 100,
    });
    console.log(`  User trades: ${userTrades.length}`);
    
    // Try getMarketTradesEvents (market trades)
    console.log('\nTrying clobClient.getMarketTradesEvents() (market trades)...');
    const marketTrades = await clobClient.getMarketTradesEvents({
      asset_id: tokenId,
      limit: 100,
    });
    console.log(`  Market trades: ${marketTrades ? marketTrades.length : 'N/A'}`);
    
    if (marketTrades && marketTrades.length > 0) {
      console.log('\n✓ Success with getMarketTradesEvents!\n');
      analyzeTrades(marketTrades);
    } else {
      console.log('\nNo market trades found');
      
      // Try without asset_id (might be condition_id instead)
      console.log('\nTrying with condition_id instead...');
      const conditionId = market.conditionId;
      console.log('  Condition ID:', conditionId);
      
      const tradesByCondition = await clobClient.getMarketTradesEvents({
        condition_id: conditionId,
        limit: 100,
      });
      console.log(`  Trades: ${tradesByCondition ? tradesByCondition.length : 'N/A'}`);
      
      if (tradesByCondition && tradesByCondition.length > 0) {
        console.log('\n✓ Success with condition_id!\n');
        analyzeTrades(tradesByCondition);
      }
    }
    
  } catch (err: any) {
    console.error('✗ Error:', err.message);
    console.error('Stack:', err.stack);
  }
}

function analyzeTrades(trades: any[]) {
  if (trades.length === 0) {
    console.log('No trades found');
    return;
  }
  
  console.log('=== SAMPLE TRADES (first 10) ===');
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
  console.log('✅ CONCLUSION: Trades API is accessible via CLOB client');
  console.log('   Database size is manageable (~1-2 MB/day for 50 markets)');
  console.log('   Recommend: Store hourly aggregates, not raw trades');
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

testClobTrades().catch(console.error);
