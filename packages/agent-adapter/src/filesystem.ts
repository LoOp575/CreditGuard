import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, realpath, unlink } from "node:fs/promises";
import path from "node:path";
import { executeWithGuard, type ActionAuthorization, type GuardedAction } from "@credit-guard/guard-core";

export type ActionAuthorizer = (request: {
  projectId: string;
  action: GuardedAction;
  scopeFingerprint: string;
  approvalId?: string;
}) => Promise<ActionAuthorization>;

export interface FilesystemAdapterOptions {
  rootDirectory: string;
  projectId: string;
  authorize: ActionAuthorizer;
}

export interface FileOperationResult {
  executed: boolean;
  reason: string;
  path: string;
}

/**
 * Workspace-scoped filesystem adapter. All mutations pass through executeWithGuard.
 * It rejects absolute paths, traversal, and symlink targets. Use an OS/container
 * sandbox as an additional boundary for hostile concurrent local processes.
 */
export class GuardedFilesystemAdapter {
  private constructor(
    private readonly root: string,
    private readonly projectId: string,
    private readonly authorize: ActionAuthorizer,
  ) {}

  static async create(options: FilesystemAdapterOptions): Promise<GuardedFilesystemAdapter> {
    if (!options.projectId.trim()) throw new Error("PROJECT_REQUIRED");
    const root = await realpath(options.rootDirectory);
    return new GuardedFilesystemAdapter(root, options.projectId, options.authorize);
  }

  private async resolveTarget(relativePath: string): Promise<string> {
    if (!relativePath || path.isAbsolute(relativePath)) throw new Error("INVALID_WORKSPACE_PATH");
    const target = path.resolve(this.root, relativePath);
    const rel = path.relative(this.root, target);
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
      if (!rel) return target;
      throw new Error("PATH_OUTSIDE_WORKSPACE");
    }
    const parent = await realpath(path.dirname(target));
    const parentRel = path.relative(this.root, parent);
    if (parentRel.startsWith("..") || path.isAbsolute(parentRel)) throw new Error("PATH_OUTSIDE_WORKSPACE");
    return target;
  }

  async read(relativePath: string): Promise<string> {
    const target = await this.resolveTarget(relativePath);
    const info = await lstat(target);
    if (info.isSymbolicLink() || !info.isFile()) throw new Error("UNSAFE_FILE_TARGET");
    return readFile(target, "utf8");
  }

  async write(relativePath: string, content: string, approvalId?: string): Promise<FileOperationResult> {
    const target = await this.resolveTarget(relativePath);
    let exists = false;
    try {
      const info = await lstat(target);
      if (info.isSymbolicLink() || !info.isFile()) throw new Error("UNSAFE_FILE_TARGET");
      exists = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const action: GuardedAction = exists ? "FILE_OVERWRITE" : "FILE_WRITE";
    const result = await executeWithGuard(
      { projectId: this.projectId, action, payload: { path: relativePath, content } },
      this.authorize,
      async () => {
        const flags = exists ? constants.O_WRONLY | constants.O_TRUNC | (constants.O_NOFOLLOW ?? 0) : constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0);
        const handle = await open(target, flags, 0o600);
        try { await handle.writeFile(content, "utf8"); } finally { await handle.close(); }
      },
    );
    return { executed: result.executed, reason: result.reason, path: relativePath };
  }

  async delete(relativePath: string, approvalId?: string): Promise<FileOperationResult> {
    const target = await this.resolveTarget(relativePath);
    const info = await lstat(target);
    if (info.isSymbolicLink() || !info.isFile()) throw new Error("UNSAFE_FILE_TARGET");
    const result = await executeWithGuard(
      { projectId: this.projectId, action: "FILE_DELETE", payload: { path: relativePath } , approvalId },
      this.authorize,
      async () => { await unlink(target); },
    );
    return { executed: result.executed, reason: result.reason, path: relativePath };
  }
}
