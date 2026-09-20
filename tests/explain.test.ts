// Plain-language explanations, summaries and attempt views built from stored traces and dashboard statistics.
import { beforeEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { compileContext, type CompileInput } from "@/lib/consolidate/compile";
import { buildAttempts, buildDecisionCards, decisionBasis, decisionCounts, summarizeTrace, understanding, type Basis } from "@/lib/consolidate/explain";
import { memoryLineTokens } from "@/lib/consolidate/memory";
import { openDatabase } from "@/lib/db";
import * as repo from "@/lib/db/repo";
import { runTurn } from "@/lib/engine/turn";
import type { ContextTrace } from "@/lib/types";
import { DEMO, FakeProvider, prepare, type Script } from "./helpers";

const { messages, memory } = prepare(DEMO);
const basisOf = (input: Omit<CompileInput, "messages" | "memory">): Basis => {
  const r = compileContext({ messages, memory, ...input });
  return {
    basis: "attempt",
    attemptIndex: 0,
    decisions: r.decisions.map((d) => ({ id: d.id, action: d.action, tokens: d.tokens, score: d.score, reason: d.reason, role: d.role, preview: d.preview, contentType: d.contentType, classMethod: d.classMethod, protected: d.protected, protectionReason: d.protectionReason, protectionMethod: d.protectionMethod, signals: d.signals, matched: d.matched, continuity: d.continuity, groupId: d.groupId, duplicateOf: d.duplicateOf })),
    groups: r.groups.map((g) => ({ id: g.id, kind: g.kind, method: g.method, sourceIds: g.sourceIds, originalTokens: g.originalTokenEstimate, compressedTokens: g.compressedTokenEstimate, summary: g.summary, reason: g.reason })),
    memory: r.memoryInjected.map((m) => ({ key: m.key, value: m.value, type: m.type, sourceIds: m.sourceIds, memoryTokens: memoryLineTokens(m) })),
  };
};

describe("decision cards: every routing decision has a plain-English version", () => {
  it("KEPT EXACTLY explains protection in the user's terms", () => {
    const cards = buildDecisionCards(basisOf({ request: "Which region is production in and how is connection pooling handled?" }));
    const kept = cards.filter((c) => c.kind === "kept");
    expect(kept.length).toBeGreaterThan(0);
    for (const c of kept) {
      expect(c.label).toBe("Kept exactly");
      expect(c.why).toMatch(/preserved|preserves|always|never changed/);
      expect(c.impact).toMatch(/retained for safety/);
      expect(c.technical.action).toBe("KEEP");
      expect(c.technical.protection).toBeTruthy(); // the rule name stays available behind the expander
    }
    expect(kept.some((c) => /rule or requirement/.test(c.why))).toBe(true);
  });

  it("REMEMBERED shows the fact, where it came from, and what the note replaced", () => {
    const cards = buildDecisionCards(basisOf({ request: "Which region is production in and how is connection pooling handled?" }));
    const region = cards.find((c) => c.kind === "remembered" && /region/i.test(c.headline))!;
    expect(region).toBeDefined();
    expect(region.label).toBe("Remembered");
    expect(region.detail).toBe("eu-west-1");
    expect(region.why).toMatch(/lasting|persistent/);
    expect(region.source).toMatch(/region/i);
    expect(region.before!).toBeGreaterThan(region.after!);
    expect(region.impact).toMatch(/note replaced/);
    expect(region.technical.action).toBe("MEMORY");
  });

  it("BROUGHT BACK says why: conversational flow or relevance", () => {
    const cards = buildDecisionCards(basisOf({ request: "Why is the navbar dropdown flickering?" }));
    const back = cards.filter((c) => c.kind === "brought_back");
    expect(back.length).toBeGreaterThan(0);
    expect(back.some((c) => /most recent exchange|shares key words|refers back/.test(c.why))).toBe(true);
    for (const c of back) expect(c.technical.action).toBe("RETRIEVE");
  });

  it("COMPRESSED reports before, after and saved tokens", () => {
    const cards = buildDecisionCards(basisOf({ request: "What's causing the PostgreSQL connection failure?" }));
    const c = cards.find((x) => x.kind === "compressed")!;
    expect(c).toBeDefined();
    expect(c.label).toBe("Compressed");
    expect(c.before! - c.after!).toBe(c.saved);
    expect(c.saved!).toBeGreaterThan(0);
    expect(c.why).toMatch(/repeats|wasn't needed/);
    expect(c.technical.ids.length).toBeGreaterThan(1);
  });

  it("REMOVED explains unrelated and duplicate messages and the tokens saved", () => {
    const cards = buildDecisionCards(basisOf({ request: "Why is the navbar dropdown flickering?" }));
    const removed = cards.filter((c) => c.kind === "removed");
    expect(removed.some((c) => /unrelated to your current request/.test(c.why))).toBe(true);
    expect(removed.some((c) => /repeats a message/.test(c.why))).toBe(true);
    for (const c of removed) expect(c.impact).toMatch(/^Saved ~\d/);
  });

  it("counts every message and keeps technical fields out of the primary text", () => {
    const basis = basisOf({ request: "What's causing the PostgreSQL connection failure?" });
    const cards = buildDecisionCards(basis);
    const counts = decisionCounts(cards, basis);
    const routed = basis.decisions.filter((d) => d.action !== "COMPRESS" && d.action !== "MEMORY").length;
    expect(counts.kept + counts.brought_back + counts.removed).toBe(routed);
    for (const c of cards) for (const text of [c.label, c.why, c.impact]) expect(text).not.toMatch(/\b(KEEP|RETRIEVE|OMIT|COMPRESS|score|lexical)\b/);
  });
});

// ---- real runs through the engine ----

let db: DatabaseSync;
let convId: string;
beforeEach(() => {
  db = openDatabase(":memory:");
  convId = repo.createConversation(db).id;
});
const isRaw = (r: { mode?: string }) => r.mode === "raw";
const filler = (n: number) => `Answer ${n}. ` + "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda. ".repeat(20);
const verdict = (category: string, o: { missing?: string[]; failing?: string; reason?: string } = {}) =>
  JSON.stringify({ criteria: [{ name: o.failing ?? "answers_request", pass: !o.failing, reason: o.reason ?? "ok" }], category, missing_ids: o.missing ?? [] });
function provider(request: string, judge: (call: number) => string) {
  let evals = 0;
  const script: Script = (req, n) => {
    if (isRaw(req)) {
      if (req.request.includes("evaluating an AI assistant")) return req.request.includes(request) ? judge(++evals) : verdict("PASS");
      if (req.request.includes("context-management")) return '{"results":[]}';
      return "{}";
    }
    return filler(n);
  };
  return new FakeProvider(script, { api: {} });
}
const seed = async (p: FakeProvider) => {
  for (const t of ["i must use react for this", "Tell me about the moon landing with dates.", "Explain how transistors work with analogies.", "Describe the history of bicycles in some detail.", "Explain what a monad is in functional programming."]) await runTurn(db, p, { conversationId: convId, content: t });
};

describe("trace summary and attempts from real runs", () => {
  it("a passing run: provider-counted numbers, no fallback, cards for every kind that applies", async () => {
    const request = "whats a hackathon";
    const p = provider(request, () => verdict("PASS"));
    await seed(p);
    const out = await runTurn(db, p, { conversationId: convId, content: request });
    const t = repo.getRun(db, out.run.id)!.trace;
    const s = summarizeTrace(t);
    expect(s).toMatchObject({ counted: true, full: out.run.originalTokens, sent: out.run.compiledTokens, avoided: out.run.tokensAvoided, percent: out.run.reductionPercent, fellBack: false, fallback: "None" });
    expect(s.quality).toMatchObject({ tone: "good", label: "Passed" });
    const basis = decisionBasis(t, 0);
    expect(basis.basis).toBe("attempt");
    const cards = buildDecisionCards(basis);
    const kept = cards.find((c) => c.kind === "kept")!;
    expect(kept.headline).toContain("i must use react for this");
    expect(kept.why).toMatch(/rule or requirement/);
    expect(cards.filter((c) => c.kind === "kept").length + cards.filter((c) => c.kind === "brought_back").length + cards.filter((c) => c.kind === "removed").length).toBe(10); // every message has a card
    expect(cards.filter((c) => c.kind === "removed").length).toBe(7);
    expect(cards.filter((c) => c.kind === "brought_back").every((c) => /most recent exchange/.test(c.why))).toBe(true);
    const u = understanding(t);
    expect(u).toMatchObject({ messagesReviewed: 10, protectedCount: 1 });
  });

  it("a fallback run keeps attempt 1 visible and explains what attempt 2 added", async () => {
    const request = "Tell me something else interesting.";
    const p = provider(request, (call) => {
      if (call > 1) return verdict("PASS");
      const msgs = repo.listMessages(db, convId);
      const i = msgs.findIndex((m) => m.content.startsWith("Tell me about the moon"));
      return verdict("MISSING_CONTEXT", { failing: "no_missing_context", reason: "The answer ignores the moon landing question.", missing: [msgs[i + 1].id] });
    });
    await seed(p);
    const out = await runTurn(db, p, { conversationId: convId, content: request });
    const t = repo.getRun(db, out.run.id)!.trace;
    const s = summarizeTrace(t);
    expect(s.fellBack).toBe(true);
    expect(s.initialPercent).toBeGreaterThan(s.percent);
    expect(s.percent).toBeGreaterThan(0);
    expect(s.quality).toMatchObject({ tone: "warn", label: "Passed after a retry" });
    expect(s.fallback).toBe("Added more context");

    const [a1, a2] = buildAttempts(t);
    expect(a1).toMatchObject({ n: 1, verdict: "Missing context", passed: false, counted: true, isFinal: false });
    expect(a1.why).toContain("ignores the moon landing");
    expect(a1.percent).toBe(out.run.initialReductionPercent);
    expect(a2).toMatchObject({ n: 2, verdict: "Passed", passed: true, isFinal: true, title: "Added more context" });
    expect(a2.sent).toBeGreaterThan(a1.sent);
    expect(a2.added).toHaveLength(2);
    expect(a2.added![0].title).toMatch(/moon/i);
    expect(a2.percent).toBe(out.run.finalReductionPercent);
    // the first attempt's decisions are the ones the cards describe, not the expanded compile
    const cards = buildDecisionCards(decisionBasis(t, 0));
    expect(cards.filter((c) => c.kind === "removed").length).toBeGreaterThan(buildDecisionCards(decisionBasis(t, 1)).filter((c) => c.kind === "removed").length);
  });

  it("a regeneration is described as the same context asked again", async () => {
    const request = "Tell me something else interesting.";
    const p = provider(request, (call) => (call === 1 ? verdict("ANSWER_QUALITY", { failing: "answers_request", reason: "Too vague." }) : verdict("PASS")));
    await seed(p);
    const out = await runTurn(db, p, { conversationId: convId, content: request });
    const t = repo.getRun(db, out.run.id)!.trace;
    const [a1, a2] = buildAttempts(t);
    expect(a1.verdict).toBe("Answer quality");
    expect(a2).toMatchObject({ title: "Same context, asked again", added: [], passed: true });
    expect(summarizeTrace(t)).toMatchObject({ regenerated: true, fallback: "Regenerated once" });
  });

  it("older runs without per-attempt detail are rebuilt from the stored sections and say so", async () => {
    const request = "whats a hackathon";
    const p = provider(request, () => verdict("PASS"));
    await seed(p);
    const out = await runTurn(db, p, { conversationId: convId, content: request });
    const t = JSON.parse(JSON.stringify(repo.getRun(db, out.run.id)!.trace)) as ContextTrace;
    for (const a of t.evaluation.attempts) {
      delete a.decisions;
      delete a.groups;
      delete a.memoryInjected;
    }
    const basis = decisionBasis(t, 0);
    expect(basis.basis).toBe("reconstructed");
    const cards = buildDecisionCards(basis);
    expect(cards.find((c) => c.kind === "kept")!.headline).toContain("i must use react for this");
    expect(cards.filter((c) => c.kind === "removed").length).toBe(7);
    expect(cards.find((c) => c.kind === "removed")!.impact).toMatch(/^Saved ~\d/);
  });

  it("recovers the initial reduction of a run saved before initial/final tracking, from stored provider counts only", async () => {
    const request = "Tell me something else interesting.";
    const p = provider(request, (call) => {
      if (call > 1) return verdict("PASS");
      const msgs = repo.listMessages(db, convId);
      const i = msgs.findIndex((m) => m.content.startsWith("Tell me about the moon"));
      return verdict("MISSING_CONTEXT", { failing: "no_missing_context", missing: [msgs[i + 1].id] });
    });
    await seed(p);
    const out = await runTurn(db, p, { conversationId: convId, content: request });
    const t = JSON.parse(JSON.stringify(repo.getRun(db, out.run.id)!.trace)) as ContextTrace;
    // Strip everything a pre-tracking run lacked.
    const tc = t.compilation.tokenCount as Partial<NonNullable<typeof t.compilation.tokenCount>>;
    delete tc.initialCompiledTokens;
    delete tc.initialReductionPercent;
    for (const a of t.evaluation.attempts) {
      delete a.fullCountedTokens;
      delete a.reductionPercent;
    }
    const s = summarizeTrace(t);
    expect(s.initialSent).toBe(t.evaluation.attempts[0].countedInputTokens);
    expect(s.initialPercent).toBeCloseTo(out.run.initialReductionPercent, 1);
    expect(s.fellBack).toBe(true);
    const [a1, a2] = buildAttempts(t);
    expect(a1.percent).toBeCloseTo(out.run.initialReductionPercent, 1);
    expect(a2.percent).toBeCloseTo(out.run.finalReductionPercent, 1);
    expect(a1.full).toBe(out.run.originalTokens);
  });

  it("labels estimated numbers as estimated when provider counting is unavailable", async () => {
    const request = "whats a hackathon";
    const script: Script = (req, n) => (isRaw(req) ? (req.request.includes("evaluating an AI assistant") ? verdict("PASS") : '{"results":[]}') : filler(n));
    const p = new FakeProvider(script); // no countTokens
    await seed(p);
    const out = await runTurn(db, p, { conversationId: convId, content: request });
    const s = summarizeTrace(repo.getRun(db, out.run.id)!.trace);
    expect(s.counted).toBe(false);
    expect(s.countNote).toMatch(/no token-counting endpoint/);
  });
});

describe("dashboard statistics", () => {
  it("reports where time goes and pass rates after retries, without inventing time savings", async () => {
    const request = "Tell me something else interesting.";
    const p = provider(request, (call) => (call === 1 ? verdict("ANSWER_QUALITY", { failing: "answers_request" }) : verdict("PASS")));
    await seed(p);
    await runTurn(db, p, { conversationId: convId, content: request });
    const s = repo.dashboardStats(db);
    expect(s.requests).toBe(6);
    expect(s.evaluationPassRate).toBeCloseTo(5 / 6);
    expect(s.finalPassRate).toBe(1); // the regenerated answer passed
    expect(s.regeneratedCount).toBe(1);
    expect(s.fallbackCount).toBe(0);
    expect(s.avgTokenCountLatencyMs).not.toBeNull();
    expect(s.avgOptimizerLatencyMs).not.toBeNull();
    expect(s.benchmark).toBeNull(); // no baseline was generated, so no time is claimed as saved
  });

  it("computes benchmark time savings only from runs with both a baseline and a Consolidate answer", async () => {
    const p = provider("zzz", () => verdict("PASS"));
    await seed(p);
    const r = await runTurn(db, p, { conversationId: convId, content: "whats a hackathon", benchmark: true });
    expect(repo.dashboardStats(db).benchmark).toMatchObject({ runs: 1 });
    // Fix the recorded latencies so the arithmetic is checkable: baseline 5s, Consolidate 3s.
    const bench = JSON.parse((db.prepare("SELECT benchmark_json FROM compiler_run WHERE id = ?").get(r.run.id) as { benchmark_json: string }).benchmark_json);
    bench.full.modelLatencyMs = 5000;
    bench.consolidate.modelLatencyMs = 3000;
    db.prepare("UPDATE compiler_run SET benchmark_json = ? WHERE id = ?").run(JSON.stringify(bench), r.run.id);
    expect(repo.dashboardStats(db).benchmark).toEqual({ runs: 1, baselineMs: 5000, consolidatedMs: 3000, savedMs: 2000, avgSavedMs: 2000 });
    // A baseline that failed to generate must not count.
    db.prepare("UPDATE compiler_run SET benchmark_json = ? WHERE id = ?").run(JSON.stringify({ full: null, consolidate: bench.consolidate, baselineError: "boom" }), r.run.id);
    expect(repo.dashboardStats(db).benchmark).toBeNull();
  });
});
