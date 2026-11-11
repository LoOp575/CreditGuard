import test from "node:test";
import assert from "node:assert/strict";
import { analyzeFailure, assessQuality, assessTaskScope, preparePrompt } from "./index.js";

test("preparePrompt preserves original request and marks inferred payment requirements as suggestions", () => {
  const result = preparePrompt({ rawPrompt: "Buatkan sistem pembayaran online lengkap", projectMode: "new" });
  assert.equal(result.originalPrompt, "Buatkan sistem pembayaran online lengkap");
  assert.equal(result.category, "software_project");
  assert.ok(result.suggestedRequirements.every(item => item.startsWith("Suggested only:")));
  assert.ok(result.refinedPrompt.includes("ORIGINAL USER REQUEST"));
  assert.ok(result.unknowns.some(item => item.key === "payment_provider"));
});

test("preparePrompt rejects empty prompts", () => {
  assert.throws(() => preparePrompt({ rawPrompt: "  " }), /must not be empty/);
});

test("failure analysis recommends a new strategy after a repeated error/strategy pair", () => {
  const result = analyzeFailure({
    errorSignature: "WEBHOOK_SIGNATURE_INVALID",
    strategySignature: "parse-json-before-signature",
    previousAttempts: [{ errorSignature: "webhook_signature_invalid", strategySignature: "parse-json-before-signature" }],
  });
  assert.equal(result.action, "REPLAN");
  assert.equal(result.repeatedStrategy, true);
});

test("failure analysis pauses after configured same-strategy failures", () => {
  const result = analyzeFailure({
    errorSignature: "TEST_FAILED",
    strategySignature: "same-fix",
    previousAttempts: [
      { errorSignature: "test_failed", strategySignature: "same-fix" },
      { errorSignature: "test_failed", strategySignature: "same-fix" },
    ],
  });
  assert.equal(result.action, "PAUSE");
});

test("successful previous attempts do not count as repeated failures", () => {
  const result = analyzeFailure({
    errorSignature: "TEST_FAILED",
    strategySignature: "same-fix",
    previousAttempts: [{ errorSignature: "test_failed", strategySignature: "same-fix", outcome: "succeeded" }],
  });
  assert.equal(result.action, "DIAGNOSE");
});

test("task scope review identifies requirements not in approved scope", () => {
  const result = assessTaskScope({ approvedRequirementIds: ["auth", "checkout"], taskRequirementIds: ["checkout", "membership"] });
  assert.equal(result.action, "REVIEW");
  assert.deepEqual(result.outOfScopeRequirementIds, ["membership"]);
});

test("quality assessment requires evidence for required checks", () => {
  const result = assessQuality([{ id: "webhook-test", description: "Webhook signature test", required: true, passed: true }]);
  assert.equal(result.status, "INCOMPLETE");
  assert.deepEqual(result.missingEvidence, ["webhook-test"]);
});

test("quality assessment passes when all checks pass with evidence", () => {
  const result = assessQuality([
    { id: "api-test", description: "API tests", required: true, passed: true, evidenceRef: "ci://run/123" },
    { id: "docs", description: "Documentation", required: false, passed: true, evidenceRef: "file://README.md" },
  ]);
  assert.equal(result.status, "PASS");
  assert.equal(result.score, 100);
});
