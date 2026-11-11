import dotenv from "dotenv";
import { fileURLToPath } from "node:url";
dotenv.config({ path: fileURLToPath(new URL("../../../.env", import.meta.url)) });
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CreditEngine, CreditEngineError, PostgresCreditLedger, ProjectEngine, LoopGuard, DecisionEngine, ContextOptimizer, PostgresProjectStore, PostgresLoopStore, PostgresCheckpointStore, InMemoryCheckpointStore, preparePrompt, analyzeFailure, assessTaskScope, assessQuality, evaluateExecution } from "@credit-guard/guard-core";
import { Pool } from "pg";
import { z } from "zod";
import { verifySecretToken } from "./security.js";
import { registerApprovalTools } from "./approval-tools.js";

let projectEngine: ProjectEngine | PostgresProjectStore;
let loopGuard: LoopGuard | PostgresLoopStore;
let checkpointStore: InMemoryCheckpointStore | PostgresCheckpointStore;
const decisionEngine = new DecisionEngine({
  lowRemainingBudgetPercent: Number(process.env.GUARD_LOW_REMAINING_BUDGET_PERCENT ?? "10"),
  lowProgressPercent: Number(process.env.GUARD_LOW_PROGRESS_PERCENT ?? "10"),
});
const contextOptimizer = new ContextOptimizer();

const server = new McpServer({
  name: "credit-guard",
  version: "0.1.0",
});

const databaseUrl = process.env.DATABASE_URL;
const evidenceVerifierToken = process.env.EVIDENCE_VERIFIER_TOKEN;
let creditEngine: CreditEngine | PostgresCreditLedger;
let databasePool: Pool | undefined;
let ledgerMode: string;
let stateMode: string;

if (databaseUrl) {
  const pool = new Pool({ connectionString: databaseUrl, max: 10 });
  databasePool = pool;
  const schemaCheck = await pool.query(`SELECT
    to_regclass('public.cg_projects') AS credit_projects,
    to_regclass('public.cg_reservations') AS credit_reservations,
    to_regclass('public.cg_guard_projects') AS guard_projects,
    to_regclass('public.cg_loop_events') AS loop_events,
    to_regclass('public.cg_checkpoints') AS checkpoints,
    to_regclass('public.cg_gateway_requests') AS gateway_requests,
    to_regclass('public.cg_approval_requests') AS approval_requests`);
  const s = schemaCheck.rows[0];
  if (!s?.credit_projects || !s?.credit_reservations || !s?.guard_projects || !s?.loop_events || !s?.checkpoints || !s?.gateway_requests || !s?.approval_requests) {
    await pool.end();
    throw new Error("Credit Guard PostgreSQL schema is incomplete. Apply migrations 001_credit_ledger.sql, 002_project_loop_checkpoint.sql, 003_gateway_audit.sql, and 004_approval_gate.sql.");
  }
  creditEngine = new PostgresCreditLedger(pool);
  projectEngine = new PostgresProjectStore(pool);
  loopGuard = new PostgresLoopStore(pool);
  checkpointStore = new PostgresCheckpointStore(pool);
  ledgerMode = "postgresql (durable, transactional)";
  stateMode = "postgresql (durable)";
} else {
  creditEngine = new CreditEngine();
  projectEngine = new ProjectEngine();
  loopGuard = new LoopGuard();
  checkpointStore = new InMemoryCheckpointStore();
  ledgerMode = "in-memory (non-durable, single-process; development only)";
  stateMode = "in-memory (non-durable, single-process; development only)";
}

registerApprovalTools(server, databasePool);

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
        mode: "mcp-advisory",
        gateway: "separate-http-service",
        enforcement: "advisory-only",
        ledger: ledgerMode,
        projectState: stateMode,
      }),
    }],
  }),
);

server.tool(
  "guard.project.create",
  "Create a tracked project with explicit milestones.",
  { id: z.string().min(1), goal: z.string().min(1), milestones: z.array(z.object({ id: z.string().min(1), title: z.string().min(1), required: z.boolean().optional() })).optional() },
  async (args) => { try { return { content: [{ type: "text", text: JSON.stringify(await projectEngine.create(args)) }] }; } catch (error) { return toolError(error); } },
);

server.tool(
  "guard.project.get",
  "Get project lifecycle, milestones, and evidence.",
  { projectId: z.string().min(1) },
  async ({ projectId }) => { try { return { content: [{ type: "text", text: JSON.stringify({ project: await projectEngine.get(projectId), progress: await projectEngine.progress(projectId) }) }] }; } catch (error) { return toolError(error); } },
);

server.tool(
  "guard.project.transition",
  "Move a project through a validated lifecycle transition.",
  { projectId: z.string().min(1), state: z.enum(["PLANNING", "EXECUTING", "VERIFYING", "COMPLETED", "PAUSED", "BLOCKED", "FAILED"]) },
  async ({ projectId, state }) => { try { return { content: [{ type: "text", text: JSON.stringify(await projectEngine.transition(projectId, state)) }] }; } catch (error) { return toolError(error); } },
);

server.tool(
  "guard.project.record_evidence",
  "Attach evidence as unverified. A separate trusted verification step is required before it can complete a milestone.",
  { projectId: z.string().min(1), milestoneId: z.string().min(1), kind: z.enum(["artifact", "test", "file_change", "milestone"]), reference: z.string().min(1) },
  async ({ projectId, milestoneId, kind, reference }) => { try {
    const result = projectEngine instanceof PostgresProjectStore
      ? await projectEngine.recordEvidence({ projectId, milestoneId, kind, reference })
      : projectEngine.recordEvidence({ projectId, milestoneId, evidence: { kind, reference, verified: false } });
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  } catch (error) { return toolError(error); } },
);

server.tool(
  "guard.project.verify_evidence",
  "Mark evidence verified using a separate verifier secret held by a trusted operator or verifier integration. This tool does not independently inspect artifacts.",
  { projectId: z.string().min(1), milestoneId: z.string().min(1), reference: z.string().min(1), verificationSource: z.string().min(1), verifierToken: z.string().min(24) },
  async ({ projectId, milestoneId, reference, verificationSource, verifierToken }) => { try {
    if (!evidenceVerifierToken) throw new Error("EVIDENCE_VERIFIER_NOT_CONFIGURED");
    if (!verifySecretToken(verifierToken, evidenceVerifierToken)) throw new Error("INVALID_EVIDENCE_VERIFIER_TOKEN");
    const result = projectEngine instanceof PostgresProjectStore
      ? await projectEngine.verifyEvidence({ projectId, milestoneId, reference, verificationSource })
      : projectEngine.verifyEvidence({ projectId, milestoneId, reference, verificationSource });
    await loopGuard.record({ projectId, kind: "progress" });
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  } catch (error) { return toolError(error); } },
);

server.tool(
  "guard.checkpoint.save",
  "Save resumable project state. Do not include API keys, secrets, or raw private prompts.",
  { projectId: z.string().min(1), goal: z.string().min(1), nextStep: z.string().min(1), artifactRefs: z.array(z.string()), errors: z.array(z.string()), modelConfig: z.record(z.unknown()) },
  async ({ projectId, ...payload }) => { try {
    const result = await checkpointStore.save(projectId, payload);
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  } catch (error) { return toolError(error); } },
);

server.tool(
  "guard.checkpoint.latest",
  "Retrieve the latest checkpoint for a project to resume work.",
  { projectId: z.string().min(1) },
  async ({ projectId }) => { try {
    const result = await checkpointStore.latest(projectId);
    return { content: [{ type: "text", text: JSON.stringify(result ?? { found: false }) }] };
  } catch (error) { return toolError(error); } },
);

server.tool(
  "guard.loop.record",
  "Record a request, retry, or error event and assess loop risk. Verified milestone evidence records progress automatically.",
  { projectId: z.string().min(1), kind: z.enum(["request", "error", "retry"]), signature: z.string().optional() },
  async (args) => { try { return { content: [{ type: "text", text: JSON.stringify(await loopGuard.record(args)) }] }; } catch (error) { return toolError(error); } },
);

server.tool(
  "guard.loop.assess",
  "Assess recent retry, repeated-error, and no-progress patterns for a project.",
  { projectId: z.string().min(1) },
  async ({ projectId }) => ({ content: [{ type: "text", text: JSON.stringify(await loopGuard.assess(projectId)) }] }),
);

server.tool(
  "guard.decision.evaluate",
  "Combine current credit, project state, progress, estimated cost, and loop risk into an explainable action.",
  { projectId: z.string().min(1), estimatedCostMicros: z.number().int().nonnegative(), checkpointAvailable: z.boolean().optional() },
  async ({ projectId, estimatedCostMicros, checkpointAvailable }) => {
    try {
      const [credit, project] = await Promise.all([creditEngine.getStatus(projectId), projectEngine.get(projectId)]);
      const progress = await projectEngine.progress(projectId);
      const loop = await loopGuard.assess(projectId);
      return { content: [{ type: "text", text: JSON.stringify(decisionEngine.decide({ credit, projectState: project.state, progressPercent: progress.percent, progressTracked: progress.total > 0, estimatedCostMicros, loop, checkpointAvailable })) }] };
    } catch (error) { return toolError(error); }
  },
);

server.tool(
  "guard.orchestrator.evaluate",
  "Combine prompt understanding, approved-scope checks, quality evidence, project progress, loop risk, and budget policy into one explainable execution recommendation. Advisory only; it does not intercept Agent tools or provider traffic.",
  {
    projectId: z.string().min(1),
    rawPrompt: z.string().min(1).max(20000),
    projectMode: z.enum(["new", "existing", "unknown"]).optional(),
    techStack: z.array(z.string().min(1)).optional(),
    constraints: z.array(z.string().min(1)).optional(),
    estimatedCostMicros: z.number().int().nonnegative(),
    approvedRequirementIds: z.array(z.string()),
    taskRequirementIds: z.array(z.string()),
    qualityChecks: z.array(z.object({
      id: z.string().min(1),
      description: z.string(),
      required: z.boolean(),
      passed: z.boolean().nullable(),
      evidenceRef: z.string().optional(),
    })),
    checkpointAvailable: z.boolean().optional(),
  },
  async (args) => {
    try {
      const [credit, project] = await Promise.all([
        creditEngine.getStatus(args.projectId),
        projectEngine.get(args.projectId),
      ]);
      const [progress, loop] = await Promise.all([
        projectEngine.progress(args.projectId),
        loopGuard.assess(args.projectId),
      ]);
      const result = evaluateExecution({
        rawPrompt: args.rawPrompt,
        projectMode: args.projectMode,
        techStack: args.techStack,
        constraints: args.constraints,
        credit,
        projectState: project.state,
        progressPercent: progress.percent,
        progressTracked: progress.total > 0,
        estimatedCostMicros: args.estimatedCostMicros,
        loop,
        checkpointAvailable: args.checkpointAvailable,
        approvedRequirementIds: args.approvedRequirementIds,
        taskRequirementIds: args.taskRequirementIds,
        qualityChecks: args.qualityChecks,
      });
      return { content: [{ type: "text", text: JSON.stringify({ projectId: args.projectId, ...result }) }] };
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
  "guard.credit.list_reservations",
  "List a project's reservations so uncertain or abandoned requests can be reconciled safely.",
  { projectId: z.string().min(1), status: z.enum(["RESERVED", "SETTLED", "RELEASED"]).optional() },
  async ({ projectId, status }) => {
    try { return { content: [{ type: "text", text: JSON.stringify(await creditEngine.listReservations(projectId, status)) }] }; }
    catch (error) { return toolError(error); }
  },
);

server.tool(
  "guard.gateway.recover_request",
  "Recover an interrupted Gateway audit record by linking its durable reservation. If no reservation exists and status is STARTED, mark it as not dispatched.",
  { requestId: z.string().uuid() },
  async ({ requestId }) => {
    if (!databasePool) return toolError(new Error("Gateway recovery requires DATABASE_URL and PostgreSQL mode"));
    try {
      const found = await databasePool.query(`SELECT g.request_id,g.project_id,g.client_idempotency_key,g.status,
        COALESCE(g.reservation_id,r.id) AS reservation_id,r.status AS reservation_status
        FROM cg_gateway_requests g LEFT JOIN cg_reservations r
          ON r.id=g.reservation_id OR (g.reservation_id IS NULL AND r.project_id=g.project_id AND r.idempotency_key='gateway:'||g.client_idempotency_key)
        WHERE g.request_id=$1`, [requestId]);
      if (!found.rowCount) throw new Error("GATEWAY_REQUEST_NOT_FOUND");
      const row = found.rows[0];
      if (row.reservation_id) {
        if (!row.reservation_status) throw new Error("RESERVATION_STATE_UNAVAILABLE");
        if (!row.reservation_id || row.status === "STARTED") {
          await databasePool.query("UPDATE cg_gateway_requests SET reservation_id=$2,updated_at=now() WHERE request_id=$1",[requestId,row.reservation_id]);
        }
        return { content: [{ type: "text", text: JSON.stringify({ recovered: true, ...row }) }] };
      }
      if (row.status === "STARTED") {
        await databasePool.query("UPDATE cg_gateway_requests SET status='POLICY_BLOCKED',updated_at=now() WHERE request_id=$1",[requestId]);
        return { content: [{ type: "text", text: JSON.stringify({ recovered: true, requestId, outcome: "NO_RESERVATION_NO_PROVIDER_DISPATCH" }) }] };
      }
      return { content: [{ type: "text", text: JSON.stringify({ recovered: false, ...row }) }] };
    } catch (error) { return toolError(error); }
  },
);

server.tool(
  "guard.gateway.unresolved",
  "List Gateway requests whose provider billing or ledger settlement needs reconciliation. Does not expose prompts or credentials.",
  { projectId: z.string().min(1) },
  async ({ projectId }) => {
    if (!databasePool) return toolError(new Error("Gateway audit requires DATABASE_URL and PostgreSQL mode"));
    try {
      const result = await databasePool.query(`SELECT g.request_id,COALESCE(g.reservation_id,r.id) AS reservation_id,
        g.client_idempotency_key,g.provider,g.model,g.status,g.estimated_cost_micros,g.actual_cost_micros,
        g.input_tokens,g.output_tokens,g.created_at,g.updated_at,r.status AS reservation_status
        FROM cg_gateway_requests g LEFT JOIN cg_reservations r
          ON r.id=g.reservation_id OR (g.reservation_id IS NULL AND r.project_id=g.project_id AND r.idempotency_key='gateway:'||g.client_idempotency_key)
        WHERE g.project_id=$1 AND g.status IN
        ('STARTED','SUCCESS_USAGE_UNKNOWN','PROVIDER_ERROR_USAGE_UNKNOWN','UNKNOWN','RECONCILIATION_ERROR')
        AND (r.status='RESERVED' OR r.id IS NULL) ORDER BY g.created_at DESC`, [projectId]);
      return { content: [{ type: "text", text: JSON.stringify(result.rows) }] };
    } catch (error) { return toolError(error); }
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


server.tool(
  "guard.prompt.prepare",
  "Detect the input language conservatively, extract a universal software-task intent, and return a concise optimizedPrompt plus semantic interpretations. The Agent should use optimizedPrompt only when requiresSemanticReview is false; otherwise retain the original request and resolve ambiguity. Language detection is heuristic, not full translation or semantic understanding. Suggestions are not approved scope.",
  {
    rawPrompt: z.string().min(1).max(20000),
    projectMode: z.enum(["new", "existing", "unknown"]).optional(),
    techStack: z.array(z.string().min(1)).optional(),
    constraints: z.array(z.string().min(1)).optional(),
  },
  async (args) => {
    try {
      return { content: [{ type: "text", text: JSON.stringify(preparePrompt(args)) }] };
    } catch (error) { return toolError(error); }
  },
);

server.tool(
  "guard.failure.analyze",
  "Analyze whether a failure repeats a previously failed strategy. Supply prior attempts from the project checkpoint or execution history.",
  {
    projectId: z.string().min(1),
    errorSignature: z.string().min(1),
    strategySignature: z.string().min(1),
    maxSameStrategyFailures: z.number().int().positive().optional(),
    previousAttempts: z.array(z.object({
      errorSignature: z.string().min(1),
      strategySignature: z.string().min(1),
      outcome: z.enum(["failed", "succeeded"]).optional(),
    })),
  },
  async (args) => {
    try {
      const analysis = analyzeFailure(args);
      const loop = await loopGuard.record({ projectId: args.projectId, kind: "error", signature: `${args.errorSignature.trim().toLowerCase()}::${args.strategySignature.trim().toLowerCase()}` });
      return { content: [{ type: "text", text: JSON.stringify({ ...analysis, action: loop.action === "PAUSE" ? "PAUSE" : analysis.action, persistentLoopAssessment: loop }) }] };
    } catch (error) { return toolError(error); }
  },
);

server.tool(
  "guard.intent.check_scope",
  "Compare task requirement IDs with the approved project requirement baseline. Unmapped semantic intent must be reviewed by the Agent; this deterministic check does not claim natural-language understanding.",
  {
    approvedRequirementIds: z.array(z.string()),
    taskRequirementIds: z.array(z.string()),
  },
  async (args) => {
    try {
      return { content: [{ type: "text", text: JSON.stringify(assessTaskScope(args)) }] };
    } catch (error) { return toolError(error); }
  },
);

server.tool(
  "guard.quality.evaluate",
  "Evaluate explicit verification checks. Required checks need passing results and evidence references before quality can pass.",
  {
    checks: z.array(z.object({
      id: z.string().min(1),
      description: z.string(),
      required: z.boolean(),
      passed: z.boolean().nullable(),
      evidenceRef: z.string().optional(),
    })),
  },
  async ({ checks }) => {
    try {
      return { content: [{ type: "text", text: JSON.stringify(assessQuality(checks)) }] };
    } catch (error) { return toolError(error); }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
