// Evaluator scope and retry economics. Consolidate is a context compiler, not a general answer critic: a second main-model
// generation is paid for only when Consolidate's context choices can plausibly have caused the failure, or a proven,
// applicable instruction was violated. Everything else is returned as a warning.
import { beforeEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { buildAttempts, summarizeTrace } from "@/lib/consolidate/explain";
import { proposeRetry, violationProblems } from "@/lib/consolidate/retry";
import { CURRENT_REQUEST_SOURCE } from "@/lib/consolidate/semantic";
import { openDatabase } from "@/lib/db";
import * as repo from "@/lib/db/repo";
import { runTurn } from "@/lib/engine/turn";
import type { ModelRequest } from "@/lib/model";
import { FakeProvider, type Script } from "./helpers";

const EVAL = "evaluating an AI assistant";
const isRaw = (r: { mode?: string }) => r.mode === "raw";
const filler = (n: number) => `Answer ${n}. ` + "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda. ".repeat(20);

type Judgement = { evidence?: unknown; category: string; failing?: string; reason?: string; missing?: string[]; violation?: unknown; link?: unknown };
const verdict = (j: Judgement) =>
  JSON.stringify({
    criteria: [{ name: j.failing ?? "answers_request", pass: !j.failing, reason: j.failing ? (j.reason ?? "flagged by the evaluator") : "ok" }],
    category: j.category,
    missing_ids: j.missing ?? [],
    missing_context: j.category === "MISSING_CONTEXT" && j.missing?.length ? (j.evidence ?? { missing_information: "the moon landing dates from the omitted answer", answer_problem: "the answer gives the wrong dates for the moon landing", causal_link: "the omitted answer contains the correct dates the answer needs", evidence_strength: "concrete" }) : null,
    violation: j.violation ?? null,
    context_link: j.link ?? null,
  });
const PASS = verdict({ category: "PASS" });

let db: DatabaseSync;
let convId: string;
beforeEach(() => {
  db = openDatabase(":memory:");
  convId = repo.createConversation(db).id;
});

// `savings`: how big the provider counts of the full context are relative to the optimized one. It controls whether an
// optional retry is affordable: "large" leaves plenty of net headroom, "small" leaves none. (The test config turns the
// cost-aware fast path off with CONSOLIDATE_ECONOMICS_MARGIN=0, so the optimized path always runs.)
function provider(request: string, judge: (call: number) => string, savings: "large" | "small" = "large") {
  let evals = 0;
  const FULL = savings === "large" ? 60_000 : 3_500;
  const script: Script = (req: ModelRequest, n) => {
    if (isRaw(req)) {
      if (req.request.includes(EVAL)) return req.request.includes(request) ? judge(++evals) : PASS;
      if (req.request.includes("context-management")) return '{"results":[]}';
      return "{}";
    }
    return filler(n);
  };
  return new FakeProvider(script, { api: { count: (req) => (req.context.length >= 9 ? FULL : 1000 + (req.guidance ? 60 : 0)) } });
}
const say = (p: FakeProvider, text: string) => runTurn(db, p, { conversationId: convId, content: text });
const chatCalls = (p: FakeProvider, from: number) => p.calls.slice(from).filter((c) => !isRaw(c));
const TURNS = ["Tell me about the moon landing with dates.", "Explain how transistors work with analogies.", "Describe the history of bicycles in some detail.", "Explain what a monad is in functional programming."];
const seed = async (p: FakeProvider) => {
  await say(p, "i must use react for this");
  for (const t of TURNS) await say(p, t);
};
const idOf = (starts: string) => repo.listMessages(db, convId).find((m) => m.content.startsWith(starts))!.id;
const replyOf = (starts: string) => {
  const msgs = repo.listMessages(db, convId);
  return msgs[msgs.findIndex((m) => m.content.startsWith(starts)) + 1].id;
};
const run = async (request: string, judge: (call: number) => string, savings: "large" | "small" = "large") => {
  const p = provider(request, judge, savings);
  await seed(p);
  const before = p.calls.length;
  const out = await say(p, request);
  return { p, out, chats: chatCalls(p, before), a: out.trace.evaluation.attempts };
};

const REACT_VIOLATION = () => ({ instruction: "i must use react for this", source_id: idOf("i must use react"), evidence: "the answer recommends Vue", applies_to_current_request: true, applies_because: "the request asks which framework to use" });

// ------------------------------------------------------------------ pure decision rules

describe("proposeRetry: what may cost a second generation", () => {
  const reqs = [{ id: "m1", text: "Never log authentication tokens." }];
  const base = { requirements: reqs, request: "Write the authentication logger.", missingIds: [] as string[], semanticReason: "the evaluator's words" };
  const violation = { instruction: "Never log authentication tokens.", sourceId: "m1", evidence: "the logger prints the bearer token", applies: true, appliesBecause: "the request is about authentication logging" };

  it("PASS and ANSWER_QUALITY never retry; ANSWER_QUALITY is an informational warning", () => {
    expect(proposeRetry({ ...base, category: "PASS", verdict: null })).toMatchObject({ kind: "none", warningOnly: false });
    const p = proposeRetry({ ...base, category: "ANSWER_QUALITY", verdict: null });
    expect(p).toMatchObject({ kind: "none", warningOnly: true });
    expect(p.warning).toMatch(/^Quality warning — no context failure detected/);
  });

  it("MISSING_CONTEXT (with concrete evidence) and CHECK_FAILED keep their safe, mandatory expansion path", () => {
    const mc = { missingInformation: "the database version PostgreSQL 16", answerProblem: "the answer says it does not know the database", causalLink: "the omitted message states PostgreSQL 16, which answers the question", evidenceStrength: "concrete" as const };
    expect(proposeRetry({ ...base, category: "MISSING_CONTEXT", verdict: { violation: null, contextLink: null, missingContext: mc }, missingIds: ["a"] })).toMatchObject({ kind: "context_expansion", optional: false, plan: { includeIds: ["a"] } });
    expect(proposeRetry({ ...base, category: "CHECK_FAILED", verdict: null })).toMatchObject({ kind: "context_expansion", optional: false });
  });

  describe("MISSING_CONTEXT is actionable only with concrete, material, non-redundant evidence", () => {
    const concrete = { missingInformation: "the metadata database version is PostgreSQL 16", answerProblem: "the answer says it does not know which database is in use", causalLink: "the omitted message states PostgreSQL 16, which is exactly what the question asks", evidenceStrength: "concrete" as "concrete" | "speculative" };
    const at = (mc: Partial<typeof concrete> | null, ids = ["m9"], payloadText: string[] = []) =>
      proposeRetry({ ...base, category: "MISSING_CONTEXT", missingIds: ids, payloadText, verdict: { violation: null, contextLink: null, missingContext: mc === null ? null : { ...concrete, ...mc } } });

    it("1. speculative evidence (stated or worded) does not retry", () => {
      const s = at({ evidenceStrength: "speculative", missingInformation: "the stack constraints, which likely contain useful architecture details" });
      expect(s).toMatchObject({ kind: "none", warningOnly: true });
      expect(s.reason).toMatch(/evidence is speculative/);
      expect(at({ causalLink: "the omitted message might contain something that could make the answer better" })).toMatchObject({ kind: "none", warningOnly: true }); // worded as speculation despite "concrete"
      expect(at(null)).toMatchObject({ kind: "none", warningOnly: true }); // no structured evidence at all
    });
    it("2. a concrete missing fact retries (example A: the answer does not know the database version)", () => {
      expect(at({})).toMatchObject({ kind: "context_expansion", optional: false, warningOnly: false, plan: { includeIds: ["m9"] } });
    });
    it("3. missing ids without a material answer problem, exact information or causal link do not retry", () => {
      expect(at({ answerProblem: "" }).kind).toBe("none");
      expect(at({ missingInformation: "" }).kind).toBe("none");
      expect(at({ causalLink: "" }).kind).toBe("none");
      expect(at({}, []).kind).toBe("none"); // no real missing source id
    });
    it("4. information already present in protected context, memory or a compressed/retrieved source does not retry", () => {
      const p = at({ missingInformation: "the metadata database is PostgreSQL 16" }, ["m9"], ["memory: metadata_database_system: PostgreSQL 16 (decision)"]);
      expect(p).toMatchObject({ kind: "none", warningOnly: true });
      expect(p.reason).toMatch(/already represented in the payload/);
      expect(at({}, ["m9"], ["The interface must use React", "unrelated text"]).kind).toBe("context_expansion"); // not represented there
    });
    it("5. concrete missing logs that the answer needed retry (example B)", () => {
      const logs = { missingInformation: "the three ERROR upload failed log lines with retry=1, retry=2 and retry=3", answerProblem: "the answer concludes the failures are unrelated, which is wrong", causalLink: "the omitted logs all show the same connection timeout, which is the common cause", evidenceStrength: "concrete" as const };
      expect(at(logs, ["l1", "l2", "l3"], ["Explain B-trees"])).toMatchObject({ kind: "context_expansion", plan: { includeIds: ["l1", "l2", "l3"] } });
    });
  });

  it("INSTRUCTION_VIOLATION retries only with all four proofs", () => {
    const ok = proposeRetry({ ...base, category: "INSTRUCTION_VIOLATION", verdict: { violation, contextLink: null } });
    expect(ok).toMatchObject({ kind: "corrective_regeneration", purpose: "instruction", optional: false, warningOnly: false });
    expect(ok.guidance).toContain("Never log authentication tokens.");
    expect(ok.guidance).toContain("bearer token");
    const missing: [string, Partial<typeof violation>][] = [
      ["exact instruction", { instruction: "" }],
      ["source", { sourceId: "" }],
      ["cited source", { sourceId: "m999" }],
      ["evidence", { evidence: "" }],
      ["applicable", { applies: false }],
      ["applicable", { appliesBecause: "" }],
    ];
    for (const [what, patch] of missing) {
      const p = proposeRetry({ ...base, category: "INSTRUCTION_VIOLATION", verdict: { violation: { ...violation, ...patch }, contextLink: null } });
      expect(p, what).toMatchObject({ kind: "none", warningOnly: true });
    }
    expect(proposeRetry({ ...base, category: "INSTRUCTION_VIOLATION", verdict: { violation: null, contextLink: null } })).toMatchObject({ kind: "none", warningOnly: true });
  });

  it("the instruction must actually appear in the source it cites (a historical constraint is not applicable by assertion)", () => {
    expect(violationProblems({ ...violation, instruction: "Always answer in French." }, reqs, base.request).join()).toMatch(/does not appear in its cited source/);
    expect(violationProblems(violation, reqs, base.request)).toEqual([]);
    // the current request is a valid source
    expect(violationProblems({ ...violation, sourceId: CURRENT_REQUEST_SOURCE, instruction: "Write the authentication logger." }, reqs, base.request)).toEqual([]);
    expect(violationProblems({ ...violation, sourceId: CURRENT_REQUEST_SOURCE, instruction: "Never log authentication tokens." }, reqs, base.request).join()).toMatch(/does not appear/);
  });

  it("UNSUPPORTED_CLAIM retries only when tied to a compiler choice (and is then optional)", () => {
    expect(proposeRetry({ ...base, category: "UNSUPPORTED_CLAIM", verdict: { violation: null, contextLink: null } })).toMatchObject({ kind: "none", warningOnly: true });
    const p = proposeRetry({ ...base, category: "UNSUPPORTED_CLAIM", verdict: { violation: null, contextLink: { kind: "memory", explanation: "the memory note says PostgreSQL 16 but the user said 17" } } });
    expect(p).toMatchObject({ kind: "corrective_regeneration", purpose: "grounding", optional: true });
    expect(p.guidance).toContain("PostgreSQL 16");
    // omitted-context link: expansion if a specific message is named, otherwise a warning
    expect(proposeRetry({ ...base, category: "UNSUPPORTED_CLAIM", missingIds: ["x"], verdict: { violation: null, contextLink: { kind: "omitted_context", explanation: "e" } } })).toMatchObject({ kind: "context_expansion", optional: true, plan: { includeIds: ["x"] } });
    expect(proposeRetry({ ...base, category: "UNSUPPORTED_CLAIM", verdict: { violation: null, contextLink: { kind: "omitted_context", explanation: "e" } } })).toMatchObject({ kind: "none", warningOnly: true });
  });

  it("UNCERTAIN expands only when a specific omitted candidate was named", () => {
    expect(proposeRetry({ ...base, category: "UNCERTAIN", verdict: null })).toMatchObject({ kind: "none", warningOnly: true });
    expect(proposeRetry({ ...base, category: "UNCERTAIN", verdict: null, missingIds: ["c1"] })).toMatchObject({ kind: "context_expansion", optional: true, plan: { includeIds: ["c1"] } });
  });

  it("never proposes a second corrective regeneration", () => {
    expect(proposeRetry({ ...base, category: "INSTRUCTION_VIOLATION", alreadyRegenerated: true, verdict: { violation, contextLink: null } }).kind).toBe("none");
  });
});

// ------------------------------------------------------------------ engine behavior

describe("A. ANSWER_QUALITY alone never buys a second generation", () => {
  it("returns the original answer with a persisted warning, no retry, no waste", async () => {
    const { chats, out, a } = await run("Tell me something else interesting.", () => verdict({ category: "ANSWER_QUALITY", failing: "answers_request", reason: "could be more detailed" }));
    expect(chats).toHaveLength(1); // one main-model generation
    expect(a.map((x) => x.level)).toEqual(["optimized"]);
    expect(out.assistantMessage.content).toBe(a[0].response); // the original response is returned
    expect(a[0]).toMatchObject({ failureCategory: "ANSWER_QUALITY", warningOnly: true });
    expect(a[0].qualityWarning).toMatch(/^Quality warning — no context failure detected: could be more detailed/);
    expect(a[0].retryDecision).toMatchObject({ decision: "none", contextChanged: false, economicGuard: "not_applicable" });
    expect(out.run).toMatchObject({ evaluationStatus: "PASS", fallbackLevel: 0, fallbackApplied: false, qualityWarning: expect.stringMatching(/Quality warning/), retryDecision: "none" });
    expect(out.run.costs!.fallbackWasteCostUsd).toBe(0); // nothing was discarded
    expect(out.assistantMessage.qualityWarning).toBe(true);
    expect(repo.listMessages(db, convId).at(-1)).toMatchObject({ qualityWarning: true, regenerated: false });
  });
});

describe("B. omitted information must be reported as MISSING_CONTEXT, and that path is unchanged", () => {
  it("names the omitted message, adds bounded context, and records an explicit decision", async () => {
    let target = "";
    const { chats, out, a } = await run("Tell me something else interesting.", (call) => {
      if (call > 1) return PASS;
      target = replyOf("Tell me about the moon");
      return verdict({ category: "MISSING_CONTEXT", failing: "no_missing_context", missing: [target] });
    });
    expect(chats).toHaveLength(2);
    expect(a.map((x) => x.level)).toEqual(["optimized", "expanded"]);
    expect(a[0].retryDecision).toMatchObject({ decision: "context_expansion", purpose: "context", optional: false, contextChanged: true, economicGuard: "not_applicable" });
    expect(a[1].contextAdded!.map((x) => x.id)).toContain(target);
    expect(out.run).toMatchObject({ fallbackLevel: 1, retryDecision: "context_expansion", contextChanged: true });
  });
});

describe("C-E. INSTRUCTION_VIOLATION: only concrete, applicable evidence justifies a retry", () => {
  it("C. an applicable protected instruction with exact text, source and evidence gets ONE corrective retry with the same context", async () => {
    const { chats, out, a } = await run("which frontend framework should I use?", (call) => (call === 1 ? verdict({ category: "INSTRUCTION_VIOLATION", failing: "honors_requirements", violation: REACT_VIOLATION() }) : PASS));
    expect(chats).toHaveLength(2);
    expect(chats[1].context).toEqual(chats[0].context); // no history added
    expect(chats[1].guidance).toMatch(/did not follow this instruction from a standing requirement: "i must use react for this"/);
    expect(chats[1].guidance).toMatch(/the answer recommends Vue/);
    expect(a.map((x) => x.level)).toEqual(["optimized", "regenerated"]);
    expect(a[0].retryDecision).toMatchObject({ decision: "corrective_regeneration", purpose: "instruction", contextChanged: false, optional: false, economicGuard: "not_applicable" });
    expect(a[0].retryDecision!.expectedRetryCostUsd).toBeGreaterThan(0); // priced with the pricing module even when not blocked
    expect(out.run).toMatchObject({ retryDecision: "corrective_regeneration", contextChanged: false, fallbackLevel: 0 });
    // the trace says exactly what happened
    expect(buildAttempts(out.trace)[1].title).toBe("Regenerated to follow an applicable instruction");
    expect(summarizeTrace(out.trace).fallback).toBe("Regenerated to follow an applicable instruction");
  });

  it("C. it is not blocked by economics even when the request could not otherwise afford it", async () => {
    const { chats, a } = await run("which frontend framework should I use?", (call) => (call === 1 ? verdict({ category: "INSTRUCTION_VIOLATION", failing: "honors_requirements", violation: REACT_VIOLATION() }) : PASS), "small");
    expect(chats).toHaveLength(2);
    expect(a[0].retryDecision!.projectedNetUsd).toBeLessThan(0); // it would go negative, and proven violations still retry
    expect(a[0].retryDecision!.economicGuard).toBe("not_applicable");
  });

  it("D. an irrelevant protected instruction (not confirmed applicable) gets a warning and no retry", async () => {
    const irrelevant = () => ({ ...REACT_VIOLATION(), applies_to_current_request: false, applies_because: "" }); // built lazily: it needs the seeded message's id
    const { chats, out, a } = await run("Explain what a hackathon is.", () => verdict({ category: "INSTRUCTION_VIOLATION", failing: "honors_requirements", violation: irrelevant() }));
    expect(chats).toHaveLength(1);
    expect(a[0]).toMatchObject({ warningOnly: true });
    expect(a[0].retryDecision).toMatchObject({ decision: "none" });
    expect(a[0].retryDecision!.reason).toMatch(/not proven.*applies to the current request/);
    expect(out.run.evaluationStatus).toBe("PASS");
  });

  it("D. a claimed instruction that is not in its cited source is not trusted", async () => {
    const forged = () => ({ ...REACT_VIOLATION(), instruction: "Always answer in French." });
    const { chats, a } = await run("which frontend framework should I use?", () => verdict({ category: "INSTRUCTION_VIOLATION", failing: "honors_requirements", violation: forged() }));
    expect(chats).toHaveLength(1);
    expect(a[0].retryDecision!.reason).toMatch(/does not appear in its cited source/);
  });

  it("E. a vague violation with no exact source is a warning only", async () => {
    for (const violation of [null, { instruction: "follow the rules", source_id: "", evidence: "it ignored them", applies_to_current_request: true, applies_because: "always" }]) {
      const { chats, a } = await run("which frontend framework should I use?", () => verdict({ category: "INSTRUCTION_VIOLATION", failing: "honors_requirements", violation }));
      expect(chats).toHaveLength(1);
      expect(a[0]).toMatchObject({ warningOnly: true, failureCategory: "INSTRUCTION_VIOLATION" });
      db = openDatabase(":memory:");
      convId = repo.createConversation(db).id;
    }
  });
});

describe("F-G. UNSUPPORTED_CLAIM: only a claim caused by a compiler choice justifies a retry", () => {
  it("F. a generic hallucination unrelated to context selection is a warning; one generation", async () => {
    const { chats, a } = await run("Tell me something else interesting.", () => verdict({ category: "UNSUPPORTED_CLAIM", failing: "answers_request" }));
    expect(chats).toHaveLength(1);
    expect(a[0]).toMatchObject({ warningOnly: true });
    expect(a[0].retryDecision!.reason).toMatch(/generic hallucination/);
  });

  it("G. a claim tied to compression/memory gets one same-context corrective retry when the economics allow", async () => {
    const link = { kind: "compression", explanation: "the summary of the moon discussion dropped the launch date" };
    const { chats, out, a } = await run("Tell me something else interesting.", (call) => (call === 1 ? verdict({ category: "UNSUPPORTED_CLAIM", failing: "answers_request", link }) : PASS), "large");
    expect(chats).toHaveLength(2);
    expect(chats[1].context).toEqual(chats[0].context);
    expect(chats[1].guidance).toMatch(/compression: the summary of the moon discussion dropped the launch date/);
    expect(a[0].retryDecision).toMatchObject({ decision: "corrective_regeneration", purpose: "grounding", optional: true, economicGuard: "allowed", contextChanged: false });
    expect(buildAttempts(out.trace)[1].title).toBe("Response regenerated with the same context");
  });

  it("G. ...and is skipped, with the numbers, when it would knowingly destroy the request's economics", async () => {
    const link = { kind: "memory", explanation: "the memory note is wrong" };
    const { chats, out, a } = await run("Tell me something else interesting.", () => verdict({ category: "UNSUPPORTED_CLAIM", failing: "answers_request", link }), "small");
    expect(chats).toHaveLength(1);
    expect(a[0].retryDecision).toMatchObject({ decision: "none", economicGuard: "blocked", optional: true });
    expect(a[0].retryDecision!.expectedRetryCostUsd).toBeGreaterThan(0);
    expect(a[0].retryDecision!.projectedNetUsd).toBeLessThan(0);
    expect(a[0].retryDecision!.reason).toMatch(/protect the request's economics/);
    expect(out.run.evaluationStatus).toBe("FAIL"); // a real, compiler-caused failure that was not repaired is reported as one
    expect(a[0].warningOnly).toBeUndefined();
    expect(out.run.costs!.fallbackWasteCostUsd).toBe(0);
  });
});

describe("H-I. UNCERTAIN: only a specific relevant omitted candidate justifies a bounded expansion", () => {
  it("H. no specific candidate: a warning, one generation", async () => {
    const { chats, a, out } = await run("Tell me something else interesting.", () => verdict({ category: "UNCERTAIN" }));
    expect(chats).toHaveLength(1);
    expect(a[0]).toMatchObject({ warningOnly: true });
    expect(a[0].retryDecision).toMatchObject({ decision: "none", contextChanged: false });
    expect(out.run.evaluationStatus).toBe("PASS");
  });

  it("I. a named omitted candidate: bounded expansion", async () => {
    const { chats, a } = await run("Tell me something else interesting.", (call) => (call === 1 ? verdict({ category: "UNCERTAIN", missing: [replyOf("Explain how transistors")] }) : PASS));
    expect(chats).toHaveLength(2);
    expect(a.map((x) => x.level)).toEqual(["optimized", "expanded"]);
    expect(a[0].retryDecision).toMatchObject({ decision: "context_expansion", optional: true, contextChanged: true, economicGuard: "allowed" });
    expect(a[1].contextAdded!.reduce((t, x) => t + x.tokens, 0)).toBeLessThanOrEqual(800);
    expect(a.some((x) => x.level === "full")).toBe(false); // no full-context retry for UNCERTAIN
  });
});

describe("J. the trace distinguishes the three outcomes honestly", () => {
  it("expansion, same-context regeneration and warning-only are labelled differently, and 'more context' is only claimed when context changed", async () => {
    const expansion = await run("Tell me something else interesting.", (call) => (call === 1 ? verdict({ category: "MISSING_CONTEXT", failing: "no_missing_context", missing: [replyOf("Tell me about the moon")] }) : PASS));
    const e = buildAttempts(expansion.out.trace);
    expect(e[1].title).toBe("More context added");
    expect(e[0].retry).toMatchObject({ label: "More context added", contextChanged: true });
    expect(summarizeTrace(expansion.out.trace).fallback).toBe("More context added");

    db = openDatabase(":memory:");
    convId = repo.createConversation(db).id;
    const regen = await run("which frontend framework should I use?", (call) => (call === 1 ? verdict({ category: "INSTRUCTION_VIOLATION", failing: "honors_requirements", violation: REACT_VIOLATION() }) : PASS));
    const r = buildAttempts(regen.out.trace);
    expect(r[1].title).toMatch(/Regenerated to follow an applicable instruction/);
    expect(r[0].retry).toMatchObject({ label: "Regenerated to follow an applicable instruction", contextChanged: false });
    expect(summarizeTrace(regen.out.trace).fallback).not.toMatch(/More context/);
    expect(regen.out.trace.evaluation.fallbackReason).toMatch(/Regenerated to follow an applicable instruction \(no context added\)/);
    expect(regen.out.trace.evaluation.fallbackReason).not.toMatch(/More context added/);

    db = openDatabase(":memory:");
    convId = repo.createConversation(db).id;
    const warn = await run("Tell me something else interesting.", () => verdict({ category: "ANSWER_QUALITY", failing: "answers_request" }));
    const w = buildAttempts(warn.out.trace);
    expect(w).toHaveLength(1);
    expect(w[0].retry!.label).toBe("Quality warning — no context failure detected");
    expect(w[0].warning).toMatch(/^Quality warning — no context failure detected/);
    expect(summarizeTrace(warn.out.trace)).toMatchObject({ fallback: "None", quality: { tone: "warn", label: "Passed with a quality warning" } });
    expect(warn.out.trace.evaluation.fallbackReason).toMatch(/no context was added and it was not regenerated/);
  });
});

describe("the dashboard treats a warning as a pass, like the run status does", () => {
  it("counts warning-only runs in the pass rates and never as a fallback", async () => {
    await run("Tell me something else interesting.", () => verdict({ category: "ANSWER_QUALITY", failing: "answers_request" }));
    const s = repo.dashboardStats(db);
    expect(s.evaluationPassRate).toBe(1);
    expect(s.finalPassRate).toBe(1);
    expect(s.fallbackCount).toBe(0);
    expect(s.regeneratedCount).toBe(0);
    expect(s.costs.fallbackWasteCostUsd).toBe(0);
  });
});

describe("a newer user statement supersedes an older instruction", () => {
  const instruction = "The metadata database will be PostgreSQL 17.";
  it("revisesInstruction: an update marker plus real overlap, and nothing else", async () => {
    const { revisesInstruction } = await import("@/lib/consolidate/retry");
    expect(revisesInstruction(instruction, "Actually, change the metadata database to PostgreSQL 16.")).toBe(true);
    expect(revisesInstruction(instruction, "Switch the metadata database to MySQL instead.")).toBe(true);
    expect(revisesInstruction(instruction, "What database version are we using now?")).toBe(false); // overlap but no update marker
    expect(revisesInstruction(instruction, "Actually, explain B-trees.")).toBe(false); // update marker but no shared subject
    expect(revisesInstruction("Never log authentication tokens.", "Write the authentication logger.")).toBe(false);
  });

  it("a violation claimed against a superseded instruction is a warning, not a retry", () => {
    const reqs = [{ id: "m3", text: instruction }];
    const violation = { instruction, sourceId: "m3", evidence: "the answer switches to PostgreSQL 16", applies: true, appliesBecause: "the request concerns the database" };
    const request = "Actually, change the metadata database to PostgreSQL 16.";
    const p = proposeRetry({ category: "INSTRUCTION_VIOLATION", verdict: { violation, contextLink: null }, missingIds: [], requirements: reqs, request });
    expect(p).toMatchObject({ kind: "none", warningOnly: true });
    expect(p.reason).toMatch(/newer user statement revises this instruction/);
    // the same claim without a revision still retries
    expect(proposeRetry({ category: "INSTRUCTION_VIOLATION", verdict: { violation, contextLink: null }, missingIds: [], requirements: reqs, request: "Which database will the CLI use for metadata?" }).kind).toBe("corrective_regeneration");
    // and a revision that came between the source and the request counts too
    expect(proposeRetry({ category: "INSTRUCTION_VIOLATION", verdict: { violation, contextLink: null }, missingIds: [], requirements: reqs, request: "Write the schema.", revisionsOf: () => ["Actually, change the metadata database to PostgreSQL 16.", "Write the schema."] }).kind).toBe("none");
  });

  it("engine: the update turn keeps its first (correct) answer; one generation, warning, evidence persisted", async () => {
    const p = provider("Actually, change the metadata database to PostgreSQL 16.", (call) =>
      call === 1
        ? verdict({ category: "INSTRUCTION_VIOLATION", failing: "honors_requirements", violation: { instruction, source_id: idOf("The metadata database will be"), evidence: "the answer changes it to 16", applies_to_current_request: true, applies_because: "the request concerns the database" } })
        : PASS,
    );
    await say(p, "The metadata database will be PostgreSQL 17.");
    for (const t of TURNS) await say(p, t);
    const before = p.calls.length;
    const out = await say(p, "Actually, change the metadata database to PostgreSQL 16.");
    expect(chatCalls(p, before)).toHaveLength(1); // no corrective regeneration that would refuse the user's change
    const a = out.trace.evaluation.attempts;
    expect(a[0]).toMatchObject({ warningOnly: true, failureCategory: "INSTRUCTION_VIOLATION" });
    expect(a[0].retryDecision!.reason).toMatch(/newer user statement revises this instruction/);
    expect(a[0].evaluatorEvidence!.violation).toMatchObject({ instruction, evidence: "the answer changes it to 16" }); // auditable
    expect(out.run.evaluationStatus).toBe("PASS");
  });
});

describe("engine: speculative missing context never buys a second generation", () => {
  it("a speculative claim naming an omitted message returns the first answer as a warning (no expansion, no waste)", async () => {
    const spec = { missing_information: "the stack and architecture constraints", answer_problem: "the answer could be more tailored", causal_link: "the omitted message likely contains useful details", evidence_strength: "speculative" };
    const { chats, out, a } = await run("Tell me something else interesting.", () => verdict({ category: "MISSING_CONTEXT", failing: "no_missing_context", missing: [replyOf("Tell me about the moon")], evidence: spec }));
    expect(chats).toHaveLength(1);
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ warningOnly: true, failureCategory: "MISSING_CONTEXT" });
    expect(a[0].retryDecision).toMatchObject({ decision: "none", contextChanged: false });
    expect(out.run).toMatchObject({ evaluationStatus: "PASS", fallbackLevel: 0 });
    expect(out.run.costs!.fallbackWasteCostUsd).toBe(0);
  });
  it("information already in the payload (a protected requirement) does not retry, even with concrete wording", async () => {
    const dup = { missing_information: "i must use react for this", answer_problem: "the answer ignores the react requirement", causal_link: "the omitted message repeats the react requirement the answer needs", evidence_strength: "concrete" };
    const { chats, a } = await run("which frontend framework should I use?", () => verdict({ category: "MISSING_CONTEXT", failing: "no_missing_context", missing: [replyOf("Tell me about the moon")], evidence: dup }));
    expect(chats).toHaveLength(1);
    expect(a[0].retryDecision!.reason).toMatch(/already represented in the payload/);
  });
});
