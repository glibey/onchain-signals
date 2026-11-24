// Upstream HTTP helpers: timeout + retry, and a small TTL cache with in-flight de-duplication.

export class UpstreamError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const retryable = (status: number) => status === 429 || status >= 500;

/** GET JSON with a per-attempt timeout; retries network errors, 429 and 5xx with backoff. */
export async function getJson<T = unknown>(
  url: string,
  { timeoutMs = 8000, retries = 2, backoffMs = 300 } = {},
): Promise<T> {
  let last: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt) await sleep(backoffMs * 2 ** (attempt - 1));
    try {
      const res = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(timeoutMs) });
      if (res.ok) return (await res.json()) as T;
      last = new UpstreamError(`upstream ${res.status} for ${new URL(url).pathname}`, res.status);
      if (!retryable(res.status)) break;
    } catch (e) {
      last = e instanceof UpstreamError ? e : new UpstreamError(`upstream unreachable: ${(e as Error).message}`);
    }
  }
  throw last;
}

type Entry = { at: number; value: Promise<unknown> };

/** TTL cache. Concurrent callers for the same key share one upstream request; failures are not cached. */
export class TtlCache {
  private map = new Map<string, Entry>();
  hits = 0;
  misses = 0;

  constructor(private ttlMs: number, private maxEntries = 500, private now = () => Date.now()) {}

  get<T>(key: string, load: () => Promise<T>): Promise<T> {
    const e = this.map.get(key);
    if (e && this.now() - e.at < this.ttlMs) {
      this.hits++;
      return e.value as Promise<T>;
    }
    this.misses++;
    const value = load();
    this.map.set(key, { at: this.now(), value });
    value.catch(() => this.map.get(key)?.value === value && this.map.delete(key));
    if (this.map.size > this.maxEntries) this.map.delete(this.map.keys().next().value!);
    return value;
  }
}
