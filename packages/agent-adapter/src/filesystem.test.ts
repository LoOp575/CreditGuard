import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { GuardedFilesystemAdapter } from "./filesystem.js";

test("filesystem mutation is not dispatched when policy denies it", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cg-adapter-"));
  try {
    const adapter = await GuardedFilesystemAdapter.create({
      rootDirectory: root, projectId: "test-project",
      authorize: async () => ({ allowed: false, reason: "APPROVAL_REQUIRED" }),
    });
    const result = await adapter.write("new.txt", "blocked");
    assert.equal(result.executed, false);
    await assert.rejects(() => readFile(path.join(root, "new.txt"), "utf8"), { code: "ENOENT" });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("new file write uses FILE_WRITE and creates the file after authorization", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cg-adapter-"));
  try {
    const seen: string[] = [];
    const adapter = await GuardedFilesystemAdapter.create({
      rootDirectory: root, projectId: "test-project",
      authorize: async (request) => { seen.push(request.action); return { allowed: true, reason: "OK" }; },
    });
    const result = await adapter.write("new.txt", "hello");
    assert.equal(result.executed, true);
    assert.equal(await readFile(path.join(root, "new.txt"), "utf8"), "hello");
    assert.deepEqual(seen, ["FILE_WRITE"]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("overwrite and delete require protected action approvals", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cg-adapter-"));
  try {
    await writeFile(path.join(root, "existing.txt"), "before");
    const seen: string[] = [];
    const adapter = await GuardedFilesystemAdapter.create({
      rootDirectory: root, projectId: "test-project",
      authorize: async (request) => { seen.push(request.action); return { allowed: false, reason: "APPROVAL_REQUIRED" }; },
    });
    assert.equal((await adapter.write("existing.txt", "after")).executed, false);
    assert.equal((await adapter.delete("existing.txt")).executed, false);
    assert.equal(await readFile(path.join(root, "existing.txt"), "utf8"), "before");
    assert.deepEqual(seen, ["FILE_OVERWRITE", "FILE_DELETE"]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("path traversal is rejected before authorization", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cg-adapter-"));
  try {
    let called = false;
    const adapter = await GuardedFilesystemAdapter.create({
      rootDirectory: root, projectId: "test-project",
      authorize: async () => { called = true; return { allowed: true, reason: "OK" }; },
    });
    await assert.rejects(() => adapter.write("../outside.txt", "bad"), /PATH_OUTSIDE_WORKSPACE/);
    assert.equal(called, false);
  } finally { await rm(root, { recursive: true, force: true }); }
});
