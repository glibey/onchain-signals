import { afterEach, describe, expect, it, vi } from "vitest";
import { flows, market, shapeMarket, shapeTrade } from "../src/polymarket.js";

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
