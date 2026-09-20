// The turn engine: every user message flows through the eight mechanisms —
//   1 token observability, 2 classification, 3 protection, 4 structured memory, 5 retrieval,
//   6 compression/deduplication, 7 context compiler, 8 evaluation + fallback —
// and the model is called only with the compiled context. All state is persisted through the repo layer.
import "server-only";
import type { DatabaseSync } from "node:sqlite";
import { compileContext, EXPAND_TOKEN_BUDGET, fullContext, type SemanticSummary } from "../consolidate/compile";
import { ANTECEDENT_WINDOW } from "../consolidate/referential";
import { maxRequestTokens } from "../runtime-config";
import { annotateMessage } from "../consolidate/classify";
import { cacheKeyFor } from "../consolidate/compress";
import { evaluateAnswer, evaluateContext } from "../consolidate/evaluate";
import { applyStatements, extractStatements, memoryLineTokens, type MemoryChange } from "../consolidate/memory";
import { analyzeAmbiguous, evaluateAnswerSemantically, SEMANTIC_RETRIEVAL_SCORE, selectRelevant, summarizeMessages } from "../consolidate/semantic";
import { decideEconomics, economicsMargin, expectedEvalUsage, HISTORY_WINDOW } from "../consolidate/economics";
import { contextSize, economics } from "../consolidate/measure";
import { estimateMessages, estimateText } from "../consolidate/tokens";
import { buildTrace } from "../consolidate/trace";
import * as repo from "../db/repo";
import { configuredModels } from "../model/config";
import { usageCost } from "../model/pricing";
import { ProviderError, type ModelProvider, type ModelResult } from "../model";
import type { Annotation, AttemptTrace, BenchmarkResult, BenchmarkSide, ChatMessage, CompiledEntry, CompileResult, ContextTrace, CostSummary, EvalCheck, FailureCategory, GenerationUsage, HistoryMessage, MemoryStatement, RunSummary, TokenCount, UtilityCall } from "../types";

export type TurnOptions = {
  conversationId: string;
  content: string;
  // Developer/test mode only (gated by the API layer): inject an evaluation failure to exercise fallback.
  dev?: { forceEvalFailure?: "optimized" | "all" };
  // Benchmark mode: ALSO generate a full-context baseline and compare. Off by default (it doubles generation cost).
  benchmark?: boolean;
  // Streaming of the user-facing answer. "reset" = discard streamed text (a fallback attempt is starting).
  onEvent?: (e: TurnEvent) => void;
};

// Progress the UI can narrate. Purely informational: no model reasoning is ever exposed.
export type TurnStage = "understanding" | "selecting" | "building" | "responding" | "retrying" | "checking";
export type TurnEvent = { type: "delta"; text: string } | { type: "reset" } | { type: "generated" } | { type: "stage"; stage: TurnStage; level?: AttemptTrace["level"] }; // generated: answer complete, evaluation starting

export type TurnResult = { userMessage: ChatMessage; assistantMessage: ChatMessage; run: RunSummary; trace: ContextTrace };

const ANALYZE_LIMIT = 30; // ambiguous messages classified per request
const SUMMARY_LIMIT = 6; // long messages summarized per request
const RETRIEVAL_DIGESTS = 80;
const USEFUL_SCORE = 0.01; // an omitted message scoring at least this has some evidence of relevance

// What level 1 may restore for a failed attempt. Only failures that more history can plausibly fix get a plan;
// a weak answer, a violated instruction or an unsupported claim is not repaired by sending more of the conversation.
type ExpansionPlan = { includeIds: string[]; incremental?: { minScore: number } };
function expansionPlan(a: { trace: AttemptTrace; missingIds: string[] }): ExpansionPlan | null {
  switch (a.trace.failureCategory) {
    case "MISSING_CONTEXT": // named messages only; if none were named, best-scoring omitted messages within the budget
      return a.missingIds.length ? { includeIds: a.missingIds } : { includeIds: [], incremental: { minScore: 0 } };
    case "UNCERTAIN": // one bounded try, and only with omitted context that shows some relevance
      return { includeIds: a.missingIds, incremental: { minScore: USEFUL_SCORE } };
    case "CHECK_FAILED":
      return { includeIds: [], incremental: { minScore: 0 } };
    default:
      return null;
  }
}

// Failures a better answer (not more history) can fix: ask once more with the SAME optimized context and a corrective instruction.
const REGENERATION_GUIDANCE: Partial<Record<FailureCategory, string>> = {
  ANSWER_QUALITY: "Your previous reply to this request was judged weak or incomplete. Answer it again, directly and completely, using only the conversation context provided.",
  INSTRUCTION_VIOLATION:
    "Your previous reply contradicted a standing requirement that applies to this request. Answer again and follow every requirement, constraint and preference in the provided context that applies to it (a requirement about an unrelated subject does not apply and need not be mentioned).",
  UNSUPPORTED_CLAIM:
    "Your previous reply stated things about the conversation that the provided context does not support. Answer again and ground every statement about the conversation in the provided context; if the context does not contain something, say so instead of guessing.",
};
function regenerationGuidance(a: { trace: AttemptTrace }): string | null {
  const base = a.trace.failureCategory ? REGENERATION_GUIDANCE[a.trace.failureCategory] : undefined;
  if (!base) return null;
  const note = a.trace.checks.filter((c) => c.layer === "semantic" && !c.passed && c.reason).map((c) => c.reason).join(" ").slice(0, 300);
  return note ? `${base} Reviewer note: ${note}` : base;
}

const inFlight = ((globalThis as unknown as { __consolidateInFlight?: Set<string> }).__consolidateInFlight ??= new Set<string>());

export class TurnError extends Error {
  constructor(
    public code: "busy" | "not_found" | "invalid" | "too_large" | ProviderError["code"] | "internal",
    message: string,
  ) {
    super(message);
  }
}

const ms = (t0: number) => Math.round(performance.now() - t0);

type Attempt = { trace: AttemptTrace; missingIds: string[] };

export async function runTurn(db: DatabaseSync, provider: ModelProvider, opts: TurnOptions): Promise<TurnResult> {
  const request = opts.content.trim();
  if (!request) throw new TurnError("invalid", "Message is empty.");
  const conv = repo.getConversation(db, opts.conversationId);
  if (!conv) throw new TurnError("not_found", "Conversation not found.");
  if (inFlight.has(conv.id)) throw new TurnError("busy", "This conversation is still processing a message.");
  inFlight.add(conv.id);
  try {
    return await execute(db, provider, opts, request);
  } finally {
    inFlight.delete(conv.id);
  }
}

async function execute(db: DatabaseSync, provider: ModelProvider, opts: TurnOptions, request: string): Promise<TurnResult> {
  const convId = opts.conversationId;
  const utilityCalls: UtilityCall[] = [];
  const tStart = performance.now();
  let utilityMs = 0;
  const track = (calls: UtilityCall[]) => {
    utilityCalls.push(...calls);
    utilityMs += calls.reduce((s, c) => s + c.latencyMs, 0);
  };

  const stage = (s: TurnStage, level?: AttemptTrace["level"]) => opts.onEvent?.({ type: "stage", stage: s, level });
  stage("understanding");

  // ---- load history + cached analysis ----
  const stored = repo.listMessages(db, convId);
  const annotations = repo.getAnnotations(db, convId);
  for (const m of stored) {
    if (!annotations.has(m.id)) {
      const a = annotateMessage(m);
      repo.saveAnnotation(db, m.id, a);
      annotations.set(m.id, a);
    }
  }
  const history = (): HistoryMessage[] => stored.map((m) => ({ id: m.id, role: m.role, content: m.content, createdAt: m.createdAt, annotation: annotations.get(m.id) }));
  let memory = repo.listMemory(db, convId, false);
  const active = () => memory.filter((m) => m.active);
  const memoryChanges: MemoryChange[] = [];
  const mkMemId = () => repo.newId("mem");

  // ---- 2/3/4: semantic classification + protection + memory for ambiguous history (one batched call) ----
  let newlyClassified = 0;
  const pending = history().filter((m) => m.role === "user" && m.annotation?.ambiguous).slice(-ANALYZE_LIMIT);
  if (pending.length) {
    const { results, calls } = await analyzeAmbiguous(provider, pending.map((m) => ({ id: m.id, content: m.content })));
    track(calls);
    const incoming: { sourceId: string; statements: MemoryStatement[] }[] = [];
    for (const m of pending) {
      const r = results.get(m.id);
      if (!r) continue; // unresolved: stays ambiguous, retried on a later request
      const prev = annotations.get(m.id)!;
      const protection = prev.protection ?? (r.protected ? { level: "high" as const, reason: `semantic classifier: ${r.protectionReason ?? "explicit requirement stated"}`, method: "semantic" as const } : null);
      const next: Annotation = { contentType: protection && r.contentType !== "constraint" && r.protected ? "constraint" : r.contentType, classMethod: "semantic", protection, memoryComplete: !protection && r.complete, ambiguous: false };
      annotations.set(m.id, next);
      incoming.push({ sourceId: m.id, statements: r.statements });
      newlyClassified++;
    }
    const applied = applyStatements(memory, incoming, mkMemId);
    memory = applied.items;
    memoryChanges.push(...applied.changes);
    repo.tx(db, () => {
      for (const m of pending) if (annotations.get(m.id)?.classMethod === "semantic") repo.saveAnnotation(db, m.id, annotations.get(m.id)!);
      for (const item of applied.touched) repo.saveMemory(db, convId, item);
    });
  }

  // ---- 5/6/7: compile (pure), with model-assisted retrieval and summaries when they help ----
  stage("selecting");
  const msgs = history();
  const originalTokens = estimateMessages(msgs) + estimateText(request);
  let semanticMatches: Record<string, number> | undefined;
  const summaries: Record<string, SemanticSummary> = {};
  const semanticRetrieval: { used: boolean; note?: string } = { used: false };
  const cachedGroupKeys = new Set<string>();

  let result = compileContext({ messages: msgs, request, memory: active() });

  // A referential object ("these failures") that found no compatible antecedent deterministically is searched by meaning, but
  // only inside the recent window, and PROTECTED messages take part in the search (search universe != payload: a protected
  // message the search picks is already KEEP, so it is never sent twice). With nothing in the window the search abstains.
  const refObj = result.referentialObject;
  const referentialSearch = !!refObj?.needsSearch;
  const searchPool = () => {
    if (referentialSearch) return result.decisions.slice(-ANTECEDENT_WINDOW).filter((d) => !d.continuity);
    return result.decisions.filter((d) => !d.protected && !d.continuity).slice(-RETRIEVAL_DIGESTS);
  };
  const pool = result.lexicallyInsufficient ? searchPool() : [];
  if (result.lexicallyInsufficient && referentialSearch && pool.length === 0) {
    // Nothing but the continuity turns lies in the window: there is no plausible antecedent to look for. Abstain (no model call).
    semanticMatches = {};
    semanticRetrieval.used = true;
    semanticRetrieval.note = `Your request says "${refObj!.phrase}", but no earlier message in the recent conversation looks like what it refers to, so nothing was searched for.`;
    result = compileContext({ messages: msgs, request, memory: active(), semanticMatches });
  } else if (result.lexicallyInsufficient) {
    const { ids, call } = await selectRelevant(provider, request, pool.map((d) => ({ id: d.id, text: msgs.find((m) => m.id === d.id)!.content })), {
      followUp: result.referentialFollowUp,
      referential: referentialSearch ? { phrase: refObj!.phrase, kind: refObj!.kind } : undefined,
    });
    track([call]);
    semanticMatches = Object.fromEntries((ids ?? []).map((id) => [id, SEMANTIC_RETRIEVAL_SCORE]));
    semanticRetrieval.used = true;
    const why = referentialSearch ? `your request says "${refObj!.phrase}" and no message of the matching type was found in the recent conversation` : result.referentialFollowUp ? "the request is a follow-up that refers back to earlier context" : "lexical retrieval found no match";
    semanticRetrieval.note = ids === null ? "Semantic retrieval was unavailable; lexical results used." : ids.length ? `Model selected ${ids.length} message(s) by meaning because ${why}.` : "Model found no additional relevant history.";
  }

  const summaryIds = result.summaryCandidates.slice(0, SUMMARY_LIMIT);
  if (summaryIds.length) {
    const need: { id: string; content: string }[] = [];
    for (const id of summaryIds) {
      const m = msgs.find((x) => x.id === id)!;
      const key = cacheKeyFor("summary", [m]);
      const cached = repo.getCachedGroup(db, convId, key);
      if (cached) {
        // An empty cached summary records that the model could not produce a usable one: do not ask again.
        if (cached.summary) {
          summaries[id] = { summary: cached.summary, cacheKey: key };
          cachedGroupKeys.add(key);
        }
      } else need.push({ id, content: m.content });
    }
    if (need.length) {
      const out = await summarizeMessages(provider, need);
      track(out.calls);
      for (const [id, summary] of out.summaries) {
        const m = msgs.find((x) => x.id === id)!;
        summaries[id] = { summary, cacheKey: cacheKeyFor("summary", [m]) };
      }
      const call = out.calls[0];
      if (call?.ok) {
        for (const r of out.rejected) {
          const m = msgs.find((x) => x.id === r.id)!;
          const t = estimateMessages([m]);
          repo.saveGroup(db, convId, { id: "rejected", kind: "summary", method: "semantic", sourceIds: [r.id], originalTokenEstimate: t, compressedTokenEstimate: t, summary: "", reason: `rejected: ${r.reason}`, cacheKey: cacheKeyFor("summary", [m]) });
        }
      }
    }
  }
  if (semanticMatches || Object.keys(summaries).length) result = compileContext({ messages: msgs, request, memory: active(), semanticMatches: semanticMatches ?? {}, summaries });
  // Telemetry: which messages the bounded search was shown (application data, not model reasoning).
  if (result.referentialObject && referentialSearch) result.referentialObject.searchedIds = pool.map((d) => d.id);

  // The current request contributes memory too (deterministic here; ambiguous statements are resolved next turn).
  const userId = repo.newId("m");
  const userAnnotation = annotateMessage({ role: "user", content: request });
  const userExtraction = extractStatements(request);
  const requestMemory = applyStatements(memory, [{ sourceId: userId, statements: userExtraction.statements }], mkMemId);
  memoryChanges.push(...requestMemory.changes);

  stage("building");
  // Compiler latency = local computation only; time spent waiting on the model is reported separately.
  const compilerLatencyMs = Math.max(0, ms(tStart) - utilityMs);

  // ---- pre-flight token counting: the exact request payloads that WOULD be sent, counted by the provider ----
  // A = full unoptimized context, B = Consolidate compiled context. Both use the same configured model as generation.
  // Counting happens after the compiler timer stops, so its network time is not billed to compiler latency.
  const fullEntries = fullContext(msgs);
  let countError: string | undefined = provider.countTokens ? undefined : "provider has no token-counting endpoint";
  let countMs = 0;
  const count = async (entries: CompiledEntry[], guidance?: string): Promise<number | null> => {
    if (!provider.countTokens || countError) return null;
    const t0 = performance.now();
    try {
      return await provider.countTokens({ context: entries, request, guidance });
    } catch (e) {
      countError = e instanceof Error ? e.message : "token count failed"; // never fail the request over a count
      return null;
    } finally {
      countMs += ms(t0);
    }
  };
  const [fullCounted, optimizedCounted] = await Promise.all([count(fullEntries), count(result.compiledContext)]);

  // ---- 8: execute, evaluate, fall back ----
  const evalContext = (r: CompileResult, entries: CompiledEntry[]) => evaluateContext({ ...r, compiledContext: entries }, msgs, active(), request);
  const requirements = [
    ...msgs.filter((m) => m.annotation?.protection).map((m) => m.content),
    ...active().filter((m) => m.type === "constraint" || m.type === "preference").map((m) => `${m.key}: ${m.value}`),
  ];

  const semanticUsedFlag: { used: boolean; skip?: string } = { used: false };
  const attempts: Attempt[] = [];
  const usageTotals = { input: 0, output: 0, cacheCreate: 0, cacheRead: 0, seen: false, cacheSeen: false };
  let genInputCost: number | null = 0;
  let genOutputCost: number | null = 0;
  let modelLatencyMs = 0;
  let model: string | null = null;
  let attemptNo = 0;
  let previousIds: Set<string> | null = null; // entry ids of the previous attempt, to report what a retry added
  const chat = async (level: AttemptTrace["level"], entries: CompiledEntry[], r: CompileResult | null, force: boolean, counted: number | null, guidance?: string): Promise<Attempt> => {
    const contextTokens = estimateMessages(entries) + estimateText(request);
    // Spend guard: refuse BEFORE any paid generation when the request is unsafely large. Nothing is truncated or dropped to fit,
    // so protected context and requirements are never silently lost. (Provider count when available, else the local estimate.)
    const requestTokens = counted ?? contextTokens;
    const limit = maxRequestTokens();
    if (requestTokens > limit) {
      throw new TurnError("too_large", `This request would send about ${requestTokens.toLocaleString("en-US")} tokens to the model, above the configured limit of ${limit.toLocaleString("en-US")} (CONSOLIDATE_MAX_REQUEST_TOKENS). Nothing was sent to the model, and no context was removed or shortened. Start a new conversation or raise the limit.`);
    }
    let response = "";
    let error: string | undefined;
    let latency = 0;
    let out: ModelResult | undefined;
    if (attemptNo++ > 0) opts.onEvent?.({ type: "reset" });
    stage(level === "optimized" || attemptNo === 1 ? "responding" : "retrying", level);
    try {
      out = await provider.generate({ context: entries, request, guidance, onText: opts.onEvent ? (text) => opts.onEvent!({ type: "delta", text }) : undefined });
      response = out.response;
      latency = out.latencyMs;
      model = out.model ?? model;
      opts.onEvent?.({ type: "generated" });
      stage("checking", level);
    } catch (e) {
      error = e instanceof Error ? e.message : "provider error";
      const fatal = e instanceof ProviderError && ["unavailable", "auth", "config", "credits", "model"].includes(e.code);
      if (level === "full" || !(e instanceof ProviderError) || fatal) throw e;
    }
    modelLatencyMs += latency;
    const usage = out?.usage;
    let costUsd: number | null | undefined;
    if (usage) {
      usageTotals.seen = true;
      usageTotals.input += usage.inputTokens ?? 0;
      usageTotals.output += usage.outputTokens ?? 0;
      if (usage.cacheCreationInputTokens != null || usage.cacheReadInputTokens != null) usageTotals.cacheSeen = true;
      usageTotals.cacheCreate += usage.cacheCreationInputTokens ?? 0;
      usageTotals.cacheRead += usage.cacheReadInputTokens ?? 0;
      if (out?.apiBilled) {
        const inCost = usageCost(out.model, { inputTokens: usage.inputTokens, cacheCreationInputTokens: usage.cacheCreationInputTokens, cacheReadInputTokens: usage.cacheReadInputTokens });
        const outCost = usageCost(out.model, { outputTokens: usage.outputTokens });
        costUsd = inCost == null || outCost == null ? null : inCost + outCost;
        genInputCost = genInputCost == null || inCost == null ? null : genInputCost + inCost;
        genOutputCost = genOutputCost == null || outCost == null ? null : genOutputCost + outCost;
      }
    }

    let checks: EvalCheck[] = [...(r ? evalContext(r, entries).checks : []), ...evaluateAnswer(response, error)];
    let missingIds: string[] = [];
    let semanticCategory: FailureCategory = "PASS";
    const skip = !r ? "full context sent; nothing removed" : r.metrics.tokensAvoided <= 0 ? "nothing was removed from context, so the answer equals the full-context answer" : undefined;
    if (r && !skip && !error) {
      const omitted = r.decisions.filter((d) => d.action === "OMIT" && !d.duplicateOf).sort((a, b) => b.score - a.score || b.tokens - a.tokens).map((d) => ({ id: d.id, text: msgs.find((m) => m.id === d.id)!.content }));
      const { verdict, call } = await evaluateAnswerSemantically(provider, { request, requirements, answer: response, visible: entries.map((e) => e.content), omitted });
      track([call]);
      if (verdict) {
        for (const c of verdict.criteria) checks.push({ name: `Semantic: ${c.name.replace(/_/g, " ")}`, passed: c.pass, reason: c.reason, layer: "semantic" });
        semanticCategory = verdict.category;
        if (verdict.category === "UNCERTAIN") checks.push({ name: "Semantic verdict", passed: false, reason: "evaluator was uncertain; treated as not validated", layer: "semantic" });
        else if (verdict.category !== "PASS" && verdict.criteria.every((c) => c.pass)) checks.push({ name: `Semantic verdict: ${verdict.category}`, passed: false, reason: "evaluator judged the answer inadequate", layer: "semantic" });
        missingIds = verdict.missingIds;
      } else checks.push({ name: "Semantic evaluator available", passed: true, reason: "evaluator call failed; deterministic checks decide", layer: "semantic" });
      semanticUsedFlag.used = true;
    } else if (skip) semanticUsedFlag.skip ??= skip;
    if (force) checks = [...checks, { name: "Injected failure (developer test mode)", passed: false, reason: "evaluation failure injected to exercise fallback", layer: "deterministic" }];
    const passed = checks.every((c) => c.passed);
    const failed = checks.filter((c) => !c.passed);
    const reason = passed ? "all checks passed" : failed.map((c) => `${c.name}${c.reason ? ` (${c.reason})` : ""}`).join("; ");
    const failureCategory: FailureCategory = passed ? "PASS" : failed.some((c) => c.layer === "deterministic") ? "CHECK_FAILED" : semanticCategory === "PASS" ? "UNCERTAIN" : semanticCategory;
    const size = fullCounted != null && counted != null ? contextSize(fullCounted, counted) : contextSize(originalTokens, contextTokens);
    const contextAdded = previousIds
      ? entries.filter((e) => !previousIds!.has(e.id)).map((e) => ({ id: e.id, tokens: estimateMessages([e]), reason: r?.decisions.find((d) => d.id === e.id)?.reason }))
      : undefined;
    previousIds = new Set(entries.map((e) => e.id));
    return {
      missingIds,
      trace: {
        level,
        passed,
        reason,
        checks,
        contextTokens,
        countedInputTokens: counted,
        failureCategory,
        missingIds,
        fullCountedTokens: fullCounted,
        reductionPercent: size.reductionPercent,
        ...(r && {
          routing: { keep: r.metrics.keepCount, memory: r.metrics.memoryCount, retrieve: r.metrics.retrieveCount, compress: r.metrics.compressCount, omit: r.metrics.omitCount },
          decisions: r.decisions.map((d) => ({
            id: d.id, action: d.action, tokens: d.tokens, score: d.score, reason: d.reason, role: d.role, preview: d.preview, contentType: d.contentType, classMethod: d.classMethod,
            protected: d.protected, protectionReason: d.protectionReason, protectionMethod: d.protectionMethod, signals: d.signals, matched: d.matched, continuity: d.continuity, antecedent: d.antecedent, groupId: d.groupId, duplicateOf: d.duplicateOf,
          })),
          ...(r.referentialObject && { referential: r.referentialObject }),
          groups: r.groups.map((g) => ({ id: g.id, kind: g.kind, method: g.method, sourceIds: g.sourceIds, originalTokens: g.originalTokenEstimate, compressedTokens: g.compressedTokenEstimate, summary: g.summary, reason: g.reason })),
          memoryInjected: r.memoryInjected.map((m) => ({ key: m.key, value: m.value, type: m.type, sourceIds: m.sourceIds, memoryTokens: memoryLineTokens(m) })),
        }),
        ...(contextAdded && { contextAdded }),
        response,
        modelLatencyMs: latency,
        providerInputTokens: usage?.inputTokens,
        providerOutputTokens: usage?.outputTokens,
        cacheCreationInputTokens: usage?.cacheCreationInputTokens,
        cacheReadInputTokens: usage?.cacheReadInputTokens,
        model: out?.model,
        costUsd,
      },
    };
  };
  const forced = opts.dev?.forceEvalFailure;

  // ---- cost-aware fast path: decided after both contexts are counted and BEFORE any generation ----
  // Is an optimized generation + semantic validation worth its cost? If not, the request is sent once with the full context.
  const models = provider.models?.() ?? configuredModels();
  const economicsUseCounts = fullCounted != null && optimizedCounted != null;
  const structural = evalContext(result, result.compiledContext).checks.find((c) => !c.passed);
  const economicsDecision = decideEconomics({
    source: economicsUseCounts ? "provider_count" : "local_estimate",
    fullTokens: economicsUseCounts ? fullCounted : originalTokens,
    compiledTokens: economicsUseCounts ? optimizedCounted : result.metrics.compiledTokenEstimate,
    mainModel: models.main,
    utilityModel: models.utility,
    expectedEval: expectedEvalUsage(repo.recentEvaluationUsage(db, HISTORY_WINDOW)),
    margin: economicsMargin(),
    structuralFailure: structural ? `${structural.name}: ${structural.reason}` : null,
    forceOptimized: forced ? "Developer failure injection is on: the normal optimized path was used." : null,
  });
  const fullPath = economicsDecision.decision !== "optimized";
  if (fullPath) semanticUsedFlag.skip = economicsDecision.reason;

  let final = fullPath ? await chat("full", fullEntries, null, false, fullCounted) : await chat("optimized", result.compiledContext, result, forced === "optimized" || forced === "all", optimizedCounted);
  attempts.push(final);
  let finalResult = result;
  let fallbackLevel: 0 | 1 | 2 = 0;

  // A full-context answer has nothing left to restore: the fallback ladder applies only to an optimized attempt.
  if (!final.trace.passed && !fullPath) {
    // Regeneration: a weak answer, a violated instruction or an unsupported claim is fixed by asking again with the
    // SAME optimized context and a corrective instruction, never by adding history. Once only.
    const guidance = regenerationGuidance(final);
    if (guidance) {
      final = await chat("regenerated", result.compiledContext, result, forced === "all", await count(result.compiledContext, guidance), guidance);
      attempts.push(final);
    }
    // Level 1: restore a bounded amount of omitted context, only when the failure is one more history can fix.
    const plan = final.trace.passed ? null : expansionPlan(final);
    if (plan) {
      const expanded = compileContext({ messages: msgs, request, memory: active(), semanticMatches: semanticMatches ?? {}, summaries, expansion: { ...plan, tokenBudget: EXPAND_TOKEN_BUDGET } });
      const sameContext = expanded.compiledContext.length === result.compiledContext.length && expanded.metrics.compiledTokenEstimate === result.metrics.compiledTokenEstimate;
      if (!sameContext) {
        final = await chat("expanded", expanded.compiledContext, expanded, forced === "all", await count(expanded.compiledContext));
        attempts.push(final);
        finalResult = expanded;
        fallbackLevel = 1;
      }
    }
    // Level 2: the full context, reserved for failures that are about missing context (or a broken deterministic check).
    if (!final.trace.passed && (final.trace.failureCategory === "MISSING_CONTEXT" || final.trace.failureCategory === "CHECK_FAILED")) {
      final = await chat("full", fullEntries, null, false, fullCounted);
      attempts.push(final);
      finalResult = result;
      fallbackLevel = 2;
    }
  }

  // ---- benchmark mode only: a full-context baseline to compare against the Consolidate answer ----
  let benchmark: BenchmarkResult | undefined;
  if (opts.benchmark && !fullPath) {
    const side = (t: AttemptTrace, counted: number | null): BenchmarkSide => ({
      response: t.response,
      modelLatencyMs: t.modelLatencyMs,
      countedInputTokens: counted,
      usage: { inputTokens: t.providerInputTokens ?? null, outputTokens: t.providerOutputTokens ?? null, cacheCreationInputTokens: t.cacheCreationInputTokens ?? null, cacheReadInputTokens: t.cacheReadInputTokens ?? null },
      costUsd: t.costUsd ?? null,
      checksPassed: evaluateAnswer(t.response).every((c) => c.passed),
      failedChecks: evaluateAnswer(t.response).filter((c) => !c.passed).map((c) => c.name),
    });
    const consolidateSide = side(final.trace, final.trace.countedInputTokens ?? null);
    if (fallbackLevel === 2) benchmark = { full: consolidateSide, consolidate: side(attempts[0].trace, optimizedCounted) };
    else {
      try {
        const out = await provider.generate({ context: fullEntries, request });
        const c = out.apiBilled && out.usage ? usageCost(out.model, out.usage) : undefined;
        const t: AttemptTrace = {
          level: "full", passed: true, reason: "benchmark baseline", checks: [], contextTokens: originalTokens, response: out.response, modelLatencyMs: out.latencyMs,
          providerInputTokens: out.usage?.inputTokens, providerOutputTokens: out.usage?.outputTokens, cacheCreationInputTokens: out.usage?.cacheCreationInputTokens, cacheReadInputTokens: out.usage?.cacheReadInputTokens, costUsd: c,
        };
        benchmark = { full: side(t, fullCounted), consolidate: consolidateSide };
      } catch (e) {
        benchmark = { full: null, consolidate: consolidateSide, baselineError: e instanceof Error ? e.message : "baseline generation failed" };
      }
    }
  }

  // ---- persist ----
  const first = attempts[0].trace;
  const finalContextTokens = final.trace.contextTokens; // local estimate of the context behind the returned answer
  const finalSavings = fallbackLevel === 2 || fullPath ? { omission: 0, memory: 0, compression: 0, deduplication: 0 } : finalResult.savings;
  // Primary context-size numbers: provider counts when BOTH sides were counted, else the local estimator for both (never mixed).
  const finalCounted = final.trace.countedInputTokens ?? null;
  const useProviderCount = fullCounted != null && finalCounted != null;
  const size = useProviderCount ? contextSize(fullCounted, finalCounted) : contextSize(originalTokens, finalContextTokens);
  if (!useProviderCount && !countError) countError = "a token count was unavailable for the final context";
  const tokenCount: TokenCount = {
    source: useProviderCount ? "provider_count" : "local_estimate",
    ...size,
    initialCompiledTokens: size.compiledTokens, // set below, once the first attempt's numbers are known
    initialTokensAvoided: size.tokensAvoided,
    initialReductionPercent: size.reductionPercent,
    fullEstimate: originalTokens,
    compiledEstimate: finalContextTokens,
    latencyMs: countMs,
    ...(useProviderCount ? {} : { error: countError }),
  };
  const { tokensAvoided, reductionPercent } = size;
  // What the FIRST compile achieved, measured the same way (provider count or estimate) as the final request so the two compare.
  // A bypassed request never had an optimized attempt: its initial numbers are its (zero-reduction) final numbers; the would-be size lives in the economics record.
  const initialSize = fullPath ? size : useProviderCount && optimizedCounted != null ? contextSize(fullCounted, optimizedCounted) : contextSize(originalTokens, first.contextTokens);
  tokenCount.initialCompiledTokens = initialSize.compiledTokens;
  tokenCount.initialTokensAvoided = initialSize.tokensAvoided;
  tokenCount.initialReductionPercent = initialSize.reductionPercent;
  let fallbackReason: string | undefined;
  if (!first.passed) {
    const regen = attempts.find((a) => a.trace.level === "regenerated");
    const restored = attempts.find((a) => a.trace.level === "expanded")?.trace.contextAdded ?? [];
    const parts: string[] = [];
    if (regen) parts.push(`The answer was regenerated once with the same optimized context (no history added) and ${regen.trace.passed ? "the retry passed" : "the retry did not pass"}.`);
    if (fallbackLevel === 2) parts.push("Full context was used for the returned answer.");
    else if (fallbackLevel === 1) parts.push(`Omitted context was restored (${restored.length} entr${restored.length === 1 ? "y" : "ies"}, ${restored.reduce((t, x) => t + x.tokens, 0)} est. tokens) and ${final.trace.passed ? "the retry passed" : "the retry did not pass; its answer was returned"}.`);
    else if (!regen) parts.push(expansionPlan(attempts[0]) ? "No omitted context was available to restore, so the optimized answer was returned." : `No context was restored: a ${first.failureCategory} failure is not fixed by more history, so the optimized answer was returned.`);
    fallbackReason = `Optimized answer failed evaluation [${first.failureCategory}]: ${first.reason}. ${parts.join(" ")}`;
  }

  // Cost accounting (provider-counted runs on a priced model only; otherwise null rather than invented).
  const utilityModel = utilityCalls.find((c) => c.model)?.model ?? configuredModels().utility;
  const usage: GenerationUsage = {
    inputTokens: usageTotals.seen ? usageTotals.input : null,
    outputTokens: usageTotals.seen ? usageTotals.output : null,
    cacheCreationInputTokens: usageTotals.cacheSeen ? usageTotals.cacheCreate : null,
    cacheReadInputTokens: usageTotals.cacheSeen ? usageTotals.cacheRead : null,
  };
  const unpricedUtility = utilityCalls.some((c) => c.costUsd === null);
  const optimizerCostUsd = utilityCalls.reduce((t, c) => t + (c.costUsd ?? 0), 0);
  const wasteAttempts = attempts.filter((a) => a !== final);
  const wasteUnpriced = wasteAttempts.some((a) => a.trace.costUsd == null && a.trace.providerOutputTokens != null);
  const fallbackWasteCostUsd = wasteAttempts.reduce((t, a) => t + (a.trace.costUsd ?? 0), 0);
  const econ = useProviderCount && !unpricedUtility && !wasteUnpriced ? economics({ model, fullTokens: size.fullTokens, compiledTokens: size.compiledTokens, optimizerCostUsd, fallbackWasteCostUsd }) : null;
  const generationBilled = attempts.some((a) => a.trace.costUsd !== undefined);
  const costs: CostSummary | null = econ
    ? { ...econ, generationCostUsd: genInputCost != null && genOutputCost != null && generationBilled ? genInputCost + genOutputCost : null, generationInputCostUsd: generationBilled ? genInputCost : null, generationOutputCostUsd: generationBilled ? genOutputCost : null }
    : null;

  const trace = buildTrace({
    request,
    messages: msgs,
    result: fallbackLevel === 2 ? result : finalResult,
    memoryTotalActive: active().length,
    memoryChanges,
    newlyClassified,
    semanticRetrieval,
    cachedGroupIds: new Set(finalResult.groups.filter((g) => g.cacheKey && cachedGroupKeys.has(g.cacheKey)).map((g) => g.id)),
    finalContextTokens,
    finalSavings,
    compilerLatencyMs,
    modelLatencyMs,
    providerInputTokens: usage.inputTokens,
    providerOutputTokens: usage.outputTokens,
    tokenCount,
    usage,
    costs,
    model,
    utilityModel,
    benchmark,
    evaluation: {
      checks: first.checks,
      passed: first.passed,
      semanticEvaluatorUsed: semanticUsedFlag.used,
      semanticSkipReason: semanticUsedFlag.used ? undefined : semanticUsedFlag.skip,
      attempts: attempts.map((a) => a.trace),
      fallbackLevel,
      fallbackReason,
    },
    utilityCalls,
    economics: economicsDecision,
    fullContextSent: fullPath,
  });

  const assistantId = repo.newId("m");
  const runId = repo.newId("run");
  const finalResponse = final.trace.response;
  const t = new Date().toISOString();
  const userRow = { id: userId, conversationId: convId, role: "user" as const, content: request, localTokenEstimate: estimateMessages([{ content: request }]), createdAt: t };
  const assistantRow = { id: assistantId, conversationId: convId, role: "assistant" as const, content: finalResponse, localTokenEstimate: estimateMessages([{ content: finalResponse }]), createdAt: new Date().toISOString() };

  repo.tx(db, () => {
    repo.insertMessage(db, userRow);
    repo.insertMessage(db, assistantRow);
    repo.saveAnnotation(db, userId, { ...userAnnotation, memoryComplete: userAnnotation.memoryComplete });
    repo.saveAnnotation(db, assistantId, annotateMessage({ role: "assistant", content: finalResponse }));
    for (const item of requestMemory.touched) repo.saveMemory(db, convId, item);
    for (const g of finalResult.groups) repo.saveGroup(db, convId, { ...g, cacheKey: g.cacheKey ?? cacheKeyFor(`${g.kind}|${g.summary}`, g.sourceIds.map((id) => msgs.find((m) => m.id === id)!)) });
    repo.insertRun(db, {
      id: runId,
      conversationId: convId,
      userMessageId: userId,
      assistantMessageId: assistantId,
      originalTokens: size.fullTokens,
      compiledTokens: size.compiledTokens,
      tokensAvoided,
      reductionPercent,
      compilerLatencyMs,
      modelLatencyMs,
      evaluationStatus: first.passed ? "PASS" : "FAIL",
      fallbackApplied: fallbackLevel > 0,
      fallbackLevel,
      fallbackReason,
      providerInputTokens: usage.inputTokens,
      providerOutputTokens: usage.outputTokens,
      savings: finalSavings,
      countSource: tokenCount.source,
      countError: tokenCount.error,
      fullEstimateTokens: originalTokens,
      compiledEstimateTokens: finalContextTokens,
      initialCompiledTokens: initialSize.compiledTokens,
      initialReductionPercent: initialSize.reductionPercent,
      failureCategory: first.failureCategory ?? "PASS",
      cacheCreationTokens: usage.cacheCreationInputTokens,
      cacheReadTokens: usage.cacheReadInputTokens,
      utilityModel,
      costs,
      utilityCalls,
      benchmark,
      economics: economicsDecision,
      provider: provider.name,
      model,
      trace,
      attempts: attempts.map((a) => a.trace),
      decisions: (fallbackLevel === 2 ? result : finalResult).decisions,
    });
    const firstUser = stored.length === 0;
    repo.touchConversation(db, convId, firstUser ? request.replace(/\s+/g, " ").slice(0, 60) : undefined);
  });

  const saved = repo.getRun(db, runId)!;
  return {
    userMessage: userRow as ChatMessage,
    assistantMessage: { ...assistantRow, runId, fallbackLevel, evaluationStatus: first.passed ? "PASS" : "FAIL", regenerated: attempts.some((a) => a.trace.level === "regenerated"), answerPassed: final.trace.passed } as ChatMessage,
    run: saved.summary,
    trace: saved.trace,
  };
}

