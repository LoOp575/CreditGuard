export interface TokenizerAdapter {
  /** Stable identifier for the exact destination model/tokenizer, e.g. provider:model:version. */
  id: string;
  /** Count tokens using the destination model's real tokenizer. */
  countTokens(text: string): number | Promise<number>;
}

export interface PromptCompressionMeasurement {
  tokenizerId: string;
  originalTokens: number;
  optimizedTokens: number;
  savedTokens: number;
  savingsPercent: number;
}

/**
 * Measures prompt compression with a caller-supplied, model-specific tokenizer.
 * No generic character/word ratio is used as a substitute for real tokenization.
 */
export async function measurePromptCompression(
  originalPrompt: string,
  optimizedPrompt: string,
  tokenizer: TokenizerAdapter,
): Promise<PromptCompressionMeasurement> {
  if (!tokenizer.id.trim()) throw new TypeError("tokenizer.id must not be empty");
  const [originalTokens, optimizedTokens] = await Promise.all([
    tokenizer.countTokens(originalPrompt),
    tokenizer.countTokens(optimizedPrompt),
  ]);
  if (!Number.isInteger(originalTokens) || originalTokens < 0) {
    throw new RangeError("tokenizer returned an invalid original token count");
  }
  if (!Number.isInteger(optimizedTokens) || optimizedTokens < 0) {
    throw new RangeError("tokenizer returned an invalid optimized token count");
  }
  const savedTokens = originalTokens - optimizedTokens;
  return {
    tokenizerId: tokenizer.id,
    originalTokens,
    optimizedTokens,
    savedTokens,
    savingsPercent: originalTokens === 0 ? 0 : Number(((savedTokens / originalTokens) * 100).toFixed(2)),
  };
}
