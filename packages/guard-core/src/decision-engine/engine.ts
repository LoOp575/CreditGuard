import type { DecisionInput, DecisionResult } from "./types.js";
export class DecisionEngine {
  decide(input: DecisionInput): DecisionResult {
    const reasons: string[] = [];
    if (input.projectState === "COMPLETED" || input.projectState === "FAILED") {
      return { action: "BLOCK", reasons: ["PROJECT_TERMINAL_STATE"], estimatedCostMicros: input.estimatedCostMicros, availableMicros: input.credit.availableMicros, shouldCheckpoint: false };
    }
    if (input.loop.action === "PAUSE") {
      return { action: "CHECKPOINT_PAUSE", reasons: [input.loop.reason], estimatedCostMicros: input.estimatedCostMicros, availableMicros: input.credit.availableMicros, shouldCheckpoint: input.checkpointAvailable ?? true };
    }
    if (input.credit.overBudget) {
      return { action: "BLOCK", reasons: ["PROJECT_OVER_BUDGET"], estimatedCostMicros: input.estimatedCostMicros, availableMicros: input.credit.availableMicros, shouldCheckpoint: input.checkpointAvailable ?? true };
    }
    if (input.estimatedCostMicros > input.credit.availableMicros) {
      return { action: "OPTIMIZE", reasons: ["INSUFFICIENT_CREDIT_TRY_LOWER_COST"], estimatedCostMicros: input.estimatedCostMicros, availableMicros: input.credit.availableMicros, shouldCheckpoint: true };
    }
    if (input.projectState === "BLOCKED" || input.projectState === "PAUSED") reasons.push("PROJECT_REQUIRES_INTERVENTION");
    if (input.loop.action === "WARN") reasons.push(input.loop.reason);
    if (input.progressTracked !== false && input.progressPercent < 10 && input.credit.spentMicros > 0) reasons.push("LOW_PROGRESS_RELATIVE_TO_SPEND");
    if (reasons.length) return { action: "INTERVENE", reasons, estimatedCostMicros: input.estimatedCostMicros, availableMicros: input.credit.availableMicros, shouldCheckpoint: input.checkpointAvailable ?? true };
    if (input.credit.availableMicros - input.estimatedCostMicros < input.credit.budgetMicros * 0.1) {
      return { action: "OPTIMIZE", reasons: ["LOW_REMAINING_BUDGET"], estimatedCostMicros: input.estimatedCostMicros, availableMicros: input.credit.availableMicros, shouldCheckpoint: true };
    }
    return { action: "ALLOW", reasons: ["WITHIN_POLICY"], estimatedCostMicros: input.estimatedCostMicros, availableMicros: input.credit.availableMicros, shouldCheckpoint: false };
  }
}
