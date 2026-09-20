// Demo seeding: explicit only, idempotent, resumable, engine-driven, and exported from persisted runs.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { openDatabase } from "@/lib/db";
import * as repo from "@/lib/db/repo";
import { BAKERY_TURNS, ENTERPRISE_TURNS, SCENARIOS, type DemoScenario } from "@/lib/demo/scenarios";
import { assertSeedAllowed, exportDemo, seedScenario, toCsv } from "@/lib/demo/seed";
import { FakeProvider, type Script } from "./helpers";

const isRaw = (r: { mode?: string }) => r.mode === "raw";
const script: Script = (req, n) => (isRaw(req) ? (req.request.includes("evaluating an AI assistant") ? '{"criteria":[],"category":"PASS","missing_ids":[]}' : '{"results":[]}') : `Assistant answer ${n}. ` + "words ".repeat(60));
const mk = (turns: string[]): DemoScenario => ({ key: "enterprise", title: "Demo — Test Scenario", description: "t", turns, complete: true });
let db: DatabaseSync;
let p: FakeProvider;
const chats = () => p.calls.filter((c) => !isRaw(c)).length;
beforeEach(() => {
  db = openDatabase(":memory:");
  p = new FakeProvider(script, { api: {} });
});

describe("the explicit guard", () => {
  const ok = { CONSOLIDATE_SEED_DEMOS: "1", MODEL_PROVIDER: "anthropic-api", ANTHROPIC_API_KEY: "k" };
  it("refuses without CONSOLIDATE_SEED_DEMOS=1, with a stand-in provider, or without a key", () => {
    expect(() => assertSeedAllowed({ ...ok, CONSOLIDATE_SEED_DEMOS: undefined })).toThrow(/CONSOLIDATE_SEED_DEMOS=1/);
    expect(() => assertSeedAllowed({ ...ok, CONSOLIDATE_SEED_DEMOS: "true" })).toThrow(/CONSOLIDATE_SEED_DEMOS=1/);
    expect(() => assertSeedAllowed({ ...ok, MODEL_PROVIDER: "claude-code" })).toThrow(/real Anthropic provider/);
    expect(() => assertSeedAllowed({ ...ok, ANTHROPIC_API_KEY: "" })).toThrow(/ANTHROPIC_API_KEY/);
    expect(() => assertSeedAllowed(ok)).not.toThrow();
  });
  it("is never wired into the app: no app/component/lib file imports it and no npm lifecycle script runs it", () => {
    const walk = (d: string): string[] => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : [join(d, f)]));
    const files = [...walk("app"), ...walk("components"), ...walk("lib").filter((f) => !f.startsWith(join("lib", "demo"))), "instrumentation.ts", "instrumentation-node.ts", "proxy.ts"].filter((f) => /\.(ts|tsx)$/.test(f) && statSync(f, { throwIfNoEntry: false })?.isFile());
    for (const f of files) expect(readFileSync(f, "utf8"), f).not.toMatch(/lib\/demo|\.\.\/demo|seed-demos/);
    const scripts = JSON.parse(readFileSync("package.json", "utf8")).scripts as Record<string, string>;
    expect(scripts["seed:demos"]).toMatch(/seed\.vitest\.config/);
    for (const k of ["dev", "build", "start", "postinstall", "prebuild", "prestart"]) expect(scripts[k] ?? "", k).not.toMatch(/seed/);
  });
});

describe("the scenarios", () => {
  it("carry the requested titles and verbatim turns", () => {
    expect(SCENARIOS.map((s) => s.title)).toEqual(["Demo — Enterprise Employee", "Demo — Mom & Pop Website"]);
    expect(ENTERPRISE_TURNS).toHaveLength(15);
    expect(ENTERPRISE_TURNS[5]).toMatch(/changing the application database from PostgreSQL 17 to PostgreSQL 16/);
    expect(ENTERPRISE_TURNS[7].match(/^ERROR approval transition failed/gm)).toHaveLength(3);
    expect(ENTERPRISE_TURNS[7]).toMatch(/What do these failures have in common\?$/);
    expect(ENTERPRISE_TURNS[14]).toMatch(/three highest-priority things/);
    expect(BAKERY_TURNS).toHaveLength(16);
    expect(BAKERY_TURNS[7]).toMatch(/POST \/api\/cake-request 500/);
    expect(BAKERY_TURNS[13]).toBe("Remind me of our current business hours and the rule we decided on for cake payments.");
    expect(BAKERY_TURNS[15]).toMatch(/three improvements you would prioritize after launch/);
    expect(BAKERY_TURNS[4]).toMatch(/^Actually, our hours changed\./);
    expect(BAKERY_TURNS[6]).toContain('<a href="/cakes">Custom Cakes</a>');
    expect(SCENARIOS[0].complete).toBe(true);
    expect(SCENARIOS[1].complete).toBe(true);
  });
});

describe("seeding runs every turn through the real engine, idempotently", () => {
  it("creates a titled conversation with real runs, and a second call changes nothing", async () => {
    const s = mk(["First message about a project.", "Second message about a constraint: never log tokens.", "Third message asking a question."]);
    const a = await seedScenario(db, p, s);
    expect(a).toMatchObject({ action: "created", turnsRun: 3, turnsTotal: 3 });
    const conv = repo.getConversation(db, a.conversationId)!;
    expect(conv.title).toBe("Demo — Test Scenario"); // not overwritten by the engine's first-message title
    const msgs = repo.listMessages(db, conv.id);
    expect(msgs.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant", "user", "assistant"]);
    expect(msgs.filter((m) => m.role === "user").map((m) => m.content)).toEqual(s.turns);
    expect(db.prepare("SELECT COUNT(*) AS n FROM compiler_run WHERE conversation_id = ?").get(conv.id)).toEqual({ n: 3 }); // real runs, not fabricated rows
    expect(msgs.filter((m) => m.role === "assistant").every((m) => !!m.runId)).toBe(true);
    const before = chats();
    const b = await seedScenario(db, p, s);
    expect(b).toMatchObject({ action: "skipped", turnsRun: 0, conversationId: a.conversationId });
    expect(chats()).toBe(before); // no model calls
    expect(repo.listConversations(db).filter((c) => c.title === s.title)).toHaveLength(1);
  });

  it("resumes a partly seeded (or extended) scenario from its next turn without duplicates", async () => {
    const turns = ["One.", "Two must be kept.", "Three?", "Four."];
    const first = await seedScenario(db, p, mk(turns.slice(0, 2)));
    const before = chats();
    const second = await seedScenario(db, p, mk(turns));
    expect(second).toMatchObject({ action: "resumed", turnsRun: 2, conversationId: first.conversationId });
    expect(chats()).toBe(before + 2);
    expect(repo.listMessages(db, first.conversationId).filter((m) => m.role === "user").map((m) => m.content)).toEqual(turns);
    expect(repo.listConversations(db).filter((c) => c.title === "Demo — Test Scenario")).toHaveLength(1);
  });

  it("refuses to touch a conversation with the demo title whose messages are not the scenario's", async () => {
    const c = repo.createConversation(db, "Demo — Test Scenario");
    repo.insertMessage(db, { id: "m1", conversationId: c.id, role: "user", content: "something else", localTokenEstimate: 3 });
    await expect(seedScenario(db, p, mk(["First."]))).rejects.toThrow(/not this scenario's turns/);
    expect(chats()).toBe(0);
  });
});

describe("export reads persisted runs only", () => {
  it("matches the stored run summaries, sums correctly, and is chart-ready", async () => {
    const s = mk(["Project intro with some detail.", "Constraint: authentication tokens must never appear in logs.", "Unrelated question about sorting.", "Another unrelated question about trees.", "What did I say about logs?"]);
    const res = await seedScenario(db, p, s);
    const e = exportDemo(db, res.conversationId);
    const runs = repo.listRunSummaries(db, 50).filter((r) => r.conversationId === res.conversationId).reverse();
    expect(e).toMatchObject({ synthetic: true, title: "Demo — Test Scenario" });
    expect(e.label).toMatch(/not a customer conversation/);
    expect(e.turns).toHaveLength(5);
    e.turns.forEach((t, i) => {
      expect(t.fullTokens).toBe(runs[i].originalTokens);
      expect(t.finalCompiledTokens).toBe(runs[i].compiledTokens);
      expect(t.initialCompiledTokens).toBe(runs[i].initialCompiledTokens);
      expect(t.netSavingsUsd).toBe(runs[i].costs?.netSavingsUsd ?? null);
      expect(t.countSource).toBe("provider_count");
      expect(t.mainModelGenerations).toBeGreaterThanOrEqual(1);
    });
    const sum = (f: (t: (typeof e.turns)[number]) => number) => e.turns.reduce((n, t) => n + f(t), 0);
    expect(e.totals.fullTokens).toBe(sum((t) => t.fullTokens));
    expect(e.totals.finalCompiledTokens).toBe(sum((t) => t.finalCompiledTokens));
    expect(e.totals.tokensAvoided).toBe(e.totals.fullTokens - e.totals.finalCompiledTokens);
    expect(e.totals.mainModelGenerations).toBe(sum((t) => t.mainModelGenerations));
    expect(e.series.labels).toEqual(["T1", "T2", "T3", "T4", "T5"]);
    expect(e.series.cumulativeFullTokens.at(-1)).toBe(e.totals.fullTokens);
    expect(e.series.cumulativeFinalTokens.at(-1)).toBe(e.totals.finalCompiledTokens);
    expect(e.series.cumulativeNetUsd.at(-1)).toBeCloseTo(e.totals.netSavingsUsd, 5);
    const csv = toCsv(e).trimEnd().split("\n");
    expect(csv).toHaveLength(6);
    expect(csv[0]).toMatch(/^turn,prompt,countSource,fullTokens,initialCompiledTokens,finalCompiledTokens,/);
  });
});
