import type { FailureAnalysis, FailureAnalysisInput, TaskScopeAssessment, TaskScopeInput } from "./types.js";

function normalizeSignature(value: string, field: string): string {
  const normalized = value.trim().toLowerCase().replace(/\s+/g, " ");
  if (!normalized) throw new TypeError(`${field} must not be empty`);
  return normalized;
}

export function analyzeFailure(input: FailureAnalysisInput): FailureAnalysis {
  const error = normalizeSignature(input.errorSignature, "errorSignature");
  const strategy = normalizeSignature(input.strategySignature, "strategySignature");
  const maxSameStrategyFailures = input.maxSameStrategyFailures ?? 2;
  if (!Number.isInteger(maxSameStrategyFailures) || maxSameStrategyFailures < 1) {
    throw new TypeError("maxSameStrategyFailures must be a positive integer");
  }

  const prior = input.previousAttempts.filter(attempt => attempt.outcome !== "succeeded");
  const sameStrategyFailures = prior.filter(attempt =>
    normalizeSignature(attempt.errorSignature, "previous errorSignature") === error &&
    normalizeSignature(attempt.strategySignature, "previous strategySignature") === strategy
  ).length;
  const sameErrorFailures = prior.filter(attempt =>
    normalizeSignature(attempt.errorSignature, "previous errorSignature") === error
  ).length;

  if (sameStrategyFailures >= maxSameStrategyFailures) {
    return { action: "PAUSE", repeatedStrategy: true, sameStrategyFailures, sameErrorFailures, reason: "SAME_ERROR_AND_STRATEGY_REPEATED; checkpoint and request a materially different plan" };
  }
  if (sameStrategyFailures > 0 || sameErrorFailures > 0) {
    return { action: "REPLAN", repeatedStrategy: sameStrategyFailures > 0, sameStrategyFailures, sameErrorFailures, reason: sameStrategyFailures > 0 ? "DO_NOT_REPEAT_THE_PREVIOUS_STRATEGY" : "SAME_ERROR_WITH_DIFFERENT_STRATEGY; inspect root cause and evidence" };
  }
  return { action: "DIAGNOSE", repeatedStrategy: false, sameStrategyFailures: 0, sameErrorFailures: 0, reason: "NEW_FAILURE_SIGNATURE; diagnose before choosing a fix" };
}

export function assessTaskScope(input: TaskScopeInput): TaskScopeAssessment {
  const approved = new Set(input.approvedRequirementIds.map(x => x.trim()).filter(Boolean));
  const requested = [...new Set(input.taskRequirementIds.map(x => x.trim()).filter(Boolean))];
  if (approved.size === 0) {
    return { action: "REVIEW", inScopeRequirementIds: [], outOfScopeRequirementIds: requested, reason: "NO_APPROVED_REQUIREMENT_BASELINE; scope cannot be verified" };
  }
  const inScopeRequirementIds = requested.filter(id => approved.has(id));
  const outOfScopeRequirementIds = requested.filter(id => !approved.has(id));
  return {
    action: outOfScopeRequirementIds.length ? "REVIEW" : "ALLOW",
    inScopeRequirementIds,
    outOfScopeRequirementIds,
    reason: outOfScopeRequirementIds.length ? "TASK_REFERENCES_UNAPPROVED_REQUIREMENTS; request approval or revise scope" : "ALL_TASK_REQUIREMENTS_MATCH_APPROVED_SCOPE",
  };
}
