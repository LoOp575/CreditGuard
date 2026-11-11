import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CreditEngine, CreditEngineError, PostgresCreditLedger, ProjectEngine, LoopGuard, DecisionEngine, ContextOptimizer } from "@credit-guard/guard-core";
import { Pool } from "pg";
import { z } from "zod";

const projectEngine = new ProjectEngine();
const loopGuard = new LoopGuard();
const decisionEngine = new DecisionEngine();
const contextOptimizer = new ContextOptimizer();

const server = new McpServer({
  name: "credit-guard",
  version: "0.1.0",
});

const databaseUrl = process.env.DATABASE_URL;
let creditEngine: CreditEngine | PostgresCreditLedger;
let ledgerMode: string;

if (databaseUrl) {
  const pool = new Pool({ connectionString: databaseUrl, max: 10 });
  const schemaCheck = await pool.query(
    "SELECT to_regclass('public.cg_projects') AS projects, to_regclass('public.cg_reservations') AS reservations",
  );
  if (!schemaCheck.rows[0]?.projects || !schemaCheck.rows[0]?.reservations) {
    await pool.end();
    throw new Error("Credit Guard PostgreSQL schema is missing. Apply database/migrations/001_credit_ledger.sql first.");
  }
  creditEngine = new PostgresCreditLedger(pool);
  ledgerMode = "postgresql (durable, transactional)";
} else {
  creditEngine = new CreditEngine();
  ledgerMode = "in-memory (non-durable, single-process; development only)";
}

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
        ledger: ledgerMode,
      }),
    }],
  }),
);

server.tool(
  "guard.project.create",
  "Create a tracked project with explicit milestones.",
  { id: z.string().min(1), goal: z.string().min(1), milestones: z.array(z.object({ id: z.string().min(1), title: z.string().min(1), required: z.boolean().optional() })).optional() },
  async (args) => { try { return { content: [{ type: "text", text: JSON.stringify(projectEngine.create(args)) }] }; } catch (error) { return toolError(error); } },
);

server.tool(
  "guard.project.get",
  "Get project lifecycle, milestones, and evidence.",
  { projectId: z.string().min(1) },
  async ({ projectId }) => { try { return { content: [{ type: "text", text: JSON.stringify({ project: projectEngine.get(projectId), progress: projectEngine.progress(projectId) }) }] }; } catch (error) { return toolError(error); } },
);

server.tool(
  "guard.project.transition",
  "Move a project through a validated lifecycle transition.",
  { projectId: z.string().min(1), state: z.enum(["PLANNING", "EXECUTING", "VERIFYING", "COMPLETED", "PAUSED", "BLOCKED", "FAILED"]) },
  async ({ projectId, state }) => { try { return { content: [{ type: "text", text: JSON.stringify(projectEngine.transition(projectId, state)) }] }; } catch (error) { return toolError(error); } },
);

server.tool(
  "guard.project.record_evidence",
  "Attach evidence to a milestone. Only evidence explicitly marked verified completes a milestone; verification must be performed by a trusted integration.",
  { projectId: z.string().min(1), milestoneId: z.string().min(1), kind: z.enum(["artifact", "test", "file_change", "milestone"]), reference: z.string().min(1), verified: z.boolean() },
  async ({ projectId, milestoneId, kind, reference, verified }) => { try { return { content: [{ type: "text", text: JSON.stringify(projectEngine.recordEvidence({ projectId, milestoneId, evidence: { kind, reference, verified } })) }] }; } catch (error) { return toolError(error); } },
);

server.tool(
  "guard.loop.record",
  "Record a request, retry, error, or verified progress event and assess loop risk.",
  { projectId: z.string().min(1), kind: z.enum(["request", "error", "retry", "progress"]), signature: z.string().optional() },
  async (args) => { try { return { content: [{ type: "text", text: JSON.stringify(loopGuard.record(args)) }] }; } catch (error) { return toolError(error); } },
);

server.tool(
  "guard.loop.assess",
  "Assess recent retry, repeated-error, and no-progress patterns for a project.",
  { projectId: z.string().min(1) },
  async ({ projectId }) => ({ content: [{ type: "text", text: JSON.stringify(loopGuard.assess(projectId)) }] }),
);

server.tool(
  "guard.decision.evaluate",
  "Combine current credit, project state, progress, estimated cost, and loop risk into an explainable action.",
  { projectId: z.string().min(1), estimatedCostMicros: z.number().int().nonnegative(), checkpointAvailable: z.boolean().optional() },
  async ({ projectId, estimatedCostMicros, checkpointAvailable }) => {
    try {
      const [credit, project] = await Promise.all([creditEngine.getStatus(projectId), Promise.resolve(projectEngine.get(projectId))]);
      const progress = projectEngine.progress(projectId);
      const loop = loopGuard.assess(projectId);
      return { content: [{ type: "text", text: JSON.stringify(decisionEngine.decide({ credit, projectState: project.state, progressPercent: progress.percent, estimatedCostMicros, loop, checkpointAvailable })) }] };
    } catch (error) { return toolError(error); }
  },
);

server.tool(
  "guard.context.optimize",
  "Select context sections under a character budget while preserving required sections and reporting omissions.",
  { maxCharacters: z.number().int().nonnegative(), sections: z.array(z.object({ id: z.string().min(1), content: z.string(), priority: z.number().min(1).max(5), required: z.boolean().optional() })) },
  async (args) => { try { return { content: [{ type: "text", text: JSON.stringify(contextOptimizer.optimize(args)) }] }; } catch (error) { return toolError(error); } },
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
  "guard.credit.project.create",
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
