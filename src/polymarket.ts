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

// ---- traders ------------------------------------------------------------------------------

/** Run fn over items with at most `n` in flight (keeps us polite to Polymarket's rate limits). */
async function mapLimit<T, R>(items: T[], n: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k]); }
  }));
  return out;
}

const round = (v: number, d = 2) => Math.round(v * 10 ** d) / 10 ** d;

export type Tier = "sharp" | "profitable" | "break-even" | "losing" | "unproven";

/** Track record from closed positions. Callers pass the most recent ones (not the best ones) so win rate is unbiased. */
export function trackRecord(closed: Json[]) {
  const pnls = closed.map((p) => Number(p.realized_pnl) || 0);
  const wins = pnls.filter((v) => v > 0), losses = pnls.filter((v) => v < 0);
  const decided = wins.length + losses.length;
  const grossWin = wins.reduce((a, b) => a + b, 0), grossLoss = -losses.reduce((a, b) => a + b, 0);
  const holds = closed
    .map((p) => (Number(p.last_event_at) - Number(p.first_entry_at)) / 86400)
    .filter((d) => Number.isFinite(d) && d >= 0)
    .sort((a, b) => a - b);
  const winRate = decided ? wins.length / decided : null;
  const profitFactor = grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? null : 0; // null = no losses yet
  const realizedPnl = grossWin - grossLoss;
  const tier: Tier =
    decided < 20 ? "unproven"
    : winRate! >= 0.55 && (profitFactor == null || profitFactor >= 1.3) && realizedPnl > 0 ? "sharp"
    : realizedPnl > 0 && (profitFactor == null || profitFactor >= 1.05) ? "profitable"
    : realizedPnl < 0 && profitFactor! < 0.95 ? "losing"
    : "break-even";
  return {
    closedPositions: closed.length,
    wins: wins.length,
    losses: losses.length,
    winRate: winRate == null ? null : round(winRate, 3),
    realizedPnl: Math.round(realizedPnl),
    avgWin: wins.length ? Math.round(grossWin / wins.length) : null,
    avgLoss: losses.length ? Math.round(-grossLoss / losses.length) : null,
    profitFactor: profitFactor == null ? null : round(profitFactor),
    medianHoldDays: holds.length ? round(holds[Math.floor(holds.length / 2)], 1) : null,
    tier,
  };
}

/** Polymarket's auto-generated display names ("0xabc…-1759935795465") carry no information. */
const cleanName = (n?: string | null) => (!n || /^0x[0-9a-fA-F]{40}-\d+$/.test(n) ? null : n);

const isWallet = (w: string) => /^0x[0-9a-fA-F]{40}$/.test(w);

/** Most recent closed positions of a wallet (sorted by time, not by PnL). */
const closedPositions = (wallet: string, limit: number) =>
  get<{ data: Json[] }>(`${DATA}/positions?user=${wallet}&status=CLOSED&sort_by=TIMESTAMP&limit=${limit}`).then((r) => r.data ?? []);

export async function traderRecord(wallet: string, sample = 300) {
  return trackRecord(await closedPositions(wallet.toLowerCase(), sample));
}

/** Full profile of one wallet: track record, open book, recent trades. */
export async function trader(wallet: string) {
  if (!isWallet(wallet)) return null;
  const w = wallet.toLowerCase();
  const [closed, open, value, trades] = await Promise.all([
    closedPositions(w, 500),
    get<{ data: Json[] }>(`${DATA}/positions?user=${w}&status=OPEN&limit=100`).then((r) => r.data ?? []),
    get<{ data: Json }>(`${DATA}/value?user=${w}`).then((r) => r.data ?? {}),
    get<{ data: Json[] }>(`${DATA}/trades?user=${w}&limit=15`).then((r) => r.data ?? []),
  ]);
  if (!closed.length && !open.length && !trades.length) return null;
  const record = trackRecord(closed);
  const openPositions = open
    .map((p) => ({
      market: p.title, slug: p.slug, outcome: p.outcome,
      size: round(Number(p.current_size)), avgPrice: Number(p.avg_price), currentPrice: Number(p.current_price),
      valueUsd: Math.round(Number(p.current_value)), unrealizedPnl: Math.round(Number(p.unrealized_pnl)), endDate: p.end_date,
    }))
    .sort((a, b) => b.valueUsd - a.valueUsd);
  const best = [...closed].sort((a, b) => b.realized_pnl - a.realized_pnl)[0];
  const worst = [...closed].sort((a, b) => a.realized_pnl - b.realized_pnl)[0];
  const pos = (p?: Json) => (p ? { market: p.title, outcome: p.outcome, realizedPnl: Math.round(p.realized_pnl) } : null);
  const name = cleanName(trades[0]?.name || closed[0]?.name || open[0]?.name) ?? trades[0]?.pseudonym ?? null;

  const notes: string[] = [];
  if (record.tier === "unproven") notes.push(`only ${record.wins + record.losses} decided positions: too few to judge skill`);
  else notes.push(`${record.tier}: wins ${Math.round(record.winRate! * 100)}% of ${record.wins + record.losses} recent decided positions, profit factor ${record.profitFactor ?? "∞"}`);
  if (openPositions[0] && openPositions[0].valueUsd > 0.5 * Number(value.value ?? 0) && openPositions.length > 1)
    notes.push(`concentrated: over half the open book is in "${openPositions[0].market}"`);

  return {
    wallet: w,
    name,
    profileUrl: `https://polymarket.com/profile/${w}`,
    record: { ...record, sample: `last ${closed.length} closed positions` },
    openBook: {
      valueUsd: Math.round(Number(value.value ?? 0)),
      positions: open.length,
      unrealizedPnl: openPositions.reduce((a, p) => a + p.unrealizedPnl, 0),
      top: openPositions.slice(0, 10),
    },
    bestTrade: pos(best),
    worstTrade: pos(worst),
    recentTrades: trades.slice(0, 10).map(shapeTrade),
    signal: { notes },
  };
}

export const CATEGORIES = ["overall", "politics", "sports", "crypto", "culture", "economics", "tech", "finance", "weather", "mentions"] as const;

/** Polymarket leaderboard, enriched with each trader's win rate and tier from recent closed positions. */
export async function topTraders(opts: { period: "day" | "week" | "month" | "all"; category: string; sortBy: "pnl" | "volume"; limit: number }) {
  const res = await get<{ data: Json[] }>(
    `${DATA}/leaderboard?limit=${opts.limit}&time_period=${opts.period}&category=${opts.category}&sort_by=${opts.sortBy === "volume" ? "VOLUME" : "PNL"}`,
  );
  const board = res.data ?? [];
  const records = await mapLimit(board, 5, (r) => traderRecord(r.user_id, 200).catch(() => null));
  const items = board.map((r, i) => ({
    rank: r.rank,
    wallet: r.user_id,
    name: cleanName(r.user_name),
    pnl: Math.round(r.pnl),
    volume: Math.round(r.volume),
    record: records[i],
    profileUrl: `https://polymarket.com/profile/${r.user_id}`,
  }));
  return { ...opts, count: items.length, items };
}

/** Large trades with the trader's track record attached, and the money flow of proven traders only. */
export async function smartMoney(opts: { minUsd: number; limit: number; slug?: string; enrich?: number }) {
  let url = `${DATA}/trades?limit=${opts.limit}&filterType=CASH&filterAmount=${opts.minUsd}`;
  if (opts.slug) {
    const list = await get<Json[]>(`${GAMMA}/markets?slug=${encodeURIComponent(opts.slug)}`);
    if (!list.length) return null;
    url += `&condition_id=${list[0].conditionId}`;
  }
  const trades = ((await get<{ data: Json[] }>(url)).data ?? []).map(shapeTrade);

  // Enrich the wallets that moved the most money (bounded, to keep the call fast).
  const byWallet = new Map<string, number>();
  for (const t of trades) byWallet.set(t.wallet, (byWallet.get(t.wallet) ?? 0) + t.usd);
  const wallets = [...byWallet.entries()].sort((a, b) => b[1] - a[1]).slice(0, opts.enrich ?? 40).map(([w]) => w);
  const recs = await mapLimit(wallets, 5, (w) => traderRecord(w, 200).catch(() => null));
  const recOf = new Map(wallets.map((w, i) => [w, recs[i]]));

  const annotated = trades.map((t) => {
    const r = recOf.get(t.wallet);
    return { ...t, traderTier: r?.tier ?? "unknown", traderWinRate: r?.winRate ?? null, traderRealizedPnl: r?.realizedPnl ?? null };
  });
  const smart = annotated.filter((t) => t.traderTier === "sharp" || t.traderTier === "profitable");
  const tiers = annotated.reduce<Record<string, number>>((a, t) => ((a[t.traderTier] = (a[t.traderTier] ?? 0) + 1), a), {});

  return {
    minUsd: opts.minUsd,
    market: opts.slug ?? null,
    count: annotated.length,
    smartTrades: smart.length,
    tiers,
    smartFlows: flows(smart).slice(0, 10),
    allFlows: flows(trades).slice(0, 10),
    trades: annotated,
    method: "tier from each wallet's last 200 closed positions: sharp = win rate ≥55%, profit factor ≥1.3, net profit; needs ≥20 decided positions",
  };
}
