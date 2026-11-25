import { Hono, type Context } from "hono";
import { getConnInfo } from "@hono/node-server/conninfo";
import { paymentMiddleware, x402ResourceServer } from "@x402/hono";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import type { FacilitatorClient } from "@x402/core/server";
import { bazaarResourceServerExtension, declareDiscoveryExtension } from "@x402/extensions/bazaar";
import * as pm from "./polymarket.js";
import type { Ledger } from "./payments.js";
import { TOOLS } from "./tools.js";
import { remoteMcp } from "./remote-mcp.js";
import { TERMS } from "./terms.js";
import { llmsTxt, serverCard } from "./discovery.js";

export type AppOptions = {
  payTo: string;
  network: `${string}:${string}`;
  facilitator: FacilitatorClient;
  paymentsOff?: boolean; // local dev only
  ledger?: Ledger;
  freeRatePerMin?: number; // per-IP limit on free endpoints
  trustProxy?: "none" | "xff" | "fly"; // where the client IP comes from
  syncFacilitatorOnStart?: boolean;
  log?: (line: Record<string, unknown>) => void;
};

const SERVICE = { serviceName: "onchain-signals", tags: ["polymarket", "prediction-markets", "polymarket-traders", "win-rate", "smart-money", "whales", "leaderboard", "crypto", "analytics", "mcp"] };

// What the HTTP API sells, derived from the shared tool definitions.
export const CATALOG = Object.fromEntries(
  Object.values(TOOLS).map((t) => [
    t.route,
    {
      price: t.price,
      description: t.description,
      query: Object.fromEntries(
        Object.entries(t.input).filter(([k]) => !t.route.includes(`:${k}`)).map(([k, z]) => [k, (z as any).description ?? ""]),
      ),
    },
  ]),
);

/** Fixed-window per-key limiter, in memory (fine for one instance). */
export function rateLimiter(perMin: number, now = () => Date.now()) {
  const hits = new Map<string, { start: number; n: number }>();
  return (key: string) => {
    const t = now();
    const h = hits.get(key);
    if (!h || t - h.start >= 60_000) {
      hits.set(key, { start: t, n: 1 });
      if (hits.size > 10_000) hits.delete(hits.keys().next().value!);
      return { ok: true, retryAfter: 0 };
    }
    h.n++;
    return h.n <= perMin ? { ok: true, retryAfter: 0 } : { ok: false, retryAfter: Math.ceil((h.start + 60_000 - t) / 1000) };
  };
}

/** Client IP. Proxy headers are trusted only when configured, otherwise anyone could spoof them. */
export function clientIp(c: Context, trust: AppOptions["trustProxy"] = "none") {
  if (trust === "fly") {
    const ip = c.req.header("fly-client-ip");
    if (ip) return ip;
  }
  if (trust === "xff") {
    const ip = c.req.header("x-forwarded-for")?.split(",")[0]?.trim();
    if (ip) return ip;
  }
  try {
    return getConnInfo(c).remote.address ?? "unknown";
  } catch {
    return "unknown";
  }
}

const clamp = (v: string | undefined, def: number, lo: number, hi: number) => {
  const n = Number(v ?? def);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : def;
};

export function createApp(o: AppOptions) {
  const app = new Hono();
  const log = o.log ?? ((l) => console.log(JSON.stringify(l)));

  // One JSON line per request: enough for uptime/error/revenue monitoring from logs.
  app.use(async (c, next) => {
    const t0 = performance.now();
    await next();
    log({
      ts: new Date().toISOString(), method: c.req.method, path: c.req.path, status: c.res.status,
      ms: Math.round(performance.now() - t0), paid: c.res.headers.has("payment-response"),
    });
  });

  // Any upstream failure becomes a 5xx, and x402 never settles a payment for a response >= 400.
  app.onError((err, c) => {
    console.error(err);
    return c.json({ error: "upstream_error", message: err.message }, 502);
  });

  const index = () => ({
    name: "onchain-signals",
    about: "Pay-per-call prediction-market intelligence for AI agents. No API keys: pay per request in USDC via x402.",
    network: o.network,
    payTo: o.payTo || null,
    terms: "/terms",
    disclaimer: "Data and analytics only, not financial advice. Source: Polymarket public APIs; not affiliated with Polymarket.",
    mcp: { endpoint: "/mcp", transport: "streamable-http", payment: "x402 per tool call", serverCard: "/.well-known/mcp.json", registry: "io.github.glibey/onchain-signals", npm: "onchain-signals-mcp" },
    llms: "/llms.txt",
    resources: Object.entries(CATALOG).map(([route, r]) => {
      const [method, path] = route.split(" ");
      return { method, path: path.replace(/:(\w+)/g, "{$1}"), ...r };
    }),
  });

  // Free endpoints, rate-limited per IP.
  const limit = rateLimiter(o.freeRatePerMin ?? 60);
  const free = new Hono();
  free.use(async (c, next) => {
    const r = limit(clientIp(c, o.trustProxy));
    if (!r.ok) {
      c.header("retry-after", String(r.retryAfter));
      return c.json({ error: "rate_limited", retryAfterSeconds: r.retryAfter }, 429);
    }
    await next();
  });
  free.get("/", (c) => c.json(index()));
  free.get("/.well-known/x402", (c) => c.json(index()));
  free.get("/terms", (c) => c.text(TERMS));
  const origin = (c: Context) => new URL(c.req.url).origin;
  free.get("/llms.txt", (c) => c.text(llmsTxt(origin(c))));
  free.get("/.well-known/mcp.json", (c) => c.json(serverCard(origin(c))));
  free.get("/.well-known/mcp/server-card.json", (c) => c.json(serverCard(origin(c))));
  free.get("/health", (c) => c.json({ ok: true, cache: { hits: pm.cache.hits, misses: pm.cache.misses } }));
  app.route("/", free);

  // Paywall
  if (o.paymentsOff) {
    console.warn("⚠️  X402_DISABLED=1: paid endpoints are FREE. Never use this in production.");
  } else {
    const resourceServer = new x402ResourceServer(o.facilitator)
      .register(o.network, new ExactEvmScheme())
      .registerExtension(bazaarResourceServerExtension);

    if (o.ledger) {
      const ledger = o.ledger;
      resourceServer.onAfterSettle(async ({ result, requirements, paymentPayload }) => {
        if (!result.success) return;
        const url = (paymentPayload as any).resource?.url as string | undefined;
        try {
          ledger.record({
            route: !url ? "unknown" : url.startsWith("http") ? new URL(url).pathname : url, // mcp://tool/<name>
            payer: result.payer ?? "unknown",
            amount: String(requirements.amount),
            asset: String(requirements.asset),
            network: String(result.network ?? requirements.network),
            tx: result.transaction,
          });
        } catch (e) {
          console.error("ledger write failed (payment already settled):", e);
        }
      });
    }

    const routes = Object.fromEntries(
      Object.values(TOOLS).map((t) => [
        t.route,
        {
          accepts: [{ scheme: "exact", price: t.price, network: o.network, payTo: o.payTo, maxTimeoutSeconds: 60 }],
          description: t.description,
          mimeType: "application/json",
          ...SERVICE,
          // Bazaar: lets facilitators list us so agents can discover and call the endpoint on their own.
          extensions: declareDiscoveryExtension({
            // Query params travel as strings; list them that way so indexers validate them as such.
            ...(t.example.query ? { input: Object.fromEntries(Object.entries(t.example.query).map(([k, v]) => [k, String(v)])) } : {}),
            output: { example: t.example.output },
          }),
        },
      ]),
    );
    app.use(paymentMiddleware(routes as any, resourceServer, undefined, undefined, o.syncFacilitatorOnStart ?? true));

    // Remote MCP: the same tools, paid per call inside MCP.
    const mcp = remoteMcp({ resourceServer, payTo: o.payTo, network: o.network, catalog: index });
    app.all("/mcp", (c) => mcp(c.req.raw));
  }

  // Paid HTTP endpoints
  app.get("/v1/markets/movers", async (c) => {
    const window = c.req.query("window") === "1w" ? "1w" : "1d";
    return c.json(await pm.movers({
      window,
      limit: clamp(c.req.query("limit"), 20, 1, 50),
      minVolume: clamp(c.req.query("minVolume"), 10_000, 0, 1e12),
    }));
  });

  app.get("/v1/whales", async (c) =>
    c.json(await pm.whales({
      minUsd: clamp(c.req.query("min"), 10_000, 100, 1e9),
      limit: clamp(c.req.query("limit"), 200, 1, 500),
    })),
  );

  app.get("/v1/market/:slug", async (c) => {
    const data = await pm.market(c.req.param("slug"), clamp(c.req.query("min"), 5_000, 100, 1e9));
    return data ? c.json(data) : c.json({ error: "not_found" }, 404);
  });

  app.get("/v1/trader/:wallet", async (c) => {
    const data = await pm.trader(c.req.param("wallet"));
    return data ? c.json(data) : c.json({ error: "not_found", detail: "unknown or inactive wallet" }, 404);
  });

  app.get("/v1/traders/top", async (c) => {
    const q = (k: string) => c.req.query(k);
    const period = (["day", "week", "month", "all"] as const).find((p) => p === q("period")) ?? "month";
    const category = pm.CATEGORIES.find((x) => x === q("category")) ?? "overall";
    return c.json(await pm.topTraders({
      period, category, sortBy: q("sortBy") === "volume" ? "volume" : "pnl", limit: clamp(q("limit"), 10, 1, 25),
    }));
  });

  app.get("/v1/smart-money", async (c) => {
    const slug = c.req.query("slug") || undefined;
    const data = await pm.smartMoney({
      minUsd: clamp(c.req.query("min"), 10_000, 1000, 1e9),
      limit: clamp(c.req.query("limit"), 200, 1, 500),
      slug,
    });
    return data ? c.json(data) : c.json({ error: "not_found" }, 404);
  });

  return app;
}
