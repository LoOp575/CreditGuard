export type LoopEventKind = "request" | "error" | "retry" | "progress";
export interface LoopEvent { projectId: string; kind: LoopEventKind; signature?: string; at?: number; }
export interface LoopAssessment { action: "CONTINUE" | "WARN" | "PAUSE"; score: number; repeatedErrors: number; retries: number; requestsWithoutProgress: number; reason: string; }
export interface LoopGuardConfig { windowMs: number; maxRepeatedErrors: number; maxRetries: number; maxRequestsWithoutProgress: number; }
