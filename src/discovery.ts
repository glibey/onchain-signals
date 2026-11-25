// Machine-readable descriptions of the service, so agents and crawlers that only know our URL can find out
// what we sell, what it costs and how to connect: /llms.txt (plain text for LLMs) and an MCP server card.
import { z } from "zod";
import { TOOLS, VERSION } from "./tools.js";

const REPO = "https://github.com/glibey/onchain-signals";
const ICON = "https://raw.githubusercontent.com/glibey/onchain-signals/main/assets/icon.svg";
const httpPath = (route: string) => route.split(" ")[1].replace(/:(\w+)/g, "{$1}");

export function llmsTxt(base: string) {
  const tools = Object.entries(TOOLS)
    .map(([name, t]) => {
      const args = Object.entries(t.input)
        .map(([k, s]) => `    - ${k}: ${(s as z.ZodTypeAny).description ?? ""}`)
        .join("\n");
      return `- ${name} (${t.price}, HTTP GET ${base}${httpPath(t.route)}): ${t.description}\n${args}`;
    })
    .join("\n");
  return `# Onchain Signals

> Pay-per-call Polymarket intelligence for AI agents: trader track records and win rates, smart money flow, whale trades, market movers and single-market analysis. No sign-up and no API keys: each call is paid in USDC on Base via x402 (HTTP 402).

Data comes from Polymarket's public APIs. Not affiliated with Polymarket. Not financial advice. Failed calls are not charged.

## Connect

- Remote MCP (Streamable HTTP, x402 payment inside each tool call): ${base}/mcp
- Local MCP bridge with spend limits: \`npx -y onchain-signals-mcp\` (env CLIENT_PRIVATE_KEY, CLIENT_ALLOW_MAINNET=1)
- HTTP: call any endpoint below; it answers 402 with the price in the PAYMENT-REQUIRED header; pay with any x402 client (e.g. @x402/fetch) and retry.
- Catalog (JSON): ${base}/.well-known/x402
- MCP server card: ${base}/.well-known/mcp.json
- MCP Registry name: io.github.glibey/onchain-signals
- Source and docs: ${REPO}
- Terms: ${base}/terms

## Tools

${tools}
- list_services (free): catalog and current prices.

## When to use

- "Who are the best Polymarket traders in politics this month, and do they actually win?" → get_top_traders
- "Is this wallet any good?" → get_trader_profile
- "Where are proven traders putting money right now / in this market?" → get_smart_money
- "What moved today?" → get_market_movers; "big trades?" → get_whale_trades; "tell me about this market" → analyze_market
`;
}

export function serverCard(base: string) {
  return {
    $schema: "https://static.modelcontextprotocol.io/schemas/mcp-server-card/v1.json",
    version: "1.0",
    protocolVersion: "2025-06-18",
    serverInfo: { name: "io.github.glibey/onchain-signals", title: "Onchain Signals", version: VERSION },
    description: "Pay-per-call Polymarket intelligence for AI agents: trader win rates, smart money flow, whale trades, market movers. Paid per call in USDC via x402.",
    iconUrl: ICON,
    documentationUrl: REPO,
    transport: { type: "streamable-http", endpoint: `${base}/mcp` },
    authentication: { required: false, schemes: [] },
    payment: { protocol: "x402", asset: "USDC", network: "Base", perToolCall: true },
    capabilities: { tools: { listChanged: false } },
    tools: [
      ...Object.entries(TOOLS).map(([name, t]) => ({
        name,
        title: t.title,
        description: t.description,
        price: t.price,
        inputSchema: z.toJSONSchema(z.object(t.input)),
        annotations: { readOnlyHint: true },
      })),
      { name: "list_services", title: "List services and prices", description: "Free. Catalog and current prices.", price: "free" },
    ],
    registry: { name: "io.github.glibey/onchain-signals", npm: "onchain-signals-mcp" },
  };
}
