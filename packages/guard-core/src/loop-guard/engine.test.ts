import test from "node:test";
import assert from "node:assert/strict";
import { LoopGuard } from "./engine.js";

test("repeated identical errors trigger pause", () => {
  const guard = new LoopGuard({ windowMs: 60000, maxRepeatedErrors: 3, maxRetries: 5, maxRequestsWithoutProgress: 8 });
  guard.record({ projectId: "p", kind: "error", signature: "HTTP_429", at: 1000 });
  guard.record({ projectId: "p", kind: "error", signature: "HTTP_429", at: 1100 });
  const result = guard.record({ projectId: "p", kind: "error", signature: "HTTP_429", at: 1200 });
  assert.equal(result.action, "PAUSE");
  assert.equal(result.reason, "REPEATED_ERROR");
});
test("progress resets consecutive request count", () => {
  const guard = new LoopGuard({ windowMs: 60000, maxRepeatedErrors: 3, maxRetries: 5, maxRequestsWithoutProgress: 2 });
  guard.record({ projectId: "p", kind: "request", at: 1000 });
  guard.record({ projectId: "p", kind: "progress", at: 1100 });
  assert.equal(guard.record({ projectId: "p", kind: "request", at: 1200 }).requestsWithoutProgress, 1);
});
