import type { LoopAssessment } from "../loop-guard/types.js";
import type { CreditStatus } from "../credit-engine/types.js";
import type { ProjectState } from "../project-engine/types.js";
export type GuardAction = "ALLOW" | "OPTIMIZE" | "INTERVENE" | "CHECKPOINT_PAUSE" | "BLOCK";
export interface DecisionInput { credit: CreditStatus; projectState: ProjectState; progressPercent: number; estimatedCostMicros: number; loop: LoopAssessment; checkpointAvailable?: boolean; }
export interface DecisionResult { action: GuardAction; reasons: string[]; estimatedCostMicros: number; availableMicros: number; shouldCheckpoint: boolean; }
