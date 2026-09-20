// Data access. Every function takes the connection explicitly so tests can use an in-memory database.
import "server-only";
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { Annotation, BenchmarkResult, EconomicDecision, EconomicsDecision, ChatMessage, CompressedGroup, Conversation, ContextTrace, CostSummary, CountSource, Decision, FailureCategory, MemoryItem, RunSummary, AttemptTrace, Savings, UtilityCall } from "../types";

type Row = Record<string, unknown>;
const now = () => new Date().toISOString();
export const newId = (prefix: string) => `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
const json = <T>(s: unknown, fallback: T): T => {
  try {
    return JSON.parse(String(s)) as T;
  } catch {
    return fallback;
  }
};

// Runs fn inside a transaction; rolls back if it throws.
export function tx<T>(db: DatabaseSync, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const out = fn();
    db.exec("COMMIT");
    return out;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

// ---- conversations ----

const toConversation = (r: Row): Conversation => ({ id: r.id as string, title: r.title as string, createdAt: r.created_at as string, updatedAt: r.updated_at as string });

export function createConversation(db: DatabaseSync, title = "New conversation"): Conversation {
  const id = newId("c");
  const t = now();
  db.prepare("INSERT INTO conversation (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)").run(id, title, t, t);
  return { id, title, createdAt: t, updatedAt: t };
}

export const listConversations = (db: DatabaseSync): Conversation[] =>
  (db.prepare("SELECT * FROM conversation ORDER BY updated_at DESC, rowid DESC").all() as Row[]).map(toConversation);

export function getConversation(db: DatabaseSync, id: string): Conversation | null {
  const r = db.prepare("SELECT * FROM conversation WHERE id = ?").get(id) as Row | undefined;
  return r ? toConversation(r) : null;
}

export const deleteConversation = (db: DatabaseSync, id: string) => void db.prepare("DELETE FROM conversation WHERE id = ?").run(id);

export const touchConversation = (db: DatabaseSync, id: string, title?: string) =>
  void db.prepare("UPDATE conversation SET updated_at = ?, title = COALESCE(?, title) WHERE id = ?").run(now(), title ?? null, id);

// ---- messages ----

const toMessage = (r: Row): ChatMessage => ({
  id: r.id as string,
  conversationId: r.conversation_id as string,
  role: r.role as "user" | "assistant",
  content: r.content as string,
  createdAt: r.created_at as string,
  localTokenEstimate: r.local_token_estimate as number,
  ...(r.run_id ? { runId: r.run_id as string, fallbackLevel: r.fallback_level as number, evaluationStatus: r.evaluation_status as "PASS" | "FAIL", regenerated: !!r.regenerated, answerPassed: !!r.answer_passed, qualityWarning: !!r.quality_warning } : {}),
});

export const listMessages = (db: DatabaseSync, conversationId: string): ChatMessage[] =>
  (
    db
      .prepare(
        `SELECT m.*, r.id AS run_id, r.fallback_level, r.evaluation_status,
           EXISTS (SELECT 1 FROM run_attempt a WHERE a.run_id = r.id AND a.level = 'regenerated') AS regenerated,
           (SELECT a.passed FROM run_attempt a WHERE a.run_id = r.id ORDER BY a.idx DESC LIMIT 1) AS answer_passed,
           (r.quality_warning IS NOT NULL) AS quality_warning
         FROM message m
         LEFT JOIN compiler_run r ON r.assistant_message_id = m.id
         WHERE m.conversation_id = ? ORDER BY m.seq`,
      )
      .all(conversationId) as Row[]
  ).map(toMessage);

export function insertMessage(db: DatabaseSync, m: { id: string; conversationId: string; role: "user" | "assistant"; content: string; localTokenEstimate: number; createdAt?: string }) {
  db.prepare("INSERT INTO message (id, conversation_id, role, content, created_at, local_token_estimate) VALUES (?, ?, ?, ?, ?, ?)").run(
    m.id,
    m.conversationId,
    m.role,
    m.content,
    m.createdAt ?? now(),
    m.localTokenEstimate,
  );
}

// ---- annotations (classification + protection cache) ----

export type StoredAnnotation = Annotation & { messageId: string };

export function getAnnotations(db: DatabaseSync, conversationId: string): Map<string, Annotation> {
  const rows = db
    .prepare("SELECT a.* FROM message_annotation a JOIN message m ON m.id = a.message_id WHERE m.conversation_id = ?")
    .all(conversationId) as Row[];
  return new Map(
    rows.map((r) => [
      r.message_id as string,
      {
        contentType: r.content_type as Annotation["contentType"],
        classMethod: r.class_method as Annotation["classMethod"],
        ambiguous: !!r.ambiguous,
        memoryComplete: !!r.memory_complete,
        protection: r.protected
          ? { level: r.protection_level as "critical" | "high", reason: r.protection_reason as string, method: r.protection_method as "deterministic" | "semantic" }
          : null,
      },
    ]),
  );
}

export function saveAnnotation(db: DatabaseSync, messageId: string, a: Annotation) {
  db.prepare(
    `INSERT INTO message_annotation (message_id, content_type, class_method, ambiguous, protected, protection_level, protection_reason, protection_method, memory_complete, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(message_id) DO UPDATE SET content_type = excluded.content_type, class_method = excluded.class_method, ambiguous = excluded.ambiguous,
       protected = excluded.protected, protection_level = excluded.protection_level, protection_reason = excluded.protection_reason,
       protection_method = excluded.protection_method, memory_complete = excluded.memory_complete, updated_at = excluded.updated_at`,
  ).run(
    messageId,
    a.contentType,
    a.classMethod,
    a.ambiguous ? 1 : 0,
    a.protection ? 1 : 0,
    a.protection?.level ?? null,
    a.protection?.reason ?? null,
    a.protection?.method ?? null,
    a.memoryComplete ? 1 : 0,
    now(),
  );
}

// ---- structured memory ----

const toMemory = (r: Row): MemoryItem => ({
  id: r.id as string,
  key: r.key as string,
  value: r.value as string,
  type: r.type as MemoryItem["type"],
  sourceIds: json<string[]>(r.source_ids, []),
  confidence: r.confidence as number,
  active: !!r.active,
  previousValues: json<string[]>(r.previous_values, []),
  createdAt: r.created_at as string,
  updatedAt: r.updated_at as string,
});

export const listMemory = (db: DatabaseSync, conversationId: string, activeOnly = true): MemoryItem[] =>
  (db.prepare(`SELECT * FROM memory_item WHERE conversation_id = ? ${activeOnly ? "AND active = 1" : ""} ORDER BY created_at, rowid`).all(conversationId) as Row[]).map(toMemory);

export function saveMemory(db: DatabaseSync, conversationId: string, m: MemoryItem) {
  const t = now();
  db.prepare(
    `INSERT INTO memory_item (id, conversation_id, key, value, type, source_ids, confidence, previous_values, created_at, updated_at, active)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(conversation_id, key) DO UPDATE SET value = excluded.value, type = excluded.type, source_ids = excluded.source_ids,
       confidence = excluded.confidence, previous_values = excluded.previous_values, updated_at = excluded.updated_at, active = excluded.active`,
  ).run(m.id, conversationId, m.key, m.value, m.type, JSON.stringify(m.sourceIds), m.confidence, JSON.stringify(m.previousValues), m.createdAt ?? t, t, m.active ? 1 : 0);
}

// ---- compressed groups (cache) ----

export function getCachedGroup(db: DatabaseSync, conversationId: string, cacheKey: string): CompressedGroup | null {
  const r = db.prepare("SELECT * FROM compressed_group WHERE conversation_id = ? AND cache_key = ?").get(conversationId, cacheKey) as Row | undefined;
  if (!r) return null;
  return {
    id: r.id as string,
    kind: r.kind as CompressedGroup["kind"],
    method: r.method as CompressedGroup["method"],
    sourceIds: json<string[]>(r.source_ids, []),
    originalTokenEstimate: r.original_tokens as number,
    compressedTokenEstimate: r.compressed_tokens as number,
    summary: r.summary as string,
    reason: r.reason as string,
    cacheKey,
  };
}

export function saveGroup(db: DatabaseSync, conversationId: string, g: CompressedGroup & { cacheKey: string }) {
  db.prepare(
    `INSERT OR IGNORE INTO compressed_group (id, conversation_id, cache_key, kind, method, source_ids, original_tokens, compressed_tokens, summary, reason, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(newId("g"), conversationId, g.cacheKey, g.kind, g.method, JSON.stringify(g.sourceIds), g.originalTokenEstimate, g.compressedTokenEstimate, g.summary, g.reason, now());
}

// ---- compiler runs ----

export type RunInput = {
  id: string;
  conversationId: string;
  userMessageId: string;
  assistantMessageId: string;
  originalTokens: number;
  compiledTokens: number;
  tokensAvoided: number;
  reductionPercent: number;
  compilerLatencyMs: number;
  modelLatencyMs: number;
  evaluationStatus: "PASS" | "FAIL";
  fallbackApplied: boolean;
  fallbackLevel: number;
  fallbackReason?: string;
  providerInputTokens: number | null;
  providerOutputTokens: number | null;
  savings: Savings;
  provider: string | null;
  model: string | null;
  trace: ContextTrace;
  attempts: AttemptTrace[];
  decisions: Decision[];
  // measurement + cost accounting
  countSource: CountSource;
  countError?: string;
  fullEstimateTokens: number;
  compiledEstimateTokens: number;
  initialCompiledTokens: number;
  initialReductionPercent: number;
  failureCategory: FailureCategory;
  retryDecision: string;
  retryDecisionReason: string | null;
  contextChanged: boolean | null;
  expectedRetryCostUsd: number | null;
  qualityWarning: string | null;
  cacheCreationTokens: number | null;
  cacheReadTokens: number | null;
  utilityModel: string | null;
  costs: CostSummary | null;
  utilityCalls: UtilityCall[];
  benchmark?: BenchmarkResult;
  economics?: EconomicsDecision;
};

export function insertRun(db: DatabaseSync, r: RunInput) {
  db.prepare(
    `INSERT INTO compiler_run (id, conversation_id, user_message_id, assistant_message_id, original_tokens, compiled_tokens, tokens_avoided, reduction_percent,
       compiler_latency_ms, model_latency_ms, evaluation_status, fallback_applied, fallback_level, fallback_reason, provider_input_tokens, provider_output_tokens,
       saved_omission, saved_memory, saved_compression, saved_deduplication, provider, model, trace_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    r.id, r.conversationId, r.userMessageId, r.assistantMessageId, r.originalTokens, r.compiledTokens, r.tokensAvoided, r.reductionPercent,
    r.compilerLatencyMs, r.modelLatencyMs, r.evaluationStatus, r.fallbackApplied ? 1 : 0, r.fallbackLevel, r.fallbackReason ?? null,
    r.providerInputTokens, r.providerOutputTokens, r.savings.omission, r.savings.memory, r.savings.compression, r.savings.deduplication,
    r.provider, r.model, JSON.stringify(r.trace), now(),
  );
  const att = db.prepare(
    `INSERT INTO run_attempt (run_id, idx, level, passed, reason, context_tokens, response, model_latency_ms, provider_input_tokens, provider_output_tokens)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const attExtra = db.prepare(
    "UPDATE run_attempt SET counted_input_tokens = ?, cache_creation_tokens = ?, cache_read_tokens = ?, cost_usd = ?, model = ?, failure_category = ?, detail_json = ? WHERE run_id = ? AND idx = ?",
  );
  r.attempts.forEach((a, i) => {
    att.run(r.id, i, a.level, a.passed ? 1 : 0, a.reason, a.contextTokens, a.response, a.modelLatencyMs, a.providerInputTokens ?? null, a.providerOutputTokens ?? null);
    const detail = { retryDecision: a.retryDecision ?? null, warningOnly: a.warningOnly ?? false, qualityWarning: a.qualityWarning ?? null, fullCountedTokens: a.fullCountedTokens ?? null, reductionPercent: a.reductionPercent ?? null, routing: a.routing ?? null, missingIds: a.missingIds ?? [], contextAdded: a.contextAdded ?? null, decisions: a.decisions ?? null };
    attExtra.run(a.countedInputTokens ?? null, a.cacheCreationInputTokens ?? null, a.cacheReadInputTokens ?? null, a.costUsd ?? null, a.model ?? null, a.failureCategory ?? null, JSON.stringify(detail), r.id, i);
  });
  const c = r.costs;
  db.prepare(
    `UPDATE compiler_run SET retry_decision = ?, retry_decision_reason = ?, expected_retry_cost_usd = ?, context_changed = ?, quality_warning = ?, initial_compiled_tokens = ?, initial_reduction_percent = ?, failure_category = ?, count_source = ?, count_error = ?, full_estimate_tokens = ?, compiled_estimate_tokens = ?, cache_creation_tokens = ?, cache_read_tokens = ?,
       pricing_model = ?, utility_model = ?, full_input_cost_usd = ?, compiled_input_cost_usd = ?, gross_input_savings_usd = ?, optimizer_cost_usd = ?,
       fallback_waste_cost_usd = ?, net_savings_usd = ?, generation_cost_usd = ?, generation_input_cost_usd = ?, generation_output_cost_usd = ?, benchmark_json = ?,
       economic_decision = ?, economic_reason = ?, expected_gross_savings_usd = ?, expected_evaluation_cost_usd = ?, economics_margin = ?, economics_source = ?, potential_compiled_tokens = ?
     WHERE id = ?`,
  ).run(
    r.retryDecision, r.retryDecisionReason, r.expectedRetryCostUsd, r.contextChanged == null ? null : r.contextChanged ? 1 : 0, r.qualityWarning, r.initialCompiledTokens, r.initialReductionPercent, r.failureCategory, r.countSource, r.countError ?? null, r.fullEstimateTokens, r.compiledEstimateTokens, r.cacheCreationTokens, r.cacheReadTokens,
    c?.pricingModel ?? null, r.utilityModel, c?.fullInputCostUsd ?? null, c?.compiledInputCostUsd ?? null, c?.grossInputSavingsUsd ?? null, c?.optimizerCostUsd ?? null,
    c?.fallbackWasteCostUsd ?? null, c?.netSavingsUsd ?? null, c?.generationCostUsd ?? null, c?.generationInputCostUsd ?? null, c?.generationOutputCostUsd ?? null,
    r.benchmark ? JSON.stringify(r.benchmark) : null,
    r.economics?.decision ?? null, r.economics?.reason ?? null, r.economics?.expectedGrossInputSavingsUsd ?? null, r.economics?.expectedEvaluationCostUsd ?? null, r.economics?.margin ?? null, r.economics?.source ?? null, r.economics?.wouldBeCompiledTokens ?? null,
    r.id,
  );
  const uc = db.prepare(
    `INSERT INTO utility_call (run_id, kind, purpose, model, ok, latency_ms, input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens, cost_usd, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const u of r.utilityCalls) uc.run(r.id, u.kind, u.purpose, u.model ?? null, u.ok ? 1 : 0, u.latencyMs, u.inputTokens ?? null, u.outputTokens ?? null, u.cacheCreationInputTokens ?? null, u.cacheReadInputTokens ?? null, u.costUsd ?? null, u.error ?? null);
  const dec = db.prepare(
    `INSERT INTO context_decision (run_id, message_id, action, content_type, score, protected, reason, tokens, group_id, duplicate_of) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const d of r.decisions) dec.run(r.id, d.id, d.action, d.contentType, d.score, d.protected ? 1 : 0, d.reason, d.tokens, d.groupId ?? null, d.duplicateOf ?? null);
}

const toRun = (r: Row): RunSummary => ({
  id: r.id as string,
  conversationId: r.conversation_id as string,
  ...(r.title != null ? { conversationTitle: r.title as string } : {}),
  userMessageId: r.user_message_id as string,
  originalTokens: r.original_tokens as number,
  compiledTokens: r.compiled_tokens as number,
  tokensAvoided: r.tokens_avoided as number,
  reductionPercent: r.reduction_percent as number,
  finalReductionPercent: r.reduction_percent as number,
  // Runs stored before v3 had no fallback bookkeeping: their initial numbers are their final numbers.
  initialCompiledTokens: (r.initial_compiled_tokens as number | null) ?? (r.compiled_tokens as number),
  initialReductionPercent: (r.initial_reduction_percent as number | null) ?? (r.reduction_percent as number),
  failureCategory: (r.failure_category as FailureCategory | null) ?? null,
  retryDecision: (r.retry_decision as RunSummary["retryDecision"]) ?? null,
  contextChanged: r.context_changed == null ? null : !!r.context_changed,
  expectedRetryCostUsd: (r.expected_retry_cost_usd as number | null) ?? null,
  qualityWarning: (r.quality_warning as string | null) ?? null,
  compilerLatencyMs: r.compiler_latency_ms as number,
  modelLatencyMs: r.model_latency_ms as number,
  evaluationStatus: r.evaluation_status as "PASS" | "FAIL",
  fallbackApplied: !!r.fallback_applied,
  fallbackLevel: r.fallback_level as number,
  providerInputTokens: (r.provider_input_tokens as number | null) ?? null,
  providerOutputTokens: (r.provider_output_tokens as number | null) ?? null,
  cacheCreationTokens: (r.cache_creation_tokens as number | null) ?? null,
  cacheReadTokens: (r.cache_read_tokens as number | null) ?? null,
  countSource: (r.count_source as CountSource) ?? "local_estimate",
  fullEstimateTokens: (r.full_estimate_tokens as number | null) ?? null,
  compiledEstimateTokens: (r.compiled_estimate_tokens as number | null) ?? null,
  costs:
    r.net_savings_usd == null || r.pricing_model == null
      ? null
      : {
          pricingModel: r.pricing_model as string,
          fullInputCostUsd: r.full_input_cost_usd as number,
          compiledInputCostUsd: r.compiled_input_cost_usd as number,
          grossInputSavingsUsd: r.gross_input_savings_usd as number,
          optimizerCostUsd: r.optimizer_cost_usd as number,
          fallbackWasteCostUsd: r.fallback_waste_cost_usd as number,
          netSavingsUsd: r.net_savings_usd as number,
          generationCostUsd: (r.generation_cost_usd as number | null) ?? null,
        },
  savings: { omission: r.saved_omission as number, memory: r.saved_memory as number, compression: r.saved_compression as number, deduplication: r.saved_deduplication as number },
  model: (r.model as string | null) ?? null,
  createdAt: r.created_at as string,
  economicDecision: (r.economic_decision as EconomicDecision | null) ?? null,
  economicDecisionReason: (r.economic_reason as string | null) ?? null,
  expectedGrossInputSavingsUsd: (r.expected_gross_savings_usd as number | null) ?? null,
  expectedEvaluationCostUsd: (r.expected_evaluation_cost_usd as number | null) ?? null,
  economicsMargin: (r.economics_margin as number | null) ?? null,
  economicsSource: (r.economics_source as CountSource | null) ?? null,
  potentialCompiledTokens: (r.potential_compiled_tokens as number | null) ?? null,
});

// Successful evaluator calls, newest first: the basis of the expected validation cost. Read BEFORE the current request's
// own calls are persisted, so a decision never uses data from the call it is deciding.
export function recentEvaluationUsage(db: DatabaseSync, limit: number): { inputTokens: number; outputTokens: number }[] {
  return (
    db.prepare("SELECT input_tokens AS i, output_tokens AS o FROM utility_call WHERE kind = 'evaluation' AND ok = 1 AND input_tokens IS NOT NULL AND output_tokens IS NOT NULL ORDER BY id DESC LIMIT ?").all(limit) as Row[]
  ).map((r) => ({ inputTokens: r.i as number, outputTokens: r.o as number }));
}

// Reconstructs the stored Context Trace of a previous run.
export function getRun(db: DatabaseSync, id: string): { summary: RunSummary; trace: ContextTrace } | null {
  const r = db.prepare("SELECT r.*, c.title FROM compiler_run r JOIN conversation c ON c.id = r.conversation_id WHERE r.id = ?").get(id) as Row | undefined;
  return r ? { summary: toRun(r), trace: json<ContextTrace>(r.trace_json, null as unknown as ContextTrace) } : null;
}

export const listRunSummaries = (db: DatabaseSync, limit: number): RunSummary[] =>
  (db.prepare("SELECT r.*, c.title FROM compiler_run r JOIN conversation c ON c.id = r.conversation_id ORDER BY r.created_at DESC, r.rowid DESC LIMIT ?").all(limit) as Row[]).map(toRun);

// avgReductionPercent = FINAL (the request behind the returned answer); avgInitialReductionPercent = what the first compile achieved before any fallback.
type SourceTotals = { runs: number; originalTokens: number; compiledTokens: number; tokensAvoided: number; avgReductionPercent: number | null; avgInitialReductionPercent: number | null };

export type DashboardStats = {
  conversations: number;
  requests: number;
  // Context size, never mixed across sources: provider-counted vs local-estimated requests are totalled separately.
  counted: SourceTotals;
  estimated: SourceTotals;
  // Old local estimator vs provider counts, on the requests that have both.
  estimatorAccuracy: { runs: number; estimatedFull: number; countedFull: number; estimatedCompiled: number; countedCompiled: number } | null;
  // Actual completed-request usage reported by the provider (all main-model generations, incl. discarded attempts).
  actualUsage: { runs: number; inputTokens: number; outputTokens: number; cacheCreationTokens: number; cacheReadTokens: number };
  costs: {
    pricedRuns: number;
    grossInputSavingsUsd: number;
    optimizerCostUsd: number;
    fallbackWasteCostUsd: number;
    netSavingsUsd: number;
    generationCostUsd: number;
    generationInputCostUsd: number;
    generationOutputCostUsd: number;
  };
  utility: { kind: string; calls: number; failed: number; inputTokens: number; outputTokens: number; costUsd: number; unpricedCalls: number }[];
  avgCompilerLatencyMs: number | null;
  avgModelLatencyMs: number | null;
  // Where a normal request spends time. Token counting and the optimizer's own model calls are measured separately
  // from the compiler's local work; none of this is a "time saved" claim.
  avgTokenCountLatencyMs: number | null;
  avgOptimizerLatencyMs: number | null;
  // Benchmark mode only: runs where a full-context baseline AND the Consolidate answer were both generated.
  benchmark: { runs: number; baselineMs: number; consolidatedMs: number; savedMs: number; avgSavedMs: number } | null;
  evaluationPassRate: number | null; // the FIRST optimized answer passed
  finalPassRate: number | null; // the answer that was returned passed (after any regeneration / fallback)
  regeneratedCount: number;
  fallbackCount: number;
  fallbackRate: number | null;
  savings: Savings; // local-estimator partition by mechanism (the provider count is one number per request, not per mechanism)
  memoryItems: number;
  compressedGroups: number;
  // Cost-aware fast path. Bypassed requests are honest zero-reduction requests: they are never counted as token or net savings.
  economics: {
    decided: number; // requests with a recorded decision
    optimized: number;
    bypasses: number; // bypass_full_context
    equivalent: number; // equivalent_context
    safety: number; // safety_full_context
    spendAvoidedUsd: number; // expected evaluation cost of the bypassed requests (an estimate, not a saving)
    potentialGrossSavingsForgoneUsd: number; // gross savings the bypassed requests would have had
  };
};

export function dashboardStats(db: DatabaseSync): DashboardStats {
  const one = (sql: string) => db.prepare(sql).get() as Row;
  const source = (src: string): SourceTotals => {
    const r = db
      .prepare(
        `SELECT COUNT(*) AS n, COALESCE(SUM(original_tokens),0) AS orig, COALESCE(SUM(compiled_tokens),0) AS comp, COALESCE(SUM(tokens_avoided),0) AS avoided, AVG(reduction_percent) AS red, AVG(COALESCE(initial_reduction_percent, reduction_percent)) AS ired
         FROM compiler_run WHERE count_source = ?`,
      )
      .get(src) as Row;
    return { runs: r.n as number, originalTokens: r.orig as number, compiledTokens: r.comp as number, tokensAvoided: r.avoided as number, avgReductionPercent: r.n ? (r.red as number) : null, avgInitialReductionPercent: r.n ? (r.ired as number) : null };
  };
  const a = one(
    `SELECT COUNT(*) AS n, AVG(compiler_latency_ms) AS cl, AVG(model_latency_ms) AS ml, SUM(CASE WHEN evaluation_status='PASS' THEN 1 ELSE 0 END) AS pass,
       SUM(fallback_applied) AS fb, COALESCE(SUM(saved_omission),0) AS so, COALESCE(SUM(saved_memory),0) AS sm,
       COALESCE(SUM(saved_compression),0) AS sc, COALESCE(SUM(saved_deduplication),0) AS sd
     FROM compiler_run`,
  );
  const acc = one(
    `SELECT COUNT(*) AS n, COALESCE(SUM(full_estimate_tokens),0) AS ef, COALESCE(SUM(original_tokens),0) AS cf,
       COALESCE(SUM(compiled_estimate_tokens),0) AS ec, COALESCE(SUM(compiled_tokens),0) AS cc
     FROM compiler_run WHERE count_source = 'provider_count' AND full_estimate_tokens IS NOT NULL`,
  );
  const use = one(
    `SELECT COUNT(provider_output_tokens) AS n, COALESCE(SUM(provider_input_tokens),0) AS i, COALESCE(SUM(provider_output_tokens),0) AS o,
       COALESCE(SUM(cache_creation_tokens),0) AS cw, COALESCE(SUM(cache_read_tokens),0) AS cr FROM compiler_run`,
  );
  const cost = one(
    `SELECT COUNT(net_savings_usd) AS n, COALESCE(SUM(gross_input_savings_usd),0) AS g, COALESCE(SUM(optimizer_cost_usd),0) AS o, COALESCE(SUM(fallback_waste_cost_usd),0) AS w,
       COALESCE(SUM(net_savings_usd),0) AS net, COALESCE(SUM(generation_cost_usd),0) AS gen, COALESCE(SUM(generation_input_cost_usd),0) AS gi, COALESCE(SUM(generation_output_cost_usd),0) AS go
     FROM compiler_run`,
  );
  const utility = (
    db
      .prepare(
        `SELECT kind, COUNT(*) AS calls, SUM(CASE WHEN ok = 0 THEN 1 ELSE 0 END) AS failed, COALESCE(SUM(input_tokens),0) AS i, COALESCE(SUM(output_tokens),0) AS o,
           COALESCE(SUM(cost_usd),0) AS cost, SUM(CASE WHEN cost_usd IS NULL AND input_tokens IS NOT NULL THEN 1 ELSE 0 END) AS unpriced
         FROM utility_call GROUP BY kind ORDER BY kind`,
      )
      .all() as Row[]
  ).map((r) => ({ kind: r.kind as string, calls: r.calls as number, failed: r.failed as number, inputTokens: r.i as number, outputTokens: r.o as number, costUsd: r.cost as number, unpricedCalls: r.unpriced as number }));
  const extra = one(
    `SELECT (SELECT AVG(json_extract(trace_json, '$.compilation.tokenCount.latencyMs')) FROM compiler_run) AS tc,
            (SELECT COALESCE(SUM(latency_ms), 0) FROM utility_call) AS ul,
            (SELECT COUNT(*) FROM run_attempt a WHERE (a.passed = 1 OR json_extract(a.detail_json, '$.warningOnly') = 1) AND a.idx = (SELECT MAX(idx) FROM run_attempt WHERE run_id = a.run_id)) AS fp,
            (SELECT COUNT(DISTINCT run_id) FROM run_attempt WHERE level = 'regenerated') AS rg`,
  );
  const bench = one(
    `SELECT COUNT(*) AS n, COALESCE(SUM(json_extract(benchmark_json, '$.full.modelLatencyMs')), 0) AS b, COALESCE(SUM(json_extract(benchmark_json, '$.consolidate.modelLatencyMs')), 0) AS c
     FROM compiler_run WHERE benchmark_json IS NOT NULL AND json_extract(benchmark_json, '$.full') IS NOT NULL AND json_extract(benchmark_json, '$.consolidate') IS NOT NULL`,
  );
  const eco = one(
    `SELECT COUNT(economic_decision) AS n,
       COALESCE(SUM(economic_decision = 'optimized'),0) AS opt, COALESCE(SUM(economic_decision = 'bypass_full_context'),0) AS byp,
       COALESCE(SUM(economic_decision = 'equivalent_context'),0) AS eqv, COALESCE(SUM(economic_decision = 'safety_full_context'),0) AS saf,
       COALESCE(SUM(CASE WHEN economic_decision = 'bypass_full_context' THEN expected_evaluation_cost_usd END),0) AS avoided,
       COALESCE(SUM(CASE WHEN economic_decision = 'bypass_full_context' THEN expected_gross_savings_usd END),0) AS forgone
     FROM compiler_run`,
  );
  const n = a.n as number;
  return {
    conversations: one("SELECT COUNT(*) AS n FROM conversation").n as number,
    requests: n,
    counted: source("provider_count"),
    estimated: source("local_estimate"),
    estimatorAccuracy: acc.n ? { runs: acc.n as number, estimatedFull: acc.ef as number, countedFull: acc.cf as number, estimatedCompiled: acc.ec as number, countedCompiled: acc.cc as number } : null,
    actualUsage: { runs: use.n as number, inputTokens: use.i as number, outputTokens: use.o as number, cacheCreationTokens: use.cw as number, cacheReadTokens: use.cr as number },
    costs: {
      pricedRuns: cost.n as number,
      grossInputSavingsUsd: cost.g as number,
      optimizerCostUsd: cost.o as number,
      fallbackWasteCostUsd: cost.w as number,
      netSavingsUsd: cost.net as number,
      generationCostUsd: cost.gen as number,
      generationInputCostUsd: cost.gi as number,
      generationOutputCostUsd: cost.go as number,
    },
    utility,
    avgCompilerLatencyMs: n ? (a.cl as number) : null,
    avgModelLatencyMs: n ? (a.ml as number) : null,
    avgTokenCountLatencyMs: (extra.tc as number | null) ?? null,
    avgOptimizerLatencyMs: n ? (extra.ul as number) / n : null,
    benchmark: bench.n ? { runs: bench.n as number, baselineMs: bench.b as number, consolidatedMs: bench.c as number, savedMs: (bench.b as number) - (bench.c as number), avgSavedMs: ((bench.b as number) - (bench.c as number)) / (bench.n as number) } : null,
    evaluationPassRate: n ? (a.pass as number) / n : null,
    finalPassRate: n ? (extra.fp as number) / n : null,
    regeneratedCount: extra.rg as number,
    fallbackCount: (a.fb as number) ?? 0,
    fallbackRate: n ? ((a.fb as number) ?? 0) / n : null,
    savings: { omission: a.so as number, memory: a.sm as number, compression: a.sc as number, deduplication: a.sd as number },
    memoryItems: one("SELECT COUNT(*) AS n FROM memory_item WHERE active = 1").n as number,
    compressedGroups: one("SELECT COUNT(*) AS n FROM compressed_group WHERE summary != ''").n as number,
    economics: {
      decided: eco.n as number,
      optimized: eco.opt as number,
      bypasses: eco.byp as number,
      equivalent: eco.eqv as number,
      safety: eco.saf as number,
      spendAvoidedUsd: eco.avoided as number,
      potentialGrossSavingsForgoneUsd: eco.forgone as number,
    },
  };
}
