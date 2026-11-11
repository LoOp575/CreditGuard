import type { Pool } from "pg";
import { GuardedDatabaseAdapter, type TrustedMigration } from "./database.js";
import { GuardedDeploymentAdapter, type DeploymentHandler } from "./deployment.js";
import { GuardedFilesystemAdapter } from "./filesystem.js";
import { createPostgresActionAuthorizer } from "./postgres-authorizer.js";
import { GuardedTerminalAdapter } from "./terminal.js";

export interface GuardedAgentRuntimeOptions {
  pool: Pool;
  projectId: string;
  workspaceRoot: string;
  commands: Record<string, string>;
  migrations: TrustedMigration[];
  deploymentTargets: Record<string, DeploymentHandler>;
  terminalEnvironment?: Record<string, string>;
  terminalTimeoutMs?: number;
  terminalMaxBufferBytes?: number;
  migrationStatementTimeoutMs?: number;
}

export async function createGuardedAgentRuntime(options: GuardedAgentRuntimeOptions) {
  const authorize = createPostgresActionAuthorizer(options.pool);
  const [filesystem, terminal] = await Promise.all([
    GuardedFilesystemAdapter.create({
      rootDirectory: options.workspaceRoot,
      projectId: options.projectId,
      authorize,
    }),
    GuardedTerminalAdapter.create({
      rootDirectory: options.workspaceRoot,
      projectId: options.projectId,
      authorize,
      commands: options.commands,
      environment: options.terminalEnvironment,
      timeoutMs: options.terminalTimeoutMs,
      maxBufferBytes: options.terminalMaxBufferBytes,
    }),
  ]);
  const database = new GuardedDatabaseAdapter({
    pool: options.pool,
    projectId: options.projectId,
    authorize,
    migrations: options.migrations,
    statementTimeoutMs: options.migrationStatementTimeoutMs,
  });
  const deployment = new GuardedDeploymentAdapter({
    projectId: options.projectId,
    authorize,
    targets: options.deploymentTargets,
  });
  return { authorize, filesystem, terminal, database, deployment };
}
