import type { QualityAssessment, QualityCheck } from "./types.js";

export function assessQuality(checks: QualityCheck[]): QualityAssessment {
  if (checks.length === 0) {
    return { status: "INCOMPLETE", score: 0, passed: 0, failed: 0, pending: 0, missingEvidence: [], summary: "No verification checks were supplied." };
  }
  const ids = new Set<string>();
  for (const check of checks) {
    if (!check.id.trim()) throw new TypeError("quality check id must not be empty");
    if (ids.has(check.id)) throw new TypeError(`duplicate quality check id: ${check.id}`);
    ids.add(check.id);
  }

  const required = checks.filter(check => check.required);
  const passed = checks.filter(check => check.passed === true).length;
  const failed = checks.filter(check => check.passed === false).length;
  const pending = checks.filter(check => check.passed === null).length;
  const missingEvidence = checks.filter(check => check.passed === true && !check.evidenceRef?.trim()).map(check => check.id);
  const requiredFailed = required.some(check => check.passed === false);
  const requiredPending = required.some(check => check.passed === null);
  const requiredMissingEvidence = required.some(check => check.passed === true && !check.evidenceRef?.trim());
  const score = Math.round((passed / checks.length) * 100);

  if (requiredFailed) {
    return { status: "FAIL", score, passed, failed, pending, missingEvidence, summary: "At least one required verification check failed." };
  }
  if (requiredPending || requiredMissingEvidence) {
    return { status: "INCOMPLETE", score, passed, failed, pending, missingEvidence, summary: "Required checks are pending or lack evidence references." };
  }
  if (failed > 0 || pending > 0 || missingEvidence.length > 0) {
    return { status: "PASS_WITH_WARNINGS", score, passed, failed, pending, missingEvidence, summary: "All required checks passed, but optional checks or evidence remain incomplete." };
  }
  return { status: "PASS", score, passed, failed, pending, missingEvidence, summary: "All supplied checks passed and include evidence references." };
}
