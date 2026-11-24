// Thin client over Polymarket's public APIs + the signal logic we sell.
const GAMMA = "https://gamma-api.polymarket.com";
const DATA = "https://data-api.polymarket.com/v2";

import { getJson, TtlCache } from "./http.js";

type Json = Record<string, any>;

// Upstream responses are cached briefly: faster answers, fewer hits on Polymarket's limits.
export const cache = new TtlCache(Number(process.env.CACHE_TTL_MS ?? 30_000));
const get = <T = any>(url: string) => cache.get<T>(url, () => getJson<T>(url));

const num = (v: unknown) => (v == null || v === "" ? null : Number(v));
const parseArr = (v: unknown): any[] => {
  if (Array.isArray(v)) return v;
  try { return JSON.parse(String(v ?? "[]")); } catch { return []; }
};

export function shapeMarket(m: Json) {
  const outcomes = parseArr(m.outcomes);
  const prices = parseArr(m.outcomePrices).map(Number);
  return {
    slug: m.slug,
    question: m.question,
    conditionId: m.conditionId,
    endDate: m.endDate,
    outcomes: outcomes.map((o: string, i: number) => ({ outcome: o, price: prices[i] ?? null })),
    lastTradePrice: num(m.lastTradePrice),
    bestBid: num(m.bestBid),
    bestAsk: num(m.bestAsk),
    spread: num(m.spread),
    change1d: num(m.oneDayPriceChange),
    change1w: num(m.oneWeekPriceChange),
    volume24h: num(m.volume24hr),
    liquidity: num(m.liquidityNum ?? m.liquidity),
    url: `https://polymarket.com/market/${m.slug}`,
  };
}

/** Markets with the biggest price moves, weighted toward ones with real volume. */
export async function movers(opts: { window: "1d" | "1w"; limit: number; minVolume: number }) {
  const raw = await get<Json[]>(
    `${GAMMA}/markets?active=true&closed=false&limit=500&order=volume24hr&ascending=false`,
  );
  const key = opts.window === "1w" ? "change1w" : "change1d";
  const items = raw
    .map(shapeMarket)
    .filter((m) => (m.volume24h ?? 0) >= opts.minVolume && m[key] != null)
    .sort((a, b) => Math.abs(b[key]!) - Math.abs(a[key]!))
    .slice(0, opts.limit);
  return { window: opts.window, count: items.length, items };
}

export type Trade = {
  wallet: string; trader: string; side: "BUY" | "SELL"; outcome: string;
  usd: number; price: number; time: string; market: string; slug: string; conditionId: string; tx: string;
};

export function shapeTrade(t: Json): Trade {
  return {
    wallet: t.proxy_wallet,
    trader: t.name || t.pseudonym || t.proxy_wallet,
    side: t.side,
    outcome: t.outcome,
    usd: Math.round(Number(t.size) * Number(t.price) * 100) / 100,
    price: Number(t.price),
    time: new Date(Number(t.timestamp) * 1000).toISOString(),
    market: t.title,
    slug: t.slug,
    conditionId: t.condition_id,
    tx: t.transaction_hash,
  };
}

/** Net USD flow per market+outcome: BUY adds, SELL subtracts. */
export function flows(trades: Trade[]) {
  const by = new Map<string, { market: string; slug: string; outcome: string; netUsd: number; trades: number; wallets: Set<string> }>();
  for (const t of trades) {
    const k = `${t.conditionId}:${t.outcome}`;
    const f = by.get(k) ?? { market: t.market, slug: t.slug, outcome: t.outcome, netUsd: 0, trades: 0, wallets: new Set() };
    f.netUsd += t.side === "BUY" ? t.usd : -t.usd;
    f.trades += 1;
    f.wallets.add(t.wallet);
    by.set(k, f);
  }
  return [...by.values()]
    .map(({ wallets, ...f }) => ({ ...f, netUsd: Math.round(f.netUsd), uniqueWallets: wallets.size }))
    .sort((a, b) => Math.abs(b.netUsd) - Math.abs(a.netUsd));
}

/** Recent large ("whale") trades across all markets, plus where the money is flowing. */
export async function whales(opts: { minUsd: number; limit: number }) {
  const res = await get<{ data: Json[] }>(
    `${DATA}/trades?limit=${opts.limit}&filterType=CASH&filterAmount=${opts.minUsd}`,
  );
  const trades = (res.data ?? []).map(shapeTrade);
  return { minUsd: opts.minUsd, count: trades.length, topFlows: flows(trades).slice(0, 10), trades };
}

/** One market: price/liquidity snapshot + whale flow + a simple, explainable signal. */
export async function market(slug: string, minUsd: number) {
  const list = await get<Json[]>(`${GAMMA}/markets?slug=${encodeURIComponent(slug)}`);
  if (!list.length) return null;
  const m = shapeMarket(list[0]);
  const res = await get<{ data: Json[] }>(`${DATA}/trades?condition_id=${m.conditionId}&limit=500`);
  const trades = (res.data ?? []).map(shapeTrade);
  const big = trades.filter((t) => t.usd >= minUsd);
  const flow = flows(big);

  const notes: string[] = [];
  if ((m.spread ?? 0) > 0.05) notes.push("wide spread: thin book, prices may be unreliable");
  if ((m.liquidity ?? 0) < 10_000) notes.push("low liquidity");
  const lead = flow[0];
  if (lead && Math.abs(lead.netUsd) >= minUsd * 2)
    notes.push(`whales net ${lead.netUsd > 0 ? "buying" : "selling"} "${lead.outcome}" ($${Math.abs(lead.netUsd).toLocaleString("en-US")})`);
  if (m.change1d != null && Math.abs(m.change1d) >= 0.1) notes.push(`large 24h move: ${(m.change1d * 100).toFixed(1)} pts`);

  return {
    ...m,
    whaleFlow: { minUsd, sampledTrades: trades.length, largeTrades: big.length, byOutcome: flow },
    recentLargeTrades: big.slice(0, 20),
    signal: { notes },
  };
}
