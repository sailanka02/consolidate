// The turn engine: every user message flows through the eight mechanisms —
//   1 token observability, 2 classification, 3 protection, 4 structured memory, 5 retrieval,
//   6 compression/deduplication, 7 context compiler, 8 evaluation + fallback —
// and the model is called only with the compiled context. All state is persisted through the repo layer.
import "server-only";
import type { DatabaseSync } from "node:sqlite";
import { compileContext, EXPAND_TOKEN_BUDGET, FULL_EQUIVALENT_RATIO, fullContext, type SemanticSummary } from "../consolidate/compile";
import { ANTECEDENT_WINDOW } from "../consolidate/referential";
import { maxRequestTokens } from "../runtime-config";
import { annotateMessage } from "../consolidate/classify";
import { cacheKeyFor } from "../consolidate/compress";
import { evaluateAnswer, evaluateContext } from "../consolidate/evaluate";
import { applyStatements, extractStatements, memoryLineTokens, type MemoryChange } from "../consolidate/memory";
import { analyzeAmbiguous, evaluateAnswerSemantically, SEMANTIC_RETRIEVAL_SCORE, selectRelevant, summarizeMessages, type Requirement, type SemanticVerdict } from "../consolidate/semantic";
import { decideEconomics, economicsMargin, expectedEvalUsage, expectedEvaluationCostUsd, HISTORY_WINDOW } from "../consolidate/economics";
import { proposeRetry, type RetryProposal } from "../consolidate/retry";
import { contextSize, economics } from "../consolidate/measure";
import { estimateMessages, estimateText } from "../consolidate/tokens";
import { buildTrace } from "../consolidate/trace";
import * as repo from "../db/repo";
import { configuredModels } from "../model/config";
import { usageCost } from "../model/pricing";
import { ProviderError, type ModelProvider, type ModelResult } from "../model";
import type { Annotation, AttemptTrace, BenchmarkResult, BenchmarkSide, ChatMessage, CompiledEntry, CompileResult, ContextTrace, CostSummary, EvalCheck, FailureCategory, GenerationUsage, RetryDecision, HistoryMessage, MemoryStatement, RunSummary, TokenCount, UtilityCall } from "../types";

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

type Attempt = { trace: AttemptTrace; missingIds: string[]; verdict: SemanticVerdict | null; semanticReason: string };

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
  // Standing requirements with ids, so an evaluator that claims a violation must cite a real source.
  const requirements: Requirement[] = [
    ...msgs.filter((m) => m.annotation?.protection).map((m) => ({ id: m.id, text: m.content })),
    ...active().filter((m) => m.type === "constraint" || m.type === "preference").map((m) => ({ id: `memory:${m.key}`, text: `${m.key}: ${m.value}` })),
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
    let verdictOut: SemanticVerdict | null = null;
    const skip = !r ? "full context sent; nothing removed" : r.metrics.tokensAvoided <= 0 ? "nothing was removed from context, so the answer equals the full-context answer" : undefined;
    if (r && !skip && !error) {
      const omitted = r.decisions.filter((d) => d.action === "OMIT" && !d.duplicateOf).sort((a, b) => b.score - a.score || b.tokens - a.tokens).map((d) => ({ id: d.id, text: msgs.find((m) => m.id === d.id)!.content }));
      const { verdict, call } = await evaluateAnswerSemantically(provider, { request, requirements, answer: response, visible: entries.map((e) => e.content), omitted });
      track([call]);
      if (verdict) {
        for (const c of verdict.criteria) checks.push({ name: `Semantic: ${c.name.replace(/_/g, " ")}`, passed: c.pass, reason: c.reason, layer: "semantic" });
        semanticCategory = verdict.category;
        verdictOut = verdict;
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
      verdict: verdictOut,
      semanticReason: checks.filter((c) => !c.passed && c.layer === "semantic" && c.reason).map((c) => c.reason).join(" ").slice(0, 300),
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

  // ---- what to do after the first evaluation: an explicit, persisted RetryDecision ----
  // A second main-model generation is paid for only when Consolidate's context choices can plausibly have caused the failure
  // (proven missing context, a proven applicable instruction violation, a claim tied to a compiler choice). Anything else
  // is returned as a warning. Optional retries are also checked against the request's economics using the pricing module.
  const expectedEval = expectedEvalUsage(repo.recentEvaluationUsage(db, HISTORY_WINDOW));
  const optimizerSoFar = () => utilityCalls.reduce((t, c) => t + (c.costUsd ?? 0), 0);
  const spentSoFar = () => attempts.reduce((t, a) => t + (a.trace.costUsd ?? 0), 0); // every attempt so far would end up discarded
  const priceRetry = async (entries: CompiledEntry[], guidance?: string) => {
    const retryCounted = await count(entries, guidance);
    const mainModel = model ?? models.main;
    const outTokens = final.trace.providerOutputTokens;
    const evalCost = expectedEvaluationCostUsd(models.utility, expectedEval);
    const gen = retryCounted != null && mainModel && outTokens != null ? usageCost(mainModel, { inputTokens: retryCounted, outputTokens: outTokens }) : null;
    if (retryCounted == null || fullCounted == null || !mainModel || gen == null || evalCost == null) return { retryCounted, cost: null as number | null, projected: null as number | null };
    const e = economics({ model: mainModel, fullTokens: fullCounted, compiledTokens: retryCounted, optimizerCostUsd: optimizerSoFar() + evalCost, fallbackWasteCostUsd: spentSoFar() });
    return { retryCounted, cost: gen + evalCost, projected: e?.netSavingsUsd ?? null };
  };
  // User statements newer than a cited requirement (for a memory item: any message), then the current request.
  const revisionsOf = (sourceId: string): string[] => {
    const at = msgs.findIndex((m) => m.id === sourceId);
    const later = at < 0 ? [] : msgs.slice(at + 1).filter((m) => m.role === "user").map((m) => m.content);
    return [...later, request];
  };
  // What the attempt being judged was actually shown: information present here is not "missing".
  let shownText = result.compiledContext.map((c) => c.content);
  const proposeFor = (a: Attempt, alreadyRegenerated: boolean) =>
    proposeRetry({ category: a.trace.failureCategory ?? "UNCERTAIN", verdict: a.verdict, missingIds: a.missingIds, requirements, request, semanticReason: a.semanticReason, alreadyRegenerated, revisionsOf, payloadText: shownText });
  // Records the decision on the attempt it follows, and the warning when the evaluator flagged something Consolidate did not cause.
  const decideOn = (a: Attempt, p: RetryProposal, d: Partial<RetryDecision> & { decision: RetryDecision["decision"]; reason: string }) => {
    a.trace.retryDecision = { purpose: p.purpose, optional: p.optional, expectedRetryCostUsd: null, projectedNetUsd: null, economicGuard: "not_applicable", contextChanged: false, ...d };
    if (a.verdict && (a.verdict.violation || a.verdict.contextLink || a.verdict.missingIds.length)) {
      a.trace.evaluatorEvidence = {
        ...(a.verdict.violation && { violation: { instruction: a.verdict.violation.instruction, sourceId: a.verdict.violation.sourceId, evidence: a.verdict.violation.evidence, appliesBecause: a.verdict.violation.appliesBecause } }),
        ...(a.verdict.contextLink && { contextLink: a.verdict.contextLink }),
        ...(a.verdict.missingIds.length && { candidateIds: a.verdict.missingIds }),
      };
    }
    if (p.warningOnly && d.decision === "none") {
      a.trace.warningOnly = true;
      a.trace.qualityWarning = p.warning;
    }
  };
  // Optional retries must not knowingly make the request's net savings negative; proven ones never wait on economics.
  const guardOf = (p: RetryProposal, cost: number | null, projected: number | null) => {
    const blocked = p.optional && projected != null && projected < 0;
    const economicGuard: RetryDecision["economicGuard"] = !p.optional ? "not_applicable" : projected == null ? "unknown" : blocked ? "blocked" : "allowed";
    return { blocked, economicGuard, expectedRetryCostUsd: cost, projectedNetUsd: projected };
  };
  const blockedReason = (p: RetryProposal, cost: number | null, projected: number | null) => `${p.reason} Skipped to protect the request's economics: the retry would cost about $${(cost ?? 0).toFixed(4)} and leave the request at ${projected != null && projected < 0 ? "−" : ""}$${Math.abs(projected ?? 0).toFixed(4)} net.`;

  if (!final.trace.passed && !fullPath) {
    let step = proposeFor(final, false);

    // Same-context corrective regeneration: only with proven evidence, never adds history, at most once.
    if (step.kind === "corrective_regeneration") {
      const price = await priceRetry(result.compiledContext, step.guidance);
      const g = guardOf(step, price.cost, price.projected);
      decideOn(final, step, g.blocked ? { decision: "none", reason: blockedReason(step, price.cost, price.projected), ...g } : { decision: "corrective_regeneration", reason: step.reason, ...g });
      if (!g.blocked) {
        final = await chat("regenerated", result.compiledContext, result, forced === "all", price.retryCounted, step.guidance);
        attempts.push(final);
        step = final.trace.passed ? { kind: "none", reason: "Passed after regeneration.", optional: false, warningOnly: false } : proposeFor(final, true);
      } else step = { kind: "none", reason: "", optional: false, warningOnly: false };
    }

    // Level 1: bounded context expansion, only for failures that more context can fix.
    if (!final.trace.passed && step.kind === "context_expansion") {
      const expanded = compileContext({ messages: msgs, request, memory: active(), semanticMatches: semanticMatches ?? {}, summaries, expansion: { ...step.plan!, tokenBudget: EXPAND_TOKEN_BUDGET, alreadySent: result.decisions.filter((d) => d.action !== "OMIT").map((d) => d.id) } });
      const sameContext = expanded.compiledContext.length === result.compiledContext.length && expanded.metrics.compiledTokenEstimate === result.metrics.compiledTokenEstimate;
      if (sameContext) decideOn(final, step, { decision: "none", reason: `${step.reason} No additional omitted context was available to restore, so the context is unchanged and no retry was made.`, contextChanged: false });
      else {
        const price = await priceRetry(expanded.compiledContext);
        const g = guardOf(step, price.cost, price.projected);
        // A recovery that is functionally the full context is recorded as one: no "bounded expansion" that isn't.
        const share = price.retryCounted != null && fullCounted ? price.retryCounted / fullCounted : expanded.metrics.compiledTokenEstimate / Math.max(1, result.metrics.originalTokenEstimate);
        const functionallyFull = share >= FULL_EQUIVALENT_RATIO;
        const decision = functionallyFull ? ("full_fallback" as const) : ("context_expansion" as const);
        const reason = functionallyFull ? `${step.reason} The recovery payload is ${(share * 100).toFixed(0)}% of the full context, so it is recorded as a full fallback.` : step.reason;
        decideOn(final, step, g.blocked ? { decision: "none", reason: blockedReason(step, price.cost, price.projected), ...g } : { decision, reason, contextChanged: true, ...g });
        if (!g.blocked) {
          const needed = final.semanticReason;
          shownText = expanded.compiledContext.map((c) => c.content);
          final = await chat("expanded", expanded.compiledContext, expanded, forced === "all", price.retryCounted);
          if (expanded.expansionReport) final.trace.expansion = { ...expanded.expansionReport, ...(needed && { needed }) };
          attempts.push(final);
          finalResult = expanded;
          fallbackLevel = 1;
        }
      }
    } else if (!final.trace.retryDecision) {
      // Nothing was retried for this attempt: record why (a warning, an unproven claim, or simply nothing to do).
      decideOn(final, step.kind === "none" && step.reason ? step : proposeFor(final, true), { decision: "none", reason: step.reason || "No retry was justified." });
    }

    // Level 2: the full context, reserved for failures that are about missing context (or a broken deterministic check).
    if (!final.trace.passed && ((final.trace.failureCategory === "MISSING_CONTEXT" && proposeFor(final, true).kind === "context_expansion") || final.trace.failureCategory === "CHECK_FAILED")) {
      const price = await priceRetry(fullEntries);
      decideOn(final, { kind: "full_fallback", reason: "", optional: false, warningOnly: false }, { decision: "full_fallback", reason: "Still missing context after the bounded expansion (or no context was available to add): the full context is used.", expectedRetryCostUsd: price.cost, projectedNetUsd: price.projected, contextChanged: true });
      final = await chat("full", fullEntries, null, false, fullCounted);
      attempts.push(final);
      finalResult = result;
      fallbackLevel = 2;
    }
  }
  // The last attempt has no further retry.
  const last = attempts[attempts.length - 1];
  if (!last.trace.retryDecision) last.trace.retryDecision = { decision: "none", reason: fullPath ? "The request was sent once with the full context (cost-aware fast path)." : last.trace.passed ? "Passed: no retry needed." : "No further retry.", optional: false, expectedRetryCostUsd: null, projectedNetUsd: null, economicGuard: "not_applicable", contextChanged: false };

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
  // The first attempt only counts as a failure when something Consolidate did (or an applicable instruction) went wrong; a warning
  // about polish or an unproven claim is not one.
  const firstOk = first.passed || !!first.warningOnly;
  let fallbackReason: string | undefined;
  if (first.warningOnly) {
    fallbackReason = `${first.qualityWarning ?? "Quality warning — no context failure detected"}. The answer was returned as it is: no context was added and it was not regenerated.`;
  } else if (!first.passed) {
    const parts: string[] = [];
    for (const a of attempts.slice(1)) {
      const d = attempts[attempts.indexOf(a) - 1]?.trace.retryDecision;
      if (a.trace.level === "regenerated") parts.push(`${d?.purpose === "instruction" ? "Regenerated to follow an applicable instruction" : "Response regenerated with the same context"} (no context added); ${a.trace.passed ? "the retry passed" : "the retry did not pass"}.`);
      else if (a.trace.level === "expanded") parts.push(`${d?.decision === "full_fallback" ? "Full fallback (the recovery payload was functionally the full context)" : "More context added"} (${a.trace.contextAdded?.length ?? 0} entr${a.trace.contextAdded?.length === 1 ? "y" : "ies"}, ${(a.trace.contextAdded ?? []).reduce((t, x) => t + x.tokens, 0)} est. tokens); ${a.trace.passed ? "the retry passed" : "the retry did not pass"}.`);
      else parts.push("Full context was used for the returned answer.");
    }
    if (attempts.length === 1) parts.push(first.retryDecision?.reason ?? "No retry was made.");
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
      passed: firstOk,
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
      evaluationStatus: firstOk ? "PASS" : "FAIL",
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
      retryDecision: first.retryDecision?.decision ?? "none",
      retryDecisionReason: first.retryDecision?.reason ?? null,
      contextChanged: first.retryDecision ? first.retryDecision.contextChanged : null,
      expectedRetryCostUsd: first.retryDecision?.expectedRetryCostUsd ?? null,
      qualityWarning: first.qualityWarning ?? null,
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
    assistantMessage: { ...assistantRow, runId, fallbackLevel, evaluationStatus: firstOk ? "PASS" : "FAIL", qualityWarning: !!first.qualityWarning, regenerated: attempts.some((a) => a.trace.level === "regenerated"), answerPassed: final.trace.passed } as ChatMessage,
    run: saved.summary,
    trace: saved.trace,
  };
}

