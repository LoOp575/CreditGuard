import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CreditEngine, CreditEngineError } from "@credit-guard/guard-core";
import { z } from "zod";

const server = new McpServer({
  name: "credit-guard",
  version: "0.1.0",
});

const creditEngine = new CreditEngine();

function toolError(error: unknown) {
  const code = error instanceof CreditEngineError ? error.code : "INTERNAL_ERROR";
  const message = error instanceof Error ? error.message : "Unknown error";
  return {
    isError: true,
    content: [{ type: "text" as const, text: JSON.stringify({ error: code, message }) }],
  };
}

server.tool(
  "guard.health",
  "Check whether the Credit Guard MCP server is running.",
  {},
  async () => ({
    content: [{
      type: "text",
      text: JSON.stringify({
        service: "credit-guard-mcp",
        status: "ok",
        version: "0.1.0",
        mode: "foundation",
        enforcement: "advisory-only",
        ledger: "in-memory (non-durable, single-process)",
      }),
    }],
  }),
);

server.tool(
  "guard.credit.estimate",
  "Estimate request cost from caller-supplied rates. This does not reserve budget or guarantee provider billing.",
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
      content: [{
        type: "text",
        text: JSON.stringify({
          provider, model, inputTokens, outputTokens,
          inputCostUsd: Number(inputCostUsd.toFixed(8)),
          outputCostUsd: Number(outputCostUsd.toFixed(8)),
          estimatedCostUsd: Number(estimatedCostUsd.toFixed(8)),
          estimateOnly: true,
          pricingSource: "caller-supplied",
          warning: "Estimate only. No provider quote or budget reservation was performed.",
        }),
      }],
    };
  },
);

server.tool(
  "guard.project.create",
  "Create a project budget. Amounts are integer USD micros (1 USD = 1,000,000 micros).",
  {
    projectId: z.string().min(1),
    budgetMicros: z.number().int().positive(),
  },
  async (args) => {
    try {
      return { content: [{ type: "text", text: JSON.stringify(await creditEngine.createProjectBudget(args)) }] };
    } catch (error) {
      return toolError(error);
    }
  },
);

server.tool(
  "guard.credit.get_status",
  "Get budget, actual spend, active reservations, and available balance for a project.",
  { projectId: z.string().min(1) },
  async ({ projectId }) => {
    try {
      return { content: [{ type: "text", text: JSON.stringify(await creditEngine.getStatus(projectId)) }] };
    } catch (error) {
      return toolError(error);
    }
  },
);

server.tool(
  "guard.credit.preflight",
  "Check whether an estimated cost fits the currently available project budget. This is advisory; reserve before dispatch to prevent concurrent overspend.",
  {
    projectId: z.string().min(1),
    estimatedCostMicros: z.number().int().nonnegative(),
  },
  async ({ projectId, estimatedCostMicros }) => {
    try {
      return { content: [{ type: "text", text: JSON.stringify(await creditEngine.preflight(projectId, estimatedCostMicros)) }] };
    } catch (error) {
      return toolError(error);
    }
  },
);

server.tool(
  "guard.credit.reserve",
  "Atomically reserve estimated cost before dispatch. Use a unique idempotency key for each logical provider request.",
  {
    projectId: z.string().min(1),
    estimatedCostMicros: z.number().int().positive(),
    idempotencyKey: z.string().min(1),
  },
  async (args) => {
    try {
      return { content: [{ type: "text", text: JSON.stringify(await creditEngine.reserve(args)) }] };
    } catch (error) {
      return toolError(error);
    }
  },
);

server.tool(
  "guard.credit.settle",
  "Reconcile a reservation with actual provider cost in USD micros after the request completes.",
  {
    reservationId: z.string().min(1),
    actualCostMicros: z.number().int().nonnegative(),
  },
  async ({ reservationId, actualCostMicros }) => {
    try {
      return { content: [{ type: "text", text: JSON.stringify(await creditEngine.settle(reservationId, actualCostMicros)) }] };
    } catch (error) {
      return toolError(error);
    }
  },
);

server.tool(
  "guard.credit.release",
  "Release an unused reservation when a request is confirmed not to have been dispatched or charged.",
  { reservationId: z.string().min(1) },
  async ({ reservationId }) => {
    try {
      return { content: [{ type: "text", text: JSON.stringify(await creditEngine.release(reservationId)) }] };
    } catch (error) {
      return toolError(error);
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
