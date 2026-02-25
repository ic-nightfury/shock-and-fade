import { ethers } from "ethers";
import dotenv from "dotenv";
dotenv.config();

const RPC = process.env.POLYGON_RPC_URL || "https://polygon-rpc.com";
const PROXY = process.env.POLYMARKET_FUNDER || process.env.POLYMARKET_PROXY_ADDRESS;
const EOA = process.env.PRIVATE_KEY ? new ethers.Wallet(process.env.PRIVATE_KEY).address : null;
const USDC_E = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";

const provider = new ethers.providers.JsonRpcProvider(RPC);
const ERC20_ABI = ["function balanceOf(address) view returns (uint256)"];

async function main() {
  const wallet = PROXY || EOA;
  console.log(`Proxy wallet: ${wallet}`);
  console.log(`EOA wallet: ${EOA}`);

  // USDC.e balance
  const usdc = new ethers.Contract(USDC_E, ERC20_ABI, provider);
  const usdcBal = await usdc.balanceOf(wallet);
  console.log(`\n💰 USDC.e (proxy): $${(Number(usdcBal) / 1e6).toFixed(2)}`);

  if (EOA && EOA !== wallet) {
    const eoaUsdcBal = await usdc.balanceOf(EOA);
    console.log(`💰 USDC.e (EOA): $${(Number(eoaUsdcBal) / 1e6).toFixed(2)}`);
  }

  // MATIC
  const maticBal = await provider.getBalance(wallet!);
  console.log(`⛽ MATIC (proxy): ${ethers.utils.formatEther(maticBal)}`);
  if (EOA) {
    const eoaMaticBal = await provider.getBalance(EOA);
    console.log(`⛽ MATIC (EOA): ${ethers.utils.formatEther(eoaMaticBal)}`);
  }

  // Check CTF positions via Gamma API
  console.log("\n📊 CTF Token Positions (Gamma API):");
  const resp = await fetch(
    `https://gamma-api.polymarket.com/positions?user=${wallet?.toLowerCase()}&limit=50&sizeThreshold=0.1`
  );
  const positions = await resp.json();

  if (Array.isArray(positions) && positions.length > 0) {
    let totalValue = 0;
    for (const pos of positions) {
      const size = Number(pos.size || 0);
      if (size < 0.5) continue;
      const title = pos.market?.question || pos.title || pos.asset?.slice(0, 16) || "Unknown";
      const outcome = pos.outcome || "?";
      const price = Number(pos.curPrice || pos.price || 0);
      const value = size * price;
      totalValue += value;
      console.log(
        `  📌 ${outcome}: ${size.toFixed(0)} shares @ ${(price * 100).toFixed(1)}¢ = $${value.toFixed(2)}`
      );
      console.log(`     ${title.slice(0, 80)}`);
    }
    console.log(`\n💎 Total position value: ~$${totalValue.toFixed(2)}`);
  } else {
    console.log("  No positions found via Gamma API");
    console.log("  Raw response:", JSON.stringify(positions).slice(0, 200));
  }
}

main().catch(console.error);
