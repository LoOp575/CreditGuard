import test from "node:test";
import assert from "node:assert/strict";
import { evaluateExecution } from "./orchestrator.js";

const base = {
  rawPrompt: "Build a responsive website for a small shop",
  projectMode: "new" as const,
  credit: {
    projectId: "p1", budgetMicros: 10_000_000, spentMicros: 0,
    activeReservedMicros: 0, availableMicros: 10_000_000,
    overBudget: false, overspendMicros: 0,
  },
  projectState: "EXECUTING" as const,
  progressPercent: 25,
  progressTracked: true,
  estimatedCostMicros: 100_000,
  loop: {
    action: "CONTINUE" as const, score: 0, repeatedErrors: 0,
    retries: 0, requestsWithoutProgress: 0, reason: "NO_LOOP_RISK",
  },
  approvedRequirementIds: ["website", "responsive"],
  taskRequirementIds: ["website", "responsive"],
  qualityChecks: [{ id: "build", description: "Build passes", required: true, passed: true, evidenceRef: "ci://run/1" }],
};

test("orchestrator combines prompt, scope, quality and budget into a ready decision", () => {
  const result = evaluateExecution(base);
  assert.equal(result.executionStatus, "READY");
  assert.equal(result.nextAction, "EXECUTE_WITH_GUARDRAILS");
  assert.equal(result.gates.scopeApprovalRequired, false);
  assert.equal(result.gates.budgetAllowsEstimate, true);
});

test("semantic ambiguity requires clarification before execution", () => {
  const result = evaluateExecution({ ...base, rawPrompt: "Tolong kerjakan yang bagus" });
  assert.equal(result.executionStatus, "REVIEW_REQUIRED");
  assert.equal(result.nextAction, "ASK_FOR_CLARIFICATION");
});

test("out-of-scope requirement requires approval", () => {
  const result = evaluateExecution({ ...base, taskRequirementIds: ["website", "payments"] });
  assert.equal(result.nextAction, "REQUEST_SCOPE_APPROVAL");
});

test("loop pause takes priority over ordinary execution", () => {
  const result = evaluateExecution({ ...base, loop: { ...base.loop, action: "PAUSE", reason: "REPEATED_FAILURES" } });
  assert.equal(result.executionStatus, "PAUSED");
  assert.equal(result.nextAction, "PAUSE_AND_CHECKPOINT");
});

test("missing required evidence blocks completion readiness", () => {
  const result = evaluateExecution({
    ...base, projectState: "VERIFYING",
    qualityChecks: [{ id: "tests", description: "Tests pass", required: true, passed: true }],
  });
  assert.equal(result.executionStatus, "VERIFICATION_REQUIRED");
  assert.equal(result.nextAction, "VERIFY_BEFORE_COMPLETION");
});

test("budget block cannot be overridden by prompt or quality gates", () => {
  const result = evaluateExecution({
    ...base,
    credit: { ...base.credit, availableMicros: 0 },
    estimatedCostMicros: 500_000,
  });
  assert.equal(result.executionStatus, "REVIEW_REQUIRED");
  assert.equal(result.nextAction, "OPTIMIZE_COST");
});
