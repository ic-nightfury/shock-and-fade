import { NhlShockRecorder } from "./collectors/nhl/NhlShockRecorder";
import * as dotenv from "dotenv";

dotenv.config();

async function main() {
  const dbPath = process.env.NHL_SHOCK_DB || "./data/nhl_shock.db";
  const useSportradar = process.env.USE_SPORTRADAR === "true";

  const recorder = new NhlShockRecorder({
    dbPath,
    snapshotThrottleMs: Number(process.env.NHL_SHOCK_THROTTLE_MS) || 1000,
    discoveryIntervalMs: Number(process.env.NHL_SHOCK_DISCOVERY_MS) || 60_000,
    alertFilePath: process.env.NHL_SHOCK_ALERT_FILE || "./data/live_market_alerts.jsonl",
    // Sportradar — only used if USE_SPORTRADAR=true
    sportradarApiKey: process.env.SPORTRADAR_NHL_API_KEY || "",
    sportradarAccessLevel: process.env.SPORTRADAR_NHL_ACCESS_LEVEL || "trial",
    sportradarPollMs: Number(process.env.SPORTRADAR_POLL_MS) || 10_000,
    useSportradar,
  });

  await recorder.start();

  const dataSource = recorder.getDataSource();
  console.log(`✅ Live recorder started (NHL/NBA/MLB). DB: ${dbPath}`);
  console.log(`   Data source: ${dataSource}`);
  if (dataSource === "free-league-apis") {
    console.log(`   APIs: api-web.nhle.com | cdn.nba.com | statsapi.mlb.com | ESPN (fallback)`);
    console.log(`   Cost: $0/mo — no API keys required`);
  } else if (dataSource === "sportradar") {
    console.log(`   Sportradar forced via USE_SPORTRADAR=true`);
  } else {
    console.log(`   ⚠️  No game-event data source — orderbook recording only`);
  }
  console.log(`   Tables: markets, snapshots, trades, depth_snapshots, fair_values, game_events`);

  process.on("SIGINT", () => {
    console.log("\nShutting down recorder...");
    recorder.stop();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
