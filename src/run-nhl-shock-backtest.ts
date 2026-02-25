import { NhlShockBacktest } from "./backtest/NhlShockBacktest";

function envNum(key: string, fallback: number): number {
  const v = process.env[key];
  return v ? parseFloat(v) : fallback;
}

const cfg = {
  dbPath: process.env.NHL_SHOCK_DB || "./data/nhl_shock.db",
  sigma: envNum("NHL_SHOCK_SIGMA", 3),
  windowSeconds: envNum("NHL_SHOCK_WINDOW", 60),
  ladderLevels: envNum("NHL_SHOCK_LADDER_LEVELS", 3),
  ladderStepPct: envNum("NHL_SHOCK_LADDER_STEP_PCT", 0.5),      // 50% of deviation split across levels
  ladderWindowSec: envNum("NHL_SHOCK_LADDER_WINDOW", 3),
  fadeWindowSec: envNum("NHL_SHOCK_FADE_WINDOW", 15),
  targetPair: envNum("NHL_SHOCK_TARGET_PAIR", 1.02),
  tradeSize: envNum("NHL_SHOCK_TRADE_SIZE", 10),
  surpriseThreshold: envNum("NHL_SHOCK_SURPRISE_THRESHOLD", 0.4), // 0-1
  totalGameSeconds: envNum("NHL_SHOCK_GAME_SECS", 3600),          // NHL=3600, NBA=2880
};

console.log("NHL Shock-Fade Backtest v2");
console.log("Config:", JSON.stringify(cfg, null, 2));
console.log("");

const bt = new NhlShockBacktest(cfg);
bt.run();
