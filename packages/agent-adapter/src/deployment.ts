import { executeWithGuard } from "@credit-guard/guard-core";
import type { ActionAuthorizer } from "./filesystem.js";

export type DeploymentHandler = (input: { artifactRef: string; target: string }) => Promise<{
  deploymentId: string;
  url?: string;
  status: string;
}>;

export interface DeploymentAdapterOptions {
  projectId: string;
  authorize: ActionAuthorizer;
  /** Deployment handlers are registered by the trusted host, never supplied by the Agent. */
  targets: Record<string, DeploymentHandler>;
}

export interface DeploymentResult {
  executed: boolean;
  reason: string;
  target: string;
  deploymentId?: string;
  url?: string;
  status?: string;
}

/** Exact-scope approval wrapper around a trusted deployment provider integration. */
export class GuardedDeploymentAdapter {
  constructor(private readonly options: DeploymentAdapterOptions) {
    if (!options.projectId.trim()) throw new Error("PROJECT_REQUIRED");
    if (!Object.keys(options.targets).length) throw new Error("DEPLOYMENT_TARGETS_REQUIRED");
  }

  async deploy(target: string, artifactRef: string, approvalId?: string): Promise<DeploymentResult> {
    const handler = this.options.targets[target];
    if (!handler) throw new Error("DEPLOYMENT_TARGET_NOT_ALLOWED");
    if (!artifactRef.trim() || artifactRef.length > 2048) throw new Error("INVALID_ARTIFACT_REFERENCE");
    const payload = { target, artifactRef };
    const result = await executeWithGuard(
      { projectId: this.options.projectId, action: "DEPLOY", payload, approvalId },
      this.options.authorize,
      () => handler(payload),
    );
    return result.executed
      ? { executed: true, reason: result.reason, target, ...result.result }
      : { executed: false, reason: result.reason, target };
  }
}
