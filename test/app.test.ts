// End-to-end over the Hono app: a real x402 client signs payments, a fake facilitator verifies/settles them.
import { afterEach, describe, expect, it, vi } from "vitest";
import { wrapFetchWithPaymentFromConfig } from "@x402/fetch";
import { createx402MCPClient } from "@x402/mcp";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ExactEvmScheme } from "@x402/evm";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { createApp, rateLimiter } from "../src/app.js";
import { Ledger } from "../src/payments.js";

const NETWORK = "eip155:84532" as const;
const PAY_TO = "0x000000000000000000000000000000000000dEaD";
const payer = privateKeyToAccount(generatePrivateKey());

function fakeFacilitator() {
  return {
    settle: vi.fn(async (p: any) => ({ success: true, transaction: `0xtx${Math.random()}`, network: NETWORK, payer: p.payload?.authorization?.from ?? payer.address })),
    verify: vi.fn(async () => ({ isValid: true, payer: payer.address })),
    getSupported: vi.fn(async () => ({ kinds: [{ x402Version: 2, scheme: "exact", network: NETWORK }], extensions: [], signers: {} })),
  };
}

function setup(freeRatePerMin = 60) {
  const facilitator = fakeFacilitator();
  const ledger = new Ledger(":memory:");
  const app = createApp({ payTo: PAY_TO, network: NETWORK, facilitator: facilitator as any, ledger, freeRatePerMin, trustProxy: "xff", log: () => {} });
  const appFetch = (input: RequestInfo | URL, init?: RequestInit) => app.request(input instanceof Request ? input : String(input), init);
  const payFetch = wrapFetchWithPaymentFromConfig(appFetch as typeof fetch, {
    schemes: [{ network: NETWORK, client: new ExactEvmScheme(payer) }],
  });
  return { app, appFetch, facilitator, ledger, payFetch };
}

const upstream = (ok: boolean) =>
  vi.stubGlobal("fetch", async () =>
    ok ? new Response(JSON.stringify({ data: [] })) : new Response("down", { status: 500 }));

afterEach(() => vi.unstubAllGlobals());

describe("free endpoints", () => {
  it("serve the catalog", async () => {
    const { app } = setup();
    const res = await app.request("/.well-known/x402");
    expect(res.status).toBe(200);
    expect((await res.json()).resources.map((r: any) => r.path)).toEqual(["/v1/markets/movers", "/v1/whales", "/v1/market/{slug}"]);
  });

  it("are rate limited per IP", async () => {
    const { app } = setup(2);
    const hit = (ip: string) => app.request("/health", { headers: { "x-forwarded-for": ip } });
    expect((await hit("1.1.1.1")).status).toBe(200);
    expect((await hit("1.1.1.1")).status).toBe(200);
    const blocked = await hit("1.1.1.1");
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get("retry-after"))).toBeGreaterThan(0);
    expect((await hit("2.2.2.2")).status).toBe(200);
  });

  it("limiter window resets after a minute", () => {
    let t = 0;
    const limit = rateLimiter(1, () => t);
    expect(limit("a").ok).toBe(true);
    expect(limit("a").ok).toBe(false);
    t = 60_000;
    expect(limit("a").ok).toBe(true);
  });
});

describe("paid endpoints", () => {
  it("answer 402 with USDC requirements when unpaid", async () => {
    const { app } = setup();
    const res = await app.request("/v1/whales");
    expect(res.status).toBe(402);
    const req = JSON.parse(Buffer.from(res.headers.get("payment-required")!, "base64").toString());
    expect(req.accepts[0]).toMatchObject({ network: NETWORK, amount: "20000", payTo: PAY_TO });
  });

  it("settle a valid payment and record it in the ledger", async () => {
    upstream(true);
    const { payFetch, facilitator, ledger } = setup();
    const res = await payFetch("http://local.test/v1/whales?min=20000");
    expect(res.status).toBe(200);
    expect(facilitator.settle).toHaveBeenCalledTimes(1);
    const s = ledger.summary();
    expect(s).toMatchObject({ calls: 1, uniquePayers: 1, revenueUsd: 0.02 });
    expect(s.byRoute).toEqual([{ route: "/v1/whales", calls: 1, revenueUsd: 0.02 }]);
  });

  it("never charge when the upstream fails", async () => {
    upstream(false);
    const { payFetch, facilitator, ledger } = setup();
    const res = await payFetch("http://local.test/v1/whales");
    expect(res.status).toBe(502);
    expect(facilitator.settle).not.toHaveBeenCalled();
    expect(ledger.summary().calls).toBe(0);
  });

  it("price analyze_market at $0.01", async () => {
    const { app } = setup();
    const res = await app.request("/v1/market/will-x");
    const req = JSON.parse(Buffer.from(res.headers.get("payment-required")!, "base64").toString());
    expect(req.accepts[0].amount).toBe("10000");
  });

  it("never charge for a 404", async () => {
    vi.stubGlobal("fetch", async () => new Response("[]"));
    const { payFetch, facilitator } = setup();
    expect((await payFetch("http://local.test/v1/market/does-not-exist")).status).toBe(404);
    expect(facilitator.settle).not.toHaveBeenCalled();
  });
});

describe("production hardening", () => {
  it("ignores X-Forwarded-For unless the proxy is trusted", async () => {
    const facilitator = fakeFacilitator();
    const app = createApp({ payTo: PAY_TO, network: NETWORK, facilitator: facilitator as any, freeRatePerMin: 1, log: () => {} });
    expect((await app.request("/health", { headers: { "x-forwarded-for": "1.1.1.1" } })).status).toBe(200);
    // a spoofed new IP must not reset the limit
    expect((await app.request("/health", { headers: { "x-forwarded-for": "9.9.9.9" } })).status).toBe(429);
  });

  it("serves terms and logs one JSON line per request", async () => {
    const lines: any[] = [];
    const app = createApp({ payTo: PAY_TO, network: NETWORK, facilitator: fakeFacilitator() as any, log: (l) => lines.push(l) });
    const res = await app.request("/terms");
    expect(await res.text()).toMatch(/Not financial advice/);
    expect(lines.at(-1)).toMatchObject({ method: "GET", path: "/terms", status: 200, paid: false });
  });

  it("advertises Bazaar discovery metadata in the 402", async () => {
    const { app } = setup();
    const res = await app.request("/v1/whales");
    const req = JSON.parse(Buffer.from(res.headers.get("payment-required")!, "base64").toString());
    expect(req.extensions?.bazaar).toBeDefined();
    expect(JSON.stringify(req.extensions.bazaar)).toContain("minUsd");
  });
});

describe("remote MCP (/mcp)", () => {
  async function mcpClient(appFetch: any) {
    const client = createx402MCPClient({
      name: "test-agent", version: "0",
      schemes: [{ network: NETWORK, client: new ExactEvmScheme(payer) }],
      autoPayment: true,
      onPaymentRequested: async () => true,
    });
    await client.connect(new StreamableHTTPClientTransport(new URL("http://local.test/mcp"), { fetch: appFetch }));
    return client;
  }

  it("lists tools and pays per call", async () => {
    upstream(true);
    const { appFetch, facilitator, ledger } = setup();
    const client = await mcpClient(appFetch);
    const tools = (await client.listTools()).tools.map((t: any) => t.name).sort();
    expect(tools).toEqual(["analyze_market", "get_market_movers", "get_whale_trades", "list_services"]);
    const r = await client.callTool("get_whale_trades", { min: 20000 });
    expect(r.isError).toBeFalsy();
    expect(r.paymentMade).toBe(true);
    expect(facilitator.settle).toHaveBeenCalledTimes(1);
    expect(ledger.summary().byRoute).toEqual([{ route: "mcp://tool/get_whale_trades", calls: 1, revenueUsd: 0.02 }]);
    await client.close();
  });

  it("does not charge when the tool fails", async () => {
    vi.stubGlobal("fetch", async () => new Response("[]"));
    const { appFetch, facilitator, ledger } = setup();
    const client = await mcpClient(appFetch);
    const r = await client.callTool("analyze_market", { slug: "does-not-exist" });
    expect(r.isError).toBe(true);
    expect(facilitator.settle).not.toHaveBeenCalled();
    expect(ledger.summary().calls).toBe(0);
    await client.close();
  });
});
