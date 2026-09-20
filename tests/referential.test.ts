// Referential-object requests ("what do these failures have in common?"): generic detection, recent coherent antecedent
// blocks, type awareness, a bounded semantic search whose universe includes protected messages without duplicating them
// in the payload, and abstention when nothing plausible exists. No demo-specific phrases; no threshold changes.
import { beforeEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { compileContext } from "@/lib/consolidate/compile";
import { buildDecisionCards, decisionBasis, understanding } from "@/lib/consolidate/explain";
import { ANTECEDENT_MAX_MESSAGES, ANTECEDENT_WINDOW, detectReferentialObject, isCompatibleAntecedent, looksLikeErrorEvidence } from "@/lib/consolidate/referential";
import { openDatabase } from "@/lib/db";
import * as repo from "@/lib/db/repo";
import { runTurn } from "@/lib/engine/turn";
import type { ContentType } from "@/lib/types";
import { FakeProvider, prepare, type Script } from "./helpers";

const LOG = (n: number, worker = 3) => `ERROR upload failed\nworker=image-worker-${worker}\nfile=/uploads/user/4827/photo.jpg\nerror=connection timeout\nretry=${n}`;
const PROSE = (n: number) => `Here is an answer about topic ${n}. ` + "Some general explanatory prose that has nothing to do with the request. ".repeat(6);

// ---------------------------------------------------------------- A. detection

describe("detectReferentialObject: generic demonstrative + artifact noun", () => {
  it.each([
    ["what do these failures have in common?", "error", "these failures"],
    ["why are these errors happening", "error", "these errors"],
    ["summarize these logs", "output", "these logs"],
    ["are these warnings serious?", "error", "these warnings"],
    ["what do these results mean", "output", "these results"],
    ["compare these outputs", "output", "these outputs"],
    ["what causes this error?", "error", "this error"],
    ["how do I fix this issue", "error", "this issue"],
    ["what does this output mean?", "output", "this output"],
    ["why did those failures start", "error", "those failures"],
    ["look at those logs", "output", "those logs"],
    ["explain the errors above", "error", "the errors above".replace("the ", "")],
    ["what do the logs above show", "output", "logs above"],
    ["why is this failing?", "error", "why is this failing"],
    ["what does this function do", "code", "this function"],
    ["why did we make this decision", "decision", "this decision"],
    ["what do these error logs have in common", "output", "these error logs"],
  ])("%j -> %s (%s)", (request, kind, phrase) => {
    const r = detectReferentialObject(request);
    expect(r).not.toBeNull();
    expect(r!.kind).toBe(kind);
    expect(r!.phrase).toContain(phrase);
  });

  it("does not fire on ordinary vocabulary, even when the nouns appear", () => {
    for (const q of ["How do I handle errors in Go?", "what is an error budget", "failures in distributed systems", "why did the build fail", "I like these", "this is great", "what are the results of the election", "Explain how B-trees work.", "what other features can I add?", ""]) {
      expect(detectReferentialObject(q), q).toBeNull();
    }
  });
});

// ---------------------------------------------------------------- C. type awareness

describe("isCompatibleAntecedent: the type of the reference selects the type of the message", () => {
  const user = (content: string, contentType: ContentType = "discussion") => ({ id: "x", role: "user" as const, content, contentType });
  const asst = (content: string, contentType: ContentType = "discussion") => ({ id: "y", role: "assistant" as const, content, contentType });
  it("failure/error references prefer error-bearing messages and log/tool output", () => {
    expect(isCompatibleAntecedent("error", user(LOG(1)))).toBe(true);
    expect(isCompatibleAntecedent("error", user('Traceback (most recent call last):\n  File "app.py", line 12, in <module>\nTypeError: x'))).toBe(true);
    expect(isCompatibleAntecedent("error", user("I like prose about errors and failures in general."))).toBe(false);
    expect(isCompatibleAntecedent("error", asst(PROSE(1)))).toBe(false);
    expect(isCompatibleAntecedent("error", asst("2025-01-01 job ok", "log"))).toBe(true);
  });
  it("output/result references also accept pasted multi-line output", () => {
    const out = "id=1 status=ok latency=120ms\nid=2 status=ok latency=98ms\nid=3 status=slow latency=901ms";
    expect(isCompatibleAntecedent("output", user(out))).toBe(true);
    expect(isCompatibleAntecedent("error", user(out))).toBe(false); // an output that is not an error is not a "failure"
    expect(isCompatibleAntecedent("output", user("just a sentence"))).toBe(false);
  });
  it("code references prefer code", () => {
    expect(isCompatibleAntecedent("code", user("```js\nconst a = 1;\n```", "code"))).toBe(true);
    expect(isCompatibleAntecedent("code", user("a plain sentence"))).toBe(false);
  });
  it("decision references prefer facts, decisions, constraints and preferences, and not error evidence", () => {
    expect(isCompatibleAntecedent("decision", user("We decided to use PostgreSQL 17.", "decision"))).toBe(true);
    expect(isCompatibleAntecedent("decision", user("The frontend must use React.", "constraint"))).toBe(true);
    expect(isCompatibleAntecedent("decision", user(LOG(1)))).toBe(false);
    expect(looksLikeErrorEvidence(LOG(1))).toBe(true);
  });
});

// ---------------------------------------------------------------- compiler-level behavior

const history = (rows: [("user" | "assistant"), string][]) => prepare(rows.map(([role, content], i) => ({ id: `m${i}`, role, content }))).messages;
const routed = (r: ReturnType<typeof compileContext>) => Object.fromEntries(r.decisions.map((d) => [d.id, d.action]));
const compile = (rows: [("user" | "assistant"), string][], request: string) => compileContext({ messages: history(rows), request });

describe("compiler: recent coherent antecedent blocks", () => {
  it("1. three recent logs are one block: all retrieved, unrelated context excluded", () => {
    const rows: [("user" | "assistant"), string][] = [
      ["user", "Explain how B-trees work."], ["assistant", PROSE(1)],
      ["user", "What's a good recipe for chocolate chip cookies?"], ["assistant", PROSE(2)],
      ["user", "I'm debugging an image upload worker. It writes metadata to PostgreSQL."], ["assistant", PROSE(3)],
      ["user", LOG(1)], ["assistant", PROSE(4)],
      ["user", LOG(2)], ["assistant", PROSE(5)],
      ["user", LOG(3)], ["assistant", PROSE(6)],
    ];
    const r = compile(rows, "What do these failures have in common?");
    const a = routed(r);
    expect([a.m6, a.m8, a.m10]).toEqual(["RETRIEVE", "RETRIEVE", "RETRIEVE"]);
    for (const id of ["m0", "m1", "m2", "m3", "m4"]) expect(a[id], id).toBe("OMIT"); // nothing older or unrelated comes back
    expect(r.referentialObject).toMatchObject({ kind: "error", phrase: "these failures", candidateIds: ["m10", "m8", "m6"], selectedIds: ["m6", "m8", "m10"], needsSearch: false });
    expect(r.decisions.filter((d) => d.antecedent).map((d) => d.id)).toEqual(["m6", "m8", "m10"]);
    expect(r.lexicallyInsufficient).toBe(false); // found deterministically: no model call needed
    expect(r.decisions.find((d) => d.id === "m6")!.reason).toMatch(/Referential antecedent: your request says "these failures".*error logs/);
  });

  it("2. recent tool output is retrieved for 'what does this output mean?'", () => {
    const out = "id=1 status=ok latency=120ms\nid=2 status=ok latency=98ms\nid=3 status=slow latency=901ms";
    const r = compile([["user", "Explain how B-trees work."], ["assistant", PROSE(1)], ["user", "Here is the health check output:\n" + out], ["assistant", PROSE(2)], ["user", "Thanks."], ["assistant", PROSE(3)]], "what does this output mean?");
    expect(r.referentialObject).toMatchObject({ kind: "output", selectedIds: ["m2"] });
    expect(routed(r).m2).toBe("RETRIEVE");
    expect(routed(r).m0).toBe("OMIT");
  });

  it("3. a recent code error is retrieved for 'why is this failing?'", () => {
    const code = 'Here is my script:\n```python\ndef main():\n    return 1 / 0\nmain()\n```\nTraceback (most recent call last):\n  File "app.py", line 3, in <module>\nZeroDivisionError: division by zero';
    const r = compile([["user", "What's a good recipe for cookies?"], ["assistant", PROSE(1)], ["user", code], ["assistant", PROSE(2)], ["user", "ok"], ["assistant", PROSE(3)]], "why is this failing?");
    expect(r.referentialObject).toMatchObject({ kind: "error", selectedIds: ["m2"] });
    expect(routed(r).m2).toBe("RETRIEVE");
    expect(routed(r).m0).toBe("OMIT");
  });

  it("code references pick recent code, and decision references pick recent decisions", () => {
    const rc = compile([["user", "Explain B-trees."], ["assistant", PROSE(1)], ["user", "```js\nconst total = items.reduce((a, b) => a + b, 0);\n```"], ["assistant", PROSE(2)], ["user", "ok"], ["assistant", PROSE(3)]], "what does this function do?");
    expect(rc.referentialObject).toMatchObject({ kind: "code", selectedIds: ["m2"] });
    const rd = compile([["user", "Explain B-trees."], ["assistant", PROSE(1)], ["user", "We decided to use PostgreSQL 17 for the database."], ["assistant", PROSE(2)], ["user", "ok"], ["assistant", PROSE(3)]], "why did we make this decision?");
    expect(rd.referentialObject).toMatchObject({ kind: "decision", selectedIds: ["m2"] });
  });

  it("a reference to failures does not select non-error messages of another type", () => {
    const r = compile([["user", "We decided to use PostgreSQL 17 for the database."], ["assistant", PROSE(1)], ["user", "The frontend must use React."], ["assistant", PROSE(2)], ["user", "ok"], ["assistant", PROSE(3)]], "what do these failures have in common?");
    expect(r.referentialObject!.candidateIds).toEqual([]);
    expect(r.referentialObject!.selectedIds).toEqual([]);
  });

  it("4. old unrelated logs beyond a topic break are a different episode: only the recent block is selected", () => {
    const rows: [("user" | "assistant"), string][] = [
      ["user", LOG(1, 1)], ["assistant", PROSE(1)], ["user", LOG(2, 1)], ["assistant", PROSE(2)], ["user", LOG(3, 1)], ["assistant", PROSE(3)],
      ["user", "Explain how B-trees work."], ["assistant", PROSE(4)],
      ["user", LOG(1, 9)], ["assistant", PROSE(5)], ["user", LOG(2, 9)], ["assistant", PROSE(6)],
    ];
    const r = compile(rows, "what do these failures have in common");
    const a = routed(r);
    expect(r.referentialObject!.selectedIds).toEqual(["m8", "m10"]);
    expect([a.m8, a.m10]).toEqual(["RETRIEVE", "RETRIEVE"]);
    for (const id of ["m0", "m2", "m4"]) expect(a[id], id).not.toBe("RETRIEVE"); // the old worker-1 logs stay out
    expect(r.decisions.filter((d) => d.action === "RETRIEVE" && d.id.startsWith("m") && ["m0", "m2", "m4"].includes(d.id))).toHaveLength(0);
  });

  it("is bounded: at most the newest ANTECEDENT_MAX_MESSAGES logs within the recent window", () => {
    const rows: [("user" | "assistant"), string][] = [];
    for (let i = 1; i <= 9; i++) rows.push(["user", LOG(i)], ["assistant", `ok ${i}`]);
    const r = compile(rows, "what do these failures have in common");
    expect(r.referentialObject!.selectedIds).toHaveLength(ANTECEDENT_MAX_MESSAGES);
    expect(r.referentialObject!.selectedIds[ANTECEDENT_MAX_MESSAGES - 1]).toBe("m16"); // newest included
    expect(r.referentialObject!.candidateIds.every((id) => Number(id.slice(1)) >= rows.length - ANTECEDENT_WINDOW)).toBe(true);
  });

  it("5. a protected relevant message takes part in the search but is never duplicated in the payload", () => {
    const protectedLog = "Always redact user paths when you report problems.\nERROR upload failed\nworker=image-worker-3\nfile=/uploads/user/1/a.jpg\nerror=connection timeout";
    const r = compile([["user", "Explain B-trees."], ["assistant", PROSE(1)], ["user", protectedLog], ["assistant", PROSE(2)], ["user", LOG(2)], ["assistant", PROSE(3)]], "what do these failures have in common?");
    const p = r.decisions.find((d) => d.id === "m2")!;
    expect(p.protected).toBe(true);
    expect(p.action).toBe("KEEP"); // still exactly one route
    expect(r.referentialObject!.candidateIds).toContain("m2"); // it is in the search universe...
    expect(r.referentialObject!.selectedIds).toEqual(expect.arrayContaining(["m2", "m4"])); // ...and part of the antecedent block
    expect(p.antecedent).toBe(true);
    expect(r.compiledContext.filter((c) => c.id === "m2")).toHaveLength(1); // ...but sent once
    expect(r.metrics.keepCount + r.metrics.retrieveCount + r.metrics.omitCount + r.metrics.memoryCount + r.metrics.compressCount).toBe(r.metrics.totalItems);
  });

  it("6. wording with no plausible antecedent abstains: nothing is invented", () => {
    const prose: [("user" | "assistant"), string][] = [["user", "Explain how B-trees work."], ["assistant", PROSE(1)], ["user", "What's a recipe for cookies?"], ["assistant", PROSE(2)], ["user", "TCP versus UDP?"], ["assistant", PROSE(3)], ["user", "ok"], ["assistant", PROSE(4)]];
    const r = compile(prose, "what do these failures have in common?");
    expect(r.referentialObject).toMatchObject({ kind: "error", candidateIds: [], selectedIds: [], needsSearch: true }); // a bounded search may look, and may abstain
    expect(r.decisions.filter((d) => d.antecedent)).toHaveLength(0);
    expect(r.decisions.filter((d) => d.action === "RETRIEVE").every((d) => d.continuity)).toBe(true); // only the ordinary continuity turns
  });

  it("7. generic word overlap alone does not trigger the mechanism", () => {
    const rows: [("user" | "assistant"), string][] = [["user", LOG(1)], ["assistant", PROSE(1)], ["user", "Explain how B-trees work."], ["assistant", PROSE(2)], ["user", "ok"], ["assistant", PROSE(3)]];
    for (const q of ["How do I handle errors in Go?", "why did the build fail", "failures in distributed systems"]) {
      const r = compile(rows, q);
      expect(r.referentialObject, q).toBeUndefined();
      expect(r.decisions.some((d) => d.antecedent), q).toBe(false);
    }
  });

  it("8. the existing 'what other features can I add?' follow-up behavior is unchanged", () => {
    const rows: [("user" | "assistant"), string][] = [["user", "i want to make a cli app that is customizable"], ["assistant", PROSE(1)], ["user", "i need to use react for this"], ["assistant", PROSE(2)], ["user", "ok"], ["assistant", PROSE(3)]];
    const r = compile(rows, "what other features can I add?");
    expect(r.referentialObject).toBeUndefined();
    expect(r.referentialFollowUp).toBe(true);
    expect(r.lexicallyInsufficient).toBe(true);
  });
});

// ---------------------------------------------------------------- engine: bounded semantic search, telemetry, end to end

describe("engine", () => {
  let db: DatabaseSync;
  let convId: string;
  beforeEach(() => {
    db = openDatabase(":memory:");
    convId = repo.createConversation(db).id;
  });
  const isRaw = (r: { mode?: string }) => r.mode === "raw";
  const answer = (n: number) => `Answer ${n}. ` + "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda. ".repeat(20);
  const PASS = '{"criteria":[],"category":"PASS","missing_ids":[]}';
  type Search = { prompts: string[] };
  const provider = (search: Search, pick: (ids: string[]) => string[]) => {
    const script: Script = (req, n) => {
      if (isRaw(req)) {
        if (req.request.includes("Earlier messages:")) {
          search.prompts.push(req.request);
          const digests = JSON.parse(req.request.slice(req.request.indexOf("Earlier messages:\n") + "Earlier messages:\n".length)) as { id: string }[];
          return JSON.stringify({ ids: pick(digests.map((d) => d.id)) });
        }
        if (req.request.includes("evaluating an AI assistant")) return PASS;
        if (req.request.includes("context-management")) return '{"results":[]}';
        return "{}";
      }
      return answer(n);
    };
    return new FakeProvider(script, { api: {} });
  };
  const say = (p: FakeProvider, content: string) => runTurn(db, p, { conversationId: convId, content });
  const chatCalls = (p: FakeProvider, from: number) => p.calls.slice(from).filter((c) => !isRaw(c));

  it("1. end to end: the retry logs are in the FIRST optimized attempt, it passes, and nothing falls back", async () => {
    const search: Search = { prompts: [] };
    const p = provider(search, () => []);
    for (const t of ["Explain how B-trees work.", "What's a good recipe for chocolate chip cookies?", "I'm debugging an image upload worker. It writes metadata to PostgreSQL.", LOG(1), LOG(2), LOG(3)]) await say(p, t);
    const ids = repo.listMessages(db, convId).filter((m) => m.role === "user").map((m) => m.id);
    const before = p.calls.length;
    const out = await say(p, "What do these failures have in common and what should I investigate first?");

    const chats = chatCalls(p, before);
    expect(chats).toHaveLength(1);
    const sent = chats[0].context.map((c) => c.id);
    for (const logId of ids.slice(3, 6)) expect(sent).toContain(logId); // all three logs
    for (const oldId of ids.slice(0, 3)) expect(sent).not.toContain(oldId); // the earlier, unrelated user messages are not
    expect(out.run).toMatchObject({ evaluationStatus: "PASS", fallbackLevel: 0 });
    expect(out.run.finalReductionPercent).toBeGreaterThan(0);
    expect(search.prompts).toHaveLength(0); // found by type: no model search needed

    // telemetry
    const t = repo.getRun(db, out.run.id)!.trace;
    expect(t.retrieval.referential).toMatchObject({ kind: "error", phrase: "these failures", needsSearch: false });
    expect(t.retrieval.referential!.candidateIds).toHaveLength(3);
    expect(t.retrieval.referential!.selectedIds.sort()).toEqual(ids.slice(3, 6).sort());
    expect(t.evaluation.attempts[0].referential!.selectedIds).toHaveLength(3);
    expect(understanding(t).reference).toEqual({ phrase: "these failures", kind: "error", found: 3 });
    const cards = buildDecisionCards(decisionBasis(t, 0));
    const card = cards.find((c) => c.headline === "3 recent error logs")!;
    expect(card).toBeDefined();
    expect(card.label).toBe("Brought back");
    expect(card.why).toBe("Your question says “these failures”, which refers to the error logs you just provided.");
    expect(card.impact).toMatch(/added because they were relevant/);
    expect(card.technical.reason).toMatch(/\(type: error\); candidate ids: .*; selected ids:/);
  });

  it("E/D. with no deterministic antecedent, a bounded search runs over the recent window only, protected messages included, and picks are never duplicated", async () => {
    const search: Search = { prompts: [] };
    let protectedId = "";
    const p = provider(search, (ids) => [ids.find((id) => id === protectedId)!].filter(Boolean));
    // Older history first (outside the recent window), then the protected message and more turns inside it.
    for (const t of ["Explain how B-trees work.", "Summarize the plot of Hamlet.", "What is the capital of Australia?", "How do vaccines work?"]) await say(p, t);
    await say(p, "Never log authentication tokens or any secrets when the worker reports a problem.");
    protectedId = repo.listMessages(db, convId).filter((m) => m.role === "user")[4].id;
    for (const t of ["What's a recipe for cookies?", "Explain TCP versus UDP.", "Explain what a monad is.", "Describe the history of bicycles."]) await say(p, t);
    const before = p.calls.length;
    const searchesBefore = search.prompts.length; // earlier short questions may use the ordinary gate; only this request is measured
    const out = await say(p, "what do these failures have in common?");

    expect(search.prompts.length - searchesBefore).toBe(1);
    const prompt = search.prompts.at(-1)!;
    const digestIds = (JSON.parse(prompt.slice(prompt.indexOf("Earlier messages:\n") + 18)) as { id: string }[]).map((d) => d.id);
    expect(digestIds).toContain(protectedId); // protected messages are part of the search universe
    const all = repo.listMessages(db, convId);
    expect(digestIds.length).toBeLessThanOrEqual(ANTECEDENT_WINDOW); // bounded to the recent window
    expect(digestIds).not.toContain(all[0].id); // the oldest history is outside the window and was not searched
    expect(all.length).toBeGreaterThan(ANTECEDENT_WINDOW + 2);
    expect(prompt).toMatch(/up to 3 that this phrase actually points at/);
    expect(prompt).toMatch(/choose none: do not guess/);
    // the protected pick is sent exactly once (it was already KEEP)
    const sent = chatCalls(p, before)[0].context.map((c) => c.id);
    expect(sent.filter((id) => id === protectedId)).toHaveLength(1);
    const t = repo.getRun(db, out.run.id)!.trace;
    expect(t.retrieval.referential).toMatchObject({ needsSearch: true, semanticSelectedIds: [protectedId] });
    expect(t.retrieval.referential!.searchedIds).toEqual(digestIds);
    expect(out.trace.utilityCalls.filter((u) => u.kind === "semantic_retrieval")).toHaveLength(1); // this request made exactly one search
    expect(all.length).toBeGreaterThan(digestIds.length); // and the whole history was not what was searched
  });

  it("6. when the search finds nothing plausible it abstains: no antecedent, nothing invented, nothing extra sent", async () => {
    const search: Search = { prompts: [] };
    const p = provider(search, () => []);
    for (const t of ["Explain how B-trees work.", "What's a recipe for cookies?", "Explain TCP versus UDP.", "Explain what a monad is."]) await say(p, t);
    const before = p.calls.length;
    const out = await say(p, "what do these failures have in common?");
    expect(search.prompts).toHaveLength(1);
    const t = repo.getRun(db, out.run.id)!.trace;
    expect(t.retrieval.referential).toMatchObject({ selectedIds: [], semanticSelectedIds: [] });
    expect(out.trace.retrieval.semanticNote).toMatch(/no additional relevant history/i);
    expect(understanding(t).reference!.found).toBe(0);
    const cards = buildDecisionCards(decisionBasis(t, 0));
    expect(cards.some((c) => c.key.startsWith("ref:"))).toBe(false);
    expect(chatCalls(p, before)[0].context.length).toBeLessThan(repo.listMessages(db, convId).length);
  });

  it("6b. with only the continuity turns in the window there is nothing to search: no model call at all", async () => {
    const search: Search = { prompts: [] };
    const p = provider(search, () => ["x"]);
    await say(p, "Hello there.");
    const out = await say(p, "what do these failures have in common?");
    expect(search.prompts).toHaveLength(0);
    expect(out.trace.utilityCalls.filter((u) => u.kind === "semantic_retrieval")).toHaveLength(0);
  });

  it("7. an ordinary question about errors never triggers the mechanism or a search", async () => {
    const search: Search = { prompts: [] };
    const p = provider(search, () => []);
    for (const t of ["Explain how B-trees work.", LOG(1), "What's a recipe for cookies?", "Explain what a monad is."]) await say(p, t);
    const out = await say(p, "How do I handle errors in Go?");
    expect(out.trace.retrieval.referential).toBeUndefined();
    expect(search.prompts).toHaveLength(0);
  });
});
