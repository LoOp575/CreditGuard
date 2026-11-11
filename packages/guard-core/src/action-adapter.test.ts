import test from "node:test";
import assert from "node:assert/strict";
import { approvalClassForAction, createActionScopeFingerprint, executeWithGuard } from "./action-adapter.js";

test("protected action does not dispatch when approval is missing", async () => {
  let dispatched = false;
  const result = await executeWithGuard({ projectId: "p1", action: "FILE_DELETE", payload: { path: "src/old.ts" } },
    async () => ({ allowed: false, reason: "APPROVAL_REQUIRED" }), async () => { dispatched = true; });
  assert.equal(result.executed, false); assert.equal(result.reason, "APPROVAL_REQUIRED"); assert.equal(dispatched, false);
});

test("fingerprint is deterministic and changes with payload", () => {
  const first = createActionScopeFingerprint("FILE_DELETE", { path: "a.ts", recursive: false });
  const same = createActionScopeFingerprint("FILE_DELETE", { recursive: false, path: "a.ts" });
  const changed = createActionScopeFingerprint("FILE_DELETE", { path: "b.ts", recursive: false });
  assert.equal(first, same); assert.notEqual(first, changed);
});

test("action classes map to distinct approval categories", () => {
  assert.equal(approvalClassForAction("FILE_DELETE"), "DESTRUCTIVE_ACTION");
  assert.equal(approvalClassForAction("DEPLOY"), "PRODUCTION_CHANGE");
});

test("dispatch happens only after trusted authorizer allows", async () => {
  let dispatched = false; const payload = { command: "npm test" };
  const result = await executeWithGuard({ projectId: "p1", action: "READ_ONLY", payload }, async (request) => {
    assert.equal(request.projectId, "p1");
    assert.equal(request.scopeFingerprint, createActionScopeFingerprint("READ_ONLY", payload));
    return { allowed: true, reason: "POLICY_ALLOWED" };
  }, async (value) => { dispatched = true; return value.command; });
  assert.equal(dispatched, true); assert.equal(result.executed, true); assert.equal(result.result, "npm test");
});

test("authorization service failure prevents dispatch", async () => {
  let dispatched = false;
  await assert.rejects(() => executeWithGuard({ projectId: "p1", action: "DEPLOY", payload: { environment: "production" } },
    async () => { throw new Error("AUTHORITY_UNAVAILABLE"); }, async () => { dispatched = true; }), /AUTHORITY_UNAVAILABLE/);
  assert.equal(dispatched, false);
});

test("authorization must return the literal boolean true", async () => {
  let dispatched = false;
  const result = await executeWithGuard(
    { projectId: "p1", action: "READ_ONLY", payload: { path: "README.md" } },
    async () => ({ allowed: "true", reason: "MALFORMED" } as unknown as { allowed: boolean; reason: string }),
    async () => { dispatched = true; },
  );
  assert.equal(result.executed, false);
  assert.equal(result.reason, "POLICY_DENIED");
  assert.equal(dispatched, false);
});

test("fingerprinting rejects undefined and non-JSON payload values", () => {
  assert.throws(() => createActionScopeFingerprint("FILE_WRITE", { path: undefined }), /FINGERPRINT_UNDEFINED_VALUE/);
  assert.throws(() => createActionScopeFingerprint("FILE_WRITE", { amount: Number.NaN }), /FINGERPRINT_NON_FINITE_NUMBER/);
});
