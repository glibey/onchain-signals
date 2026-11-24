// Prints the revenue report from the payment ledger. Usage: npm run revenue [-- 2026-11-01]
import { Ledger } from "./payments.js";

const ledger = new Ledger();
const s = ledger.summary(process.argv[2]);
console.log(`Paid calls: ${s.calls}   Unique payers: ${s.uniquePayers}   Revenue: $${s.revenueUsd.toFixed(4)}\n`);
if (s.byRoute.length) console.table(s.byRoute);
if (s.byDay.length) console.table(s.byDay);
ledger.close();
