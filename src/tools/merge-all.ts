import { MergeClient } from "../services/MergeClient.js";
import dotenv from "dotenv";
dotenv.config();

const MERGES = [
  {
    name: "GSW@LAL",
    conditionId: "0x66256cf24badf914990a9ed69bf39abb32024afc6a0aaad4d85e6c6a671b2bf5",
    pairs: 30,
    isNegRisk: false,
  },
  {
    name: "UTA@ORL",
    conditionId: "0xd9cd7f398c210c4911f6e4a58c445df7b0e483ef4426a52614000750ed9eefbc",
    pairs: 30,
    isNegRisk: false,
  },
];

async function main() {
  const pk = process.env.POLYMARKET_PRIVATE_KEY || process.env.PRIVATE_KEY;
  if (!pk) throw new Error("POLYMARKET_PRIVATE_KEY not set");
  const mergeClient = new MergeClient(pk);
  console.log("🔀 Merging all positions back to USDC...\n");

  let totalMerged = 0;
  for (const m of MERGES) {
    console.log(`--- ${m.name}: merging ${m.pairs} pairs ($${m.pairs}) ---`);
    try {
      const start = Date.now();
      const result = await mergeClient.merge(m.conditionId, m.pairs, m.isNegRisk);
      const elapsed = Date.now() - start;
      console.log(`✅ Merged $${m.pairs} (${elapsed}ms) tx: ${result?.hash || result?.transactionHash || 'relayer'}`);
      totalMerged += m.pairs;
    } catch (err: any) {
      console.error(`❌ Failed: ${err.message}`);
    }
    console.log();
  }
  console.log(`\n💰 Total merged: $${totalMerged}`);
}

main().catch(console.error);
