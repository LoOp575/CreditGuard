export type SupportedLanguage = "id" | "en" | "es" | "pt" | "fr" | "de" | "ja" | "zh" | "unknown";

export interface LanguageDetection {
  code: SupportedLanguage;
  confidence: number;
  method: "script" | "keyword" | "unknown";
  supported: boolean;
}

const KEYWORDS: Record<Exclude<SupportedLanguage, "unknown" | "ja" | "zh">, string[]> = {
  id: ["yang", "untuk", "dengan", "tolong", "buat", "perbaiki", "jangan", "aplikasi", "website", "fitur", "saya", "gua", "ingin"],
  en: ["the", "and", "please", "build", "fix", "create", "make", "don't", "with", "application", "website", "feature", "bug"],
  es: ["el", "la", "para", "con", "por favor", "crear", "construir", "arreglar", "aplicación", "sitio", "error"],
  pt: ["por favor", "para", "com", "criar", "construir", "corrigir", "aplicativo", "site", "erro", "não"],
  fr: ["le", "la", "les", "pour", "avec", "créer", "construire", "corriger", "application", "site", "erreur"],
  de: ["der", "die", "das", "und", "bitte", "erstellen", "bauen", "beheben", "anwendung", "website", "fehler"],
};

export function detectLanguage(input: string): LanguageDetection {
  const text = input.toLowerCase();
  if (/[ぁ-ゟ゠-ヿ]/u.test(input)) return { code: "ja", confidence: 0.99, method: "script", supported: true };
  if (/[\u3400-\u4dbf\u4e00-\u9fff]/u.test(input)) return { code: "zh", confidence: 0.9, method: "script", supported: true };

  const scores = Object.entries(KEYWORDS).map(([code, words]) => ({
    code: code as Exclude<SupportedLanguage, "unknown" | "ja" | "zh">,
    score: words.reduce((sum, word) => sum + (new RegExp(`(^|[^\\p{L}])${word.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}([^\\p{L}]|$)`, "iu").test(text) ? 1 : 0), 0),
  })).sort((a, b) => b.score - a.score);

  const best = scores[0];
  const second = scores[1];
  if (!best || best.score === 0 || best.score === second?.score) {
    return { code: "unknown", confidence: 0, method: "unknown", supported: false };
  }
  const confidence = Math.min(0.95, 0.55 + best.score * 0.08 + (best.score - (second?.score ?? 0)) * 0.05);
  return { code: best.code, confidence, method: "keyword", supported: true };
}
