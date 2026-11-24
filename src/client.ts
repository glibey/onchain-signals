// Test client: calls a paid endpoint, shows the price, pays via x402, prints the result.
// Usage: npm run client -- /v1/whales?min=20000
import { wrapFetchWithPaymentFromConfig, decodePaymentResponseHeader } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm";
import { createPublicClient, http, erc20Abi, formatUnits } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base, baseSepolia } from "viem/chains";

const API_URL = process.env.API_URL ?? `http://localhost:${process.env.PORT ?? 4021}`;
const PATH = process.argv[2] ?? "/v1/markets/movers?limit=5";
const KEY = process.env.CLIENT_PRIVATE_KEY as `0x${string}` | undefined;
const MAX_USD = Number(process.env.CLIENT_MAX_USD ?? "0.05"); // refuse to pay more than this per call
const ALLOW_MAINNET = process.env.CLIENT_ALLOW_MAINNET === "1";

const CHAINS = { "eip155:84532": baseSepolia, "eip155:8453": base } as const;
const url = new URL(PATH, API_URL).toString();

function decodeB64Json(h: string) {
  return JSON.parse(Buffer.from(h, "base64").toString("utf8"));
}

async function usdcBalance(network: keyof typeof CHAINS, asset: `0x${string}`, owner: `0x${string}`) {
  const pc = createPublicClient({ chain: CHAINS[network], transport: http() });
  const raw = await pc.readContract({ address: asset, abi: erc20Abi, functionName: "balanceOf", args: [owner] });
  return Number(formatUnits(raw, 6));
}

async function main() {
  // 1. Probe without paying, to see what the server asks for.
  const probe = await fetch(url);
  if (probe.status !== 402) {
    console.log(`No payment needed (HTTP ${probe.status}).`);
    console.log(JSON.stringify(await probe.json(), null, 2).slice(0, 2000));
    return;
  }
  const header = probe.headers.get("payment-required");
  if (!header) throw new Error("402 without payment-required header");
  const reqs = decodeB64Json(header);
  const offer = reqs.accepts?.[0];
  const priceUsd = Number(offer.amount) / 1e6;
  console.log(`💳 ${PATH} costs $${priceUsd} (${offer.extra?.name ?? "token"} on ${offer.network}) → ${offer.payTo}`);

  // 2. Safety checks before spending anything.
  if (!(offer.network in CHAINS)) throw new Error(`Unsupported network ${offer.network}`);
  if (offer.network === "eip155:8453" && !ALLOW_MAINNET)
    throw new Error("Server wants REAL USDC on Base mainnet. Set CLIENT_ALLOW_MAINNET=1 if you mean it.");
  if (priceUsd > MAX_USD) throw new Error(`Price $${priceUsd} is above CLIENT_MAX_USD=$${MAX_USD}`);
  if (!KEY) {
    console.log("\nSet CLIENT_PRIVATE_KEY in .env (a TEST wallet with testnet USDC) to actually pay. See README.");
    return;
  }

  const account = privateKeyToAccount(KEY);
  const before = await usdcBalance(offer.network, offer.asset, account.address);
  console.log(`👛 payer ${account.address}  USDC before: ${before}`);
  if (before < priceUsd) {
    console.log("Not enough USDC. Get testnet USDC at https://faucet.circle.com (Base Sepolia).");
    return;
  }

  // 3. Pay and fetch.
  const payFetch = wrapFetchWithPaymentFromConfig(fetch, {
    schemes: [{ network: offer.network, client: new ExactEvmScheme(account) }],
  });
  const t0 = Date.now();
  const res = await payFetch(url);
  const ms = Date.now() - t0;
  const body = await res.json().catch(() => null);
  console.log(`\nHTTP ${res.status} in ${ms} ms`);

  const pr = res.headers.get("payment-response");
  if (pr) {
    const settle = decodePaymentResponseHeader(pr);
    console.log("🧾 settlement:", settle);
    const tx = (settle as any).transaction;
    if (tx) console.log(`   ${CHAINS[offer.network as keyof typeof CHAINS].blockExplorers.default.url}/tx/${tx}`);
  }
  const after = await usdcBalance(offer.network, offer.asset, account.address);
  console.log(`👛 USDC after: ${after}  (spent ${(before - after).toFixed(6)})`);
  console.log("\n" + JSON.stringify(body, null, 2).slice(0, 2000));
}

main().catch((e) => {
  console.error("❌", e instanceof Error ? e.message : e);
  process.exit(1);
});
