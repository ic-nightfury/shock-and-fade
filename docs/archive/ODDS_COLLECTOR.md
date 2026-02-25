# Odds Arb Collector (TS) — Paper/Realtime Simulation

This module collects **Polymarket orderbooks** + **sportsbook odds** (The Odds API), computes **de‑vigged fair probabilities**, and logs **paper trade signals** when the edge exceeds a threshold.

## What it does

- Pulls Polymarket sports moneyline markets via **Gamma API** (through `SportsMarketDiscovery`).
- Pulls odds for **NHL/NBA/NFL** via **The Odds API**.
- Matches events by **team names + start time**.
- Computes **fair probabilities** (de‑vigged).
- Computes **executable Polymarket price** at size `ODDS_TRADE_SIZE` (VWAP across asks).
- Writes **edge signals** to Postgres (paper trade simulation).

## Files

- `src/collectors/odds/OddsArbCollector.ts` — main collector
- `src/run-odds-arb-sim.ts` — one‑shot run
- `scripts/sql/odds_schema.sql` — Postgres schema

## Environment variables

```env
# Required
ODDS_DB_URL=postgres://user:pass@host:5432/db
ODDS_API_KEY=your_odds_api_key

# Optional
ODDS_API_REGION=us               # us|uk|eu
ODDS_API_MARKETS=h2h             # moneyline
ODDS_SPORT_KEYS=icehockey_nhl,basketball_nba,americanfootball_nfl
ODDS_BOOKMAKER_KEYS=pinnacle,betfair_ex_uk,betfair_ex_eu
ODDS_TRADE_SIZE=50               # shares
ODDS_MIN_EDGE=0.03               # 3% edge threshold
POLYMARKET_HOST=https://clob.polymarket.com
```

## Run (paper simulation)

```bash
npm install
npm run odds:collect
```

## Notes

- The current implementation is **paper‑only**: it logs signals when edge ≥ `ODDS_MIN_EDGE`.
- Use `edge_signals` table as the source for alerts or later auto‑trade gating.
- Edge calculation uses **VWAP across asks** at size `ODDS_TRADE_SIZE`, not last price.

## Next steps (if you want)

1) Add a **scheduler** (run every 30–60s)
2) Add **multi‑book consensus** (median of bookmakers instead of single priority book)
3) Wire into SSS as a **gating signal**
4) Build a **paper P&L simulator** (hold to settlement)
