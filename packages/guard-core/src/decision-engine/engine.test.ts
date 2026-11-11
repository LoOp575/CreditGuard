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
test("blocks request above available balance", () => assert.equal(new DecisionEngine().decide({ ...base, estimatedCostMicros: 10_000_000 }).action, "BLOCK"));
test("checkpoints when loop guard pauses", () => assert.equal(new DecisionEngine().decide({ ...base, loop: { ...base.loop, action: "PAUSE", reason: "NO_PROGRESS" } }).action, "CHECKPOINT_PAUSE"));
