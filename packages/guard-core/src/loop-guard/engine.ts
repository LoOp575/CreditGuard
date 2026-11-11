import type { LoopAssessment, LoopEvent, LoopGuardConfig } from "./types.js";
const defaults: LoopGuardConfig = { windowMs: 10 * 60_000, maxRepeatedErrors: 3, maxRetries: 5, maxRequestsWithoutProgress: 8 };
export class LoopGuard {
  private readonly events = new Map<string, LoopEvent[]>();
  constructor(private readonly config: LoopGuardConfig = defaults) {}
  record(event: LoopEvent): LoopAssessment {
    if (!event.projectId.trim()) throw new TypeError("projectId must not be empty");
    const now = event.at ?? Date.now();
    const list = this.events.get(event.projectId) ?? [];
    list.push({ ...event, at: now });
    const recent = list.filter(x => now - (x.at ?? now) <= this.config.windowMs);
    this.events.set(event.projectId, recent);
    return this.assess(event.projectId, now);
  }
  assess(projectId: string, now = Date.now()): LoopAssessment {
    const events = (this.events.get(projectId) ?? []).filter(x => now - (x.at ?? now) <= this.config.windowMs);
    const errors = events.filter(x => x.kind === "error");
    const retries = events.filter(x => x.kind === "retry").length;
    let requestsWithoutProgress = 0;
    for (let i = events.length - 1; i >= 0; i--) { if (events[i].kind === "progress") break; if (events[i].kind === "request") requestsWithoutProgress++; }
    const lastSig = errors.at(-1)?.signature;
    const repeatedErrors = lastSig ? errors.filter(x => x.signature === lastSig).length : errors.length;
    const reasons: string[] = [];
    if (repeatedErrors >= this.config.maxRepeatedErrors) reasons.push("REPEATED_ERROR");
    if (retries >= this.config.maxRetries) reasons.push("RETRY_LIMIT");
    if (requestsWithoutProgress >= this.config.maxRequestsWithoutProgress) reasons.push("NO_PROGRESS");
    const score = Math.min(100, Math.max(
      repeatedErrors / this.config.maxRepeatedErrors,
      retries / this.config.maxRetries,
      requestsWithoutProgress / this.config.maxRequestsWithoutProgress,
    ) * 100);
    const action = reasons.length ? "PAUSE" : score >= 60 ? "WARN" : "CONTINUE";
    return { action, score: Math.round(score), repeatedErrors, retries, requestsWithoutProgress, reason: reasons.join("|") || (action === "WARN" ? "LOOP_RISK" : "HEALTHY") };
  }
  clear(projectId: string): void { this.events.delete(projectId); }
}
