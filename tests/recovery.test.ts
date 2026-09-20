// MISSING_CONTEXT recovery restores the MINIMUM information that repairs the identified omission: the named source in the
// cheapest faithful form, a partner only when it is needed to interpret it, everything under one budget, and the initial
// compile's other decisions (compression included) left alone. Correctness first: nothing here weakens the safe path.
import { beforeEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { compileContext, EXPAND_TOKEN_BUDGET, FULL_EQUIVALENT_RATIO } from "@/lib/consolidate/compile";
import { buildAttempts, summarizeTrace } from "@/lib/consolidate/explain";
import { requiredPartner } from "@/lib/consolidate/partner";
import { openDatabase } from "@/lib/db";
import * as repo from "@/lib/db/repo";
import { runTurn } from "@/lib/engine/turn";
import type { ModelRequest } from "@/lib/model";
import { DEMO, FakeProvider, prepare, type Script } from "./helpers";

const REQUEST = "zzzz qqqq";
const pad = (chars: number, seed: string) => `${seed} ` + "lorem ipsum dolor sit amet consectetur. ".repeat(Math.ceil(chars / 40));
type Row = ["user" | "assistant", string];
const compile = (rows: Row[], expansion?: Parameters<typeof compileContext>[0]["expansion"], extra: Partial<Parameters<typeof compileContext>[0]> = {}) => {
  const { messages, memory } = prepare(rows.map(([role, content], i) => ({ id: `m${i}`, role, content })));
  return compileContext({ messages, memory, request: REQUEST, expansion, ...extra });
};
const restored = (r: ReturnType<typeof compileContext>) => r.decisions.filter((d) => d.reason.startsWith("Restored")).map((d) => d.id);

describe("requiredPartner: a partner only when the named message cannot be interpreted without it", () => {
  const m = (role: "user" | "assistant", content: string) => ({ role, content });
  it("assistant -> user: a short, context-dependent answer needs the question", () => {
    const hist = [m("user", "Which of these three options should I use for the database?"), m("assistant", "The second one.")];
    expect(requiredPartner(hist, 1)).toMatchObject({ index: 0 });
    expect(requiredPartner([hist[0], m("assistant", "Yes, that works well for this.")], 1)).toMatchObject({ index: 0 });
    expect(requiredPartner([hist[0], m("assistant", "As you asked, here are the trade-offs between the three options in detail.")], 1)).toMatchObject({ index: 0 });
  });
  it("assistant -> user: a self-contained answer does not, even though it is adjacent", () => {
    expect(requiredPartner([m("user", "What database should I use?"), m("assistant", "PostgreSQL 16, because it has the extensions you need and mature tooling.")], 1)).toBeNull();
    expect(requiredPartner([m("user", "Explain B-trees."), m("assistant", "A B-tree is a self-balancing tree that keeps data sorted. " + "It has many properties. ".repeat(20))], 1)).toBeNull();
  });
  it("user -> assistant: a short reply needs the assistant message it answers; a self-contained question needs nothing", () => {
    const hist = [m("assistant", "I can scaffold it with Ink or with Blessed. Which do you prefer?"), m("user", "The second one.")];
    expect(requiredPartner(hist, 1)).toMatchObject({ index: 0 });
    expect(requiredPartner([hist[0], m("user", "Yes, do that.")], 1)).toMatchObject({ index: 0 });
    expect(requiredPartner([m("assistant", "Happy to help."), m("user", "What database should I use for the metadata store?")], 1)).toBeNull();
    expect(requiredPartner([m("assistant", "Ready."), m("user", "Please write the whole plugin loader with tests and docs for the CLI project.")], 1)).toBeNull();
  });
  it("never invents a partner at the edges or across the same role", () => {
    expect(requiredPartner([m("assistant", "The second one.")], 0)).toBeNull();
    expect(requiredPartner([m("user", "Which?"), m("user", "The second one.")], 1)).toBeNull();
  });
});

describe("A-B. partner restoration is conditional", () => {
  it("A. a named self-contained assistant message comes back alone; its user question is not added", () => {
    const rows: Row[] = [["user", pad(120, "unique0 question about apples")], ["assistant", pad(800, "unique1 answer about apples")], ["user", pad(60, "unique2 other")], ["assistant", pad(60, "unique3 other")], ["user", "ok"], ["assistant", "ok"]];
    const r = compile(rows, { includeIds: ["m1"], tokenBudget: 800 });
    expect(restored(r)).toEqual(["m1"]);
    expect(r.decisions.find((d) => d.id === "m0")!.action).toBe("OMIT"); // the adjacent question stays out
    expect(r.expansionReport!.items).toMatchObject([{ id: "m1", kind: "named", representation: "original" }]);
  });

  it("B. 'The second one' cannot be read without its question: the user message comes back too, with the reason", () => {
    const rows: Row[] = [["user", "Which of these three options should I use for the database?"], ["assistant", "The second one."], ["user", pad(60, "unique2 other")], ["assistant", pad(60, "unique3 other")], ["user", "ok"], ["assistant", "ok"]];
    const r = compile(rows, { includeIds: ["m1"], tokenBudget: 800 });
    expect(restored(r).sort()).toEqual(["m0", "m1"]);
    const partner = r.expansionReport!.items.find((x) => x.kind === "partner")!;
    expect(partner).toMatchObject({ id: "m0", role: "user", representation: "original" });
    expect(partner.why).toMatch(/only makes sense next to the question it answers/);
    expect(r.decisions.find((d) => d.id === "m0")!.reason).toMatch(/needed to interpret m1/);
  });

  it("B. the other direction: a named short user reply brings back the assistant message it answers", () => {
    const rows: Row[] = [["assistant", "I can scaffold it with Ink or with Blessed. Which do you prefer?"], ["user", "The second one."], ["assistant", pad(60, "unique2 other")], ["user", pad(60, "unique3 other")], ["assistant", "ok"], ["user", "ok"]];
    const r = compile(rows, { includeIds: ["m1"], tokenBudget: 800 });
    expect(restored(r).sort()).toEqual(["m0", "m1"]);
    expect(r.expansionReport!.items.find((x) => x.kind === "partner")!.why).toMatch(/short reply/);
  });

  it("B. a named self-contained user question does not drag in the answer that follows it", () => {
    const rows: Row[] = [["user", pad(120, "unique0 What database should I use for the metadata store")], ["assistant", pad(800, "unique1 PostgreSQL 16 because")], ["user", "ok"], ["assistant", "ok"], ["user", "ok2"], ["assistant", "ok2"]];
    expect(restored(compile(rows, { includeIds: ["m0"], tokenBudget: 800 }))).toEqual(["m0"]);
  });
});

describe("C-D. one budget for everything restored", () => {
  const big = (n: number, seed: string): Row => ["assistant", pad(n, seed)];
  it("C. a named id counts against the budget: a second named source that no longer fits is not restored", () => {
    const rows: Row[] = [["user", "ok"], big(2400, "unique1 first"), ["user", "ok2"], big(1200, "unique3 second"), ["user", "ok3"], ["assistant", "ok3"], ["user", "ok4"], ["assistant", "ok4"]];
    const r = compile(rows, { includeIds: ["m1", "m3"], tokenBudget: 800 });
    expect(restored(r)).toEqual(["m1"]); // ~604 used, ~304 more would not fit in the remaining ~196
    const skipped = r.expansionReport!.items.find((x) => x.id === "m3")!;
    expect(skipped).toMatchObject({ skipped: true, tokens: 0 });
    expect(r.expansionReport!.usedTokens).toBeLessThanOrEqual(EXPAND_TOKEN_BUDGET);
    expect(r.expansionReport!.exceededByRequired).toBe(false);
  });

  it("D. a named source larger than the budget is still restored (never dropped), and then nothing unrelated is added", () => {
    const rows: Row[] = [["user", "Which of these three options should I use?"], ["assistant", "The second one."], ["user", "unrelated words alpha"], ["assistant", pad(200, "unique3 beta")], ["user", "ok"], ["assistant", "ok"]];
    // budget 5: the ~8-token named answer alone exceeds it. Its required partner and the scored extras must stay out.
    const r = compile(rows, { includeIds: ["m1"], tokenBudget: 5, incremental: { minScore: 0 } });
    expect(restored(r)).toEqual(["m1"]);
    expect(r.expansionReport).toMatchObject({ exceededByRequired: true });
    expect(r.expansionReport!.usedTokens).toBeGreaterThan(5);
    expect(r.decisions.find((d) => d.id === "m0")!.action).toBe("OMIT"); // even the (otherwise required) partner: budget closed
    expect(r.expansionReport!.items.filter((x) => x.kind === "scored")).toHaveLength(0);
  });

  it("scored extras spend what is left of the SAME budget, best first", () => {
    const rows: Row[] = [["user", "ok"], big(1200, "unique1 named"), ["user", "ok2"], big(320, "unique3 extra one"), ["user", "ok3"], big(320, "unique5 extra two"), ["user", "ok4"], ["assistant", "ok4"]];
    const r = compile(rows, { includeIds: ["m1"], tokenBudget: 800, incremental: { minScore: 0 } });
    expect(r.expansionReport!.usedTokens).toBeLessThanOrEqual(EXPAND_TOKEN_BUDGET);
    expect(r.expansionReport!.items[0]).toMatchObject({ id: "m1", kind: "named" });
  });
});

describe("E-F. representation before the full original", () => {
  it("E. information that exists as memory comes back as a memory note, not as the full original message", () => {
    const { messages, memory } = prepare(DEMO);
    const base = compileContext({ messages, memory, request: "Why is the navbar dropdown flickering?" });
    expect(base.decisions.find((d) => d.id === "m96")!.action).not.toBe("MEMORY"); // omitted for an unrelated request
    const r = compileContext({ messages, memory, request: "Why is the navbar dropdown flickering?", expansion: { includeIds: ["m96"], tokenBudget: 800 } });
    expect(r.decisions.find((d) => d.id === "m96")!.action).toBe("MEMORY");
    expect(r.memoryInjected.map((m) => m.key)).toContain("production_region");
    expect(r.compiledContext.some((c) => c.id === "m96")).toBe(false); // the original is not duplicated in the payload
    expect(r.compiledContext.find((c) => c.section === "memory")!.content).toMatch(/production_region: eu-west-1/);
    const item = r.expansionReport!.items.find((x) => x.id === "m96")!;
    expect(item.representation).toBe("memory");
    expect(item.tokens).toBeLessThan(messages.find((m) => m.id === "m96")!.content.length / 4 + 4);
  });

  it("E. an existing faithful cached summary is used instead of the original", () => {
    const rows: Row[] = [["user", "ok"], ["assistant", pad(2000, "unique1 long assistant message")], ["user", "ok2"], ["assistant", "ok2"], ["user", "ok3"], ["assistant", "ok3"]];
    const summary = "Long assistant message: summary of the lorem ipsum discussion.";
    const r = compile(rows, { includeIds: ["m1"], tokenBudget: 800 }, { summaries: { m1: { summary, cacheKey: "k" } } });
    expect(r.decisions.find((d) => d.id === "m1")!.action).toBe("COMPRESS");
    expect(r.compiledContext.some((c) => c.content === summary && c.section === "compressed")).toBe(true);
    expect(r.compiledContext.some((c) => c.id === "m1")).toBe(false);
    expect(r.expansionReport!.items.find((x) => x.id === "m1")).toMatchObject({ representation: "compressed" });
  });

  it("F. a named source that is protected and already in the payload is not duplicated", () => {
    const { messages, memory } = prepare(DEMO);
    const r = compileContext({ messages, memory, request: "Why is the navbar dropdown flickering?", expansion: { includeIds: ["m2"], tokenBudget: 800 } });
    expect(r.decisions.find((d) => d.id === "m2")!.action).toBe("KEEP");
    expect(r.compiledContext.filter((c) => c.id === "m2")).toHaveLength(1);
    expect(r.expansionReport!.items[0]).toMatchObject({ id: "m2", representation: "already_in_payload", tokens: 0 });
    expect(r.expansionReport!.usedTokens).toBe(0);
  });

  // The real cause of the turn-7 loss: expansion mode skipped the discussion summarizer, so a relevant message that had been
  // COMPRESSED came back verbatim (and its group was destroyed). Recovery is a delta on the initial compile.
  const sent = (n: number) => `The database migration strategy for step ${n} should use expand and contract so that the schema change is backward compatible. Each migration needs a rollback plan and a verification query. Teams often forget the rollback plan until the migration fails in production. `;
  const discussion: Row[] = [["user", "unique0 " + sent(1).repeat(3)], ["assistant", "unique1 " + sent(2).repeat(4)], ["user", "ok"], ["assistant", "ok"], ["user", "unrelatedwords " + "x".repeat(600)], ["assistant", "unrelatedtail " + "y".repeat(600)], ["user", "fine"], ["assistant", "fine"]];
  const req = "explain the database migration strategy";
  const build = (expansion?: Parameters<typeof compileContext>[0]["expansion"]) => {
    const { messages, memory } = prepare(discussion.map(([role, content], i) => ({ id: `m${i}`, role, content })));
    return compileContext({ messages, memory, request: req, expansion });
  };

  it("recovery keeps the initial compile's compression: a compressed message is not silently restored in full", () => {
    const base = build();
    expect(["m0", "m1"].map((id) => base.decisions.find((d) => d.id === id)!.action)).toEqual(["COMPRESS", "COMPRESS"]);
    const r = build({ includeIds: ["m4"], tokenBudget: 800, alreadySent: base.decisions.filter((d) => d.action !== "OMIT").map((d) => d.id) });
    expect(["m0", "m1"].map((id) => r.decisions.find((d) => d.id === id)!.action)).toEqual(["COMPRESS", "COMPRESS"]);
    expect(r.groups.map((g) => g.sourceIds.join("+"))).toEqual(base.groups.map((g) => g.sourceIds.join("+")));
    expect(restored(r)).toEqual(["m4"]); // only the named source
    expect(r.metrics.compressCount).toBe(base.metrics.compressCount);
  });

  it("a required partner that the initial compile already sent (here, compressed) is not restored again", () => {
    const base = build();
    const alreadySent = base.decisions.filter((d) => d.action !== "OMIT").map((d) => d.id);
    // m2 is the short reply "ok" whose partner m1 is part of the compressed group.
    const withDelta = build({ includeIds: ["m2"], tokenBudget: 800, alreadySent });
    expect(withDelta.decisions.find((d) => d.id === "m1")!.action).toBe("COMPRESS");
    expect(restored(withDelta)).toEqual(["m2"]);
    expect(withDelta.expansionReport!.items.some((x) => x.kind === "partner")).toBe(false);
  });
});

// ---------------------------------------------------------------- engine: the functionally-full ceiling

describe("G. a recovery that is functionally the full context is recorded as one", () => {
  const EVAL = "evaluating an AI assistant";
  const isRaw = (r: { mode?: string }) => r.mode === "raw";
  const filler = (n: number) => `Answer ${n}. ` + "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda. ".repeat(20);
  let db: DatabaseSync;
  let convId: string;
  beforeEach(() => {
    db = openDatabase(":memory:");
    convId = repo.createConversation(db).id;
  });
  const verdictJson = (missing: string[]) => JSON.stringify({ criteria: [{ name: "no_missing_context", pass: false, reason: "the answer ignores the moon landing" }], category: "MISSING_CONTEXT", missing_ids: missing, missing_context: { missing_information: "the moon landing dates from the omitted answer", answer_problem: "the answer gives the wrong dates for the moon landing", causal_link: "the omitted answer contains the correct dates the answer needs", evidence_strength: "concrete" }, violation: null, context_link: null });
  const PASS = JSON.stringify({ criteria: [], category: "PASS", missing_ids: [], violation: null, context_link: null });
  const run = async (expandedCount: number) => {
    let evals = 0;
    const request = "Tell me something else interesting.";
    const script: Script = (req: ModelRequest, n) => {
      if (isRaw(req)) {
        if (req.request.includes(EVAL)) {
          if (!req.request.includes(request)) return PASS;
          if (++evals > 1) return PASS;
          const msgs = repo.listMessages(db, convId);
          return verdictJson([msgs[msgs.findIndex((m) => m.content.startsWith("Tell me about the moon")) + 1].id]);
        }
        return req.request.includes("context-management") ? '{"results":[]}' : "{}";
      }
      return filler(n);
    };
    // full context (>= 9 entries): 10,000 tokens; the optimized compile (3 entries): 3,000; the recovery (4 entries): as given.
    const p = new FakeProvider(script, { api: { count: (req) => (req.context.length >= 9 ? 10_000 : req.context.length >= 4 ? expandedCount : 3_000) } });
    const say = (t: string) => runTurn(db, p, { conversationId: convId, content: t });
    for (const t of ["i must use react for this", "Tell me about the moon landing with dates.", "Explain how transistors work with analogies.", "Describe the history of bicycles in some detail.", "Explain what a monad is in functional programming."]) await say(t);
    return say(request);
  };

  it("the ratio is a single named constant", () => expect(FULL_EQUIVALENT_RATIO).toBe(0.9));

  it("near-full recovery (>= 90% of the full payload) is a full fallback in the decision, the trace and the wording", async () => {
    const out = await run(9_500);
    const a = out.trace.evaluation.attempts;
    expect(a.map((x) => x.level)).toEqual(["optimized", "expanded"]);
    expect(a[0].retryDecision).toMatchObject({ decision: "full_fallback", contextChanged: true, optional: false });
    expect(a[0].retryDecision!.reason).toMatch(/95% of the full context, so it is recorded as a full fallback/);
    expect(out.run.retryDecision).toBe("full_fallback");
    expect(buildAttempts(out.trace)[1].title).toBe("Full fallback");
    expect(summarizeTrace(out.trace).fallback).toBe("Full fallback");
    expect(out.trace.evaluation.fallbackReason).toMatch(/Full fallback \(the recovery payload was functionally the full context\)/);
    expect(out.trace.evaluation.fallbackReason).not.toMatch(/More context added/);
    expect(out.run.evaluationStatus).toBe("FAIL"); // the first attempt did fail; only the label of the recovery changed, never its safety
  });

  it("a genuinely bounded recovery keeps its label, and the report explains what was added", async () => {
    const out = await run(5_000);
    const a = out.trace.evaluation.attempts;
    expect(a[0].retryDecision).toMatchObject({ decision: "context_expansion" });
    expect(buildAttempts(out.trace)[1].title).toBe("More context added");
    const rec = buildAttempts(out.trace)[1].recovery!;
    expect(rec.needed).toMatch(/the answer ignores the moon landing/);
    expect(rec.added).toHaveLength(1); // the named answer only
    expect(rec.added[0]).toMatchObject({ kind: "named", representation: "original", skipped: false });
    expect(rec.tokensAdded).toBeGreaterThan(0);
    expect(rec.tokensAdded).toBeLessThanOrEqual(EXPAND_TOKEN_BUDGET);
    expect(rec.exceeded).toBe(false);
    expect(out.run).toMatchObject({ retryDecision: "context_expansion", fallbackLevel: 1 });
  });
});
