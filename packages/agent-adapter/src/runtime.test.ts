import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createGuardedAgentRuntime } from "./runtime.js";

test("runtime factory wires all privileged adapters to one trusted PostgreSQL authorizer", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cg-runtime-"));
  try {
    const runtime = await createGuardedAgentRuntime({
      pool: {} as never,
      projectId: "runtime-project",
      workspaceRoot: root,
      commands: { node: process.execPath },
      migrations: [],
      deploymentTargets: {
        staging: async () => ({ deploymentId: "test-deploy", status: "ready" }),
      },
    });
    assert.equal(typeof runtime.authorize, "function");
    assert.equal(typeof runtime.filesystem.read, "function");
    assert.equal(typeof runtime.filesystem.write, "function");
    assert.equal(typeof runtime.terminal.run, "function");
    assert.equal(typeof runtime.database.runMigration, "function");
    assert.equal(typeof runtime.deployment.deploy, "function");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
