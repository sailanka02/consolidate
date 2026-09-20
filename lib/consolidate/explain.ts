// Plain-language view of a stored Context Trace. Pure and client-safe: it only reads persisted trace data and never
// invents numbers. Every card keeps the technical fields it was derived from, so the UI can offer them on demand.
import type { Action, AttemptDecision, AttemptGroup, AttemptMemory, AttemptTrace, ContextTrace, FailureCategory, ReferentialInfo, RetryDecision, RetryKind, Role } from "../types";

export type CardKind = "kept" | "remembered" | "brought_back" | "compressed" | "removed";

export type DecisionCard = {
  key: string;
  kind: CardKind;
  label: string; // KEPT EXACTLY, REMEMBERED, ...
  who: "You" | "Claude" | null;
  headline: string; // what the decision is about, in the user's own words where possible
  detail?: string; // e.g. the remembered value
  why: string;
  impact: string;
  tokens: number | null; // local-estimate tokens of the original message(s); null when a stored trace did not record them
  before?: number;
  after?: number;
  saved?: number;
  source?: string; // memory cards: the message the fact came from
  technical: { action: Action | "MEMORY"; reason: string; score: number | null; signals: AttemptDecision["signals"] | null; matched: string[]; contentType: string | null; classMethod: string | null; protection: string | null; ids: string[]; groupId: string | null; continuity: boolean; duplicateOf: string | null };
};

export const KIND_LABEL: Record<CardKind, string> = { kept: "Kept exactly", remembered: "Remembered", brought_back: "Brought back", compressed: "Compressed", removed: "Removed" };

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n).trimEnd() + "…" : s);
const quote = (s: string) => `“${clip(s.replace(/\s+/g, " ").trim(), 110)}”`;
const humanize = (key: string) => key.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
const who = (role: Role | undefined): "You" | "Claude" | null => (role === "user" ? "You" : role === "assistant" ? "Claude" : null);
const tok = (n: number | null) => (n == null ? "" : `~${n.toLocaleString()} token${n === 1 ? "" : "s"}`);

type Norm = Omit<AttemptDecision, "tokens"> & { tokens: number | null }; // null: a run stored before per-attempt detail did not record every message's tokens
export type Basis = { decisions: Norm[]; groups: AttemptGroup[]; memory: AttemptMemory[]; basis: "attempt" | "reconstructed"; attemptIndex: number; referential?: ReferentialInfo };

// Decisions of one attempt. Runs saved before per-attempt detail existed are rebuilt from the trace's section lists,
// which describe the FINAL compile (so `basis` says so and the UI can label it).
export function decisionBasis(trace: ContextTrace, attemptIndex = 0): Basis {
  const a: AttemptTrace | undefined = trace.evaluation.attempts[attemptIndex];
  if (a?.decisions?.length && a.decisions[0].preview !== undefined) return { decisions: a.decisions as Norm[], groups: a.groups ?? [], memory: a.memoryInjected ?? [], basis: "attempt", attemptIndex, referential: a.referential };

  const prot = new Map(trace.protection.items.map((p) => [p.id, p]));
  const retr = new Map(trace.retrieval.items.map((r) => [r.id, r]));
  const omit = new Map(trace.omission.items.map((o) => [o.id, o]));
  const groupOf = new Map(trace.compression.groups.flatMap((g) => g.sourceIds.map((id) => [id, g] as const)));
  const memOf = new Map(trace.memory.injected.flatMap((m) => m.sourceIds.map((id) => [id, m] as const)));
  const decisions: Norm[] = trace.classification.items.map((c): Norm => {
    const base = { id: c.id, preview: c.preview, contentType: c.contentType, classMethod: c.method, tokens: null as number | null, score: 0 };
    const p = prot.get(c.id);
    if (p) return { ...base, action: "KEEP", reason: p.reason, protected: true, protectionReason: p.reason, protectionMethod: p.method };
    const r = retr.get(c.id);
    if (r) return { ...base, action: "RETRIEVE", reason: r.reason, score: r.score, signals: r.signals, matched: r.matched, continuity: r.continuity };
    const g = groupOf.get(c.id);
    if (g) return { ...base, action: "COMPRESS", reason: `Compressed into ${g.id}`, groupId: g.id };
    const o = omit.get(c.id);
    if (o) return { ...base, action: "OMIT", reason: o.reason, score: o.score, tokens: o.tokens, duplicateOf: o.duplicate ? "another message" : undefined };
    if (memOf.has(c.id)) return { ...base, action: "MEMORY", reason: "Durable statement represented as memory" };
    return { ...base, action: "RETRIEVE", reason: "Kept" };
  });
  const groups: AttemptGroup[] = trace.compression.groups.map((g) => ({ id: g.id, kind: g.kind, method: g.method, sourceIds: g.sourceIds, originalTokens: g.originalTokens, compressedTokens: g.compressedTokens, summary: g.summary, reason: g.reason }));
  const memory: AttemptMemory[] = trace.memory.injected.map((m) => ({ key: m.key, value: m.value, type: m.type, sourceIds: m.sourceIds, memoryTokens: m.memoryTokens }));
  return { decisions, groups, memory, basis: "reconstructed", attemptIndex, referential: trace.retrieval.referential };
}

function whyKept(d: Norm): string {
  const r = d.protectionReason ?? d.reason;
  if (/^explicit user constraint/.test(r)) return "You stated this as a rule or requirement, so Consolidate preserved it word for word.";
  if (/^semantic classifier/.test(r)) return "Consolidate recognized this as a project requirement, so it is preserved exactly.";
  if (/exact code|exact form/.test(r)) return "You asked for this exact wording, so it is never changed.";
  if (/system instruction|application instruction/.test(r)) return "This is a standing instruction, so it is always preserved exactly.";
  return "This looks like something that must not be lost, so it is preserved exactly.";
}

function whyBroughtBack(d: Norm): string {
  const r = d.reason;
  if (/named as missing/.test(r)) return "The quality check found the answer needed this, so it was added back.";
  if (/partner of/.test(r)) return "It is the other half of a question and answer that was added back.";
  if (/^Restored by expanded retrieval/.test(r)) return "It was the best remaining match when the quality check asked for more context.";
  if (d.continuity) return "It is part of the most recent exchange, so it stays to keep the conversation flowing.";
  if (/semantic retrieval/.test(r) || (d.signals?.semantic ?? 0) > 0.5) return "Your request refers back to earlier context, and this is the message it points to.";
  if (/paired with/.test(r)) return "It is the other half of a relevant question and answer.";
  if (/not cheaper|not smaller/.test(r)) return "Kept as written because a short note would not have been smaller.";
  if (/Standing constraint/.test(r)) return "You gave this as a standing preference, so it stays.";
  if (d.matched?.length) return `It shares key words with your request (${d.matched.slice(0, 4).join(", ")}).`;
  return "It looked relevant to your request.";
}

export function buildDecisionCards(basis: Basis): DecisionCard[] {
  const { decisions, groups, memory } = basis;
  const byId = new Map(decisions.map((d) => [d.id, d]));
  const cards: DecisionCard[] = [];
  const tech = (d: Norm | null, extra: Partial<DecisionCard["technical"]> = {}): DecisionCard["technical"] => ({
    action: (d?.action ?? "MEMORY") as DecisionCard["technical"]["action"],
    reason: d?.reason ?? "",
    score: d ? d.score : null,
    signals: d?.signals ?? null,
    matched: d?.matched ?? [],
    contentType: d?.contentType ?? null,
    classMethod: d?.classMethod ?? null,
    protection: d?.protectionReason ? `${d.protectionReason}${d.protectionMethod ? ` (${d.protectionMethod})` : ""}` : null,
    ids: d ? [d.id] : [],
    groupId: d?.groupId ?? null,
    continuity: !!d?.continuity,
    duplicateOf: d?.duplicateOf ?? null,
    ...extra,
  });

  // "these failures": the messages brought back because the request refers to them are ONE card, in the user's terms.
  const ref = basis.referential;
  const antecedents = ref ? decisions.filter((d) => d.action === "RETRIEVE" && d.antecedent) : [];
  if (ref && antecedents.length) {
    const n = antecedents.length;
    const NOUN: Record<ReferentialInfo["kind"], [string, string]> = { error: ["error log", "error logs"], output: ["output", "outputs"], code: ["code message", "code messages"], decision: ["statement", "statements"], any: ["message", "messages"] };
    const DESC: Record<ReferentialInfo["kind"], string> = { error: "error logs you just provided", output: "output you just provided", code: "code you just provided", decision: "statements you made earlier", any: "content you just provided" };
    const tokens = antecedents.reduce((t, d) => t + (d.tokens ?? 0), 0);
    cards.push({
      key: `ref:${ref.phrase}`, kind: "brought_back", label: KIND_LABEL.brought_back, who: null,
      headline: `${n} recent ${NOUN[ref.kind][n === 1 ? 0 : 1]}`,
      why: `Your question says “${ref.phrase}”, which refers to the ${DESC[ref.kind]}.`,
      impact: tokens ? `${tok(tokens)} added because they were relevant` : "Added because they were relevant",
      tokens: tokens || null,
      technical: { action: "RETRIEVE", reason: `referential object "${ref.phrase}" (type: ${ref.kind}); candidate ids: ${ref.candidateIds.join(", ") || "none"}; selected ids: ${ref.selectedIds.join(", ") || "none"}${ref.searchedIds ? `; searched ids: ${ref.searchedIds.join(", ")}` : ""}`, score: null, signals: null, matched: [], contentType: ref.kind, classMethod: ref.semanticSelectedIds ? "semantic" : "deterministic", protection: null, ids: antecedents.map((d) => d.id), groupId: null, continuity: false, duplicateOf: null },
    });
  }
  const grouped = new Set(antecedents.map((d) => d.id));

  for (const d of decisions) {
    if (grouped.has(d.id)) continue;
    if (d.action === "KEEP") {
      cards.push({ key: d.id, kind: "kept", label: KIND_LABEL.kept, who: who(d.role), headline: quote(d.preview ?? ""), why: whyKept(d), impact: d.tokens != null ? `${tok(d.tokens)} retained for safety` : "Retained for safety", tokens: d.tokens, technical: tech(d) });
    } else if (d.action === "RETRIEVE") {
      const flow = d.continuity;
      cards.push({
        key: d.id, kind: "brought_back", label: KIND_LABEL.brought_back, who: who(d.role), headline: quote(d.preview ?? ""), why: whyBroughtBack(d),
        impact: d.tokens == null ? (flow ? "Kept for conversational flow" : "Added because it was relevant") : flow ? `${tok(d.tokens)} kept for conversational flow` : `${tok(d.tokens)} added because they were relevant`,
        tokens: d.tokens, technical: tech(d),
      });
    } else if (d.action === "OMIT") {
      const dup = !!d.duplicateOf;
      cards.push({
        key: d.id, kind: "removed", label: KIND_LABEL.removed, who: who(d.role), headline: quote(d.preview ?? ""),
        why: dup ? "It repeats a message that is already included." : "It was unrelated to your current request and was not a lasting requirement.",
        impact: d.tokens != null ? `Saved ${tok(d.tokens)}` : "Saved tokens", tokens: d.tokens, saved: d.tokens ?? undefined, technical: tech(d),
      });
    }
  }

  for (const g of groups) {
    const n = g.sourceIds.length;
    const repeated = g.kind === "duplicate" || g.kind === "related_logs";
    const first = byId.get(g.sourceIds[0]);
    cards.push({
      key: g.id, kind: "compressed", label: KIND_LABEL.compressed, who: null,
      headline: `${n} older message${n === 1 ? "" : "s"}${first?.preview ? ` starting “${clip(first.preview.replace(/\s+/g, " "), 60)}”` : ""}`,
      why: repeated ? "These were near-identical repeats, so one representative is enough." : "The information was still useful, but the full wording wasn't needed.",
      impact: `Saved ${tok(g.originalTokens - g.compressedTokens)}`, tokens: g.originalTokens, before: g.originalTokens, after: g.compressedTokens, saved: g.originalTokens - g.compressedTokens,
      detail: clip(g.summary.replace(/\s+/g, " "), 240),
      technical: { action: "COMPRESS", reason: g.reason, score: null, signals: null, matched: [], contentType: null, classMethod: g.method, protection: null, ids: g.sourceIds, groupId: g.id, continuity: false, duplicateOf: null },
    });
  }

  for (const m of memory) {
    const replaced = m.sourceIds.map((id) => byId.get(id)).filter((d): d is Norm => !!d && d.action === "MEMORY");
    const originalTokens = replaced.reduce((t, d) => t + (d.tokens ?? 0), 0);
    const src = byId.get(m.sourceIds[0]);
    cards.push({
      key: `mem:${m.key}`, kind: "remembered", label: KIND_LABEL.remembered, who: null, headline: humanize(m.key), detail: m.value,
      why: m.type === "decision" ? "This is a persistent project decision that may matter later." : m.type === "preference" || m.type === "constraint" ? "This is a lasting preference or rule that should keep applying." : "This is a lasting fact that may matter later.",
      impact: replaced.length && originalTokens ? `A ${tok(m.memoryTokens)} note replaced ${tok(originalTokens)}` : `A ${tok(m.memoryTokens)} note carries it`,
      tokens: originalTokens || null, before: originalTokens || undefined, after: m.memoryTokens, source: src?.preview ? quote(src.preview) : undefined,
      technical: { action: "MEMORY", reason: `${m.type} memory item "${m.key}"`, score: null, signals: null, matched: [], contentType: m.type, classMethod: null, protection: null, ids: m.sourceIds, groupId: null, continuity: false, duplicateOf: null },
    });
  }

  const order: Record<CardKind, number> = { kept: 0, remembered: 1, brought_back: 2, compressed: 3, removed: 4 };
  return cards.sort((a, b) => order[a.kind] - order[b.kind]);
}

// ---- summaries ----

export type Quality = { tone: "good" | "warn" | "bad"; label: string; detail: string };
export type TraceSummary = {
  counted: boolean; // provider-counted (true) or a local estimate (false)
  countNote?: string;
  full: number;
  sent: number;
  avoided: number;
  percent: number;
  initialSent: number;
  initialPercent: number;
  fellBack: boolean; // final reduction differs from what the first compile achieved
  quality: Quality;
  fallback: string; // "None" or a plain description
  regenerated: boolean;
  netUsd: number | null;
};

export function summarizeTrace(t: ContextTrace): TraceSummary {
  const c = t.compilation;
  const tc = c.tokenCount;
  const counted = tc?.source === "provider_count";
  const full = tc?.fullTokens ?? c.originalTokenEstimate;
  const sent = tc?.compiledTokens ?? c.compiledTokenEstimate;
  const percent = tc?.reductionPercent ?? c.reductionPercent;
  // Runs saved before initial/final were tracked still stored the first attempt's provider count: use it when both sides are counted.
  const first = t.evaluation.attempts[0];
  const legacyInitial = counted && tc?.initialCompiledTokens == null && first?.countedInputTokens != null ? first.countedInputTokens : null;
  const initialSent = tc?.initialCompiledTokens ?? legacyInitial ?? sent;
  const initialPercent = tc?.initialReductionPercent ?? (legacyInitial != null && full > 0 ? Math.round(((full - legacyInitial) / full) * 1000) / 10 : percent);
  const ev = t.evaluation;
  const last = ev.attempts[ev.attempts.length - 1];
  const regen = ev.attempts.some((a) => a.level === "regenerated");
  const finalPassed = last ? last.passed : ev.status === "PASS";
  const parts: string[] = [];
  const regenAttempt = ev.attempts.findIndex((a) => a.level === "regenerated");
  if (regen) parts.push(ev.attempts[regenAttempt - 1]?.retryDecision?.purpose === "instruction" ? "Regenerated to follow an applicable instruction" : "Response regenerated with the same context");
  if (ev.fallbackLevel === 1) parts.push(ev.attempts.some((a) => a.retryDecision?.decision === "full_fallback") ? "Full fallback" : "More context added");
  if (ev.fallbackLevel === 2) parts.push("Used the full context");
  let quality: Quality;
  if (ev.attempts[0]?.warningOnly) quality = { tone: "warn", label: "Passed with a quality warning", detail: "No context failure detected; the answer was returned as it is" };
  else if (ev.status === "PASS") quality = { tone: "good", label: "Passed", detail: "No fallback required" };
  else if (finalPassed) quality = { tone: "warn", label: "Passed after a retry", detail: parts.join(" · ") || "Retried" };
  else quality = { tone: "bad", label: "Did not pass", detail: parts.length ? `${parts.join(" · ")}; the last answer still failed the check` : "The answer was returned but failed the check" };
  return {
    counted,
    countNote: counted ? undefined : tc?.error ?? (tc ? undefined : "Recorded before provider counting existed"),
    full, sent, avoided: full - sent, percent, initialSent, initialPercent,
    fellBack: Math.abs(initialPercent - percent) > 0.05,
    quality, fallback: parts.length ? parts.join(" · ") : "None", regenerated: regen,
    netUsd: c.costs?.netSavingsUsd ?? null,
  };
}

export type Understanding = { messagesReviewed: number; protectedCount: number; memoryCount: number; followUp: boolean; note?: string; reference?: { phrase: string; kind: ReferentialInfo["kind"]; found: number } };
export function understanding(t: ContextTrace): Understanding {
  const r = t.retrieval.referential;
  return {
    messagesReviewed: t.requestAnalysis.historyScanned,
    protectedCount: t.protection.items.length,
    memoryCount: t.memory.totalActive,
    followUp: /follow-up/i.test(t.retrieval.semanticNote ?? ""),
    note: t.retrieval.semanticNote,
    ...(r && { reference: { phrase: r.phrase, kind: r.kind, found: r.selectedIds.length } }),
  };
}

export function decisionCounts(cards: DecisionCard[], basis: Basis) {
  const n = (k: CardKind) => cards.filter((c) => c.kind === k);
  const sum = (k: CardKind) => n(k).reduce((t, c) => t + (c.saved ?? 0), 0);
  return {
    kept: n("kept").length,
    remembered: n("remembered").length,
    brought_back: n("brought_back").length,
    // A compressed card stands for several messages; count the messages, as the user thinks in messages.
    compressed: basis.groups.reduce((t, g) => t + g.sourceIds.length, 0),
    removed: n("removed").length,
    savedByRemoval: sum("removed"),
    savedByCompression: sum("compressed"),
  };
}

// ---- attempts ----

export const CATEGORY_LABEL: Record<FailureCategory, string> = {
  PASS: "Passed",
  MISSING_CONTEXT: "Missing context",
  ANSWER_QUALITY: "Answer quality",
  INSTRUCTION_VIOLATION: "Instruction not followed",
  UNSUPPORTED_CLAIM: "Unsupported claim",
  UNCERTAIN: "Could not be confirmed",
  CHECK_FAILED: "A safety check failed",
};

const LEVEL_TITLE: Record<AttemptTrace["level"], string> = {
  optimized: "Optimized context",
  regenerated: "Response regenerated with the same context",
  expanded: "More context added",
  full: "Full context",
};

export type AttemptView = {
  n: number;
  level: AttemptTrace["level"];
  title: string;
  full: number | null;
  sent: number;
  counted: boolean;
  percent: number | null;
  passed: boolean;
  category: FailureCategory;
  verdict: string;
  why: string | null;
  added: { title: string; tokens: number }[] | null;
  addedTokens: number;
  routing: AttemptTrace["routing"] | null;
  response: string;
  isFinal: boolean;
  // What the engine decided after this attempt, stated plainly (never inferred from other fields).
  recovery: { needed: string | null; added: { title: string; representation: string; tokens: number; kind: string; why: string; skipped: boolean }[]; tokensAdded: number; exceeded: boolean; budget: number } | null;
  retry: { decision: RetryKind; label: string; reason: string; contextChanged: boolean; expectedCostUsd: number | null } | null;
  warning: string | null;
};

const RETRY_LABEL = (d: RetryDecision): string =>
  d.decision === "context_expansion" ? "More context added" : d.decision === "full_fallback" ? "Full fallback" : d.decision === "corrective_regeneration" ? (d.purpose === "instruction" ? "Regenerated to follow an applicable instruction" : "Response regenerated with the same context") : "No retry";

export function buildAttempts(t: ContextTrace): AttemptView[] {
  const previews = new Map<string, string>([...t.classification.items.map((i) => [i.id, i.preview] as const), ...t.evaluation.attempts.flatMap((a) => (a.decisions ?? []).map((d) => [d.id, d.preview ?? ""] as const))]);
  return t.evaluation.attempts.map((a, i, all) => {
    // Older runs did not store the full count per attempt; the run-level provider count is the same number.
    const fullCounted = a.fullCountedTokens ?? (t.compilation.tokenCount?.source === "provider_count" ? t.compilation.tokenCount.fullTokens : null);
    const counted = a.countedInputTokens != null && fullCounted != null;
    const category = (a.failureCategory ?? (a.passed ? "PASS" : "UNCERTAIN")) as FailureCategory;
    const semantic = a.checks.filter((c) => !c.passed && c.layer === "semantic" && c.reason).map((c) => c.reason!);
    const failing = a.checks.filter((c) => !c.passed).map((c) => c.reason || c.name);
    return {
      n: i + 1,
      level: a.level,
      title: a.level === "regenerated" && all[i - 1]?.retryDecision?.purpose === "instruction" ? "Regenerated to follow an applicable instruction" : a.level === "expanded" && all[i - 1]?.retryDecision?.decision === "full_fallback" ? "Full fallback" : LEVEL_TITLE[a.level],
      full: counted ? fullCounted : null,
      sent: counted ? a.countedInputTokens! : a.contextTokens,
      counted,
      percent: a.reductionPercent ?? (counted && fullCounted! > 0 ? Math.round(((fullCounted! - a.countedInputTokens!) / fullCounted!) * 1000) / 10 : null),
      passed: a.passed,
      category,
      verdict: CATEGORY_LABEL[category],
      why: a.passed ? null : (semantic.length ? semantic : failing).join(" ") || a.reason,
      added: a.contextAdded ? a.contextAdded.map((x) => ({ title: previews.get(x.id) ? quote(previews.get(x.id)!) : x.id, tokens: x.tokens })) : null,
      addedTokens: a.contextAdded?.reduce((s, x) => s + x.tokens, 0) ?? 0,
      routing: a.routing ?? null,
      response: a.response,
      isFinal: i === all.length - 1,
      recovery: a.expansion ? { needed: a.expansion.needed ?? null, added: a.expansion.items.map((x) => ({ title: quote(x.preview), representation: x.representation, tokens: x.tokens, kind: x.kind, why: x.why, skipped: !!x.skipped })), tokensAdded: a.expansion.usedTokens, exceeded: a.expansion.exceededByRequired, budget: a.expansion.budgetTokens } : null,
      retry: a.retryDecision ? { decision: a.retryDecision.decision, label: a.warningOnly ? "Quality warning — no context failure detected" : RETRY_LABEL(a.retryDecision), reason: a.retryDecision.reason, contextChanged: a.retryDecision.contextChanged, expectedCostUsd: a.retryDecision.expectedRetryCostUsd } : null,
      warning: a.warningOnly ? (a.qualityWarning ?? "Quality warning — no context failure detected") : null,
    };
  });
}
