import { MergeClient } from "../services/MergeClient.js";
import dotenv from "dotenv";
dotenv.config();

// Orphaned positions to merge back (bot doesn't know about these)
const ORPHANS = [
  {
    name: "CLE@SAC",
    conditionId: "0x7bddf526fc942294c0de2fbeaee667d6145fe8cb503ab37bba28be88c539be50",
    pairs: 25, // 30 Cavaliers + 25 Kings → 25 mergeable
    isNegRisk: false,
  },
  {
    name: "UTA@ORL",
    conditionId: "0xd9cd7f398c210c4911f6e4a58c445df7b0e483ef4426a52614000750ed9eefbc",
    pairs: 30, // 30 Jazz + 30 Magic → game over
    isNegRisk: false,
  },
];

async function main() {
  const pk = process.env.POLYMARKET_PRIVATE_KEY || process.env.PRIVATE_KEY;
  if (!pk) throw new Error("POLYMARKET_PRIVATE_KEY or PRIVATE_KEY not set in .env");
  const mergeClient = new MergeClient(pk);
  console.log("🔀 Merging orphaned positions back to USDC...\n");

  for (const orphan of ORPHANS) {
    console.log(`--- ${orphan.name}: merging ${orphan.pairs} pairs ($${orphan.pairs}) ---`);
    try {
      const start = Date.now();
      const result = await mergeClient.merge(orphan.conditionId, orphan.pairs, orphan.isNegRisk);
      const elapsed = Date.now() - start;
      console.log(`✅ Merged $${orphan.pairs} (${elapsed}ms) tx: ${result?.hash || 'relayer'}`);
    } catch (err: any) {
      console.error(`❌ Failed to merge ${orphan.name}: ${err.message}`);
    }
    console.log();
  }

  console.log("Done! Check USDC.e balance.");
}

main().catch(console.error);
