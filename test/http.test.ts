import { afterEach, describe, expect, it, vi } from "vitest";
import { getJson, TtlCache, UpstreamError } from "../src/http.js";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

afterEach(() => vi.unstubAllGlobals());

describe("getJson", () => {
  it("retries 5xx and then succeeds", async () => {
    const f = vi.fn().mockResolvedValueOnce(json({}, 503)).mockResolvedValueOnce(json({ ok: 1 }));
    vi.stubGlobal("fetch", f);
    await expect(getJson("https://x.test/a", { backoffMs: 1 })).resolves.toEqual({ ok: 1 });
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("does not retry a 404", async () => {
    const f = vi.fn().mockResolvedValue(json({}, 404));
    vi.stubGlobal("fetch", f);
    await expect(getJson("https://x.test/a", { backoffMs: 1 })).rejects.toMatchObject({ status: 404 });
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("gives up after the retry budget on network errors", async () => {
    const f = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
    vi.stubGlobal("fetch", f);
    await expect(getJson("https://x.test/a", { retries: 2, backoffMs: 1 })).rejects.toBeInstanceOf(UpstreamError);
    expect(f).toHaveBeenCalledTimes(3);
  });

  it("times out a hung request", async () => {
    vi.stubGlobal("fetch", (_u: string, init: RequestInit) =>
      new Promise((_, rej) => init.signal!.addEventListener("abort", () => rej(init.signal!.reason))));
    await expect(getJson("https://x.test/a", { timeoutMs: 20, retries: 0 })).rejects.toThrow(/unreachable/);
  });
});

describe("TtlCache", () => {
  it("serves hits within the TTL and reloads after it", async () => {
    let t = 0;
    const c = new TtlCache(1000, 10, () => t);
    const load = vi.fn().mockResolvedValue("v");
    await c.get("k", load);
    t = 999;
    await c.get("k", load);
    expect(load).toHaveBeenCalledTimes(1);
    t = 1000;
    await c.get("k", load);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("shares one in-flight load between concurrent callers", async () => {
    const c = new TtlCache(1000);
    const load = vi.fn(() => new Promise((r) => setTimeout(() => r("v"), 5)));
    const [a, b] = await Promise.all([c.get("k", load), c.get("k", load)]);
    expect([a, b]).toEqual(["v", "v"]);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("does not cache failures", async () => {
    const c = new TtlCache(1000);
    await expect(c.get("k", () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    await new Promise((r) => setTimeout(r));
    await expect(c.get("k", async () => "ok")).resolves.toBe("ok");
  });
});
