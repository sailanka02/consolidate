// Model pricing configuration: the single place per-token prices live. USD per million tokens.
// Source: https://platform.claude.com/docs/en/about-claude/pricing (verified 2026-09-20).
// A model that is not listed here is "unpriced": cost functions return null rather than guessing.

export type ModelPrice = {
  input: number;
  output: number;
  cacheWrite5m: number; // 1.25x input
  cacheWrite1h: number; // 2x input
  cacheRead: number; // 0.1x input
};

export const PRICING: Record<string, ModelPrice> = {
  "claude-sonnet-5": { input: 2, output: 10, cacheWrite5m: 2.5, cacheWrite1h: 4, cacheRead: 0.2 },
  "claude-haiku-4-5": { input: 1, output: 5, cacheWrite5m: 1.25, cacheWrite1h: 2, cacheRead: 0.1 },
  "claude-sonnet-4-6": { input: 3, output: 15, cacheWrite5m: 3.75, cacheWrite1h: 6, cacheRead: 0.3 },
  "claude-opus-5": { input: 5, output: 25, cacheWrite5m: 6.25, cacheWrite1h: 10, cacheRead: 0.5 },
  "claude-opus-4-8": { input: 5, output: 25, cacheWrite5m: 6.25, cacheWrite1h: 10, cacheRead: 0.5 },
  "claude-fable-5-1": { input: 10, output: 50, cacheWrite5m: 12.5, cacheWrite1h: 20, cacheRead: 0.25 },
};

// Dated snapshot IDs (e.g. claude-haiku-4-5-20251001) price like their alias.
export function priceFor(model: string | null | undefined, table: Record<string, ModelPrice> = PRICING): ModelPrice | null {
  if (!model) return null;
  if (table[model]) return table[model];
  const stripped = model.replace(/-\d{8}$/, "");
  return table[stripped] ?? null;
}

export type Usage = {
  inputTokens?: number; // uncached input only
  outputTokens?: number;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
};

const perM = (tokens: number | undefined, price: number) => ((tokens ?? 0) * price) / 1_000_000;

// Cost of input tokens billed at the base input rate (what a request costs with no prompt caching).
export function inputCost(model: string | null | undefined, tokens: number, table?: Record<string, ModelPrice>): number | null {
  const p = priceFor(model, table);
  return p ? perM(tokens, p.input) : null;
}

// Actual cost of a completed request from provider-reported usage. Cache tokens are priced separately
// from normal input. Cache writes are assumed 5-minute (the API default; this SDK path never sets 1h).
export function usageCost(model: string | null | undefined, u: Usage, table?: Record<string, ModelPrice>): number | null {
  const p = priceFor(model, table);
  if (!p) return null;
  return perM(u.inputTokens, p.input) + perM(u.outputTokens, p.output) + perM(u.cacheCreationInputTokens, p.cacheWrite5m) + perM(u.cacheReadInputTokens, p.cacheRead);
}
