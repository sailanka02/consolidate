// Token observability. LOCAL ESTIMATE, not a real tokenizer: ~4 characters per token plus a
// fixed per-message overhead for role/formatting. Deterministic, only roughly tracks a model.
// Provider-reported usage is tracked separately and never mixed with these estimates.
import type { CompileMetrics } from "../types";

export const TOKEN_ESTIMATE_METHOD = "local estimate: ceil(chars / 4) + 4 per message";

const PER_MESSAGE_OVERHEAD = 4;

export const estimateText = (text: string) => Math.ceil(text.length / 4);

export const estimateMessages = (messages: { content: string }[]) =>
  messages.reduce((sum, m) => sum + estimateText(m.content) + PER_MESSAGE_OVERHEAD, 0);

type Counts = Pick<CompileMetrics, "keepCount" | "memoryCount" | "retrieveCount" | "compressCount" | "omitCount" | "totalItems">;

export function buildMetrics(original: { content: string }[], compiled: { content: string }[], request: string, counts: Counts): CompileMetrics {
  const requestTokens = estimateText(request);
  const originalTokenEstimate = estimateMessages(original) + requestTokens;
  const compiledTokenEstimate = estimateMessages(compiled) + requestTokens;
  const tokensAvoided = originalTokenEstimate - compiledTokenEstimate;
  return {
    originalTokenEstimate,
    compiledTokenEstimate,
    tokensAvoided,
    reductionPercent: originalTokenEstimate ? Math.round((tokensAvoided / originalTokenEstimate) * 1000) / 10 : 0,
    ...counts,
  };
}
