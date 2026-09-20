// Compiler behavior on the coding-demo fixture (test-only data). Verifies each mechanism from real conditions.
import { describe, expect, it } from "vitest";
import { compileContext } from "@/lib/consolidate/compile";
import { evaluateContext } from "@/lib/consolidate/evaluate";
import { applyStatements, extractStatements } from "@/lib/consolidate/memory";
import { annotateMessage, classifyDeterministic } from "@/lib/consolidate/classify";
import { detectProtection } from "@/lib/consolidate/protection";
import { summaryIsFaithful } from "@/lib/consolidate/compress";
import { DEMO, prepare } from "./helpers";

const AUTH = "Fix the authentication issue. Can we switch production to API keys?";
const NAVBAR = "Why is the navbar dropdown flickering?";
const DB = "What's causing the PostgreSQL connection failure?";
const REGION = "Which region is production in and how is connection pooling handled?";

const { messages, memory } = prepare(DEMO);
const compile = (request: string) => compileContext({ messages, request, memory });
const action = (r: ReturnType<typeof compile>, id: string) => r.decisions.find((d) => d.id === id)!.action;

describe("protection", () => {
  it("keeps system policy, developer hard rules and explicit user constraints for every request", () => {
    for (const q of [AUTH, NAVBAR, DB, REGION]) {
      const r = compile(q);
      for (const id of ["m2", "m3", "m98"]) expect(action(r, id)).toBe("KEEP");
      expect(r.decisions.filter((d) => d.protected).every((d) => d.action === "KEEP")).toBe(true);
    }
  });
  it("never puts a protected message in a compressed group", () => {
    const r = compile(DB);
    const protectedIds = new Set(r.decisions.filter((d) => d.protected).map((d) => d.id));
    expect(r.groups.some((g) => g.sourceIds.some((id) => protectedIds.has(id)))).toBe(false);
  });
  it("records why a message was protected", () => {
    expect(detectProtection({ role: "user", content: "Never store passwords in plain text." })?.reason).toMatch(/explicit user constraint/);
    expect(detectProtection({ role: "user", content: "I don't know why it fails." })).toBeNull();
    expect(detectProtection({ role: "user", content: "Use exactly this config:\n```yaml\na: 1\n```" })?.reason).toMatch(/exact code/);
  });
});

describe("retrieval and omission", () => {
  it("retrieves what matches the request and omits unrelated history", () => {
    const nav = compile(NAVBAR);
    expect(action(nav, "m22")).toBe("RETRIEVE");
    expect(nav.decisions.filter((d) => d.action === "OMIT").length).toBeGreaterThan(50);
    expect(nav.compiledContext.map((c) => c.content).join(" ")).not.toMatch(/ECONNREFUSED/);
    const db = compile(DB);
    expect(action(db, "m38")).toBe("RETRIEVE");
    expect(db.compiledContext.map((c) => c.content).join(" ")).not.toMatch(/mouseleave/);
  });
  it("exposes scores and signals per decision", () => {
    const d = compile(NAVBAR).decisions.find((x) => x.id === "m22")!;
    expect(d.score).toBeGreaterThan(0.5);
    expect(d.signals.lexical).toBeGreaterThan(0);
    expect(d.reason).toMatch(/Relevant/);
  });
  it("gives recent turns a continuity boost", () => {
    const r = compile("hmm, ok");
    expect(r.decisions.filter((d) => d.continuity).length).toBe(2);
  });
});

describe("structured memory", () => {
  it("routes fully-captured durable statements to MEMORY and sends them as memory lines", () => {
    const r = compile(REGION);
    expect(action(r, "m96")).toBe("MEMORY");
    expect(r.memoryInjected.map((m) => m.key)).toContain("production_region");
    const block = r.compiledContext.find((c) => c.section === "memory")!;
    expect(block.content).toMatch(/production_region: eu-west-1/);
    expect(r.compiledContext.some((c) => c.id === "m96")).toBe(false);
    expect(r.savings.memory).toBeGreaterThan(0);
  });
  it("extracts durable state, updates it when superseded, and keeps provenance", () => {
    let n = 0;
    const mk = () => `mem${++n}`;
    const a = applyStatements([], [{ sourceId: "a", statements: extractStatements("We decided to use PostgreSQL 15.").statements }], mk);
    expect(a.items[0]).toMatchObject({ key: "database", value: "PostgreSQL 15", type: "decision", sourceIds: ["a"] });
    const b = applyStatements(a.items, [{ sourceId: "b", statements: extractStatements("Actually we switched to PostgreSQL 17.").statements }], mk);
    expect(b.items).toHaveLength(1);
    expect(b.items[0]).toMatchObject({ value: "PostgreSQL 17", previousValues: ["PostgreSQL 15"], sourceIds: ["a", "b"] });
    expect(b.changes[0].change).toBe("updated");
    const c = applyStatements(b.items, [{ sourceId: "c", statements: extractStatements("We decided to use PostgreSQL 17.").statements }], mk);
    expect(c.changes[0].change).toBe("unchanged");
    expect(c.items[0].sourceIds).toEqual(["a", "b", "c"]);
  });
  it("supersedes a value stated under a more specific key, and drops the reason clause", () => {
    let n = 0;
    const mk = () => `mem${++n}`;
    const a = applyStatements([], [{ sourceId: "a", statements: extractStatements("We decided to use PostgreSQL 17 for the metadata database.").statements }], mk);
    expect(a.items[0].key).toBe("metadata_database");
    const b = applyStatements(a.items, [{ sourceId: "b", statements: extractStatements("Actually we switched to PostgreSQL 16 because of hosting limits.").statements }], mk);
    expect(b.items).toHaveLength(1);
    expect(b.items[0]).toMatchObject({ key: "metadata_database", value: "PostgreSQL 16", previousValues: ["PostgreSQL 17"] });
  });
  it("deactivates memory when the user says it no longer applies", () => {
    let n = 0;
    const mk = () => `mem${++n}`;
    const a = applyStatements([], [{ sourceId: "a", statements: extractStatements("We use Redis for caching.").statements }], mk);
    const b = applyStatements(a.items, [{ sourceId: "b", statements: extractStatements("We no longer use Redis.").statements }], mk);
    expect(b.items[0].active).toBe(false);
    expect(b.changes[0].change).toBe("removed");
  });
  it("does not create memory from casual or ephemeral talk", () => {
    for (const t of ["Thanks, that works!", "Can you explain how this works?", "The test is failing again.", "hmm this is confusing", "Write me a haiku about rain."]) {
      expect(extractStatements(t).statements, t).toHaveLength(0);
    }
  });
});

describe("compression and deduplication", () => {
  it("collapses repeated identical logs into one representative", () => {
    const r = compile(DB);
    const g = r.groups.find((x) => x.kind === "duplicate")!;
    expect(g).toBeDefined();
    expect(g.compressedTokenEstimate).toBeLessThan(g.originalTokenEstimate);
    expect(g.sourceIds.length).toBeGreaterThan(1);
    expect(g.summary).toMatch(/ECONNREFUSED/);
  });
  it("drops exact duplicates of irrelevant messages", () => {
    const r = compile(NAVBAR);
    expect(r.decisions.filter((d) => d.duplicateOf).length).toBeGreaterThan(0);
    expect(r.savings.deduplication).toBeGreaterThan(0);
  });
  it("collapses near-identical logs that differ only in numbers", () => {
    const logs = [1, 2, 3, 4].map((i) => ({ id: `l${i}`, role: "assistant" as const, content: `2025-01-0${i}T10:00:0${i}Z ERROR worker ${i} failed: connection timeout after ${i * 10}ms on host db-${i}.internal` }));
    const r = compileContext({ messages: [{ id: "u", role: "user" as const, content: "start" }, ...logs, { id: "u2", role: "user" as const, content: "next" }, { id: "a2", role: "assistant" as const, content: "ok" }].map((m) => ({ ...m, annotation: annotateMessage(m) })), request: "why does the worker keep failing with connection timeout?" });
    expect(r.groups.some((g) => g.kind === "related_logs" || g.kind === "duplicate")).toBe(true);
  });
  it("rejects model summaries that invent numbers or identifiers", () => {
    expect(summaryIsFaithful("Uses port 5432 and `pg_pool`.", ["We use port 5432 with `pg_pool`."]).ok).toBe(true);
    expect(summaryIsFaithful("Sanitize and/or wrap the OS/driver output.", ["Sanitize or wrap the operating system driver output."]).ok).toBe(true);
    expect(summaryIsFaithful("Uses port 6379.", ["We use port 5432."])).toMatchObject({ ok: false, invented: ["6379"] });
  });
});

describe("regressions found in real use", () => {
  it("never loses a memory item the request references, even when the request is long and the source message is chatty", () => {
    const convo = [
      ["user", "Hi! I'm building a small CLI tool for photo backups. We decided to use PostgreSQL 17 for the metadata database."],
      ["assistant", "Nice choice. PostgreSQL 17 is a solid fit for photo backup metadata. A files table keyed by content hash works well."],
      ["user", "Unrelated: explain how B-trees work and why they make indexes fast."],
      ["assistant", "A B-tree keeps keys sorted in wide nodes so lookups take a handful of page reads. ".repeat(20)],
      ["user", "Give me a chickpea dinner idea."],
      ["assistant", "Chickpea coconut curry: simmer chickpeas with coconut milk, onion, garlic and curry powder for twenty minutes."],
    ].map(([role, content], i) => ({ id: `r${i}`, role: role as "user" | "assistant", content }));
    const p = prepare(convo);
    const req = "2025-03-01T10:00:00Z ERROR uploader: connection refused to postgres:5432 (ECONNREFUSED) while writing metadata batch 17, retrying in 5s";
    const r = compileContext({ messages: p.messages, request: req, memory: p.memory });
    expect(evaluateContext(r, p.messages, p.memory, req).passed).toBe(true);
    expect(r.compiledContext.map((c) => c.content).join("\n")).toMatch(/PostgreSQL 17/);
  });
  it("keeps the last question together with its answer, however long the answer is", () => {
    const convo = [
      ["user", "Thanks for the earlier help."],
      ["assistant", "You're welcome."],
      ["user", "Explain how B-trees work."],
      ["assistant", "A B-tree keeps keys sorted in wide nodes so lookups take a handful of page reads. ".repeat(200)],
    ].map(([role, content], i) => ({ id: `q${i}`, role: role as "user" | "assistant", content }));
    const p = prepare(convo);
    const r = compileContext({ messages: p.messages, request: "Give me a dinner idea.", memory: p.memory });
    const ids = r.decisions.filter((d) => d.action === "RETRIEVE").map((d) => d.id);
    expect(ids.includes("q2")).toBe(ids.includes("q3")); // a question and its answer are kept or dropped together
  });
});

describe("token accounting", () => {
  it("partitions original - compiled exactly across the four mechanisms", () => {
    for (const q of [AUTH, NAVBAR, DB, REGION]) {
      const r = compile(q);
      const s = r.savings;
      expect(s.omission + s.memory + s.compression + s.deduplication).toBe(r.metrics.tokensAvoided);
      expect(r.metrics.reductionPercent).toBeGreaterThan(50);
    }
  });
});

describe("deterministic evaluation", () => {
  it("passes for compiler output", () => {
    for (const q of [AUTH, NAVBAR, DB, REGION]) expect(evaluateContext(compile(q), messages, memory, q).passed).toBe(true);
  });
  it("fails when protected context is dropped", () => {
    const r = compile(AUTH);
    const tampered = { ...r, compiledContext: r.compiledContext.filter((c) => c.id !== "m2") };
    const ev = evaluateContext(tampered, messages, memory, AUTH);
    expect(ev.passed).toBe(false);
    expect(ev.checks.find((c) => !c.passed)?.name).toMatch(/Protected/);
  });
  it("fails when the request names an identifier that was compiled away", () => {
    const req = "What is `pgbouncer.ini`?";
    const msgs = [{ id: "a", role: "user" as const, content: "Our pool config lives in `pgbouncer.ini` on the db host." }, ...messages.slice(5, 12)].map((m) => ({ ...m, annotation: annotateMessage(m) }));
    const r = compileContext({ messages: msgs, request: req, memory: [] });
    const tampered = { ...r, compiledContext: [] };
    expect(evaluateContext(tampered, msgs, [], req).checks.find((c) => c.name.startsWith("Identifiers"))?.passed).toBe(false);
  });
});

describe("classification", () => {
  it("is generic: labels arbitrary content without domain assumptions", () => {
    expect(classifyDeterministic({ role: "assistant", content: "```py\nprint('hi')\n```" }).contentType).toBe("code");
    expect(classifyDeterministic({ role: "assistant", content: "2025-01-01T10:00:00Z ERROR a\n2025-01-01T10:00:01Z ERROR b" }).contentType).toBe("log");
    expect(classifyDeterministic({ role: "assistant", content: "$ npm test\n3 passed" }).contentType).toBe("tool_output");
    expect(classifyDeterministic({ role: "user", content: "We decided to launch on Friday." }).contentType).toBe("decision");
    expect(classifyDeterministic({ role: "user", content: "I prefer short answers." }).contentType).toBe("preference");
    expect(classifyDeterministic({ role: "user", content: "Can you help me plan a trip?" })).toEqual({ contentType: "discussion", ambiguous: false });
  });
  it("flags durable-sounding statements no rule can settle as ambiguous", () => {
    expect(classifyDeterministic({ role: "user", content: "Our rollout should probably wait until the audit is finished next quarter." }).ambiguous).toBe(true);
  });
});

describe("generic-ness", () => {
  it("works on a conversation that has nothing to do with the demo", () => {
    const convo = [
      ["user", "I'm planning a wedding in Lisbon. The budget is 25000 euros."],
      ["assistant", "Congratulations! Lisbon is lovely. Are you thinking of a summer date?"],
      ["user", "Always give me prices in euros."],
      ["assistant", "Understood, I will quote prices in euros."],
      ["user", "We decided to book the venue in Sintra."],
      ["assistant", "Sintra has beautiful quintas. I can list a few venues."],
      ["user", "Tell me a joke about cats."],
      ["assistant", "Why did the cat sit on the computer? To keep an eye on the mouse!"],
      ["user", "Thanks!"],
      ["assistant", "You're welcome!"],
    ].map(([role, content], i) => ({ id: `w${i}`, role: role as "user" | "assistant", content }));
    const p = prepare(convo);
    const r = compileContext({ messages: p.messages, request: "What was our budget and where did we decide to hold the venue?", memory: p.memory });
    const text = r.compiledContext.map((c) => c.content).join("\n");
    expect(text).toMatch(/25000/);
    expect(text).toMatch(/Sintra/);
    expect(r.decisions.find((d) => d.id === "w2")!.action).toBe("KEEP"); // "Always give me prices in euros."
    expect(text).not.toMatch(/joke about cats/);
  });
});

describe("json extraction", () => {
  it("takes the first balanced object and ignores trailing prose", async () => {
    const { extractJson } = await import("@/lib/model/json");
    expect(extractJson('```json\n{"a":{"b":"}"}}\n```\nHope that helps {"x":1}')).toEqual({ a: { b: "}" } });
    expect(() => extractJson("no json here")).toThrow();
  });
});
