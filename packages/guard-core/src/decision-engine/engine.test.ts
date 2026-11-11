import test from "node:test";
import assert from "node:assert/strict";
import { DecisionEngine } from "./engine.js";
import type { DecisionInput } from "./types.js";
const base: DecisionInput = {
  credit: { projectId: "p", budgetMicros: 10_000_000, spentMicros: 1_000_000, activeReservedMicros: 0, availableMicros: 9_000_000, overBudget: false, overspendMicros: 0 },
  projectState: "EXECUTING", progressPercent: 40, estimatedCostMicros: 1_000_000,
  loop: { action: "CONTINUE", score: 0, repeatedErrors: 0, retries: 0, requestsWithoutProgress: 0, reason: "HEALTHY" },
};
test("allows healthy affordable work", () => assert.equal(new DecisionEngine().decide(base).action, "ALLOW"));
test("recommends optimization when estimate exceeds available credit", () => assert.equal(new DecisionEngine().decide({ ...base, estimatedCostMicros: 10_000_000 }).action, "OPTIMIZE"));
test("blocks an already over-budget project", () => assert.equal(new DecisionEngine().decide({ ...base, credit: { ...base.credit, overBudget: true } }).action, "BLOCK"));
test("checkpoints when loop guard pauses", () => assert.equal(new DecisionEngine().decide({ ...base, loop: { ...base.loop, action: "PAUSE", reason: "NO_PROGRESS" } }).action, "CHECKPOINT_PAUSE"));

test("loop warning requires intervention even when cheaper model could fit", () => {
  const result = new DecisionEngine().decide({ ...base, estimatedCostMicros: 10_000_000,
    loop: { ...base.loop, action: "WARN", reason: "LOOP_RISK" } });
  assert.equal(result.action, "INTERVENE");
});

test("policy thresholds can be adjusted without changing decision code", () => {
  const input = { ...base, credit: { ...base.credit, availableMicros: 1_500_000 }, estimatedCostMicros: 1_000_000 };
  assert.equal(new DecisionEngine().decide(input).action, "OPTIMIZE");
  assert.equal(new DecisionEngine({ lowRemainingBudgetPercent: 3 }).decide(input).action, "ALLOW");
});
test("invalid policy percentages are rejected", () => {
  assert.throws(() => new DecisionEngine({ lowProgressPercent: 101 }), /between 0 and 100/);
});
