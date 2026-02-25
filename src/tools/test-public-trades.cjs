const { ClobClient } = require('@polymarket/clob-client');

(async () => {
  // Initialize PUBLIC client (no auth needed)
  const client = new ClobClient(
    "https://clob.polymarket.com",
    137  // Polygon chain ID
  );
  
  console.log('=== TESTING PUBLIC TRADES ACCESS ===\n');
  
  // Get test market
  const gammaRes = await fetch('https://gamma-api.polymarket.com/markets?slug=will-trump-nominate-judy-shelton-as-the-next-fed-chair');
  const markets = await gammaRes.json();
  
  if (!markets || markets.length === 0) {
    console.error('Failed to fetch market');
    return;
  }
  
  const market = markets[0];
  const conditionId = market.conditionId;
  
  console.log('Market:', market.question);
  console.log('Condition ID:', conditionId);
  console.log('Current price:', JSON.parse(market.outcomePrices)[0]);
  console.log('24h volume: $' + (market.volume24hr / 1000).toFixed(1) + 'K\n');
  
  // Try getMarketTradesEvents with condition_id (correct parameter)
  console.log('Calling getMarketTradesEvents()...');
  const trades = await client.getMarketTradesEvents(conditionId);
  
  console.log('✓ SUCCESS!\n');
  console.log(`Got ${trades.length} recent market trades\n`);
  
  if (trades.length > 0) {
    console.log('=== SAMPLE TRADES (first 10) ===');
    trades.slice(0, 10).forEach((t, i) => {
      const price = (parseFloat(t.price) * 100).toFixed(2);
      const size = parseFloat(t.size).toFixed(0);
      const timestamp = new Date(t.timestamp).toISOString().substring(11, 19);
      console.log(`${i+1}. ${price}¢ x ${size} (${t.side}) @ ${timestamp}`);
    });
    
    // Analyze
    console.log('\n=== TICK CROSSING ANALYSIS ===');
    const prices = trades.map(t => parseFloat(t.price));
    const min = Math.min(...prices);
    const max = Math.max(...prices);
    const range = max - min;
    
    console.log(`Price range: ${(min * 100).toFixed(2)}¢ - ${(max * 100).toFixed(2)}¢`);
    console.log(`Oscillation: ${(range * 100).toFixed(2)}¢`);
    console.log(`Ticks crossed: ${Math.floor(range / 0.001)}`);
    
    // Count crossings
    let upCrossings = 0;
    for (let i = 1; i < trades.length; i++) {
      if (parseFloat(trades[i].price) > parseFloat(trades[i-1].price) + 0.001) {
        upCrossings++;
      }
    }
    console.log(`Upward crossings: ${upCrossings} (${(upCrossings / trades.length * 100).toFixed(0)}%)`);
    
    // Fill probability
    const currentPrice = prices[0];
    const higherTrades = trades.filter(t => parseFloat(t.price) > currentPrice).length;
    console.log(`Fill probability (1 tick above): ${(higherTrades / trades.length * 100).toFixed(1)}%`);
  }
})();
