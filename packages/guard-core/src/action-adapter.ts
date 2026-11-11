import { createHash } from "node:crypto";

export type GuardedAction = "READ_ONLY" | "MODEL_REQUEST" | "FILE_WRITE" | "FILE_OVERWRITE" | "FILE_DELETE" | "DEPLOY" | "DATABASE_MIGRATION" | "BUDGET_CHANGE" | "SCOPE_CHANGE" | "ARCHITECTURE_CHANGE" | "SECURITY_CHANGE";
export type ApprovalClass = "DESTRUCTIVE_ACTION" | "PRODUCTION_CHANGE" | "SPEND_LIMIT" | "SCOPE_CHANGE" | "ARCHITECTURE_CHANGE" | "SECURITY_SENSITIVE";
export interface ActionAuthorization { allowed: boolean; reason: string; requiredApproval?: ApprovalClass; }
export interface GuardedExecutionInput<T> { projectId: string; action: GuardedAction; payload: T; approvalId?: string; }
export interface GuardedExecutionResult<R> { executed: boolean; reason: string; scopeFingerprint: string; result?: R; }

const requiredApproval: Record<GuardedAction, ApprovalClass | null> = {
  READ_ONLY: null, MODEL_REQUEST: null, FILE_WRITE: null,
  FILE_OVERWRITE: "DESTRUCTIVE_ACTION", FILE_DELETE: "DESTRUCTIVE_ACTION",
  DEPLOY: "PRODUCTION_CHANGE", DATABASE_MIGRATION: "PRODUCTION_CHANGE",
  BUDGET_CHANGE: "SPEND_LIMIT", SCOPE_CHANGE: "SCOPE_CHANGE",
  ARCHITECTURE_CHANGE: "ARCHITECTURE_CHANGE", SECURITY_CHANGE: "SECURITY_SENSITIVE",
};

function stableSerialize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return "[" + value.map(stableSerialize).join(",") + "]";
  const record = value as Record<string, unknown>;
  return "{" + Object.keys(record).sort().map((key) => JSON.stringify(key) + ":" + stableSerialize(record[key])).join(",") + "}";
}

/** Fingerprint is derived by the trusted adapter from the exact action payload. */
export function createActionScopeFingerprint(action: GuardedAction, payload: unknown): string {
  return createHash("sha256").update(stableSerialize({ action, payload })).digest("hex");
}

/** Wrap a real tool handler. The authorizer must query trusted Credit Guard state. */
export async function executeWithGuard<T, R>(
  input: GuardedExecutionInput<T>,
  authorize: (request: { projectId: string; action: GuardedAction; scopeFingerprint: string; approvalId?: string }) => Promise<ActionAuthorization>,
  dispatch: (payload: T) => Promise<R>,
): Promise<GuardedExecutionResult<R>> {
  if (!input.projectId.trim()) throw new Error("PROJECT_REQUIRED");
  const scopeFingerprint = createActionScopeFingerprint(input.action, input.payload);
  const decision = await authorize({ projectId: input.projectId, action: input.action, scopeFingerprint, approvalId: input.approvalId });
  if (!decision.allowed) return { executed: false, reason: decision.reason || "POLICY_DENIED", scopeFingerprint };
  const result = await dispatch(input.payload);
  return { executed: true, reason: decision.reason, scopeFingerprint, result };
}

export function approvalClassForAction(action: GuardedAction): ApprovalClass | null { return requiredApproval[action]; }