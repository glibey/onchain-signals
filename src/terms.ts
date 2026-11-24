// Draft terms served at /terms. A starting point, not legal advice: have it reviewed before mainnet launch.
export const TERMS = `onchain-signals: Terms of Use (draft)

1. What this is. onchain-signals provides data and analytics derived from public prediction-market data
   (currently Polymarket public APIs). It is not affiliated with, endorsed by, or operated by Polymarket.

2. Not financial advice. Everything returned is information only. Nothing here is investment, trading,
   legal or tax advice, or a recommendation to buy, sell or bet on anything. You are responsible for your
   own decisions.

3. No warranty. Data is provided "as is", may be delayed, incomplete or wrong, and upstream sources can
   change or disappear without notice.

4. Payments. Each paid request is priced up front in the HTTP 402 response and settled on-chain in USDC
   via the x402 protocol. Requests that fail (any error response) are not charged. Settled payments are
   final and are not refunded.

5. Acceptable use. Do not abuse, overload or attempt to bypass payment or rate limits. Do not use the
   service where doing so is unlawful for you, including where prediction markets are restricted.

6. Records. We log request metadata and settled payments (payer address, amount, transaction hash) to
   operate the service and account for revenue.

7. Changes. These terms and prices may change; the version served at /terms applies.
`;
