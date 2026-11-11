import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { GuardedDatabaseAdapter } from "./database.js";

function fakePool(existing?: string) {
  const calls: Array<{ sql: string; values?: unknown[] }> = [];
  const client = {
    async query(sql: string, values?: unknown[]) {
      calls.push({ sql, values });
      if (sql.includes("SELECT sha256 FROM cg_agent_migrations")) return { rows: existing ? [{ sha256: existing }] : [] };
      return { rows: [] };
    },
    release() {},
  };
  return { calls, pool: { async connect() { return client; } } };
}

test("database migration is not run without approval", async () => {
  const sql = "CREATE TABLE guarded_test(id integer)";
  const sha256 = createHash("sha256").update(sql).digest("hex");
  const fake = fakePool();
  const adapter = new GuardedDatabaseAdapter({
    pool: fake.pool as never, projectId: "p1", migrations: [{ id: "001-test", sql, sha256 }],
    authorize: async (request) => {
      assert.equal(request.action, "DATABASE_MIGRATION");
      return { allowed: false, reason: "APPROVAL_REQUIRED" };
    },
  });
  const result = await adapter.runMigration("001-test");
  assert.equal(result.executed, false);
  assert.equal(fake.calls.length, 0);
});

test("database migration runs only registered SQL in a transaction after approval", async () => {
  const sql = "CREATE TABLE guarded_test(id integer)";
  const sha256 = createHash("sha256").update(sql).digest("hex");
  const fake = fakePool();
  const adapter = new GuardedDatabaseAdapter({
    pool: fake.pool as never, projectId: "p1", migrations: [{ id: "001-test", sql, sha256 }],
    authorize: async () => ({ allowed: true, reason: "APPROVED" }),
  });
  const result = await adapter.runMigration("001-test");
  assert.equal(result.executed, true);
  assert.equal(result.alreadyApplied, false);
  assert.ok(fake.calls.some((call) => call.sql === sql));
  assert.ok(fake.calls.some((call) => call.sql === "COMMIT"));
});

test("database adapter rejects unregistered SQL and checksum drift", () => {
  const sql = "SELECT 1";
  const sha256 = createHash("sha256").update(sql).digest("hex");
  const fake = fakePool();
  const adapter = new GuardedDatabaseAdapter({
    pool: fake.pool as never, projectId: "p1", migrations: [{ id: "known", sql, sha256 }],
    authorize: async () => ({ allowed: true, reason: "APPROVED" }),
  });
  assert.rejects(() => adapter.runMigration("SELECT 2"), /MIGRATION_NOT_REGISTERED/);
  assert.throws(() => new GuardedDatabaseAdapter({
    pool: fake.pool as never, projectId: "p1", migrations: [{ id: "bad", sql, sha256: "wrong" }],
    authorize: async () => ({ allowed: true, reason: "APPROVED" }),
  }), /MIGRATION_CHECKSUM_MISMATCH/);
});
