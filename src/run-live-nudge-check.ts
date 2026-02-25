import * as fs from "fs";
import * as path from "path";

const ALERT_FILE = process.env.LIVE_ALERT_FILE || "./data/live_market_alerts.jsonl";
const STATE_FILE = process.env.LIVE_ALERT_STATE || "./data/live_market_alerts.state.json";

function loadState(): { lastTs: number } {
  if (!fs.existsSync(STATE_FILE)) return { lastTs: 0 };
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf-8"));
  } catch {
    return { lastTs: 0 };
  }
}

function saveState(state: { lastTs: number }) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state));
}

function main() {
  if (!fs.existsSync(ALERT_FILE)) return;
  const lines = fs.readFileSync(ALERT_FILE, "utf-8").trim().split("\n").filter(Boolean);
  const state = loadState();
  let latestTs = state.lastTs;
  const newAlerts: any[] = [];

  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      if (obj.ts > state.lastTs) {
        newAlerts.push(obj);
        if (obj.ts > latestTs) latestTs = obj.ts;
      }
    } catch {}
  }

  if (newAlerts.length > 0) {
    console.log(JSON.stringify({ newAlerts }));
    saveState({ lastTs: latestTs });
  }
}

main();
