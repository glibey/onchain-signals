// Remote MCP endpoint (Streamable HTTP, stateless) with per-tool x402 payment.
// x402-aware MCP clients (e.g. @x402/mcp createx402MCPClient) pay inside the MCP call; no local install needed.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createPaymentWrapper, type x402ResourceServer } from "@x402/mcp";
import { TOOLS, READ_ONLY, VERSION, type ToolName } from "./tools.js";

type Opts = { resourceServer: x402ResourceServer; payTo: string; network: `${string}:${string}`; catalog: () => unknown };

const text = (v: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(v, null, 2) }] });

export function remoteMcp(o: Opts) {
  // Payment wrappers need the facilitator's supported kinds, so build them once, on first use.
  let wrappers: Promise<Record<ToolName, ReturnType<typeof createPaymentWrapper>>> | null = null;
  const getWrappers = () =>
    (wrappers ??= (async () => {
      await o.resourceServer.initialize();
      const entries = await Promise.all(
        (Object.keys(TOOLS) as ToolName[]).map(async (name) => {
          const accepts = await o.resourceServer.buildPaymentRequirements({
            scheme: "exact", network: o.network, payTo: o.payTo, price: TOOLS[name].price, maxTimeoutSeconds: 60,
          });
          return [name, createPaymentWrapper(o.resourceServer, { accepts, resource: { url: `mcp://tool/${name}`, description: TOOLS[name].description, mimeType: "application/json" } })] as const;
        }),
      );
      return Object.fromEntries(entries) as Record<ToolName, ReturnType<typeof createPaymentWrapper>>;
    })().catch((e) => {
      wrappers = null; // retry init on the next request
      throw e;
    }));

  return async (req: Request): Promise<Response> => {
    const paid = await getWrappers();
    const server = new McpServer({ name: "onchain-signals", title: "Onchain Signals", version: VERSION });

    for (const name of Object.keys(TOOLS) as ToolName[]) {
      const t = TOOLS[name] as (typeof TOOLS)[ToolName];
      server.registerTool(
        name,
        { title: t.title, description: `${t.description} Paid: ${t.price} per call (x402, USDC).`, inputSchema: t.input, annotations: { title: t.title, ...READ_ONLY } },
        // A thrown error becomes isError, and the payment wrapper does not settle failed calls.
        paid[name](async (args: any) => {
          try {
            return text(await (t.run as (a: unknown) => Promise<unknown>)(args));
          } catch (e) {
            return { ...text({ error: (e as Error).message }), isError: true };
          }
        }) as any,
      );
    }
    server.registerTool(
      "list_services",
      { title: "List services and prices", description: "Free. What onchain-signals sells and current prices.", inputSchema: {}, annotations: { title: "List services and prices", ...READ_ONLY } },
      async () => text(o.catalog()),
    );

    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server.connect(transport);
    return transport.handleRequest(req);
  };
}
