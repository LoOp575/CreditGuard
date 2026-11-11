import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { executeWithGuard } from "@credit-guard/guard-core";
import type { ActionAuthorizer } from "./filesystem.js";

export interface TrustedMigration {
  id: string;
  sql: string;
  sha256: string;
}

export interface DatabaseAdapterOptions {
  pool: Pick<Pool, "connect">;
  projectId: string;
  authorize: ActionAuthorizer;
  migrations: TrustedMigration[];
  statementTimeoutMs?: number;
}

export interface MigrationResult {
  executed: boolean;
  reason: string;
  migrationId: string;
  alreadyApplied?: boolean;
}

/**
 * Runs only migrations registered by the trusted host. Agent input selects an ID;
 * it cannot submit arbitrary SQL. Each migration is transactionally recorded and
 * protected by a PostgreSQL advisory transaction lock.
 */
export class GuardedDatabaseAdapter {
  private readonly migrations: Map<string, TrustedMigration>;

  constructor(private readonly options: DatabaseAdapterOptions) {
    if (!options.projectId.trim()) throw new Error("PROJECT_REQUIRED");
    this.migrations = new Map();
    for (const migration of options.migrations) {
      if (!/^[a-zA-Z0-9_.-]{1,120}$/.test(migration.id) || !migration.sql.trim()) {
        throw new Error("INVALID_TRUSTED_MIGRATION");
      }
      const actual = createHash("sha256").update(migration.sql).digest("hex");
      if (actual !== migration.sha256) throw new Error("MIGRATION_CHECKSUM_MISMATCH");
      if (this.migrations.has(migration.id)) throw new Error("DUPLICATE_MIGRATION_ID");
      this.migrations.set(migration.id, migration);
    }
  }

  async runMigration(migrationId: string, approvalId?: string): Promise<MigrationResult> {
    const migration = this.migrations.get(migrationId);
    if (!migration) throw new Error("MIGRATION_NOT_REGISTERED");
    const payload = { migrationId: migration.id, sha256: migration.sha256 };
    const result = await executeWithGuard(
      { projectId: this.options.projectId, action: "DATABASE_MIGRATION", payload, approvalId },
      this.options.authorize,
      async () => this.applyMigration(migration),
    );
    return result.executed
      ? { executed: true, reason: result.reason, migrationId, ...result.result }
      : { executed: false, reason: result.reason, migrationId };
  }

  private async applyMigration(migration: TrustedMigration): Promise<{ alreadyApplied: boolean }> {
    const client: PoolClient = await this.options.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", ["credit-guard-agent-migrations"]);
      await client.query(`SET LOCAL statement_timeout = ${Math.max(1000, Math.min(this.options.statementTimeoutMs ?? 30_000, 120_000))}`);
      await client.query(`CREATE TABLE IF NOT EXISTS cg_agent_migrations (
        migration_id TEXT PRIMARY KEY,
        sha256 TEXT NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`);
      const existing = await client.query<{ sha256: string }>(
        "SELECT sha256 FROM cg_agent_migrations WHERE migration_id=$1 FOR UPDATE",
        [migration.id],
      );
      if (existing.rows[0]) {
        if (existing.rows[0].sha256 !== migration.sha256) throw new Error("APPLIED_MIGRATION_CHECKSUM_MISMATCH");
        await client.query("COMMIT");
        return { alreadyApplied: true };
      }
      await client.query(migration.sql);
      await client.query("INSERT INTO cg_agent_migrations(migration_id,sha256) VALUES($1,$2)", [migration.id, migration.sha256]);
      await client.query("COMMIT");
      return { alreadyApplied: false };
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch { /* preserve original error */ }
      throw error;
    } finally {
      client.release();
    }
  }
}
