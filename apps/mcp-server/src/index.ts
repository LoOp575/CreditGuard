import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({
  name: "credit-guard",
  version: "0.1.0",
});

server.tool(
  "guard.health",
  "Check whether the Credit Guard MCP server is running.",
  {},
  async () => ({
    content: [
      {
        type: "text",
        text: JSON.stringify({
          service: "credit-guard-mcp",
          status: "ok",
          version: "0.1.0",
          mode: "foundation",
          enforcement: "advisory-only",
        }),
      },
    ],
  }),
);

server.tool(
  "guard.credit.estimate",
  "Estimate request cost before execution. This foundation tool returns a transparent estimate only; it does not reserve funds or guarantee provider billing.",
  {
    provider: z.enum(["openai", "anthropic", "google", "other"]),
    model: z.string().min(1),
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    inputUsdPerMillion: z.number().nonnegative(),
    outputUsdPerMillion: z.number().nonnegative(),
  },
  async ({ provider, model, inputTokens, outputTokens, inputUsdPerMillion, outputUsdPerMillion }) => {
    const inputCostUsd = (inputTokens / 1_000_000) * inputUsdPerMillion;
    const outputCostUsd = (outputTokens / 1_000_000) * outputUsdPerMillion;
    const estimatedCostUsd = inputCostUsd + outputCostUsd;

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            provider,
            model,
            inputTokens,
            outputTokens,
            inputCostUsd: Number(inputCostUsd.toFixed(8)),
            outputCostUsd: Number(outputCostUsd.toFixed(8)),
            estimatedCostUsd: Number(estimatedCostUsd.toFixed(8)),
            estimateOnly: true,
            pricingSource: "caller-supplied",
            warning: "This is an estimate based on caller-supplied rates, not a provider quote or a budget reservation.",
          }),
        },
      ],
    };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
