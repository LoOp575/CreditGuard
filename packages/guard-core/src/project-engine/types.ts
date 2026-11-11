export type ProjectState = "CREATED" | "PLANNING" | "EXECUTING" | "VERIFYING" | "COMPLETED" | "PAUSED" | "BLOCKED" | "FAILED";
export interface ProjectEvidence { kind: "artifact" | "test" | "file_change" | "milestone"; reference: string; verified: boolean; recordedAt: string; }
export interface ProjectMilestone { id: string; title: string; required: boolean; completed: boolean; evidence: ProjectEvidence[]; completedAt: string | null; }
export interface GuardProject { id: string; goal: string; state: ProjectState; milestones: ProjectMilestone[]; createdAt: string; updatedAt: string; version: number; }
export interface CreateGuardProjectInput { id: string; goal: string; milestones?: Array<{ id: string; title: string; required?: boolean }>; }
export interface RecordEvidenceInput { projectId: string; milestoneId: string; evidence: Omit<ProjectEvidence, "recordedAt">; }
