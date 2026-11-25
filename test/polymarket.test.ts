import { afterEach, describe, expect, it, vi } from "vitest";
import { flows, market, shapeMarket, shapeTrade, smartMoney, topTraders, trackRecord, trader } from "../src/polymarket.js";

const rawTrade = (o: Partial<Record<string, unknown>>) => ({
  proxy_wallet: "0xw1", side: "BUY", size: 1000, price: 0.5, timestamp: 1795514771,
  title: "Will X happen?", slug: "will-x", outcome: "Yes", condition_id: "0xc1", transaction_hash: "0xt", ...o,
});

const rawMarket = {
  slug: "will-x", question: "Will X happen?", conditionId: "0xc1", endDate: "2027-01-01T00:00:00Z",
  outcomes: '["Yes","No"]', outcomePrices: '["0.62","0.38"]', lastTradePrice: "0.62", bestBid: 0.61, bestAsk: 0.63,
  spread: 0.02, oneDayPriceChange: 0.15, oneWeekPriceChange: 0.2, volume24hr: 50000, liquidityNum: 80000,
};

afterEach(() => vi.unstubAllGlobals());

describe("shaping", () => {
  it("parses outcome arrays and prices", () => {
    const m = shapeMarket(rawMarket);
    expect(m.outcomes).toEqual([{ outcome: "Yes", price: 0.62 }, { outcome: "No", price: 0.38 }]);
    expect(m.url).toBe("https://polymarket.com/market/will-x");
  });

  it("computes trade USD as size × price", () => {
    expect(shapeTrade(rawTrade({ size: 36621.87, price: 0.67 })).usd).toBe(24536.65);
  });
});

describe("flows", () => {
  it("nets buys against sells per outcome and counts unique wallets", () => {
    const t = [
      rawTrade({ size: 20000, price: 0.5 }), // +10k Yes
      rawTrade({ size: 10000, price: 0.5, proxy_wallet: "0xw2" }), // +5k Yes
      rawTrade({ size: 4000, price: 0.5, side: "SELL" }), // -2k Yes
      rawTrade({ size: 2000, price: 0.5, outcome: "No" }), // +1k No
    ].map(shapeTrade);
    expect(flows(t)).toEqual([
      { market: "Will X happen?", slug: "will-x", outcome: "Yes", netUsd: 13000, trades: 3, uniqueWallets: 2 },
      { market: "Will X happen?", slug: "will-x", outcome: "No", netUsd: 1000, trades: 1, uniqueWallets: 1 },
    ]);
  });
});

describe("market()", () => {
  it("flags whale buying and a large 24h move", async () => {
    vi.stubGlobal("fetch", async (url: string) => {
      const body = url.includes("gamma-api")
        ? [rawMarket]
        : { data: [rawTrade({ size: 40000, price: 0.5 }), rawTrade({ size: 100, price: 0.5 })] };
      return new Response(JSON.stringify(body));
    });
    const m = await market("will-x", 5000);
    expect(m!.whaleFlow.largeTrades).toBe(1);
    expect(m!.signal.notes).toEqual(['whales net buying "Yes" ($20,000)', "large 24h move: 15.0 pts"]);
  });

  it("returns null for an unknown slug", async () => {
    vi.stubGlobal("fetch", async () => new Response("[]"));
    await expect(market("nope", 5000)).resolves.toBeNull();
  });
});

const closed = (pnl: number, i = 0) => ({ realized_pnl: pnl, first_entry_at: 1_000_000 + i, last_event_at: 1_000_000 + i + 86400 * 2, title: `M${i}`, outcome: "Yes" });

describe("trackRecord()", () => {
  it("computes win rate, profit factor and tier", () => {
    const rows = [...Array(15).keys()].map((i) => closed(100, i)).concat([...Array(5).keys()].map((i) => closed(-100, 20 + i)));
    expect(trackRecord(rows)).toMatchObject({
      wins: 15, losses: 5, winRate: 0.75, realizedPnl: 1000, avgWin: 100, avgLoss: -100, profitFactor: 3, medianHoldDays: 2, tier: "sharp",
    });
  });

  it("ignores flat positions in the win rate and needs 20 decided positions to judge", () => {
    const r = trackRecord([closed(50), closed(0), closed(-10)]);
    expect(r).toMatchObject({ wins: 1, losses: 1, winRate: 0.5, tier: "unproven" });
  });

  it("labels a net loser", () => {
    const rows = [...Array(10).keys()].map((i) => closed(50, i)).concat([...Array(10).keys()].map((i) => closed(-100, i)));
    expect(trackRecord(rows).tier).toBe("losing");
  });

  it("handles a wallet with no history", () => {
    expect(trackRecord([])).toMatchObject({ winRate: null, profitFactor: 0, tier: "unproven" });
  });
});

const W = "0x00000000000000000000000000000000000000a1";

describe("trader()", () => {
  it("rejects malformed wallets without calling upstream", async () => {
    const f = vi.fn();
    vi.stubGlobal("fetch", f);
    await expect(trader("nope")).resolves.toBeNull();
    expect(f).not.toHaveBeenCalled();
  });

  it("asks for recent (not best) closed positions and drops auto-generated names", async () => {
    const urls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      urls.push(url);
      if (url.includes("status=CLOSED")) return new Response(JSON.stringify({ data: [closed(10), closed(-5)] }));
      if (url.includes("/value")) return new Response(JSON.stringify({ data: { value: 100 } }));
      if (url.includes("/trades")) return new Response(JSON.stringify({ data: [rawTrade({ name: `${W}-1759935795465`, pseudonym: "Rosy-Trinket" })] }));
      return new Response(JSON.stringify({ data: [] }));
    });
    const t = await trader(W.toUpperCase().replace("0X", "0x"));
    expect(urls.find((u) => u.includes("status=CLOSED"))).toContain("sort_by=TIMESTAMP");
    expect(t).toMatchObject({ wallet: W, name: "Rosy-Trinket", record: { wins: 1, losses: 1 }, openBook: { valueUsd: 100 } });
  });
});

describe("topTraders() and smartMoney()", () => {
  const winners = { data: [...Array(20).keys()].map((i) => closed(100, i)) };

  it("enriches the leaderboard with each trader's record", async () => {
    vi.stubGlobal("fetch", async (url: string) =>
      new Response(JSON.stringify(url.includes("leaderboard")
        ? { data: [{ rank: 1, user_id: W, user_name: "alice", pnl: 1000.4, volume: 5000 }] }
        : winners)));
    const r = await topTraders({ period: "week", category: "politics", sortBy: "pnl", limit: 1 });
    expect(r.items[0]).toMatchObject({ rank: 1, name: "alice", pnl: 1000, record: { tier: "sharp", winRate: 1 } });
  });

  it("counts only proven traders in smart flow", async () => {
    vi.stubGlobal("fetch", async (url: string) => {
      if (url.includes("/trades")) return new Response(JSON.stringify({ data: [
        rawTrade({ proxy_wallet: "0xsharp", size: 40000 }),
        rawTrade({ proxy_wallet: "0xnew", size: 40000, outcome: "No" }),
      ] }));
      return new Response(JSON.stringify(url.includes("0xsharp") ? winners : { data: [] }));
    });
    const r = (await smartMoney({ minUsd: 10000, limit: 10 }))!;
    expect(r.smartTrades).toBe(1);
    expect(r.smartFlows).toEqual([expect.objectContaining({ outcome: "Yes", netUsd: 20000 })]);
    expect(r.allFlows).toHaveLength(2);
    expect(r.tiers).toEqual({ sharp: 1, unproven: 1 });
  });
});
