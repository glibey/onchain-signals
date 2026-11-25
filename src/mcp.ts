#!/usr/bin/env node
// MCP server (stdio) that lets Claude / Cursor / any MCP agent use the onchain-signals API.
// Paid tools pay the HTTP API per call via x402 from the user's wallet, with spend limits.
//
// Env:
//   API_URL                  default: the hosted onchain-signals API
//   CLIENT_PRIVATE_KEY       payer wallet (use a dedicated wallet with a small balance)
//   CLIENT_MAX_USD           max price per call (default 0.05)
//   CLIENT_SESSION_BUDGET_USD max total spend per MCP session (default 1.00)
//   CLIENT_ALLOW_MAINNET=1   required to spend real USDC on Base mainnet
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { wrapFetchWithPaymentFromConfig, decodePaymentResponseHeader } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm";
import { createPublicClient, http, erc20Abi, formatUnits } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base, baseSepolia } from "viem/chains";
import { TOOLS, READ_ONLY, VERSION } from "./tools.js";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Load the project's .env (kept out of git) so the wallet key needn't live in MCP client configs.
// Values already set in the environment win.
const envFile = fileURLToPath(new URL("../.env", import.meta.url));
if (existsSync(envFile)) process.loadEnvFile(envFile);

export const DEFAULT_API_URL = "https://13-49-215-169.sslip.io";
const API_URL = process.env.API_URL ?? DEFAULT_API_URL;
const KEY = process.env.CLIENT_PRIVATE_KEY as `0x${string}` | undefined;
const MAX_USD = Number(process.env.CLIENT_MAX_USD ?? "0.05");
const BUDGET_USD = Number(process.env.CLIENT_SESSION_BUDGET_USD ?? "1");
const ALLOW_MAINNET = process.env.CLIENT_ALLOW_MAINNET === "1";

const CHAINS = { "eip155:84532": baseSepolia, "eip155:8453": base } as const;
type Net = keyof typeof CHAINS;

const account = KEY ? privateKeyToAccount(KEY) : null;
const payFetch = account
  ? wrapFetchWithPaymentFromConfig(fetch, { schemes: [{ network: "eip155:*", client: new ExactEvmScheme(account) }] })
  : null;

let spentUsd = 0;
const receipts: { tool: string; usd: number; tx?: string; at: string }[] = [];
let lastOffer: { network: Net; asset: `0x${string}` } | null = null;

const text = (v: unknown) => ({ content: [{ type: "text" as const, text: typeof v === "string" ? v : JSON.stringify(v, null, 2) }] });
const fail = (msg: string) => ({ ...text(msg), isError: true });

/** Probe → check price & limits → pay → return JSON. */
async function paidCall(tool: string, path: string) {
  const url = new URL(path, API_URL).toString();
  let probe: Response;
  try {
    probe = await fetch(url);
  } catch {
    return fail(`Cannot reach onchain-signals API at ${API_URL}. Is the server running?`);
  }
  if (probe.status !== 402) return probe.ok ? text(await probe.json()) : fail(`API error ${probe.status}: ${await probe.text()}`);

  const header = probe.headers.get("payment-required");
  if (!header) return fail("API returned 402 without payment details.");
  const offer = JSON.parse(Buffer.from(header, "base64").toString("utf8")).accepts?.[0];
  const price = Number(offer?.amount) / 1e6;

  if (!(offer?.network in CHAINS)) return fail(`Unsupported payment network ${offer?.network}.`);
  if (offer.network === "eip155:8453" && !ALLOW_MAINNET)
    return fail("This API charges real USDC on Base mainnet. The user must set CLIENT_ALLOW_MAINNET=1 to allow it.");
  if (price > MAX_USD) return fail(`Price $${price} exceeds the per-call limit CLIENT_MAX_USD=$${MAX_USD}.`);
  if (spentUsd + price > BUDGET_USD + 1e-9)
    return fail(`Session budget reached: spent $${spentUsd.toFixed(3)} of $${BUDGET_USD}. Ask the user to raise CLIENT_SESSION_BUDGET_USD or restart.`);
  if (!payFetch) return fail(`This tool costs $${price}. No wallet configured: the user must set CLIENT_PRIVATE_KEY in the MCP server env.`);

  lastOffer = { network: offer.network, asset: offer.asset };
  const res = await payFetch(url);
  if (!res.ok) {
    const body = await res.text();
    const reason = res.headers.get("payment-required");
    const why = reason ? JSON.parse(Buffer.from(reason, "base64").toString("utf8")).error : body.slice(0, 300);
    return fail(`Payment or request failed (HTTP ${res.status}): ${why}`);
  }
  const pr = res.headers.get("payment-response");
  const tx = pr ? (decodePaymentResponseHeader(pr) as any).transaction : undefined;
  spentUsd += price;
  receipts.push({ tool, usd: price, tx, at: new Date().toISOString() });
  return text({ paid: { usd: price, tx, sessionSpentUsd: +spentUsd.toFixed(6) }, data: await res.json() });
}

// ---- server -------------------------------------------------------------
const server = new McpServer({ name: "onchain-signals", title: "Onchain Signals", version: VERSION });

for (const [name, t] of Object.entries(TOOLS)) {
  server.registerTool(
    name,
    { title: t.title, description: `${t.description} Paid: ~${t.price} per call (x402, USDC).`, inputSchema: t.input, annotations: { title: t.title, ...READ_ONLY } },
    async (a: any) => paidCall(name, (t.path as (a: unknown) => string)(a)),
  );
}

server.registerTool(
  "list_services",
  { title: "List services and prices", description: "Free. Lists what the onchain-signals API sells and current prices.", inputSchema: {}, annotations: { title: "List services and prices", ...READ_ONLY } },
  async () => {
    try {
      return text(await (await fetch(new URL("/.well-known/x402", API_URL))).json());
    } catch {
      return fail(`Cannot reach onchain-signals API at ${API_URL}.`);
    }
  },
);

server.registerTool(
  "wallet_status",
  { title: "Wallet & spend status", description: "Free. Payer wallet address, USDC balance, spend this session and remaining budget.", inputSchema: {}, annotations: { title: "Wallet & spend status", ...READ_ONLY } },
  async () => {
    let balance: number | null = null;
    if (account && lastOffer) {
      const pc = createPublicClient({ chain: CHAINS[lastOffer.network], transport: http() });
      balance = Number(formatUnits(await pc.readContract({ address: lastOffer.asset, abi: erc20Abi, functionName: "balanceOf", args: [account.address] }), 6));
    }
    return text({
      wallet: account?.address ?? null,
      usdcBalance: balance ?? "unknown until first paid call",
      limits: { perCallUsd: MAX_USD, sessionBudgetUsd: BUDGET_USD, mainnetAllowed: ALLOW_MAINNET },
      sessionSpentUsd: +spentUsd.toFixed(6),
      receipts,
    });
  },
);

await server.connect(new StdioServerTransport());
console.error(`onchain-signals MCP ready → ${API_URL} (wallet: ${account?.address ?? "none"})`);
