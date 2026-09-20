// Trace construction: turns compiler and engine decisions into the structured ContextTrace the UI renders.
// Every string comes from application signals (scores, rule matches, counts), never from model reasoning.
import { analyzeRequest } from "./analyze";
import { CONTENT_TYPES } from "./classify";
import { memoryBlockTokens, memoryLineTokens, type MemoryChange } from "./memory";
import { estimateMessages } from "./tokens";
import type { EconomicsDecision, AttemptTrace, BenchmarkResult, ClassMethod, CompileResult, ContentType, ContextTrace, CostSummary, EvalCheck, GenerationUsage, HistoryMessage, TokenCount, UtilityCall } from "../types";

export type TraceInput = {
  request: string;
  messages: HistoryMessage[];
  result: CompileResult; // the compile whose context was actually used (or, for full fallback, the optimized one)
  memoryTotalActive: number;
  memoryChanges: MemoryChange[];
  newlyClassified: number;
  semanticRetrieval: { used: boolean; note?: string };
  cachedGroupIds: Set<string>;
  finalContextTokens: number; // tokens of the context that produced the returned answer
  finalSavings: CompileResult["savings"];
  compilerLatencyMs: number;
  modelLatencyMs: number;
  providerInputTokens: number | null;
  providerOutputTokens: number | null;
  tokenCount: TokenCount;
  usage: GenerationUsage;
  costs: CostSummary | null;
  model: string | null;
  utilityModel: string | null;
  benchmark?: BenchmarkResult;
  evaluation: {
    checks: EvalCheck[];
    passed: boolean;
    semanticEvaluatorUsed: boolean;
    semanticSkipReason?: string;
    attempts: AttemptTrace[];
    fallbackLevel: 0 | 1 | 2;
    fallbackReason?: string;
  };
  utilityCalls: UtilityCall[];
  economics?: EconomicsDecision;
  fullContextSent?: boolean; // the returned answer used the full context (fallback level 2 or an economic/safety bypass)
};

export function buildTrace(i: TraceInput): ContextTrace {
  const { result, messages } = i;
  const { decisions, metrics } = result;
  const byId = new Map(messages.map((m) => [m.id, m]));
  const tokensOf = (id: string) => decisions.find((d) => d.id === id)?.tokens ?? estimateMessages([byId.get(id) ?? { content: "" }]);
  const { task, keyTerms } = analyzeRequest(i.request);

  const counts = Object.fromEntries(CONTENT_TYPES.map((t) => [t, 0])) as Record<ContentType, number>;
  const methods: Record<ClassMethod, number> = { deterministic: 0, semantic: 0, heuristic: 0 };
  decisions.forEach((d) => {
    counts[d.contentType]++;
    methods[d.classMethod]++;
  });

  const omitted = decisions
    .filter((d) => d.action === "OMIT")
    .map((d) => ({ id: d.id, preview: d.preview, tokens: d.tokens, score: d.score, reason: d.reason, duplicate: !!d.duplicateOf }))
    .sort((a, b) => b.tokens - a.tokens);

  const fullContext = i.evaluation.fallbackLevel === 2 || !!i.fullContextSent;
  const injected = result.memoryInjected.map((m) => ({
    key: m.key,
    value: m.value,
    type: m.type,
    sourceIds: m.sourceIds,
    confidence: m.confidence,
    originalTokens: m.sourceIds.reduce((t, id) => t + (byId.has(id) ? tokensOf(id) : 0), 0),
    memoryTokens: memoryLineTokens(m),
    previousValues: m.previousValues,
  }));

  return {
    ...(i.economics ? { economics: i.economics } : {}),
    requestAnalysis: {
      request: i.request,
      task,
      keyTerms,
      historyScanned: messages.length,
      originalTokenEstimate: metrics.originalTokenEstimate,
      memoryAvailable: i.memoryTotalActive,
    },
    classification: {
      counts,
      total: decisions.length,
      methods,
      newlyClassified: i.newlyClassified,
      items: decisions.map((d) => ({ id: d.id, preview: d.preview, contentType: d.contentType, method: d.classMethod })),
    },
    protection: {
      items: decisions
        .filter((d) => d.protected)
        .map((d) => ({ id: d.id, preview: d.preview, reason: d.protectionReason ?? "protected", method: d.protectionMethod ?? "deterministic", level: (messages.find((m) => m.id === d.id)?.annotation?.protection?.level ?? "high") as "critical" | "high" })),
    },
    memory: {
      changes: i.memoryChanges,
      injected,
      totalActive: i.memoryTotalActive,
      blockTokens: memoryBlockTokens(result.memoryInjected),
      netTokensSaved: fullContext ? 0 : result.savings.memory,
    },
    retrieval: {
      items: decisions
        .filter((d) => d.action === "RETRIEVE")
        .map((d) => ({ id: d.id, preview: d.preview, score: d.score, signals: d.signals, matched: d.matched, reason: d.reason, continuity: !!d.continuity, ...(d.antecedent && { antecedent: true }) })),
      ...(result.referentialObject && { referential: result.referentialObject }),
      semanticUsed: i.semanticRetrieval.used,
      semanticNote: i.semanticRetrieval.note,
    },
    compression: {
      groups: result.groups.map((g) => ({
        id: g.id,
        kind: g.kind,
        method: g.method,
        sourceIds: g.sourceIds,
        summary: g.summary,
        reason: g.reason,
        originalTokens: g.originalTokenEstimate,
        compressedTokens: g.compressedTokenEstimate,
        cached: i.cachedGroupIds.has(g.id),
      })),
      deduplicated: decisions.filter((d) => d.duplicateOf).map((d) => ({ id: d.id, duplicateOf: d.duplicateOf!, tokens: d.tokens, preview: d.preview })),
    },
    omission: { totalCount: omitted.length, tokensRemoved: omitted.reduce((s, o) => s + o.tokens, 0), items: omitted },
    compilation: {
      originalTokenEstimate: metrics.originalTokenEstimate,
      compiledTokenEstimate: i.finalContextTokens,
      tokensAvoided: metrics.originalTokenEstimate - i.finalContextTokens,
      reductionPercent: metrics.originalTokenEstimate ? Math.round(((metrics.originalTokenEstimate - i.finalContextTokens) / metrics.originalTokenEstimate) * 1000) / 10 : 0,
      counts: { keep: metrics.keepCount, memory: metrics.memoryCount, retrieve: metrics.retrieveCount, compress: metrics.compressCount, omit: metrics.omitCount },
      savings: i.finalSavings,
      providerInputTokens: i.providerInputTokens,
      providerOutputTokens: i.providerOutputTokens,
      compilerLatencyMs: i.compilerLatencyMs,
      modelLatencyMs: i.modelLatencyMs,
      tokenCount: i.tokenCount,
      usage: i.usage,
      costs: i.costs,
      model: i.model,
      utilityModel: i.utilityModel,
    },
    evaluation: {
      status: i.evaluation.passed ? "PASS" : "FAIL",
      checks: i.evaluation.checks,
      semanticEvaluatorUsed: i.evaluation.semanticEvaluatorUsed,
      semanticSkipReason: i.evaluation.semanticSkipReason,
      attempts: i.evaluation.attempts,
      fallbackApplied: i.evaluation.fallbackLevel > 0,
      fallbackLevel: i.evaluation.fallbackLevel,
      fallbackReason: i.evaluation.fallbackReason,
    },
    utilityCalls: i.utilityCalls,
    ...(i.benchmark ? { benchmark: i.benchmark } : {}),
  };
}
