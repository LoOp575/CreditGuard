import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { verifySecretToken } from "./security.js";

type ApprovalStatus = "PENDING" | "APPROVED" | "REJECTED" | "EXPIRED";
type ApprovalAction = "SCOPE_CHANGE" | "ARCHITECTURE_CHANGE" | "DESTRUCTIVE_ACTION" | "PRODUCTION_CHANGE" | "SPEND_LIMIT" | "SECURITY_SENSITIVE";
type ApprovalRecord = {
  id: string; projectId: string; action: ApprovalAction; title: string; details: string;
  scopeFingerprint: string; idempotencyKey: string; status: ApprovalStatus;
  requestedAt: string; expiresAt: string; resolvedAt?: string; resolutionNote?: string;
};
const memory = new Map<string, ApprovalRecord>();
function matchesRequest(record: ApprovalRecord, args: { action: ApprovalAction; title: string; details: string; scopeFingerprint: string }): boolean {
  return record.action===args.action && record.title===args.title && record.details===args.details && record.scopeFingerprint===args.scopeFingerprint;
}
const actionSchema = z.enum(["SCOPE_CHANGE", "ARCHITECTURE_CHANGE", "DESTRUCTIVE_ACTION", "PRODUCTION_CHANGE", "SPEND_LIMIT", "SECURITY_SENSITIVE"]);

export function registerApprovalTools(server: McpServer, pool?: Pool) {
  const authorityToken = process.env.APPROVAL_AUTHORITY_TOKEN;
  async function get(id: string): Promise<ApprovalRecord | null> {
    if (!pool) return memory.get(id) ?? null;
    const q = await pool.query("SELECT * FROM cg_approval_requests WHERE approval_id=$1", [id]);
    if (!q.rowCount) return null;
    const r = q.rows[0];
    return { id:r.approval_id, projectId:r.project_id, action:r.action, title:r.title, details:r.details,
      scopeFingerprint:r.scope_fingerprint, idempotencyKey:r.idempotency_key, status:r.status,
      requestedAt:new Date(r.requested_at).toISOString(), expiresAt:new Date(r.expires_at).toISOString(),
      resolvedAt:r.resolved_at ? new Date(r.resolved_at).toISOString() : undefined, resolutionNote:r.resolution_note ?? undefined };
  }

  server.tool("guard.approval.request",
    "Create a pending user-approval request for a risky or out-of-scope action. The Agent must pause that action until approval is granted.",
    { projectId:z.string().min(1), action:actionSchema, title:z.string().min(1).max(160), details:z.string().min(1).max(5000),
      scopeFingerprint:z.string().min(8).max(256), idempotencyKey:z.string().min(8).max(128), expiresInMinutes:z.number().int().min(1).max(10080).optional() },
    async (args) => {
      try {
        const expiresInMinutes=args.expiresInMinutes ?? 60;
        if (pool) {
          const existing=await pool.query("SELECT * FROM cg_approval_requests WHERE project_id=$1 AND idempotency_key=$2",[args.projectId,args.idempotencyKey]);
          if (existing.rowCount) { const record=await get(existing.rows[0].approval_id); if(!record || !matchesRequest(record,args)) throw new Error("APPROVAL_IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD"); return {content:[{type:"text",text:JSON.stringify(record)}]}; }
        } else {
          const existing=[...memory.values()].find(x=>x.projectId===args.projectId && x.idempotencyKey===args.idempotencyKey);
          if (existing) { if(!matchesRequest(existing,args)) throw new Error("APPROVAL_IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD"); return {content:[{type:"text",text:JSON.stringify(existing)}]}; }
        }
        const now=new Date();
        const record:ApprovalRecord={id:randomUUID(),projectId:args.projectId,action:args.action,title:args.title,details:args.details,
          scopeFingerprint:args.scopeFingerprint,idempotencyKey:args.idempotencyKey,status:"PENDING",
          requestedAt:now.toISOString(),expiresAt:new Date(now.getTime()+expiresInMinutes*60000).toISOString()};
        if (pool) {
          const inserted=await pool.query(`INSERT INTO cg_approval_requests
            (approval_id,project_id,action,title,details,scope_fingerprint,idempotency_key,status,expires_at)
            VALUES($1,$2,$3,$4,$5,$6,$7,'PENDING',$8)
            ON CONFLICT (project_id,idempotency_key) DO NOTHING RETURNING approval_id`,
            [record.id,record.projectId,record.action,record.title,record.details,record.scopeFingerprint,record.idempotencyKey,record.expiresAt]);
          if (!inserted.rowCount) {
            const existing=await pool.query("SELECT approval_id FROM cg_approval_requests WHERE project_id=$1 AND idempotency_key=$2",[record.projectId,record.idempotencyKey]);
            if (existing.rowCount) { const record=await get(existing.rows[0].approval_id); if(!record || !matchesRequest(record,args)) throw new Error("APPROVAL_IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD"); return {content:[{type:"text",text:JSON.stringify(record)}]}; }
            throw new Error("APPROVAL_IDEMPOTENCY_CONFLICT");
          }
        } else memory.set(record.id,record);
        return {content:[{type:"text",text:JSON.stringify({ ...record, instruction:"PAUSE_ACTION_UNTIL_APPROVED" })}]};
      } catch(error) { return {isError:true,content:[{type:"text",text:error instanceof Error?error.message:"APPROVAL_REQUEST_FAILED"}]}; }
    });

  server.tool("guard.approval.get",
    "Read an approval request and its current status. PENDING, REJECTED, EXPIRED, or missing means do not execute the protected action.",
    { approvalId:z.string().uuid() },
    async ({approvalId}) => {
      const record=await get(approvalId);
      if (!record) return {content:[{type:"text",text:JSON.stringify({found:false,approved:false})}]};
      if (record.status==="PENDING" && Date.now()>=Date.parse(record.expiresAt)) {
        if(pool) await pool.query("UPDATE cg_approval_requests SET status='EXPIRED' WHERE approval_id=$1 AND status='PENDING'",[approvalId]);
        else record.status="EXPIRED";
        record.status="EXPIRED";
      }
      return {content:[{type:"text",text:JSON.stringify({ ...record, approved:record.status==="APPROVED" })}]};
    });

  server.tool("guard.approval.resolve",
    "Record an explicit approval or rejection from a trusted user-approval interface. Requires the server-held authority token; never expose that token to an Agent.",
    { approvalId:z.string().uuid(), decision:z.enum(["APPROVE","REJECT"]), resolutionNote:z.string().max(1000).optional(), authorityToken:z.string().min(24) },
    async ({approvalId,decision,resolutionNote,authorityToken:provided}) => {
      if (!authorityToken || !verifySecretToken(provided,authorityToken))
        return {isError:true,content:[{type:"text",text:"APPROVAL_AUTHORITY_DENIED"}]};
      const record=await get(approvalId);
      if(!record) return {isError:true,content:[{type:"text",text:"APPROVAL_NOT_FOUND"}]};
      if(record.status!=="PENDING") return {isError:true,content:[{type:"text",text:"APPROVAL_NOT_PENDING"}]};
      if(Date.now()>=Date.parse(record.expiresAt)) {
        if(pool) await pool.query("UPDATE cg_approval_requests SET status='EXPIRED' WHERE approval_id=$1 AND status='PENDING'",[approvalId]);
        else record.status="EXPIRED";
        return {isError:true,content:[{type:"text",text:"APPROVAL_EXPIRED"}]};
      }
      const status=decision==="APPROVE"?"APPROVED":"REJECTED";
      if(pool) {
        const updated=await pool.query("UPDATE cg_approval_requests SET status=$2,resolved_at=now(),resolution_note=$3 WHERE approval_id=$1 AND status='PENDING' AND expires_at>now() RETURNING approval_id",
          [approvalId,status,resolutionNote ?? null]);
        if(!updated.rowCount) return {isError:true,content:[{type:"text",text:"APPROVAL_STATE_CHANGED_OR_EXPIRED"}]};
      } else { record.status=status; record.resolvedAt=new Date().toISOString(); record.resolutionNote=resolutionNote; }
      return {content:[{type:"text",text:JSON.stringify({approvalId,status,approved:status==="APPROVED",scopeFingerprint:record.scopeFingerprint})}]};
    });

  server.tool("guard.approval.check",
    "Fail-closed check before executing a protected action. Approval is valid only for the exact scope fingerprint and an unexpired APPROVED request.",
    { approvalId:z.string().uuid(), projectId:z.string().min(1), action:actionSchema, scopeFingerprint:z.string().min(8).max(256) },
    async ({approvalId,projectId,action,scopeFingerprint}) => {
      const record=await get(approvalId);
      if(!record) return {content:[{type:"text",text:JSON.stringify({allowed:false,reason:"NOT_FOUND"})}]};
      if(record.status==="PENDING" && Date.now()>=Date.parse(record.expiresAt)) {
        if(pool) await pool.query("UPDATE cg_approval_requests SET status='EXPIRED' WHERE approval_id=$1 AND status='PENDING'",[approvalId]);
        else record.status="EXPIRED";
        record.status="EXPIRED";
      }
      const allowed=record.status==="APPROVED" && record.projectId===projectId && record.action===action && record.scopeFingerprint===scopeFingerprint;
      const reason=allowed?"APPROVED":record.status!=="APPROVED"?record.status:record.projectId!==projectId?"PROJECT_MISMATCH":record.action!==action?"ACTION_MISMATCH":"SCOPE_MISMATCH";
      return {content:[{type:"text",text:JSON.stringify({allowed,reason})}]};
    });

  // Single preflight contract for Agent tool adapters. This does not intercept
  // third-party tools by itself; adapters must call it before dispatch.
  const actionPolicy = z.enum(["READ_ONLY","MODEL_REQUEST","FILE_WRITE","FILE_OVERWRITE","FILE_DELETE","DEPLOY","DATABASE_MIGRATION","BUDGET_CHANGE","SCOPE_CHANGE","ARCHITECTURE_CHANGE","SECURITY_CHANGE"]);
  const requiredApproval: Record<z.infer<typeof actionPolicy>, ApprovalAction | null> = {
    READ_ONLY:null, MODEL_REQUEST:null, FILE_WRITE:null,
    FILE_OVERWRITE:"DESTRUCTIVE_ACTION", FILE_DELETE:"DESTRUCTIVE_ACTION", DEPLOY:"PRODUCTION_CHANGE",
    DATABASE_MIGRATION:"PRODUCTION_CHANGE", BUDGET_CHANGE:"SPEND_LIMIT", SCOPE_CHANGE:"SCOPE_CHANGE",
    ARCHITECTURE_CHANGE:"ARCHITECTURE_CHANGE", SECURITY_CHANGE:"SECURITY_SENSITIVE",
  };
  server.tool("guard.action.authorize",
    "Preflight authorization contract for an Agent tool adapter. Non-protected actions pass; protected actions require an unexpired approval bound to the same project, action class, and exact scope fingerprint. The adapter must stop dispatch when allowed is false.",
    { projectId:z.string().min(1), action:actionPolicy, scopeFingerprint:z.string().min(8).max(256), approvalId:z.string().uuid().optional() },
    async ({projectId,action,scopeFingerprint,approvalId}) => {
      const required=requiredApproval[action];
      if(!required) return {content:[{type:"text",text:JSON.stringify({allowed:true,reason:"NO_APPROVAL_REQUIRED",action,projectId,scopeFingerprint})}]};
      if(!approvalId) return {content:[{type:"text",text:JSON.stringify({allowed:false,reason:"APPROVAL_REQUIRED",requiredApproval:required})}]};
      const record=await get(approvalId);
      if(!record) return {content:[{type:"text",text:JSON.stringify({allowed:false,reason:"APPROVAL_NOT_FOUND",requiredApproval:required})}]};
      if(record.status==="PENDING" && Date.now()>=Date.parse(record.expiresAt)) {
        if(pool) await pool.query("UPDATE cg_approval_requests SET status='EXPIRED' WHERE approval_id=$1 AND status='PENDING'",[approvalId]);
        else record.status="EXPIRED";
        record.status="EXPIRED";
      }
      const allowed=record.status==="APPROVED" && record.projectId===projectId &&
        record.action===required && record.scopeFingerprint===scopeFingerprint;
      const reason=allowed?"APPROVED":record.status!=="APPROVED"?record.status:
        record.projectId!==projectId?"PROJECT_MISMATCH":
        record.action!==required?"ACTION_MISMATCH":"SCOPE_MISMATCH";
      return {content:[{type:"text",text:JSON.stringify({allowed,reason,requiredApproval:required,approvalId})}]};
    });

}
