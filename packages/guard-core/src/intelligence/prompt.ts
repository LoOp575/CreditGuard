import type { ClarificationItem, PreparedPrompt, PreparedTask, PromptPreparationInput, TaskCategory } from "./types.js";

function unique(values: string[]): string[] {
  return [...new Set(values.map(value => value.trim()).filter(Boolean))];
}

function classify(prompt: string): TaskCategory {
  const value = prompt.toLowerCase();
  if (/\b(debug|bug|error|fix|perbaiki|perbaikan|gagal|crash)\b/.test(value)) return "bug_fix";
  if (/\b(research|riset|analisis|analisa|bandingkan|investigasi)\b/.test(value)) return "research";
  if (/\b(tulis|buatkan artikel|draft|email|surat|konten|write)\b/.test(value)) return "writing";
  if (/\b(buat|bangun|build|develop|aplikasi|website|sistem|platform|software|backend|frontend|payment|pembayaran|kasir|bot)\b/.test(value)) return "software_project";
  return "general";
}

function buildQuestions(category: TaskCategory, projectMode: PromptPreparationInput["projectMode"], techStack: string[], promptForQuestions: string): ClarificationItem[] {
  const questions: ClarificationItem[] = [];
  if (projectMode !== "new" && projectMode !== "existing") {
    questions.push({ key: "project_mode", question: "Apakah ini proyek baru atau melanjutkan proyek yang sudah ada?", importance: "critical" });
  }
  if (!techStack.length && category === "software_project") {
    questions.push({ key: "tech_stack", question: "Apakah ada framework atau bahasa pemrograman yang wajib digunakan?", importance: "useful" });
  }
  if (category === "software_project" && /payment|pembayaran|checkout|transaksi/i.test(promptForQuestions)) {
    questions.push({ key: "payment_provider", question: "Payment gateway atau penyedia pembayaran apa yang akan digunakan?", importance: "critical" });
  }
  return questions;
}

function buildTasks(category: TaskCategory): PreparedTask[] {
  if (category === "software_project") {
    return [
      { id: "inspect", title: "Inspect project and clarify scope", objective: "Inspect existing files or confirm a clean project, then resolve critical unknowns.", dependsOn: [], completionEvidence: ["Project inventory", "Approved requirements"] },
      { id: "design", title: "Plan architecture", objective: "Choose a minimal architecture that satisfies approved requirements.", dependsOn: ["inspect"], completionEvidence: ["Architecture decision record", "Task breakdown"] },
      { id: "implement", title: "Implement in small vertical slices", objective: "Build only approved functionality in dependency order and reuse existing components.", dependsOn: ["design"], completionEvidence: ["Changed files", "Implementation notes"] },
      { id: "test", title: "Run targeted tests", objective: "Run relevant automated tests and fix root causes rather than repeating failed edits.", dependsOn: ["implement"], completionEvidence: ["Test output", "Failure and retry history"] },
      { id: "verify", title: "Verify requirements and report", objective: "Map every approved requirement to observable evidence and disclose anything incomplete.", dependsOn: ["test"], completionEvidence: ["Requirement coverage report", "Final status"] },
    ];
  }
  return [
    { id: "understand", title: "Clarify the objective", objective: "Restate the goal, constraints, and success criteria without inventing missing facts.", dependsOn: [], completionEvidence: ["Objective summary", "Open questions"] },
    { id: "execute", title: "Complete the work in bounded steps", objective: "Use the smallest effective workflow and preserve relevant context.", dependsOn: ["understand"], completionEvidence: ["Work product", "Decision notes"] },
    { id: "verify", title: "Check the result", objective: "Validate the output against the stated objective and report limitations.", dependsOn: ["execute"], completionEvidence: ["Verification notes", "Final status"] },
  ];
}

export function preparePrompt(input: PromptPreparationInput): PreparedPrompt {
  const originalPrompt = input.rawPrompt.trim();
  if (!originalPrompt) throw new TypeError("rawPrompt must not be empty");
  if (originalPrompt.length > 20_000) throw new RangeError("rawPrompt exceeds the 20000 character limit");

  const category = classify(originalPrompt);
  const projectMode = input.projectMode ?? "unknown";
  const techStack = unique(input.techStack ?? []);
  const explicitConstraints = unique(input.constraints ?? []);
  const unknowns = buildQuestions(category, projectMode, techStack, originalPrompt);
  const tasks = buildTasks(category);
  const suggestedRequirements = category === "software_project" && /payment|pembayaran|checkout|transaksi/i.test(originalPrompt)
    ? [
        "Suggested only: payment provider integration using the provider's official API.",
        "Suggested only: verified webhook signatures and idempotent payment processing.",
        "Suggested only: transaction state management and audit history.",
        "Suggested only: automated tests for success, failure, duplicate, and delayed payment events.",
      ]
    : [];

  const executionRules = [
    "Preserve the user's original goal; clarify it, do not silently replace it.",
    "Treat suggested requirements as proposals until approved; never present them as user instructions.",
    "Inspect existing project files before creating or replacing files.",
    "Do not recreate completed work; check current artifacts and task history first.",
    "After a failure, record the error and attempted strategy; do not repeat the same strategy without new evidence.",
    "Use the smallest context and least expensive capable model; escalate only when complexity or verified failure justifies it.",
    "Run relevant tests and report evidence. Never claim completion from self-report alone.",
    "If a critical unknown blocks safe implementation, ask the user before making an irreversible decision.",
  ];

  const normalizedGoal = originalPrompt.replace(/\s+/g, " ").trim();
  const techLine = techStack.length ? techStack.join(", ") : "Not specified; do not assume.";
  const constraintLines = explicitConstraints.length ? explicitConstraints.map(x => `- ${x}`).join("\n") : "- No additional constraints supplied.";
  const questionLines = unknowns.length ? unknowns.map(x => `- [${x.importance}] ${x.question}`).join("\n") : "- No blocking questions identified by the deterministic pre-check.";
  const requirementLines = suggestedRequirements.length ? suggestedRequirements.map(x => `- ${x}`).join("\n") : "- Do not add unrequested features.";
  const taskLines = tasks.map((task, index) => `${index + 1}. ${task.title}: ${task.objective}`).join("\n");
  const refinedPrompt = [
    "CREDIT GUARD EXECUTION BRIEF",
    "",
    "ORIGINAL USER REQUEST (authoritative; preserve meaning):",
    originalPrompt,
    "",
    `TASK CATEGORY: ${category}`,
    `PROJECT MODE: ${projectMode}`,
    `TECH STACK: ${techLine}`,
    "",
    "EXPLICIT USER CONSTRAINTS:",
    constraintLines,
    "",
    "OPEN QUESTIONS (do not invent answers):",
    questionLines,
    "",
    "OPTIONAL REQUIREMENT SUGGESTIONS (not approved scope):",
    requirementLines,
    "",
    "PROPOSED WORKFLOW:",
    taskLines,
    "",
    "EXECUTION RULES:",
    ...executionRules.map(rule => `- ${rule}`),
  ].join("\n");

  return { version: "1", originalPrompt, normalizedGoal, category, projectMode, explicitConstraints, unknowns, suggestedRequirements, tasks, executionRules, refinedPrompt };
}
