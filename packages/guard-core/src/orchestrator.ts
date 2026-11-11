import type { CreditStatus } from "../credit-engine/types.js";
import type { LoopAssessment } from "../loop-guard/types.js";
import type { ProjectState } from "../project-engine/types.js";
import { DecisionEngine } from "../decision-engine/engine.js";
import { preparePrompt } from "./intelligence/prompt.js";
import { assessTaskScope } from "./intelligence/prompt.js";
import { assessQuality } from "./intelligence/quality.js";
import type { QualityCheck } from "./intelligence/types.js";

export interface OrchestratorInput {
  rawPrompt: string;
  projectMode?: "new" | "existing" | "unknown";
  techStack?: string[];
  constraints?: string[];
  credit: CreditStatus;
  projectState: ProjectState;
  progressPercent: number;
  progressTracked?: boolean;
  estimatedCostMicros: number;
  loop: LoopAssessment;
  checkpointAvailable?: boolean;
  approvedRequirementIds: string[];
  taskRequirementIds: string[];
  qualityChecks: QualityCheck[];
}

export type OrchestratorNextAction =
  | "BLOCK"
  | "PAUSE_AND_CHECKPOINT"
  | "OPTIMIZE_COST"
  | "ASK_FOR_CLARIFICATION"
  | "REQUEST_SCOPE_APPROVAL"
  | "EXECUTE_WITH_GUARDRAILS"
  | "VERIFY_BEFORE_COMPLETION";

export interface OrchestratorResult {
  version: "1";
  executionStatus: "BLOCKED" | "PAUSED" | "REVIEW_REQUIRED" | "READY" | "VERIFICATION_REQUIRED";
  nextAction: OrchestratorNextAction;
  prompt: ReturnType<typeof preparePrompt>;
  scope: ReturnType<typeof assessTaskScope>;
  quality: ReturnType<typeof assessQuality>;
  decision: ReturnType<DecisionEngine["decide"]>;
  gates: {
    promptReviewRequired: boolean;
    scopeApprovalRequired: boolean;
    qualityPassed: boolean;
    budgetAllowsEstimate: boolean;
    loopAllowsContinue: boolean;
  };
  warnings: string[];
}

/**
 * Advisory orchestration only. It combines existing policy engines into one
 * explainable result; it does not intercept tools or provider traffic.
 */
export function evaluateExecution(input: OrchestratorInput): OrchestratorResult {
  if (!input.rawPrompt.trim()) throw new TypeError("rawPrompt must not be empty");
  if (!Number.isSafeInteger(input.estimatedCostMicros) || input.estimatedCostMicros < 0) {
    throw new TypeError("estimatedCostMicros must be a non-negative safe integer");
  }
  if (!Number.isFinite(input.progressPercent) || input.progressPercent < 0 || input.progressPercent > 100) {
    throw new TypeError("progressPercent must be between 0 and 100");
  }

  const prompt = preparePrompt({
    rawPrompt: input.rawPrompt,
    projectMode: input.projectMode,
    techStack: input.techStack,
    constraints: input.constraints,
  });
  const scope = assessTaskScope({
    approvedRequirementIds: input.approvedRequirementIds,
    taskRequirementIds: input.taskRequirementIds,
  });
  const quality = assessQuality(input.qualityChecks);
  const decision = new DecisionEngine().decide({
    credit: input.credit,
    projectState: input.projectState,
    progressPercent: input.progressPercent,
    progressTracked: input.progressTracked,
    estimatedCostMicros: input.estimatedCostMicros,
    loop: input.loop,
    checkpointAvailable: input.checkpointAvailable,
  });

  const promptReviewRequired = prompt.requiresSemanticReview;
  const scopeApprovalRequired = scope.action === "REVIEW";
  const budgetAllowsEstimate = input.estimatedCostMicros <= input.credit.availableMicros && !input.credit.overBudget;
  const loopAllowsContinue = input.loop.action === "CONTINUE";
  const qualityPassed = quality.status === "PASS" || quality.status === "PASS_WITH_WARNINGS";
  const warnings: string[] = [];

  if (promptReviewRequired) warnings.push("PROMPT_SEMANTIC_REVIEW_REQUIRED");
  if (scopeApprovalRequired) warnings.push("TASK_OUTSIDE_APPROVED_SCOPE");
  if (!qualityPassed) warnings.push("QUALITY_EVIDENCE_INCOMPLETE");
  if (!budgetAllowsEstimate) warnings.push("ESTIMATED_COST_EXCEEDS_AVAILABLE_BUDGET");
  if (!loopAllowsContinue) warnings.push("LOOP_GUARD_REQUIRES_ATTENTION");

  let executionStatus: OrchestratorResult["executionStatus"];
  let nextAction: OrchestratorNextAction;

  if (decision.action === "BLOCK") {
    executionStatus = "BLOCKED";
    nextAction = "BLOCK";
  } else if (decision.action === "CHECKPOINT_PAUSE" || decision.action === "INTERVENE") {
    executionStatus = "PAUSED";
    nextAction = "PAUSE_AND_CHECKPOINT";
  } else if (decision.action === "OPTIMIZE") {
    executionStatus = "REVIEW_REQUIRED";
    nextAction = "OPTIMIZE_COST";
  } else if (promptReviewRequired) {
    executionStatus = "REVIEW_REQUIRED";
    nextAction = "ASK_FOR_CLARIFICATION";
  } else if (scopeApprovalRequired) {
    executionStatus = "REVIEW_REQUIRED";
    nextAction = "REQUEST_SCOPE_APPROVAL";
  } else if (input.projectState === "VERIFYING" || input.projectState === "COMPLETED") {
    executionStatus = qualityPassed ? "READY" : "VERIFICATION_REQUIRED";
    nextAction = qualityPassed ? "EXECUTE_WITH_GUARDRAILS" : "VERIFY_BEFORE_COMPLETION";
  } else {
    executionStatus = "READY";
    nextAction = "EXECUTE_WITH_GUARDRAILS";
  }

  return {
    version: "1",
    executionStatus,
    nextAction,
    prompt,
    scope,
    quality,
    decision,
    gates: {
      promptReviewRequired,
      scopeApprovalRequired,
      qualityPassed,
      budgetAllowsEstimate,
      loopAllowsContinue,
    },
    warnings,
  };
}
