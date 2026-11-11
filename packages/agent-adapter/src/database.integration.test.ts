import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { GuardedDatabaseAdapter } from "./database.js";

test("real PostgreSQL migration adapter commits once and records checksum", {
  skip: !process.env.TEST_DATABASE_URL,
}, async () => {
  const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  const suffix = randomUUID().replaceAll("-", "");
  const migrationId = "it_" + suffix;
  const tableName = "cg_adapter_it_" + suffix;
  const sql = `CREATE TABLE ${tableName} (id integer PRIMARY KEY)`;
  const sha256 = createHash("sha256").update(sql).digest("hex");
  try {
    const adapter = new GuardedDatabaseAdapter({
      pool, projectId: "integration-project",
      migrations: [{ id: migrationId, sql, sha256 }],
      authorize: async () => ({ allowed: true, reason: "APPROVED" }),
    });
    const first = await adapter.runMigration(migrationId);
    assert.equal(first.executed, true);
    assert.equal(first.alreadyApplied, false);

    const second = await adapter.runMigration(migrationId);
    assert.equal(second.executed, true);
    assert.equal(second.alreadyApplied, true);

    const exists = await pool.query(
      "SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name=$1",
      [tableName],
    );
    assert.equal(exists.rowCount, 1);
    const ledger = await pool.query("SELECT sha256 FROM cg_agent_migrations WHERE migration_id=$1", [migrationId]);
    assert.equal(ledger.rows[0].sha256, sha256);
  } finally {
    await pool.query(`DROP TABLE IF EXISTS ${tableName}`);
    await pool.query("DELETE FROM cg_agent_migrations WHERE migration_id=$1", [migrationId]);
    await pool.end();
  }
});
