import type { DecisionInput, DecisionResult, DecisionPolicyConfig } from "./types.js";
export class DecisionEngine {
  private readonly policy: DecisionPolicyConfig;
  constructor(policy: Partial<DecisionPolicyConfig> = {}) {
    this.policy = {
      lowRemainingBudgetPercent: policy.lowRemainingBudgetPercent ?? 10,
      lowProgressPercent: policy.lowProgressPercent ?? 10,
    };
    for (const [key,value] of Object.entries(this.policy)) {
      if (!Number.isFinite(value) || value < 0 || value > 100) throw new TypeError(key + " must be between 0 and 100");
    }
  }
  decide(input: DecisionInput): DecisionResult {
    const base = { estimatedCostMicros: input.estimatedCostMicros, availableMicros: input.credit.availableMicros };
    if (input.projectState === "COMPLETED" || input.projectState === "FAILED") {
      return { ...base, action: "BLOCK", reasons: ["PROJECT_TERMINAL_STATE"], shouldCheckpoint: false };
    }
    if (input.loop.action === "PAUSE") {
      return { ...base, action: "CHECKPOINT_PAUSE", reasons: [input.loop.reason], shouldCheckpoint: input.checkpointAvailable ?? true };
    }
    if (input.credit.overBudget) {
      return { ...base, action: "BLOCK", reasons: ["PROJECT_OVER_BUDGET"], shouldCheckpoint: input.checkpointAvailable ?? true };
    }
    const interventionReasons: string[] = [];
    if (input.projectState === "BLOCKED" || input.projectState === "PAUSED") interventionReasons.push("PROJECT_REQUIRES_INTERVENTION");
    if (input.loop.action === "WARN") interventionReasons.push(input.loop.reason);
    if (input.progressTracked !== false && input.progressPercent < this.policy.lowProgressPercent && input.credit.spentMicros > 0) interventionReasons.push("LOW_PROGRESS_RELATIVE_TO_SPEND");
    if (interventionReasons.length) {
      return { ...base, action: "INTERVENE", reasons: interventionReasons, shouldCheckpoint: input.checkpointAvailable ?? true };
    }
    if (input.estimatedCostMicros > input.credit.availableMicros) {
      return { ...base, action: "OPTIMIZE", reasons: ["INSUFFICIENT_CREDIT_TRY_LOWER_COST"], shouldCheckpoint: true };
    }
    if (input.credit.availableMicros - input.estimatedCostMicros < input.credit.budgetMicros * this.policy.lowRemainingBudgetPercent / 100) {
      return { ...base, action: "OPTIMIZE", reasons: ["LOW_REMAINING_BUDGET"], shouldCheckpoint: true };
    }
    return { ...base, action: "ALLOW", reasons: ["WITHIN_POLICY"], shouldCheckpoint: false };
  }
}
