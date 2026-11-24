// Payment ledger: every settled x402 payment, stored in SQLite (built into Node, no native deps).
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type Payment = {
  route: string;
  payer: string;
  amount: string; // atomic units (USDC = 6 decimals)
  asset: string;
  network: string;
  tx: string;
};

export class Ledger {
  private db: DatabaseSync;

  constructor(path = process.env.DB_PATH ?? "data/payments.db") {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`CREATE TABLE IF NOT EXISTS payments (
      id INTEGER PRIMARY KEY,
      ts TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      route TEXT NOT NULL, payer TEXT NOT NULL, amount TEXT NOT NULL,
      asset TEXT NOT NULL, network TEXT NOT NULL, tx TEXT NOT NULL UNIQUE)`);
  }

  record(p: Payment) {
    this.db
      .prepare("INSERT OR IGNORE INTO payments (route, payer, amount, asset, network, tx) VALUES (?, ?, ?, ?, ?, ?)")
      .run(p.route, p.payer.toLowerCase(), p.amount, p.asset, p.network, p.tx);
  }

  /** Revenue summary, optionally since an ISO timestamp. Amounts in USD (6-decimal stablecoin). */
  summary(since = "1970-01-01") {
    const totals = this.db
      .prepare(`SELECT COUNT(*) AS calls, COUNT(DISTINCT payer) AS payers, COALESCE(SUM(CAST(amount AS INTEGER)), 0) AS atomic
                FROM payments WHERE ts >= ?`)
      .get(since) as { calls: number; payers: number; atomic: number };
    const byRoute = this.db
      .prepare(`SELECT route, COUNT(*) AS calls, SUM(CAST(amount AS INTEGER)) AS atomic
                FROM payments WHERE ts >= ? GROUP BY route ORDER BY atomic DESC`)
      .all(since) as { route: string; calls: number; atomic: number }[];
    const byDay = this.db
      .prepare(`SELECT substr(ts, 1, 10) AS day, COUNT(*) AS calls, COUNT(DISTINCT payer) AS payers, SUM(CAST(amount AS INTEGER)) AS atomic
                FROM payments WHERE ts >= ? GROUP BY day ORDER BY day DESC LIMIT 30`)
      .all(since) as { day: string; calls: number; payers: number; atomic: number }[];
    const usd = (a: number) => a / 1e6;
    return {
      calls: totals.calls,
      uniquePayers: totals.payers,
      revenueUsd: usd(totals.atomic),
      byRoute: byRoute.map((r) => ({ route: r.route, calls: r.calls, revenueUsd: usd(r.atomic) })),
      byDay: byDay.map((d) => ({ day: d.day, calls: d.calls, payers: d.payers, revenueUsd: usd(d.atomic) })),
    };
  }

  close() {
    this.db.close();
  }
}
