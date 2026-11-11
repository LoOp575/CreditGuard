import test from "node:test";
import assert from "node:assert/strict";
import { ContextOptimizer } from "./optimizer.js";
test("keeps required context and ranks optional sections", () => {
  const result = new ContextOptimizer().optimize({ maxCharacters: 8, sections: [
    { id: "goal", content: "12345", priority: 1, required: true },
    { id: "noise", content: "xxxxx", priority: 1 },
    { id: "error", content: "abc", priority: 5 },
  ] });
  assert.deepEqual(result.includedIds, ["goal", "error"]);
  assert.deepEqual(result.omittedIds, ["noise"]);
});
