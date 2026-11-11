import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { executeWithGuard } from "@credit-guard/guard-core";
import type { ActionAuthorizer } from "./filesystem.js";

const execFile = promisify(execFileCallback);

export interface TerminalAdapterOptions {
  rootDirectory: string;
  projectId: string;
  authorize: ActionAuthorizer;
  /** Trusted executable map. The Agent chooses a profile, never an executable path. */
  commands: Record<string, string>;
  /** Explicit environment allowlist. Do not pass provider credentials here. */
  environment?: Record<string, string>;
  timeoutMs?: number;
  maxBufferBytes?: number;
}

export interface TerminalResult {
  executed: boolean;
  reason: string;
  stdout?: string;
  stderr?: string;
  exitCode?: number;
}

/**
 * Executes only trusted executable profiles, with shell=false and exact approval
 * over profile, arguments and workspace. Every command is security-sensitive.
 */
export class GuardedTerminalAdapter {
  private constructor(private readonly options: TerminalAdapterOptions, private readonly root: string) {}

  static async create(options: TerminalAdapterOptions): Promise<GuardedTerminalAdapter> {
    if (!options.projectId.trim()) throw new Error("PROJECT_REQUIRED");
    if (!Object.keys(options.commands).length) throw new Error("COMMAND_PROFILES_REQUIRED");
    const root = await import("node:fs/promises").then((fs) => fs.realpath(options.rootDirectory));
    for (const [profile, executable] of Object.entries(options.commands)) {
      if (!/^[a-zA-Z0-9_-]{1,64}$/.test(profile) || !path.isAbsolute(executable)) {
        throw new Error("INVALID_TRUSTED_COMMAND_PROFILE");
      }
    }
    return new GuardedTerminalAdapter(options, root);
  }

  async run(profile: string, args: string[], approvalId?: string): Promise<TerminalResult> {
    const executable = this.options.commands[profile];
    if (!executable) throw new Error("COMMAND_PROFILE_NOT_ALLOWED");
    if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string" || arg.includes("\0"))) {
      throw new Error("INVALID_COMMAND_ARGUMENTS");
    }
    const payload = { profile, executable, args, cwd: this.root };
    const result = await executeWithGuard(
      { projectId: this.options.projectId, action: "TERMINAL_COMMAND", payload, approvalId },
      this.options.authorize,
      async () => {
        try {
          const output = await execFile(executable, args, {
            cwd: this.root,
            env: { PATH: process.env.PATH ?? "", ...(this.options.environment ?? {}) },
            shell: false,
            timeout: this.options.timeoutMs ?? 30_000,
            maxBuffer: this.options.maxBufferBytes ?? 1024 * 1024,
            windowsHide: true,
          });
          return { stdout: output.stdout, stderr: output.stderr, exitCode: 0 };
        } catch (error) {
          const e = error as Error & { code?: number; stdout?: string; stderr?: string };
          return { stdout: e.stdout ?? "", stderr: e.stderr ?? e.message, exitCode: typeof e.code === "number" ? e.code : 1 };
        }
      },
    );
    return result.executed
      ? { executed: true, reason: result.reason, ...result.result }
      : { executed: false, reason: result.reason };
  }
}
