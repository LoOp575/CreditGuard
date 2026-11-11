import test from "node:test";
import assert from "node:assert/strict";
import { analyzeFailure, assessQuality, assessTaskScope, preparePrompt } from "./index.js";

test("preparePrompt preserves original request and marks inferred payment requirements as suggestions", () => {
  const result = preparePrompt({ rawPrompt: "Buatkan sistem pembayaran online lengkap", projectMode: "new" });
  assert.equal(result.originalPrompt, "Buatkan sistem pembayaran online lengkap");
  assert.equal(result.category, "software_project");
  assert.ok(result.suggestedRequirements.every(item => item.startsWith("Suggested only:")));
  assert.ok(result.refinedPrompt.includes("ORIGINAL USER REQUEST"));
  assert.ok(result.unknowns.some(item => item.key === "payment_provider"));
});

test("preparePrompt rejects empty prompts", () => {
  assert.throws(() => preparePrompt({ rawPrompt: "  " }), /must not be empty/);
});

test("failure analysis recommends a new strategy after a repeated error/strategy pair", () => {
  const result = analyzeFailure({
    errorSignature: "WEBHOOK_SIGNATURE_INVALID",
    strategySignature: "parse-json-before-signature",
    previousAttempts: [{ errorSignature: "webhook_signature_invalid", strategySignature: "parse-json-before-signature" }],
  });
  assert.equal(result.action, "REPLAN");
  assert.equal(result.repeatedStrategy, true);
});

test("failure analysis pauses after configured same-strategy failures", () => {
  const result = analyzeFailure({
    errorSignature: "TEST_FAILED",
    strategySignature: "same-fix",
    previousAttempts: [
      { errorSignature: "test_failed", strategySignature: "same-fix" },
      { errorSignature: "test_failed", strategySignature: "same-fix" },
    ],
  });
  assert.equal(result.action, "PAUSE");
});

test("successful previous attempts do not count as repeated failures", () => {
  const result = analyzeFailure({
    errorSignature: "TEST_FAILED",
    strategySignature: "same-fix",
    previousAttempts: [{ errorSignature: "test_failed", strategySignature: "same-fix", outcome: "succeeded" }],
  });
  assert.equal(result.action, "DIAGNOSE");
});

test("task scope review identifies requirements not in approved scope", () => {
  const result = assessTaskScope({ approvedRequirementIds: ["auth", "checkout"], taskRequirementIds: ["checkout", "membership"] });
  assert.equal(result.action, "REVIEW");
  assert.deepEqual(result.outOfScopeRequirementIds, ["membership"]);
});

test("quality assessment requires evidence for required checks", () => {
  const result = assessQuality([{ id: "webhook-test", description: "Webhook signature test", required: true, passed: true }]);
  assert.equal(result.status, "INCOMPLETE");
  assert.deepEqual(result.missingEvidence, ["webhook-test"]);
});

test("quality assessment passes when all checks pass with evidence", () => {
  const result = assessQuality([
    { id: "api-test", description: "API tests", required: true, passed: true, evidenceRef: "ci://run/123" },
    { id: "docs", description: "Documentation", required: false, passed: true, evidenceRef: "file://README.md" },
  ]);
  assert.equal(result.status, "PASS");
  assert.equal(result.score, 100);
});

test("general software prompts do not receive payment-specific questions", () => {
  const result = preparePrompt({ rawPrompt: "Buatkan aplikasi catatan sederhana", projectMode: "new" });
  assert.ok(!result.unknowns.some(item => item.key === "payment_provider"));
});

test("an explicit framework in the prompt avoids a redundant stack question", () => {
  const result = preparePrompt({ rawPrompt: "Buatkan website menggunakan Next.js", projectMode: "new" });
  assert.ok(!result.unknowns.some(item => item.key === "tech_stack"));
});


test("prompt preparation maps natural Indonesian design language into concise technical requirements", () => {
  const result = preparePrompt({
    rawPrompt: "Buat website toko online yang bagus, modern, enak dipandang, tidak kaku, nyaman dibuka di HP, dan menyesuaikan layar. Ada katalog produk, keranjang, checkout, QRIS, transfer bank, dashboard admin untuk produk, harga, stok, dan pesanan.",
    projectMode: "new",
  });
  assert.equal(result.objective, "Website toko online");
  assert.ok(result.semanticInterpretations.some(item => item.userPhrase === "Bagus / indah / keren" && item.interpretation === "High-quality visual design"));
  assert.ok(result.semanticInterpretations.some(item => item.interpretation === "Responsive design"));
  assert.ok(result.optimizedPrompt.includes("Product catalog"));
  assert.ok(result.optimizedPrompt.includes("QRIS payment"));
  assert.ok(result.optimizedPrompt.includes("Mobile-friendly user experience"));
  assert.equal(result.requiresSemanticReview, false);
  assert.ok(result.originalPrompt.includes("tidak kaku"));
});

test("ambiguous or unsupported prompt remains flagged for semantic review", () => {
  const result = preparePrompt({ rawPrompt: "Tolong bikin sesuatu yang bagus dan beda", projectMode: "new" });
  assert.equal(result.requiresSemanticReview, true);
});
test("universal intent schema classifies bug fixing and preserves target and verification", () => {
  const result = preparePrompt({
    rawPrompt: "Tolong perbaiki bug login di aplikasi Android. Tombol login terus loading. Jangan ubah alur autentikasi yang sudah ada.",
    projectMode: "existing",
    techStack: ["Kotlin"],
  });
  assert.equal(result.intent.taskType, "debug");
  assert.match(result.intent.target, /application/);
  assert.ok(result.intent.constraints.some(item => item.includes("Jangan ubah")));
  assert.ok(result.intent.verification.some(item => item.includes("regressions")));
  assert.equal(result.originalPrompt.includes("Tombol login terus loading"), true);
});

test("universal intent schema supports tool creation, optimization, analysis, and integration", () => {
  const build = preparePrompt({ rawPrompt: "Buat tool CLI untuk memantau log server", projectMode: "new" });
  const optimize = preparePrompt({ rawPrompt: "Optimalkan kode parser agar lebih cepat", projectMode: "existing" });
  const analyze = preparePrompt({ rawPrompt: "Audit keamanan API dan jelaskan temuan", projectMode: "existing" });
  const integrate = preparePrompt({ rawPrompt: "Integrasikan webhook Telegram ke backend", projectMode: "existing" });
  assert.equal(build.intent.taskType, "build");
  assert.match(build.intent.target, /developer tool/);
  assert.equal(optimize.intent.taskType, "optimize");
  assert.equal(analyze.intent.taskType, "analyze");
  assert.equal(integrate.intent.taskType, "integrate");
});

test("universal intent schema supports modifying an existing feature", () => {
  const result = preparePrompt({ rawPrompt: "Tambahkan fitur export CSV ke dashboard admin", projectMode: "existing" });
  assert.equal(result.intent.taskType, "modify");
  assert.ok(result.intent.expectedOutput.length > 0);
  assert.ok(result.intent.verification.length > 0);
});
test("language detection identifies Indonesian and English input", () => {
  const indonesian = preparePrompt({ rawPrompt: "Tolong perbaiki bug login yang gagal di aplikasi saya" });
  const english = preparePrompt({ rawPrompt: "Please fix the login bug in my application" });
  assert.equal(indonesian.language.code, "id");
  assert.equal(english.language.code, "en");
});

test("language detection identifies Spanish and Japanese scripts conservatively", () => {
  const spanish = preparePrompt({ rawPrompt: "Por favor crear una aplicación para mi sitio" });
  const japanese = preparePrompt({ rawPrompt: "アプリのバグを修正してください" });
  assert.equal(spanish.language.code, "es");
  assert.equal(japanese.language.code, "ja");
  assert.equal(japanese.requiresSemanticReview, true);
});

test("multilingual task keywords classify common software requests", () => {
  const spanish = preparePrompt({ rawPrompt: "Por favor arreglar el bug de mi aplicación" });
  const french = preparePrompt({ rawPrompt: "Créer une application mobile" });
  assert.equal(spanish.intent.taskType, "debug");
  assert.equal(french.intent.taskType, "build");
});

test("English design language maps to canonical technical requirements", () => {
  const result = preparePrompt({ rawPrompt: "Build a modern website that is mobile-friendly and easy on the eyes", projectMode: "new" });
  assert.equal(result.language.code, "en");
  assert.ok(result.semanticInterpretations.some(item => item.interpretation === "Modern UI design"));
  assert.ok(result.semanticInterpretations.some(item => item.interpretation === "Mobile-friendly user experience"));
});

test("token compression measurement uses the supplied model tokenizer", async () => {
  const { measurePromptCompression } = await import("./tokenizer.js");
  const result = await measurePromptCompression("original prompt", "short prompt", {
    id: "test-model-tokenizer-v1",
    countTokens: (value) => value === "original prompt" ? 100 : 25,
  });
  assert.equal(result.tokenizerId, "test-model-tokenizer-v1");
  assert.equal(result.originalTokens, 100);
  assert.equal(result.optimizedTokens, 25);
  assert.equal(result.savedTokens, 75);
  assert.equal(result.savingsPercent, 75);
});

test("token compression measurement rejects invalid tokenizer counts", async () => {
  const { measurePromptCompression } = await import("./tokenizer.js");
  await assert.rejects(
    () => measurePromptCompression("original", "optimized", { id: "bad", countTokens: () => -1 }),
    /invalid original token count/,
  );
});
