import { serve } from "@hono/node-server";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { createApp } from "./app.js";
import { Ledger } from "./payments.js";

const env = process.env;
const PAY_TO = env.PAY_TO ?? "";
const NETWORK = (env.NETWORK ?? "eip155:84532") as `${string}:${string}`; // Base Sepolia by default
const PORT = Number(env.PORT ?? 4021);
const PAYMENTS_OFF = env.X402_DISABLED === "1";
const PROD = env.NODE_ENV === "production";
const MAINNET = NETWORK === "eip155:8453";
const CDP = Boolean(env.CDP_API_KEY_ID && env.CDP_API_KEY_SECRET);

const fail = (msg: string) => {
  console.error(`✖ ${msg}`);
  process.exit(1);
};

if (PROD && PAYMENTS_OFF) fail("X402_DISABLED=1 is not allowed with NODE_ENV=production.");
if (!PAYMENTS_OFF && !/^0x[0-9a-fA-F]{40}$/.test(PAY_TO)) fail("Set PAY_TO to the EVM address that receives USDC (see .env.example).");
if (MAINNET && !CDP && !env.FACILITATOR_URL)
  fail("Base mainnet needs a mainnet facilitator: set CDP_API_KEY_ID and CDP_API_KEY_SECRET (Coinbase CDP).");

// Coinbase CDP facilitator when keys are present, otherwise FACILITATOR_URL (e.g. PayAI) or the free testnet one.
// @coinbase/x402 is loaded only for CDP: it is not a dependency (it pulls a vulnerable zod 3 via cdp-sdk).
async function cdpConfig() {
  const mod = "@coinbase/x402";
  try {
    const { createFacilitatorConfig } = await import(mod);
    return createFacilitatorConfig(env.CDP_API_KEY_ID, env.CDP_API_KEY_SECRET);
  } catch {
    return fail("CDP keys are set but @coinbase/x402 is not installed: npm i @coinbase/x402") as never;
  }
}
const facilitator = CDP
  ? new HTTPFacilitatorClient(await cdpConfig())
  : new HTTPFacilitatorClient({ url: env.FACILITATOR_URL ?? "https://x402.org/facilitator" });

const ledger = PAYMENTS_OFF ? undefined : new Ledger();
const app = createApp({
  payTo: PAY_TO,
  network: NETWORK,
  facilitator,
  paymentsOff: PAYMENTS_OFF,
  ledger,
  freeRatePerMin: Number(env.FREE_RATE_PER_MIN ?? 60),
  trustProxy: (env.TRUST_PROXY as "none" | "xff" | "fly") ?? "none",
});

// Behind a TLS-terminating proxy the app sees http://; restore the public scheme so payment
// requirements (and Bazaar listings) advertise https:// resource URLs.
const trustProxy = (env.TRUST_PROXY ?? "none") !== "none";
const fetchHandler = (req: Request) => {
  if (trustProxy && req.headers.get("x-forwarded-proto") === "https" && req.url.startsWith("http:")) {
    req = new Request(req.url.replace(/^http:/, "https:"), req);
  }
  return app.fetch(req);
};

const server = serve({ fetch: fetchHandler, port: PORT }, () =>
  console.log(
    `onchain-signals on :${PORT}  network=${NETWORK}  facilitator=${CDP ? "cdp" : "url"}  payments=${PAYMENTS_OFF ? "OFF" : "ON"}`,
  ),
);

// Graceful shutdown: finish in-flight requests (and their settlements), then close the ledger.
for (const sig of ["SIGTERM", "SIGINT"] as const)
  process.on(sig, () => {
    console.log(`${sig}: shutting down`);
    server.close(() => {
      ledger?.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  });
