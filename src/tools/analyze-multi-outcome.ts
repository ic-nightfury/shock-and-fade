import { GammaClient } from '../services/GammaClient.js';

async function analyzeMultiOutcome() {
  const gamma = new GammaClient();
  
  // Get all active markets
  const markets = await gamma.getAllMarkets();
  
  // Filter for multi-outcome (more than 2 outcomes)
  const multiOutcome = markets.filter(m => m.outcomes && m.outcomes.length > 2);
  
  console.log('=== MULTI-OUTCOME MARKETS ANALYSIS ===');
  console.log(`Total markets: ${markets.length}`);
  console.log(`Multi-outcome (3+ options): ${multiOutcome.length}\n`);
  
  // Sort by volume
  const byVolume = multiOutcome.sort((a, b) => (b.volume || 0) - (a.volume || 0));
  
  console.log('TOP 20 BY VOLUME:');
  byVolume.slice(0, 20).forEach((m, i) => {
    const vol = m.volume ? `$${(m.volume / 1e6).toFixed(1)}M` : 'N/A';
    const outcomes = m.outcomes.length;
    const prices = m.outcomePrices ? m.outcomePrices.map(p => `${(p * 100).toFixed(1)}¢`).join(', ') : 'N/A';
    console.log(`${i + 1}. [${outcomes} outcomes, ${vol}] ${m.question}`);
    console.log(`   Prices: ${prices}\n`);
  });
  
  // Find markets with outcomes priced at 1-5¢
  console.log('\n=== MARKETS WITH LOW-PRICE OUTCOMES (1-5¢) ===');
  const lowPrice = multiOutcome.filter(m => {
    if (!m.outcomePrices) return false;
    return m.outcomePrices.some(p => p >= 0.01 && p <= 0.05);
  }).sort((a, b) => (b.volume || 0) - (a.volume || 0));
  
  lowPrice.slice(0, 15).forEach((m, i) => {
    const vol = m.volume ? `$${(m.volume / 1e6).toFixed(1)}M` : 'N/A';
    const lowPrices = m.outcomePrices!
      .map((p, idx) => ({ price: p, outcome: m.outcomes![idx] }))
      .filter(o => o.price >= 0.01 && o.price <= 0.05)
      .map(o => `${o.outcome}: ${(o.price * 100).toFixed(1)}¢`)
      .join(', ');
    console.log(`${i + 1}. [${vol}] ${m.question}`);
    console.log(`   Low-price: ${lowPrices}\n`);
  });
}

analyzeMultiOutcome().catch(console.error);
