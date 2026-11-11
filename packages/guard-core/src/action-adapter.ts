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

// Only JSON data is accepted so fingerprints are stable across runtimes.
function stableSerialize(value: unknown, seen = new Set<object>()): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("FINGERPRINT_NON_FINITE_NUMBER");
    return JSON.stringify(value);
  }
  if (typeof value !== "object") throw new Error("FINGERPRINT_NON_JSON_VALUE");
  if (seen.has(value)) throw new Error("FINGERPRINT_CIRCULAR_REFERENCE");
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.keys(value).length !== value.length) throw new Error("FINGERPRINT_SPARSE_ARRAY");
      return "[" + value.map((item) => stableSerialize(item, seen)).join(",") + "]";
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new Error("FINGERPRINT_NON_PLAIN_OBJECT");
    const record = value as Record<string, unknown>;
    return "{" + Object.keys(record).sort().map((key) => {
      if (record[key] === undefined) throw new Error("FINGERPRINT_UNDEFINED_VALUE");
      return JSON.stringify(key) + ":" + stableSerialize(record[key], seen);
    }).join(",") + "}";
  } finally {
    seen.delete(value);
  }
}

/** Fingerprint is derived by the trusted adapter from the exact JSON payload. */
export function createActionScopeFingerprint(action: GuardedAction, payload: unknown): string {
  return createHash("sha256").update(stableSerialize({ action, payload })).digest("hex");
}

/**
 * Wrap a real tool handler. The authorizer must query trusted Credit Guard state.
 * The dispatch function must remain private to the trusted adapter.
 */
export async function executeWithGuard<T, R>(
  input: GuardedExecutionInput<T>,
  authorize: (request: { projectId: string; action: GuardedAction; scopeFingerprint: string; approvalId?: string }) => Promise<ActionAuthorization>,
  dispatch: (payload: T) => Promise<R>,
): Promise<GuardedExecutionResult<R>> {
  if (typeof input.projectId !== "string" || !input.projectId.trim()) throw new Error("PROJECT_REQUIRED");
  const scopeFingerprint = createActionScopeFingerprint(input.action, input.payload);
  const decision = await authorize({ projectId: input.projectId, action: input.action, scopeFingerprint, approvalId: input.approvalId });
  // Exact true is required. Undefined, truthy strings, and malformed responses fail closed.
  if (decision?.allowed !== true) {
    return { executed: false, reason: typeof decision?.reason === "string" && decision.reason ? decision.reason : "POLICY_DENIED", scopeFingerprint };
  }
  const result = await dispatch(input.payload);
  return { executed: true, reason: decision.reason || "POLICY_ALLOWED", scopeFingerprint, result };
}

export function approvalClassForAction(action: GuardedAction): ApprovalClass | null { return requiredApproval[action]; }
