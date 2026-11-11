import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { GuardedTerminalAdapter } from "./terminal.js";

test("terminal refuses commands without exact security approval", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cg-terminal-"));
  try {
    const adapter = await GuardedTerminalAdapter.create({
      rootDirectory: root, projectId: "p1", commands: { node: process.execPath },
      authorize: async (request) => {
        assert.equal(request.action, "TERMINAL_COMMAND");
        return { allowed: false, reason: "APPROVAL_REQUIRED" };
      },
    });
    const marker = path.join(root, "should-not-exist.txt");
    const result = await adapter.run("node", ["-e", "require('node:fs').writeFileSync(process.argv[1], 'bad')", marker]);
    assert.equal(result.executed, false);
    await assert.rejects(() => access(marker), { code: "ENOENT" });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("terminal uses configured executable without shell after authorization", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cg-terminal-"));
  try {
    const adapter = await GuardedTerminalAdapter.create({
      rootDirectory: root, projectId: "p1", commands: { node: process.execPath },
      authorize: async () => ({ allowed: true, reason: "APPROVED" }),
    });
    const result = await adapter.run("node", ["-e", "process.stdout.write('guarded')"]);
    assert.equal(result.executed, true);
    assert.equal(result.stdout, "guarded");
    assert.equal(result.exitCode, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("terminal does not accept an Agent-provided executable path", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cg-terminal-"));
  try {
    const adapter = await GuardedTerminalAdapter.create({
      rootDirectory: root, projectId: "p1", commands: { node: process.execPath },
      authorize: async () => ({ allowed: true, reason: "APPROVED" }),
    });
    await assert.rejects(() => adapter.run("/bin/sh", ["-c", "echo unsafe"]), /COMMAND_PROFILE_NOT_ALLOWED/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
