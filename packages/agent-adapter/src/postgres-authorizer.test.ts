import test from "node:test";
import assert from "node:assert/strict";
import { createPostgresActionAuthorizer } from "./postgres-authorizer.js";

function fakePool(row?: Record<string, unknown>) {
  const calls: Array<{ sql: string; values?: unknown[] }> = [];
  return {
    calls,
    async query(sql: string, values?: unknown[]) {
      calls.push({ sql, values });
      if (sql.includes("SELECT project_id")) return { rows: row ? [row] : [] };
      return { rows: [] };
    },
  };
}

test("PostgreSQL authorizer permits unprotected action without approval lookup", async () => {
  const pool = fakePool();
  const authorize = createPostgresActionAuthorizer(pool as never);
  const result = await authorize({ projectId: "p1", action: "FILE_WRITE", scopeFingerprint: "abc123" });
  assert.equal(result.allowed, true);
  assert.equal(pool.calls.length, 0);
});

test("PostgreSQL authorizer denies protected action without approval ID", async () => {
  const pool = fakePool();
  const authorize = createPostgresActionAuthorizer(pool as never);
  const result = await authorize({ projectId: "p1", action: "FILE_DELETE", scopeFingerprint: "abc123" });
  assert.equal(result.allowed, false);
  assert.equal(result.reason, "APPROVAL_REQUIRED");
});

test("PostgreSQL authorizer accepts only matching approved project, class, and fingerprint", async () => {
  const pool = fakePool({
    project_id: "p1", action: "DESTRUCTIVE_ACTION", scope_fingerprint: "fp-123",
    status: "APPROVED", unexpired: true,
  });
  const authorize = createPostgresActionAuthorizer(pool as never);
  const result = await authorize({
    projectId: "p1", action: "FILE_DELETE", scopeFingerprint: "fp-123", approvalId: "approval-1",
  });
  assert.equal(result.allowed, true);
  assert.equal(result.reason, "APPROVED");
});

test("PostgreSQL authorizer rejects project, scope, status and expiry mismatches", async () => {
  const base = { project_id: "p1", action: "DESTRUCTIVE_ACTION", scope_fingerprint: "fp-123", status: "APPROVED", unexpired: true };
  const cases = [
    { row: { ...base, project_id: "p2" }, reason: "PROJECT_MISMATCH" },
    { row: { ...base, scope_fingerprint: "other" }, reason: "SCOPE_MISMATCH" },
    { row: { ...base, status: "PENDING" }, reason: "PENDING" },
    { row: { ...base, unexpired: false }, reason: "APPROVAL_EXPIRED" },
  ];
  for (const item of cases) {
    const pool = fakePool(item.row);
    const authorize = createPostgresActionAuthorizer(pool as never);
    const result = await authorize({
      projectId: "p1", action: "FILE_DELETE", scopeFingerprint: "fp-123", approvalId: "approval-1",
    });
    assert.equal(result.allowed, false);
    assert.equal(result.reason, item.reason);
  }
});
