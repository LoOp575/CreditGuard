import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { createPostgresActionAuthorizer } from "./postgres-authorizer.js";

test("real PostgreSQL approval rows enforce project, action, scope and expiry", {
  skip: !process.env.TEST_DATABASE_URL,
}, async () => {
  const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  const approvalId = randomUUID();
  const projectId = "adapter-integration-" + randomUUID();
  try {
    await pool.query(
      `INSERT INTO cg_approval_requests
       (approval_id,project_id,action,title,details,scope_fingerprint,idempotency_key,status,expires_at)
       VALUES($1,$2,'DESTRUCTIVE_ACTION','Delete test file','Integration test','fingerprint-123',$3,'APPROVED',now()+interval '5 minutes')`,
      [approvalId, projectId, "key-" + randomUUID()],
    );
    const authorize = createPostgresActionAuthorizer(pool);
    const allowed = await authorize({
      projectId, action: "FILE_DELETE", scopeFingerprint: "fingerprint-123", approvalId,
    });
    assert.equal(allowed.allowed, true);

    const wrongScope = await authorize({
      projectId, action: "FILE_DELETE", scopeFingerprint: "fingerprint-other", approvalId,
    });
    assert.equal(wrongScope.allowed, false);
    assert.equal(wrongScope.reason, "SCOPE_MISMATCH");

    await pool.query("UPDATE cg_approval_requests SET expires_at=now()-interval '1 second' WHERE approval_id=$1", [approvalId]);
    const expired = await authorize({
      projectId, action: "FILE_DELETE", scopeFingerprint: "fingerprint-123", approvalId,
    });
    assert.equal(expired.allowed, false);
    assert.equal(expired.reason, "APPROVAL_EXPIRED");
    const persisted = await pool.query("SELECT status FROM cg_approval_requests WHERE approval_id=$1", [approvalId]);
    assert.equal(persisted.rows[0].status, "EXPIRED");
  } finally {
    await pool.query("DELETE FROM cg_approval_requests WHERE approval_id=$1", [approvalId]);
    await pool.end();
  }
});
