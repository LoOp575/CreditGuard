import type { ClarificationItem, PreparedPrompt, PreparedTask, PromptPreparationInput, SemanticInterpretation, TaskCategory } from "./types.js";
import { detectLanguage } from "./language.js";

function unique(values: string[]): string[] {
  return [...new Set(values.map(value => value.trim()).filter(Boolean))];
}

function extractExplicitConstraints(prompt: string): string[] {
  return prompt.split(/(?<=[.!?])\s+|\n+/)
    .map(part => part.trim())
    .filter(part => /^(jangan|jgn|tidak boleh|nggak boleh|gak boleh|tanpa|do not|don't|must not|keep|preserve|maintain)\b/i.test(part));
}

function classifyCodingTask(prompt: string): "build" | "debug" | "modify" | "optimize" | "analyze" | "integrate" | "other" {
  const value = prompt.toLowerCase();
  if (/\b(debug|bug|error|fix|perbaiki|perbaikan|gagal|crash|errornya)\b/.test(value)) return "debug";
  if (/\b(optimasi|optimalkan|optimize|optimization|lebih cepat|lebih ringan|refactor|rapikan kode)\b/.test(value)) return "optimize";
  if (/\b(integrasi|integrasikan|integrate|integration|hubungkan|connect|webhook|api pihak ketiga)\b/.test(value)) return "integrate";
  if (/\b(analisis|analisa|audit|review|inspect|investigasi|jelaskan kode)\b/.test(value)) return "analyze";
  if (/\b(ubah|tambahkan|tambah|modifikasi|update|perbarui|ubah fitur|modify|extend)\b/.test(value)) return "modify";
  if (/\b(buat|bangun|build|develop|create|kembangkan|bikin|implementasikan)\b/.test(value)) return "build";
  return "other";
}

function inferTarget(prompt: string): string {
  const value = prompt.toLowerCase();
  const targets: string[] = [];
  const rules: Array<[RegExp, string]> = [
    [/\b(website|web app|situs|frontend|front-end)\b/, "web application"],
    [/\b(api|backend|back-end|server)\b/, "API / backend service"],
    [/\b(database|basis data|postgres|mysql|mongodb|sqlite)\b/, "database"],
    [/\b(bot|telegram bot|discord bot)\b/, "automation bot"],
    [/\b(tool|utility|cli|command line)\b/, "developer tool"],
    [/\b(aplikasi|app|mobile|android|ios)\b/, "application"],
    [/\b(library|package|sdk|module)\b/, "software library / module"],
    [/\b(script|otomasi|automation)\b/, "script / automation"],
    [/\b(test|testing|unit test|integration test)\b/, "test suite"],
    [/\b(config|konfigurasi|deployment|deploy|ci\/cd)\b/, "configuration / deployment"],
    [/\b(komponen|component|ui|ux)\b/, "software component / UI"],
  ];
  for (const [pattern, target] of rules) if (pattern.test(value)) targets.push(target);
  return [...new Set(targets)].join(", ") || "existing or requested software component (inspect context)";
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
  const stackMentionedInPrompt = /\b(next\.?js|react|vue|angular|svelte|node(?:\.js)?|express|fastify|nestjs|django|flask|laravel|rails|spring|\.net|postgres(?:ql)?|mysql|mongodb)\b/i.test(promptForQuestions);
  if (!techStack.length && !stackMentionedInPrompt && category === "software_project") {
    questions.push({ key: "tech_stack", question: "Apakah ada framework atau bahasa pemrograman yang wajib digunakan?", importance: "useful" });
  }
  if (category === "software_project" && /payment|pembayaran|checkout|transaksi/i.test(promptForQuestions)) {
    questions.push({ key: "payment_provider", question: "Payment gateway atau penyedia pembayaran apa yang akan digunakan?", importance: "critical" });
  }
  return questions;
}

type SemanticRule = { pattern: RegExp; userPhrase: string; interpretation: string; category: "design" | "usability" | "performance" | "security"; requiresDesignContext?: boolean };

const SEMANTIC_RULES: SemanticRule[] = [
  { pattern: /\bbagus\b|\bindah\b|\bkeren\b/i, userPhrase: "Bagus / indah / keren", interpretation: "High-quality visual design", category: "design", requiresDesignContext: true },
  { pattern: /\bmodern\b/i, userPhrase: "Modern", interpretation: "Modern UI design", category: "design", requiresDesignContext: true },
  { pattern: /sederhana|tidak ramai|minimalis|tidak ribet|simple|minimalista|minimaliste|einfach/i, userPhrase: "Simple / uncluttered", interpretation: "Simple, uncluttered UI with clear information hierarchy", category: "design", requiresDesignContext: true },
  { pattern: /enak dipandang|nyaman dilihat|tidak menyakitkan mata|fácil de ver|agradável de usar|agréable à regarder|easy on the eyes/i, userPhrase: "Pleasant to look at", interpretation: "Clear visual hierarchy, balanced spacing, and consistent visual styling", category: "design", requiresDesignContext: true },
  { pattern: /tidak kaku|nggak kaku|gak kaku|lebih hidup|not rigid|natural interactions|dinâmico|dynamique/i, userPhrase: "Not rigid / dynamic", interpretation: "Dynamic layout and natural interactions", category: "usability", requiresDesignContext: true },
  { pattern: /nyaman dibuka di (hp|ponsel|mobile)|mudah digunakan di (hp|ponsel)|mobile[- ]friendly|fácil de usar en (el )?móvil|facile à utiliser sur mobile/i, userPhrase: "Comfortable on mobile", interpretation: "Mobile-friendly user experience", category: "usability" },
  { pattern: /menyesuaikan (ukuran )?layar|semua ukuran layar|berbagai ukuran layar|responsive|responsivo|adaptable to screen sizes|s\\\x27adapte à toutes les tailles/i, userPhrase: "Adapts to screen sizes", interpretation: "Responsive design", category: "design" },
  { pattern: /\bresponsive\b|\bresponsif\b/i, userPhrase: "Responsive", interpretation: "Responsive design", category: "design" },
  { pattern: /tidak lemot|jangan lemot|cepat dibuka|loading cepat|performa cepat/i, userPhrase: "Tidak lemot / cepat", interpretation: "Web performance optimization", category: "performance" },
  { pattern: /aman|keamanan kuat|tidak mudah dibobol/i, userPhrase: "Aman / keamanan kuat", interpretation: "Apply appropriate application security controls", category: "security" },
];

function inferObjective(prompt: string, category: TaskCategory): string {
  const value = prompt.toLowerCase();
  if (/website|web\s*app|situs/.test(value) && /toko online|e-?commerce|jualan online|belanja online/.test(value)) return "Website toko online";
  if (/website|web\s*app|situs/.test(value)) return "Website";
  if (/aplikasi|mobile app/.test(value)) return "Aplikasi";
  if (/\bapi\b|backend|layanan server/.test(value)) return "API / backend service";
  if (category === "software_project") return "Software project";
  return category === "general" ? "User's stated task" : category.replace("_", " ");
}

function interpretSemantics(prompt: string): SemanticInterpretation[] {
  const hasDesignContext = /website|web|aplikasi|app|ui|ux|desain|design|tampilan|halaman/i.test(prompt);
  return SEMANTIC_RULES.filter(rule => rule.pattern.test(prompt) && (!rule.requiresDesignContext || hasDesignContext))
    .map(({ userPhrase, interpretation, category }) => ({ userPhrase, interpretation, category }));
}

function buildOptimizedPrompt(objective: string, prompt: string, interpretations: SemanticInterpretation[], explicitConstraints: string[]): { prompt: string; requiresReview: boolean } {
  const value = prompt.toLowerCase();
  const requirements: string[] = [];
  const add = (condition: boolean, text: string) => { if (condition) requirements.push(text); };
  add(/katalog|daftar produk|produk-produk|lihat produk/.test(value), "Product catalog");
  add(/keranjang|cart/.test(value), "Shopping cart");
  add(/checkout|pembayaran|bayar/.test(value), "Checkout");
  add(/qris/.test(value), "QRIS payment");
  add(/transfer bank|transfer/.test(value), "Bank transfer");
  add(/dashboard admin|halaman admin|admin/.test(value), "Admin dashboard");
  add(/stok|persediaan/.test(value), "Stock management");
  add(/pesanan|order/.test(value), "Order management");
  add(/harga/.test(value), "Price management");
  add(/produk/.test(value) && /admin|kelola|mengatur/.test(value), "Product management");
  add(/pembayaran|payment|transaksi/.test(value) && /admin|kelola|mengatur|monitor|pantau/.test(value), "Payment management");
  requirements.push(...interpretations.map(item => item.interpretation));
  requirements.push(...explicitConstraints);
  const uniqueRequirements = [...new Set(requirements)];
  const output = [
    "Objective: " + objective + ".",
    ...(uniqueRequirements.length ? ["Requirements: " + uniqueRequirements.join("; ") + "."] : []),
  ].join("\n");
  // This first deterministic release only compresses facts covered by explicit rules.
  // Unrecognized or ambiguous requests must retain the original prompt for semantic review.
  const hasRecognizedIntent = objective !== "User's stated task" && (uniqueRequirements.length > 0 || objective !== "Software project");
  return { prompt: output, requiresReview: !hasRecognizedIntent };
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
  const language = detectLanguage(originalPrompt);
  if (!originalPrompt) throw new TypeError("rawPrompt must not be empty");
  if (originalPrompt.length > 20_000) throw new RangeError("rawPrompt exceeds the 20000 character limit");

  const category = classify(originalPrompt);
  const taskType = classifyCodingTask(originalPrompt);
  const target = inferTarget(originalPrompt);
  const projectMode = input.projectMode ?? "unknown";
  const techStack = unique(input.techStack ?? []);
  const explicitConstraints = unique([...(input.constraints ?? []), ...extractExplicitConstraints(originalPrompt)]);
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

  const objective = inferObjective(originalPrompt, category);
  const semanticInterpretations = interpretSemantics(originalPrompt);
  const optimized = buildOptimizedPrompt(objective, originalPrompt, semanticInterpretations, explicitConstraints);

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

  const intent = {
    taskType,
    target,
    objective,
    requirements: [...new Set([...suggestedRequirements, ...optimized.prompt.split("\n").slice(1).flatMap(line => line.startsWith("Requirements: ") ? line.slice(14).split("; ") : [])])],
    constraints: explicitConstraints,
    context: [...techStack, ...(projectMode === "unknown" ? [] : [`project_mode:${projectMode}`])],
    expectedOutput: taskType === "debug" ? ["Root cause", "Minimal fix", "Regression test or reproducible verification"] : taskType === "analyze" ? ["Findings", "Evidence", "Prioritized recommendations"] : ["Requested software change or deliverable"],
    verification: taskType === "debug" || taskType === "modify" || taskType === "optimize" ? ["Run relevant tests", "Check for regressions", "Report evidence and limitations"] : ["Validate deliverable against explicit requirements", "Report evidence and limitations"],
  };

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
    `CODING TASK TYPE: ${taskType}`,
    `TARGET: ${target}`,
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

  return { version: "1", language, originalPrompt, normalizedGoal, objective, intent, semanticInterpretations, optimizedPrompt: optimized.prompt, requiresSemanticReview: optimized.requiresReview || !language.supported, category, projectMode, explicitConstraints, unknowns, suggestedRequirements, tasks, executionRules, refinedPrompt };
}
