import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
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


test("filesystem rejects symlink files and parent directories escaping the workspace", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cg-adapter-root-"));
  const outside = await mkdtemp(path.join(os.tmpdir(), "cg-adapter-outside-"));
  try {
    await writeFile(path.join(outside, "secret.txt"), "secret");
    await symlink(path.join(outside, "secret.txt"), path.join(root, "secret-link"));
    await symlink(outside, path.join(root, "outside-dir"));
    const adapter = await GuardedFilesystemAdapter.create({
      rootDirectory: root, projectId: "test-project",
      authorize: async () => ({ allowed: true, reason: "OK" }),
    });
    await assert.rejects(() => adapter.read("secret-link"), /UNSAFE_FILE_TARGET/);
    await assert.rejects(() => adapter.write("secret-link", "overwrite"), /UNSAFE_FILE_TARGET/);
    await assert.rejects(() => adapter.write("outside-dir/new.txt", "escape"), /PATH_OUTSIDE_WORKSPACE/);
    assert.equal(await readFile(path.join(outside, "secret.txt"), "utf8"), "secret");
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
