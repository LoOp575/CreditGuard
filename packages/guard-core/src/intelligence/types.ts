import type { LanguageDetection } from "./language.js";

export type TaskCategory = "software_project" | "bug_fix" | "research" | "writing" | "general";

export interface PromptPreparationInput {
  rawPrompt: string;
  projectMode?: "new" | "existing" | "unknown";
  techStack?: string[];
  constraints?: string[];
}

export interface ClarificationItem {
  key: string;
  question: string;
  importance: "critical" | "useful";
}

export interface PreparedTask {
  id: string;
  title: string;
  objective: string;
  dependsOn: string[];
  completionEvidence: string[];
}

export interface SemanticInterpretation {
  userPhrase: string;
  interpretation: string;
  category: "design" | "usability" | "performance" | "security";
}

export type CodingTaskType = "build" | "debug" | "modify" | "optimize" | "analyze" | "integrate" | "other";

export interface UniversalIntent {
  taskType: CodingTaskType;
  target: string;
  objective: string;
  requirements: string[];
  constraints: string[];
  context: string[];
  expectedOutput: string[];
  verification: string[];
}

export interface PreparedPrompt {
  version: "1";
  language: LanguageDetection;
  originalPrompt: string;
  normalizedGoal: string;
  objective: string;
  intent: UniversalIntent;
  semanticInterpretations: SemanticInterpretation[];
  optimizedPrompt: string;
  requiresSemanticReview: boolean;
  category: TaskCategory;
  projectMode: "new" | "existing" | "unknown";
  explicitConstraints: string[];
  unknowns: ClarificationItem[];
  suggestedRequirements: string[];
  tasks: PreparedTask[];
  executionRules: string[];
  refinedPrompt: string;
}

export interface FailureAttempt {
  errorSignature: string;
  strategySignature: string;
  outcome?: "failed" | "succeeded";
}

export interface FailureAnalysisInput {
  errorSignature: string;
  strategySignature: string;
  previousAttempts: FailureAttempt[];
  maxSameStrategyFailures?: number;
}

export interface FailureAnalysis {
  action: "DIAGNOSE" | "REPLAN" | "PAUSE";
  repeatedStrategy: boolean;
  sameStrategyFailures: number;
  sameErrorFailures: number;
  reason: string;
}

export interface TaskScopeInput {
  approvedRequirementIds: string[];
  taskRequirementIds: string[];
}

export interface TaskScopeAssessment {
  action: "ALLOW" | "REVIEW";
  inScopeRequirementIds: string[];
  outOfScopeRequirementIds: string[];
  reason: string;
}

export interface QualityCheck {
  id: string;
  description: string;
  required: boolean;
  passed: boolean | null;
  evidenceRef?: string;
}

export interface QualityAssessment {
  status: "PASS" | "PASS_WITH_WARNINGS" | "INCOMPLETE" | "FAIL";
  score: number;
  passed: number;
  failed: number;
  pending: number;
  missingEvidence: string[];
  summary: string;
}
