// Pure measurement arithmetic: pre-flight context size (counted or estimated), reduction, and cost accounting.
// Kept free of I/O so the formulas are unit-tested exactly.
import { inputCost } from "../model/pricing";

export type ContextSize = { fullTokens: number; compiledTokens: number; tokensAvoided: number; reductionPercent: number };

// tokensAvoided = full - compiled; reductionPercent = tokensAvoided / full * 100 (one decimal place).
export function contextSize(fullTokens: number, compiledTokens: number): ContextSize {
  const tokensAvoided = fullTokens - compiledTokens;
  return { fullTokens, compiledTokens, tokensAvoided, reductionPercent: fullTokens > 0 ? Math.round((tokensAvoided / fullTokens) * 1000) / 10 : 0 };
}

export type Economics = {
  pricingModel: string;
  fullInputCostUsd: number;
  compiledInputCostUsd: number;
  grossInputSavingsUsd: number; // full-context input cost - compiled input cost
  optimizerCostUsd: number; // every internal Consolidate model call
  fallbackWasteCostUsd: number; // generation spend on attempts whose answer was discarded
  netSavingsUsd: number; // gross - optimizer - fallback waste
};

// Returns null when the main model is unpriced (cost claims would be invented).
export function economics(input: {
  model: string | null | undefined;
  fullTokens: number;
  compiledTokens: number;
  optimizerCostUsd: number;
  fallbackWasteCostUsd?: number;
}): Economics | null {
  const full = inputCost(input.model, input.fullTokens);
  const compiled = inputCost(input.model, input.compiledTokens);
  if (full == null || compiled == null || !input.model) return null;
  const gross = full - compiled;
  const waste = input.fallbackWasteCostUsd ?? 0;
  return {
    pricingModel: input.model,
    fullInputCostUsd: full,
    compiledInputCostUsd: compiled,
    grossInputSavingsUsd: gross,
    optimizerCostUsd: input.optimizerCostUsd,
    fallbackWasteCostUsd: waste,
    netSavingsUsd: gross - input.optimizerCostUsd - waste,
  };
}
