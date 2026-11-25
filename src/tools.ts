// Single definition of what we sell, shared by the HTTP paywall, the remote MCP endpoint and the local MCP bridge.
import { z } from "zod";
import * as pm from "./polymarket.js";

const qs = (o: Record<string, unknown>) =>
  new URLSearchParams(Object.entries(o).filter(([, v]) => v != null).map(([k, v]) => [k, String(v)])).toString();

const moversInput = {
  window: z.enum(["1d", "1w"]).default("1d").describe("Lookback window for the price change: '1d' (24 hours) or '1w' (7 days)"),
  limit: z.number().int().min(1).max(50).default(20).describe("How many markets to return (1-50)"),
  minVolume: z.number().min(0).default(10000).describe("Skip markets with less than this 24h trading volume, in USD"),
};
const whalesInput = {
  min: z.number().min(100).default(10000).describe("Only count trades of at least this size, in USD"),
  limit: z.number().int().min(1).max(500).default(200).describe("How many recent large trades to scan"),
};
const marketInput = {
  slug: z.string().min(1).describe("Market slug or polymarket.com URL, e.g. 'new-nvidia-ceo-named-by-december-31-2026'"),
  min: z.number().min(100).default(5000).describe("Trades of at least this size (USD) count as whale trades in the flow analysis"),
};

const toSlug = (s: string) => s.replace(/^.*\/market\//, "").replace(/[?#].*$/, "");

type Shape = Record<string, z.ZodTypeAny>;
export const VERSION = "0.3.1"; // keep in sync with package.json and server.json (checked by tests)

/** MCP tool annotations: every tool only reads public market data. */
export const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;

export type Tool<S extends Shape> = {
  route: string; // HTTP route key, as the paywall sees it
  price: string;
  title: string;
  description: string;
  input: S;
  path: (a: z.infer<z.ZodObject<S>>) => string; // HTTP path for the local bridge
  run: (a: z.infer<z.ZodObject<S>>) => Promise<unknown>; // direct call for the remote MCP endpoint
  example: { query?: Record<string, unknown>; output: unknown }; // Bazaar discovery hints
};
const tool = <S extends Shape>(t: Tool<S>) => t;

export const TOOLS = {
  get_market_movers: tool({
    route: "GET /v1/markets/movers",
    price: "$0.01",
    title: "Prediction market movers",
    description: "Polymarket markets with the biggest price moves over 1 day or 1 week, filtered by 24h volume.",
    input: moversInput,
    path: (a) => `/v1/markets/movers?${qs(a)}`,
    run: (a) => pm.movers({ window: a.window, limit: a.limit, minVolume: a.minVolume }),
    example: { query: { window: "1d", limit: 20 }, output: { window: "1d", count: 1, items: [{ slug: "will-x", question: "Will X happen?", change1d: 0.15, volume24h: 50000 }] } },
  }),
  get_whale_trades: tool({
    route: "GET /v1/whales",
    price: "$0.02",
    title: "Whale trades & money flow",
    description: "Recent large Polymarket trades and net whale USD flow per market/outcome (where big money is going).",
    input: whalesInput,
    path: (a) => `/v1/whales?${qs(a)}`,
    run: (a) => pm.whales({ minUsd: a.min, limit: a.limit }),
    example: { query: { min: 10000 }, output: { minUsd: 10000, count: 1, topFlows: [{ market: "Will X happen?", outcome: "Yes", netUsd: 25000, uniqueWallets: 2 }], trades: [] } },
  }),
  analyze_market: tool({
    route: "GET /v1/market/:slug",
    price: "$0.01",
    title: "Analyze one market",
    description: "One Polymarket market by slug: prices, spread, liquidity, whale flow and plain-language signal notes.",
    input: marketInput,
    path: (a) => `/v1/market/${encodeURIComponent(toSlug(a.slug))}?${qs({ min: a.min })}`,
    run: async (a) => {
      const m = await pm.market(toSlug(a.slug), a.min);
      if (!m) throw new Error(`market not found: ${toSlug(a.slug)}`);
      return m;
    },
    example: { output: { slug: "will-x", question: "Will X happen?", signal: { notes: ['whales net buying "Yes" ($20,000)'] } } },
  }),
};

export type ToolName = keyof typeof TOOLS;
