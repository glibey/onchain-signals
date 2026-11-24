# onchain-signals-mcp

Prediction-market intelligence for AI agents, paid per call in USDC via [x402](https://x402.org). No sign-up, no API keys: your agent pays a cent or two per request from its own wallet.

- **Market movers:** Polymarket markets with the biggest 1-day or 1-week price moves, filtered by volume.
- **Whale trades:** recent large trades and the net money flow per market and outcome.
- **Market analysis:** one market's prices, spread, liquidity, whale flow and plain-language signal notes.

Data comes from Polymarket's public APIs. This project is not affiliated with Polymarket. Nothing it returns is financial advice.

## Tools and prices

| Tool | Price | What it returns |
|---|---|---|
| `get_market_movers` | $0.01 | biggest price moves (`window` 1d/1w, `limit`, `minVolume`) |
| `get_whale_trades` | $0.02 | large trades + net whale flow (`min` USD, `limit`) |
| `analyze_market` | $0.01 | one market by slug or polymarket.com URL (`slug`, `min`) |
| `list_services` | free | catalog and current prices |
| `wallet_status` | free | payer address, USDC balance, spend this session, receipts |

Payments settle on **Base mainnet** in USDC. Failed calls (upstream error, unknown market) are not charged.

## Quick start

You need Node.js 22.5+ and a wallet with a little USDC on Base. **Use a dedicated wallet with a small balance:** the key you configure lets the server spend from it.

**Claude Code**

```bash
claude mcp add onchain-signals -e CLIENT_PRIVATE_KEY=0x... -e CLIENT_ALLOW_MAINNET=1 -- npx -y onchain-signals-mcp
```

**Claude Desktop / Cursor** (`claude_desktop_config.json` or `.cursor/mcp.json`)

```json
{
  "mcpServers": {
    "onchain-signals": {
      "command": "npx",
      "args": ["-y", "onchain-signals-mcp"],
      "env": {
        "CLIENT_PRIVATE_KEY": "0x...",
        "CLIENT_ALLOW_MAINNET": "1",
        "CLIENT_SESSION_BUDGET_USD": "1"
      }
    }
  }
}
```

Without `CLIENT_PRIVATE_KEY` the free tools still work and paid tools tell you their price.

## Spending limits

| Variable | Default | Meaning |
|---|---|---|
| `CLIENT_ALLOW_MAINNET` | off | must be `1` to spend real USDC on Base mainnet |
| `CLIENT_MAX_USD` | `0.05` | refuse any single call priced above this |
| `CLIENT_SESSION_BUDGET_USD` | `1` | stop paying once this much was spent in one session |
| `API_URL` | hosted API | point at your own deployment |

Every paid call is probed first: the bridge reads the price from the HTTP 402 response, checks it against these limits, and only then signs the payment.

## Without the bridge

Agents that already speak x402 can skip this package:

- **HTTP API:** `GET /v1/markets/movers`, `GET /v1/whales`, `GET /v1/market/{slug}` answer `402 Payment Required` with the price; pay and retry with any x402 client (for example `@x402/fetch`). The catalog is at `/.well-known/x402`.
- **Remote MCP:** Streamable HTTP at `/mcp`, with x402 payment inside each tool call (for example `createx402MCPClient` from `@x402/mcp`).

Hosted API: https://13-49-215-169.sslip.io (terms at `/terms`).

## License

MIT
