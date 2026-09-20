// Cost-aware fast path: is semantic optimization (an optimized generation + a semantic evaluator call) worth paying for?
// Pure and deterministic; no I/O. The engine feeds it provider-counted sizes, model names and recent evaluator usage.
//
//   expectedGrossInputSavingsUsd = inputCost(full tokens, main model) - inputCost(compiled tokens, main model)
//   expectedEvaluationCostUsd    = utility input cost(expected eval input tokens) + utility output cost(expected eval output tokens)
//   optimize only when  expectedGrossInputSavingsUsd >= expectedEvaluationCostUsd * margin
//
// Otherwise the request is sent once with the full context and the semantic evaluator is not called. Deterministic
// checks always run; a structural failure of the compiled context forces the conservative (full-context) path.
import { inputCost, priceFor, type ModelPrice } from "../model/pricing";
import type { EconomicDecision, EconomicsDecision, CountSource } from "../types";

// Multiplier on the expected validation cost. 1.5 by default because the expected cost is an average (real evaluator calls
// scale with context size, roughly +/-30%), and an optimized attempt also carries some chance of a fallback whose discarded
// generation costs far more than an evaluation. Override with CONSOLIDATE_ECONOMICS_MARGIN (0 disables the bypass: any smaller compiled context is optimized).
export const DEFAULT_ECONOMICS_MARGIN = 1.5;
export const ECONOMICS_MARGIN_ENV = "CONSOLIDATE_ECONOMICS_MARGIN";

// Used until enough evaluation calls are persisted. Measured average of 18 real evaluator calls: ~1,450 input / ~185 output tokens.
export const DEFAULT_EVAL_INPUT_TOKENS = 1500;
export const DEFAULT_EVAL_OUTPUT_TOKENS = 200;
// A history average needs this many successful evaluation calls; the most recent HISTORY_WINDOW are used.
export const MIN_HISTORY_SAMPLES = 3;
export const HISTORY_WINDOW = 20;

export function economicsMargin(env: Record<string, string | undefined> = process.env): number {
  const raw = env[ECONOMICS_MARGIN_ENV]?.trim();
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_ECONOMICS_MARGIN;
}

export type EvalUsageSample = { inputTokens: number; outputTokens: number };
export type ExpectedEvalUsage = { inputTokens: number; outputTokens: number; source: "history" | "default"; samples: number };

// Mean of recent successful evaluation calls (rounded up), or the documented default when there is not enough history.
export function expectedEvalUsage(history: EvalUsageSample[]): ExpectedEvalUsage {
  const recent = history.slice(0, HISTORY_WINDOW);
  if (recent.length < MIN_HISTORY_SAMPLES) return { inputTokens: DEFAULT_EVAL_INPUT_TOKENS, outputTokens: DEFAULT_EVAL_OUTPUT_TOKENS, source: "default", samples: recent.length };
  const mean = (f: (s: EvalUsageSample) => number) => Math.ceil(recent.reduce((t, s) => t + f(s), 0) / recent.length);
  return { inputTokens: mean((s) => s.inputTokens), outputTokens: mean((s) => s.outputTokens), source: "history", samples: recent.length };
}

// Expected cost of one semantic validation on the utility model; null when the utility model is unpriced.
export function expectedEvaluationCostUsd(utilityModel: string | null | undefined, usage: ExpectedEvalUsage, table?: Record<string, ModelPrice>): number | null {
  const p = priceFor(utilityModel, table);
  return p ? (usage.inputTokens * p.input + usage.outputTokens * p.output) / 1_000_000 : null;
}

export type EconomicsInput = {
  source: CountSource; // provider_count when both sizes were counted by the provider, else local_estimate
  fullTokens: number;
  compiledTokens: number;
  mainModel: string | null | undefined;
  utilityModel: string | null | undefined;
  expectedEval: ExpectedEvalUsage;
  margin: number;
  structuralFailure?: string | null; // first failed deterministic compile-time check, if any
  forceOptimized?: string | null; // developer failure injection: exercise the normal path
  pricing?: Record<string, ModelPrice>;
};

const usdPlain = (n: number) => `$${n.toFixed(4)}`;

export function decideEconomics(i: EconomicsInput): EconomicsDecision {
  const tokensAvoided = i.fullTokens - i.compiledTokens;
  const full = inputCost(i.mainModel, i.fullTokens, i.pricing);
  const compiled = inputCost(i.mainModel, i.compiledTokens, i.pricing);
  const gross = full != null && compiled != null ? full - compiled : null;
  const evalCost = expectedEvaluationCostUsd(i.utilityModel, i.expectedEval, i.pricing);
  const base = {
    source: i.source,
    margin: i.margin,
    fullTokens: i.fullTokens,
    wouldBeCompiledTokens: i.compiledTokens,
    tokensAvoided,
    expectedGrossInputSavingsUsd: gross,
    expectedEvaluationCostUsd: evalCost,
    thresholdUsd: evalCost != null ? evalCost * i.margin : null,
    evalUsageSource: i.expectedEval.source,
    expectedEvalInputTokens: i.expectedEval.inputTokens,
    expectedEvalOutputTokens: i.expectedEval.outputTokens,
  };
  const out = (decision: EconomicDecision, reason: string): EconomicsDecision => ({ decision, reason, ...base });

  if (i.structuralFailure) return out("safety_full_context", `Compiled context failed a structural check (${i.structuralFailure}); the conservative full context was used regardless of economics.`);
  if (i.forceOptimized) return out("optimized", i.forceOptimized);
  if (tokensAvoided <= 0) return out("equivalent_context", "No economic benefit from semantic optimization: the compiled context is not smaller than the full context.");
  if (gross == null || evalCost == null) return out("optimized", "Economics not applied: the main or utility model is not in the pricing table, so the break-even cannot be calculated.");
  if (gross < evalCost * i.margin) {
    return out(
      "bypass_full_context",
      `The estimated savings (${usdPlain(gross)}) were smaller than the expected cost of validating the optimized context (${usdPlain(evalCost)} x ${i.margin} safety margin = ${usdPlain(evalCost * i.margin)}).`,
    );
  }
  return out("optimized", `The estimated savings (${usdPlain(gross)}) exceed the expected validation cost (${usdPlain(evalCost)} x ${i.margin} = ${usdPlain(evalCost * i.margin)}).`);
}

// Smallest number of tokens a request must avoid for optimization to be worth validating, on the main model's input price.
export function breakEvenTokens(mainModel: string | null | undefined, evalCostUsd: number | null, margin: number, table?: Record<string, ModelPrice>): number | null {
  const p = priceFor(mainModel, table);
  return p && evalCostUsd != null ? Math.ceil((evalCostUsd * margin * 1_000_000) / p.input) : null;
}
