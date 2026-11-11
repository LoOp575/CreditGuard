import test from "node:test";
import assert from "node:assert/strict";
import { ProjectEngine } from "./engine.js";

test("project transitions and verified evidence govern completion", () => {
  const engine = new ProjectEngine();
  engine.create({ id: "p1", goal: "Ship a working feature", milestones: [{ id: "m1", title: "Tests pass" }] });
  engine.transition("p1", "PLANNING");
  engine.transition("p1", "EXECUTING");
  engine.transition("p1", "VERIFYING");
  assert.throws(() => engine.transition("p1", "COMPLETED"), /REQUIRED_MILESTONES_INCOMPLETE/);
  engine.recordEvidence({ projectId: "p1", milestoneId: "m1", evidence: { kind: "test", reference: "ci://run/1", verified: true } });
  assert.equal(engine.progress("p1").percent, 100);
  assert.equal(engine.transition("p1", "COMPLETED").state, "COMPLETED");
});
test("unverified evidence does not complete milestone", () => {
  const engine = new ProjectEngine();
  engine.create({ id: "p2", goal: "Goal", milestones: [{ id: "m", title: "Artifact" }] });
  engine.recordEvidence({ projectId: "p2", milestoneId: "m", evidence: { kind: "artifact", reference: "artifact://x", verified: false } });
  assert.equal(engine.progress("p2").percent, 0);
});
