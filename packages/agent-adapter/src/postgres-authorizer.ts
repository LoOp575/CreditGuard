import type { Pool } from "pg";
import type { ActionAuthorization, ApprovalClass, GuardedAction } from "@credit-guard/guard-core";
import type { ActionAuthorizer } from "./filesystem.js";

const requiredApproval: Partial<Record<GuardedAction, ApprovalClass>> = {
  FILE_OVERWRITE: "DESTRUCTIVE_ACTION",
  FILE_DELETE: "DESTRUCTIVE_ACTION",
  TERMINAL_COMMAND: "SECURITY_SENSITIVE",
  DEPLOY: "PRODUCTION_CHANGE",
  DATABASE_MIGRATION: "PRODUCTION_CHANGE",
  BUDGET_CHANGE: "SPEND_LIMIT",
  SCOPE_CHANGE: "SCOPE_CHANGE",
  ARCHITECTURE_CHANGE: "ARCHITECTURE_CHANGE",
  SECURITY_CHANGE: "SECURITY_SENSITIVE",
};

/**
 * Server-side PostgreSQL authorizer. It reads the canonical approval row directly;
 * never accepts an Agent-supplied "allowed" flag or scope fingerprint.
 */
export function createPostgresActionAuthorizer(pool: Pick<Pool, "query">): ActionAuthorizer {
  return async ({ projectId, action, scopeFingerprint, approvalId }): Promise<ActionAuthorization> => {
    const required = requiredApproval[action];
    if (!required) return { allowed: true, reason: "NO_APPROVAL_REQUIRED" };
    if (!approvalId) return { allowed: false, reason: "APPROVAL_REQUIRED", requiredApproval: required };

    const result = await pool.query<{
      project_id: string;
      action: string;
      scope_fingerprint: string;
      status: string;
      unexpired: boolean;
    }>(
      `SELECT project_id, action, scope_fingerprint, status, (expires_at > now()) AS unexpired
       FROM cg_approval_requests WHERE approval_id = $1`,
      [approvalId],
    );
    const record = result.rows[0];
    if (!record) return { allowed: false, reason: "APPROVAL_NOT_FOUND", requiredApproval: required };
    if (!record.unexpired) {
      await pool.query(
        "UPDATE cg_approval_requests SET status='EXPIRED' WHERE approval_id=$1 AND status='PENDING' AND expires_at<=now()",
        [approvalId],
      );
      return { allowed: false, reason: "APPROVAL_EXPIRED", requiredApproval: required };
    }
    if (record.status !== "APPROVED") {
      return { allowed: false, reason: record.status || "APPROVAL_NOT_APPROVED", requiredApproval: required };
    }
    if (record.project_id !== projectId) return { allowed: false, reason: "PROJECT_MISMATCH", requiredApproval: required };
    if (record.action !== required) return { allowed: false, reason: "ACTION_MISMATCH", requiredApproval: required };
    if (record.scope_fingerprint !== scopeFingerprint) return { allowed: false, reason: "SCOPE_MISMATCH", requiredApproval: required };
    return { allowed: true, reason: "APPROVED", requiredApproval: required };
  };
}
