import type { CreateGuardProjectInput, GuardProject, ProjectEvidence, ProjectState, RecordEvidenceInput } from "./types.js";
const transitions: Record<ProjectState, ProjectState[]> = {
  CREATED: ["PLANNING", "PAUSED", "FAILED"],
  PLANNING: ["EXECUTING", "PAUSED", "BLOCKED", "FAILED"],
  EXECUTING: ["VERIFYING", "PAUSED", "BLOCKED", "FAILED"],
  VERIFYING: ["EXECUTING", "COMPLETED", "PAUSED", "BLOCKED", "FAILED"],
  COMPLETED: [], PAUSED: ["PLANNING", "EXECUTING", "VERIFYING", "BLOCKED", "FAILED"],
  BLOCKED: ["PLANNING", "EXECUTING", "PAUSED", "FAILED"], FAILED: [],
};
function nonempty(v: string, name: string): void { if (!v.trim()) throw new TypeError(name + " must not be empty"); }
export class ProjectEngine {
  private readonly projects = new Map<string, GuardProject>();
  create(input: CreateGuardProjectInput): GuardProject {
    nonempty(input.id, "id"); nonempty(input.goal, "goal");
    if (this.projects.has(input.id)) throw new Error("PROJECT_ALREADY_EXISTS");
    const ids = new Set<string>();
    const milestones = (input.milestones ?? []).map(m => {
      nonempty(m.id, "milestone id"); nonempty(m.title, "milestone title");
      if (ids.has(m.id)) throw new Error("DUPLICATE_MILESTONE_ID");
      ids.add(m.id);
      return { id: m.id, title: m.title, required: m.required ?? true, completed: false, evidence: [], completedAt: null };
    });
    const now = new Date().toISOString();
    const p: GuardProject = { id: input.id, goal: input.goal, state: "CREATED", milestones, createdAt: now, updatedAt: now, version: 1 };
    this.projects.set(p.id, p); return structuredClone(p);
  }
  get(projectId: string): GuardProject {
    const p = this.projects.get(projectId); if (!p) throw new Error("PROJECT_NOT_FOUND"); return structuredClone(p);
  }
  transition(projectId: string, next: ProjectState): GuardProject {
    const p = this.require(projectId);
    if (!transitions[p.state].includes(next)) throw new Error("INVALID_PROJECT_TRANSITION:" + p.state + "->" + next);
    if (next === "COMPLETED" && p.milestones.some(m => m.required && !m.completed)) throw new Error("REQUIRED_MILESTONES_INCOMPLETE");
    p.state = next; p.version++; p.updatedAt = new Date().toISOString(); return structuredClone(p);
  }
  recordEvidence(input: RecordEvidenceInput): GuardProject {
    const p = this.require(input.projectId);
    const m = p.milestones.find(x => x.id === input.milestoneId); if (!m) throw new Error("MILESTONE_NOT_FOUND");
    nonempty(input.evidence.reference, "evidence reference");
    const e: ProjectEvidence = { ...input.evidence, recordedAt: new Date().toISOString() };
    m.evidence.push(e);
    // Evidence is not self-verifying. A milestone completes only after a caller marks
    // evidence verified; adapters must verify artifacts/tests before setting this flag.
    if (e.verified) { m.completed = true; m.completedAt = e.recordedAt; }
    p.version++; p.updatedAt = e.recordedAt; return structuredClone(p);
  }
  verifyEvidence(input: { projectId: string; milestoneId: string; reference: string; verificationSource: string }): GuardProject {
    const p = this.require(input.projectId);
    if (!input.verificationSource.trim()) throw new TypeError("verificationSource is required");
    const m = p.milestones.find(x => x.id === input.milestoneId);
    if (!m) throw new Error("MILESTONE_NOT_FOUND");
    const e = [...m.evidence].reverse().find(x => x.reference === input.reference);
    if (!e) throw new Error("EVIDENCE_NOT_FOUND");
    e.verified = true;
    m.completed = true;
    m.completedAt = new Date().toISOString();
    p.version++;
    p.updatedAt = m.completedAt;
    return structuredClone(p);
  }
  progress(projectId: string): { completed: number; total: number; percent: number; requiredComplete: boolean } {
    const p = this.require(projectId); const total = p.milestones.length;
    const completed = p.milestones.filter(m => m.completed).length;
    return { completed, total, percent: total ? Math.round(completed / total * 100) : 0,
      requiredComplete: p.milestones.every(m => !m.required || m.completed) };
  }
  private require(id: string): GuardProject { const p = this.projects.get(id); if (!p) throw new Error("PROJECT_NOT_FOUND"); return p; }
}
