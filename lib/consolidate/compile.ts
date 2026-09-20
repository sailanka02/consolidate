// Context compilation. Routing order per message:
//   A protected exact context        -> KEEP
//   B durable info held structurally -> MEMORY
//   C relevant verbose / duplicated  -> COMPRESS
//   D relevant, needs original words -> RETRIEVE
//   E irrelevant, not protected      -> OMIT
// The most recent turns get a continuity boost (they are retrieved even when lexically unrelated).
// Pure function: persistence, model calls and evaluation live elsewhere.
import { annotationOf } from "./classify";
import { findGroups, needsExactWording, representGroup, signature, summarizeExtractive, cacheKeyFor } from "./compress";
import { formatMemoryBlock, memoryBlockTokens, memoryLineTokens } from "./memory";
import { detectReferentialObject, selectAntecedents } from "./referential";
import { MEMORY_THRESHOLD, RETRIEVE_THRESHOLD, scoreRelevance } from "./relevance";
import { buildMetrics, estimateMessages } from "./tokens";
import type { Action, CompiledEntry, CompileResult, CompressedGroup, Decision, HistoryMessage, MemoryItem, ReferentialInfo } from "../types";

// Compression must pay for itself.
const MIN_SAVED_TOKENS = 12;
const MAX_COMPRESSED_RATIO = 0.8;
// A run of prose messages is only worth summarizing when it is verbose.
const MIN_DISCUSSION_TOKENS = 60;
const DISCUSSION_BUDGET = 0.5;
// A single relevant message this long is worth a semantic summary.
export const SEMANTIC_SUMMARY_MIN_TOKENS = 220;
const SEMANTIC_MAX_RATIO = 0.65;
// Continuity: the previous exchange stays in context unless it is huge.
const CONTINUITY_MESSAGES = 2;
const CONTINUITY_MAX_TOKENS = 3000;
const PREVIEW_LEN = 140;
// Fallback level 1 may restore at most this many (local-estimate) tokens of omitted history. It is a cap, not a target:
// restoring everything is what the full-context fallback is for.
export const EXPAND_TOKEN_BUDGET = 800;

// Short follow-ups that point back at earlier context without naming it ("what else can I add?", "expand on that").
// Their few words rarely overlap the earlier project description, so lexical retrieval alone misses the antecedent.
const FOLLOW_UP_MAX_WORDS = 20;
const FOLLOW_UP_PATTERNS: RegExp[] = [
  /\b(what|anything|which|any) (else|other|more)\b/,
  /\b(additional|other|more|extra|further|another) (features?|options?|ideas?|things?|ways?|steps?|suggestions?|improvements?|approaches?|alternatives?|examples?|enhancements?)\b/,
  /\b(can|could|would|will) you (please )?(expand|elaborate|continue|go deeper|improve|refine|extend|explain (that|this|it|more|further)|make (it|this|that))\b/,
  /\b(expand|elaborate|continue|improve|extend|refine|build)( on| upon)? (that|this|it|those|them)\b/,
  /\bhow (can|could|do|should) (i|we) (improve|extend|expand|enhance|make|build on) (it|this|that|them)\b/,
  /\bwhat (about|if) (this|that|it|those)\b/,
  /\bwhat (should|do|shall) (i|we) do next\b|\bwhat'?s next\b|\bwhat next\b|\bnext steps?\b/,
  /\bmake (it|this|that) (better|faster|nicer|simpler|cleaner|more \w+)\b/,
  /\b(tell|show) me more\b|\bgo on\b|\bkeep going\b/,
];
export function isReferentialFollowUp(request: string): boolean {
  const t = request.trim().toLowerCase().replace(/[\u2019]/g, "'");
  const words = t.split(/\s+/).filter(Boolean).length;
  return words > 0 && words <= FOLLOW_UP_MAX_WORDS && FOLLOW_UP_PATTERNS.some((re) => re.test(t));
}

export type SemanticSummary = { summary: string; cacheKey: string };

export type CompileInput = {
  messages: HistoryMessage[]; // history before the current request, oldest first
  request: string;
  memory?: MemoryItem[]; // active structured memory
  semanticMatches?: Record<string, number>; // model-selected relevance (message id -> score)
  summaries?: Record<string, SemanticSummary>; // model-written summaries of single messages
  // Fallback level 1: bring back a bounded amount of original context.
  //  includeIds   omitted messages the evaluator named as needed (restored in order, with their question/answer partner)
  //  incremental  when set, further omitted messages scoring >= minScore are restored best-first
  //  tokenBudget  cap on everything restored; the first named id is always restored even if it alone exceeds it
  expansion?: { includeIds: string[]; tokenBudget: number; incremental?: { minScore: number } };
};

type Route = { action: Action; reason: string; groupId?: string; duplicateOf?: string; continuity?: boolean; antecedent?: boolean };

const ANTECEDENT_DESCRIPTION = { error: "error logs you recently provided", output: "output you recently provided", code: "code you recently provided", decision: "statements you recently made", any: "content you recently provided" } as const;

const preview = (s: string) => {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > PREVIEW_LEN ? one.slice(0, PREVIEW_LEN) + "…" : one;
};

export function compileContext({ messages, request, memory = [], semanticMatches, summaries = {}, expansion }: CompileInput): CompileResult {
  const n = messages.length;
  const ann = messages.map(annotationOf);
  const activeMemory = memory.filter((m) => m.active);
  const { scores, requestTerms, memoryScores } = scoreRelevance({
    messages: messages.map((m, i) => ({ id: m.id, role: m.role, content: m.content, contentType: ann[i].contentType, protectedLevel: ann[i].protection?.level })),
    request,
    memory: activeMemory,
    semantic: semanticMatches,
  });
  const idx = new Map(messages.map((m, i) => [m.id, i]));
  const tok = messages.map((m) => estimateMessages([m]));
  const sum = (ids: number[]) => ids.reduce((s, i) => s + tok[i], 0);
  const relevant = (i: number) => scores[i].score >= RETRIEVE_THRESHOLD;
  const explain = (i: number) => {
    const { matched, pairedWith, signals } = scores[i];
    if (signals.semantic > 0 && signals.semantic >= scores[i].score) return "selected by semantic retrieval";
    return pairedWith ? `paired with ${pairedWith} (question/answer)` : matched.length ? `overlap on: ${matched.slice(0, 6).join(", ")}` : "no term overlap with current request";
  };
  const notRelevant = (i: number): Route => ({ action: "OMIT", reason: `Not relevant: ${explain(i)}` });

  const routes: (Route | undefined)[] = new Array(n);
  const groups: CompressedGroup[] = [];

  // A. Protected exact context. Never compressed, never omitted.
  ann.forEach((a, i) => {
    if (a.protection) routes[i] = { action: "KEEP", reason: a.protection.reason };
  });

  // Continuity: the last few unprotected messages stay verbatim so follow-ups make sense.
  const recent = [...Array(n).keys()].reverse().filter((i) => !routes[i]).slice(0, CONTINUITY_MESSAGES);
  // The recent turns travel together: a question is never kept without its answer (or vice versa).
  if (recent.every((i) => tok[i] <= CONTINUITY_MAX_TOKENS)) {
    for (const i of recent) routes[i] = { action: "RETRIEVE", reason: "Recent turn kept for conversational continuity", continuity: true };
  }

  // Referential object ("what do these failures have in common?"): the request points at something recently presented and
  // shares no vocabulary with it, so the antecedent is found by type, not by words: the most recent coherent block of
  // compatible messages inside a bounded window. Routed as one unit (never one retry without the others); no vocabulary
  // scoring, no older history.
  const referentialObject = detectReferentialObject(request);
  let referentialInfo: ReferentialInfo | undefined;
  if (referentialObject) {
    const found = selectAntecedents(referentialObject.kind, messages.map((m, i) => ({ id: m.id, role: m.role, content: m.content, contentType: ann[i].contentType })), tok);
    for (const id of found.selectedIds) {
      const i = idx.get(id)!;
      if (!routes[i]) routes[i] = { action: "RETRIEVE", reason: `Referential antecedent: your request says "${referentialObject.phrase}", which refers to the ${ANTECEDENT_DESCRIPTION[referentialObject.kind]}`, antecedent: true };
    }
    referentialInfo = { kind: referentialObject.kind, noun: referentialObject.noun, phrase: referentialObject.phrase, candidateIds: found.candidateIds, selectedIds: found.selectedIds, needsSearch: false };
  }

  // Expanded retrieval (fallback level 1): explicitly requested messages come back verbatim, each with the other half
  // of its question/answer pair, within the token budget.
  let budget = expansion?.tokenBudget ?? 0;
  const restore = (i: number, reason: string) => {
    routes[i] = { action: "RETRIEVE", reason };
    budget -= tok[i];
  };
  let restoredAny = false;
  for (const id of expansion?.includeIds ?? []) {
    const i = idx.get(id);
    if (i === undefined || routes[i] || (restoredAny && tok[i] > budget)) continue;
    restore(i, "Restored by expanded retrieval: named as missing by the evaluator");
    restoredAny = true;
    const j = messages[i].role === "user" ? i + 1 : i - 1;
    const partner = messages[j];
    if (partner && partner.role !== messages[i].role && !routes[j] && tok[j] <= budget) restore(j, `Restored by expanded retrieval: question/answer partner of ${id}`);
  }

  // Exact duplicates of context that is already kept verbatim.
  const keptSig = new Map<string, string>();
  messages.forEach((m, i) => {
    if (routes[i]?.action === "KEEP" || routes[i]?.action === "RETRIEVE") keptSig.set(`${m.role}|${signature(m.content)}`, m.id);
  });
  messages.forEach((m, i) => {
    if (routes[i]) return;
    const first = keptSig.get(`${m.role}|${signature(m.content)}`);
    if (first) routes[i] = { action: "OMIT", reason: `Duplicate of ${first}`, duplicateOf: first };
  });

  // B. Durable information held structurally.
  const memRelevant = (m: MemoryItem) => (memoryScores.get(m.id) ?? 0) >= MEMORY_THRESHOLD;
  const alwaysCarried = (m: MemoryItem) => m.type === "constraint" || m.type === "preference";
  const eligible = activeMemory.filter((m) => {
    if (!(alwaysCarried(m) || memRelevant(m))) return false;
    // A memory item whose every source is already kept verbatim adds nothing.
    return m.sourceIds.some((id) => {
      const i = idx.get(id);
      return i !== undefined && routes[i]?.action !== "KEEP";
    });
  });
  const constraintMsgs = new Set<number>();
  const memoryRouted = new Map<number, MemoryItem[]>();
  messages.forEach((m, i) => {
    if (routes[i]) return;
    const items = eligible.filter((e) => e.sourceIds.includes(m.id));
    if (!items.length) return;
    // Standing constraints/preferences are never silently dropped: without a memory line they stay verbatim.
    if (items.some(alwaysCarried)) constraintMsgs.add(i);
    // A relevant message with extra content stays verbatim; otherwise the memory line stands in for it.
    if (!(ann[i].memoryComplete || !relevant(i))) return;
    // Memory must be cheaper than the wording it replaces; if not, keep the original.
    if (tok[i] <= items.reduce((s, e) => s + memoryLineTokens(e), 0)) {
      routes[i] = { action: "RETRIEVE", reason: "Memory line not cheaper than the original message; kept verbatim" };
      return;
    }
    memoryRouted.set(i, items);
  });
  const blockItems = () => eligible.filter((e) => e.sourceIds.some((id) => memoryRouted.has(idx.get(id)!)));
  if (memoryRouted.size && memoryBlockTokens(blockItems()) >= sum([...memoryRouted.keys()])) {
    // The whole block costs more than what it replaces: keep the originals.
    for (const i of memoryRouted.keys()) routes[i] = { action: "RETRIEVE", reason: "Memory block not cheaper than the originals; kept verbatim" };
    memoryRouted.clear();
  }
  const memoryBlock = blockItems();
  for (const [i, items] of memoryRouted) routes[i] = { action: "MEMORY", reason: `Durable statement represented as memory (${items.map((e) => e.key).join(", ")}); exact wording not required` };

  // C. Duplicated / related-log groups, decided as a unit.
  const pool = messages.flatMap((m, i) => (routes[i] ? [] : [{ id: m.id, role: m.role, content: m.content, contentType: ann[i].contentType }]));
  for (const g of findGroups(pool)) {
    const gi = g.ids.map((id) => idx.get(id)!).sort((a, b) => a - b);
    const score = Math.max(...gi.map((i) => scores[i].score));
    const seen = new Map<string, string>(); // signature -> first id
    const asDuplicate = (i: number): Route | null => {
      const sig = signature(messages[i].content);
      const first = seen.get(sig);
      if (first) return { action: "OMIT", reason: `Duplicate of ${first}`, duplicateOf: first };
      seen.set(sig, messages[i].id);
      return null;
    };
    if (score < RETRIEVE_THRESHOLD) {
      gi.forEach((i) => (routes[i] = asDuplicate(i) ?? notRelevant(i)));
      continue;
    }
    const isLog = gi.every((i) => ann[i].contentType === "log" || ann[i].contentType === "tool_output");
    const summary = representGroup(g, gi.map((i) => messages[i].content), isLog);
    const original = sum(gi);
    const compressed = estimateMessages([{ content: summary }]);
    if (original - compressed >= MIN_SAVED_TOKENS && compressed <= original * MAX_COMPRESSED_RATIO) {
      const id = `cg${groups.length + 1}`;
      const what = g.kind === "duplicate" ? `${gi.length} equivalent ${isLog ? "logs" : "messages"}` : `${gi.length} near-identical repeated ${isLog ? "logs" : "messages"}${g.event ? ` sharing event ${g.event}` : ""}`;
      groups.push({
        id,
        kind: g.kind,
        method: "deterministic",
        sourceIds: gi.map((i) => messages[i].id),
        originalTokenEstimate: original,
        compressedTokenEstimate: compressed,
        summary,
        reason: `${what}, relevance ${score.toFixed(2)}; wording not needed beyond one representative`,
        cacheKey: cacheKeyFor(g.kind, gi.map((i) => messages[i])),
      });
      gi.forEach((i) => (routes[i] = { action: "COMPRESS", reason: `Compressed into ${id}`, groupId: id }));
    } else if (g.kind === "duplicate") {
      // Too small to compress: keep one exact copy, drop the rest.
      gi.forEach((i) => (routes[i] = asDuplicate(i) ?? { action: "RETRIEVE", reason: `Relevant: ${explain(i)}` }));
    } // small related-log groups fall through to per-message routing
  }

  // C2. Verbose relevant prose: deterministic extractive summary of consecutive messages (skipped when expanding).
  if (!expansion) {
    const candidate = (i: number) => !routes[i] && relevant(i) && ["discussion", "fact", "decision"].includes(ann[i].contentType) && !needsExactWording(messages[i].content);
    for (let i = 0; i < n; i++) {
      if (!candidate(i)) continue;
      const run = [i];
      while (candidate(run[run.length - 1] + 1)) run.push(run[run.length - 1] + 1);
      i = run[run.length - 1];
      const original = sum(run);
      if (original < MIN_DISCUSSION_TOKENS) continue;
      const extract = summarizeExtractive(run.map((r) => messages[r].content), request, Math.floor(original * DISCUSSION_BUDGET));
      if (!extract) continue;
      const summary = `Discussion summary (${run.length} messages): ${extract}`;
      const compressed = estimateMessages([{ content: summary }]);
      if (original - compressed < MIN_SAVED_TOKENS || compressed > original * MAX_COMPRESSED_RATIO) continue;
      const id = `cg${groups.length + 1}`;
      const score = Math.max(...run.map((r) => scores[r].score));
      groups.push({
        id,
        kind: "discussion",
        method: "deterministic",
        sourceIds: run.map((r) => messages[r].id),
        originalTokenEstimate: original,
        compressedTokenEstimate: compressed,
        summary,
        reason: `verbose relevant discussion (relevance ${score.toFixed(2)}); kept highest-information sentences verbatim`,
      });
      run.forEach((r) => (routes[r] = { action: "COMPRESS", reason: `Compressed into ${id}`, groupId: id }));
    }
  }

  // C3. Long relevant messages: model-written summaries (persisted and reused). Candidates are reported so the
  // caller can request them; supplied summaries are used only when they genuinely shrink the message.
  const summaryCandidates: string[] = [];
  if (!expansion) {
    messages.forEach((m, i) => {
      if (routes[i] || !relevant(i) || tok[i] < SEMANTIC_SUMMARY_MIN_TOKENS) return;
      if (!["discussion", "fact", "decision", "other"].includes(ann[i].contentType)) return;
      const s = summaries[m.id];
      if (!s) {
        summaryCandidates.push(m.id);
        return;
      }
      const compressed = estimateMessages([{ content: s.summary }]);
      if (compressed > tok[i] * SEMANTIC_MAX_RATIO || tok[i] - compressed < MIN_SAVED_TOKENS) return;
      const id = `cg${groups.length + 1}`;
      groups.push({
        id,
        kind: "summary",
        method: "semantic",
        sourceIds: [m.id],
        originalTokenEstimate: tok[i],
        compressedTokenEstimate: compressed,
        summary: s.summary,
        reason: `verbose relevant message (relevance ${scores[i].score.toFixed(2)}); model summary, checked to add no numbers or identifiers`,
        cacheKey: s.cacheKey,
      });
      routes[i] = { action: "COMPRESS", reason: `Compressed into ${id}`, groupId: id };
    });
  }

  // D + E. Everything left: exact relevant context or irrelevant.
  messages.forEach((_, i) => {
    routes[i] ??= relevant(i)
      ? { action: "RETRIEVE", reason: `Relevant (${scores[i].score.toFixed(2)}): ${explain(i)}` }
      : constraintMsgs.has(i)
        ? { action: "RETRIEVE", reason: "Standing constraint/preference kept verbatim (memory line not cheaper)" }
        : notRelevant(i);
  });

  // Expanded retrieval, incremental mode: bring back omitted messages best-scoring first until the budget is spent.
  if (expansion?.incremental) {
    const { minScore } = expansion.incremental;
    const pickable = messages
      .map((_, i) => i)
      .filter((i) => routes[i]!.action === "OMIT" && !routes[i]!.duplicateOf && scores[i].score >= minScore)
      .sort((a, b) => scores[b].score - scores[a].score || b - a);
    for (const i of pickable) if (tok[i] <= budget) restore(i, "Restored by expanded retrieval (next best match within budget)");
  }

  // Lexical retrieval is "insufficient" when only continuity turns matched and the request is short or referential.
  const outsideContinuity = messages.map((_, i) => i).filter((i) => !ann[i].protection && !routes[i]!.continuity);
  const referential = /\b(earlier|before|previous(ly)?|again|remind|recall|remember|we (talked|discussed|decided|said|agreed)|you (said|mentioned|told|suggested)|i (said|mentioned|told)|that|those|the (one|thing|approach|plan|option|idea))\b/i.test(request);
  // An explicit recall request ("remind me what I said at the start") needs meaning-based search even when some words match.
  const recall = /\b(remind me|what did (?:i|we|you)|(?:i|we|you) (?:told|said|mentioned|asked|decided)|at the (?:very )?(?:start|beginning)|earlier|previously|go back to)\b/i.test(request);
  // A referential follow-up needs the semantic pass even with little history: nothing outside the recent turns
  // matched, so the message it points back at can only be found by meaning. (The >= 6 gate below stays as it was.)
  const referentialFollowUp = isReferentialFollowUp(request);
  const followUpNeedsSearch = referentialFollowUp && !semanticMatches && outsideContinuity.length >= 1 && !outsideContinuity.some((i) => relevant(i));
  // A referential object with no compatible antecedent in the recent window: only meaning can say what it refers to (or that nothing does).
  // "Found" describes the deterministic pass, so it is decided BEFORE any semantic choices are folded in below.
  const referentialFound = !!referentialInfo && referentialInfo.selectedIds.length > 0;
  const referentialUnresolved = !!referentialInfo && !referentialFound && outsideContinuity.length >= 1;
  const referentialNeedsSearch = referentialUnresolved && !semanticMatches;
  if (referentialInfo) {
    referentialInfo.needsSearch = referentialUnresolved; // stays true in the recompile that follows a search, so the record shows one was needed
    // A bounded semantic search ran for this request: record what it chose. Chosen messages that are protected are already
    // KEEP (search universe != payload), so this changes the record, never the payload.
    if (semanticMatches) {
      const chosen = Object.keys(semanticMatches).filter((id) => idx.has(id));
      referentialInfo.semanticSelectedIds = chosen;
      referentialInfo.selectedIds = [...new Set([...referentialInfo.selectedIds, ...chosen])];
    }
  }
  // A referential object whose antecedent was found by type has resolved the lexical miss: the generic "few matching words"
  // gates below must not also send the request to a model search.
  const lexicallyInsufficient =
    !referentialFound &&
    (followUpNeedsSearch ||
    referentialNeedsSearch ||
    (outsideContinuity.length >= 6 && !semanticMatches && ((referential && recall) || (!outsideContinuity.some((i) => relevant(i)) && (referential || requestTerms.length <= 2)))));

  const decisions = messages.map((m, i): Decision => {
    const route = routes[i]!;
    const p = ann[i].protection;
    return {
      id: m.id,
      role: m.role,
      preview: preview(m.content),
      tokens: tok[i],
      contentType: ann[i].contentType,
      classMethod: ann[i].classMethod,
      protected: !!p,
      ...(p && { protectionReason: p.reason, protectionMethod: p.method }),
      score: scores[i].score,
      signals: scores[i].signals,
      action: route.action,
      reason: route.reason,
      matched: scores[i].matched,
      ...(route.groupId && { groupId: route.groupId }),
      ...(route.duplicateOf && { duplicateOf: route.duplicateOf }),
      ...(route.continuity && { continuity: true }),
      ...((route.antecedent || referentialInfo?.selectedIds.includes(m.id)) && { antecedent: true }),
    };
  });

  // Compiled context in original order: exact items, compressed groups at their first source, memory block after leading protected items.
  const out: { entry: CompiledEntry; protectedItem: boolean }[] = [];
  const emitted = new Set<string>();
  decisions.forEach((d, i) => {
    if (d.action === "KEEP" || d.action === "RETRIEVE") out.push({ entry: { id: d.id, role: messages[i].role, content: messages[i].content }, protectedItem: d.protected });
    else if (d.action === "COMPRESS" && !emitted.has(d.groupId!)) {
      emitted.add(d.groupId!);
      out.push({ entry: { id: d.groupId!, role: messages[i].role, content: groups.find((g) => g.id === d.groupId)!.summary, section: "compressed" }, protectedItem: false });
    }
  });
  if (memoryBlock.length) {
    const at = out.findIndex((o) => !o.protectedItem);
    out.splice(at === -1 ? out.length : at, 0, { entry: { id: "memory", role: "system", content: formatMemoryBlock(memoryBlock), section: "memory" }, protectedItem: false });
  }
  const compiledContext = out.map((o) => o.entry);

  // Token accounting: each removed token is attributed to exactly one mechanism, so
  // original - compiled = omission + deduplication + compression + memory (memory net of its own block).
  const idsOf = (a: Action) => decisions.flatMap((d, i) => (d.action === a ? [i] : []));
  const omitted = idsOf("OMIT");
  const groupSaving = (g: CompressedGroup) => g.originalTokenEstimate - g.compressedTokenEstimate;
  const savings = {
    omission: sum(omitted.filter((i) => !decisions[i].duplicateOf)),
    deduplication: sum(omitted.filter((i) => decisions[i].duplicateOf)) + groups.filter((g) => g.kind === "duplicate").reduce((s, g) => s + groupSaving(g), 0),
    compression: groups.filter((g) => g.kind !== "duplicate").reduce((s, g) => s + groupSaving(g), 0),
    memory: memoryBlock.length ? sum(idsOf("MEMORY")) - memoryBlockTokens(memoryBlock) : 0,
  };

  const metrics = buildMetrics(messages, compiledContext, request, {
    keepCount: idsOf("KEEP").length,
    memoryCount: idsOf("MEMORY").length,
    retrieveCount: idsOf("RETRIEVE").length,
    compressCount: idsOf("COMPRESS").length,
    omitCount: omitted.length,
    totalItems: n,
  });

  return { decisions, compiledContext, metrics, memoryInjected: memoryBlock, groups, savings, summaryCandidates, lexicallyInsufficient, referentialFollowUp, ...(referentialInfo && { referentialObject: referentialInfo }), requestTerms };
}

// Full-context execution (fallback level 2): every message, in order, nothing removed.
export function fullContext(messages: HistoryMessage[]): CompiledEntry[] {
  return messages.map(({ id, role, content }) => ({ id, role, content }));
}
