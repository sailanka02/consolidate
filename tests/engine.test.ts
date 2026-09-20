// End-to-end engine behavior with a scripted fake provider and an in-memory SQLite database.
import { beforeEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { openDatabase } from "@/lib/db";
import * as repo from "@/lib/db/repo";
import { runTurn } from "@/lib/engine/turn";
import { ProviderError, type ModelRequest } from "@/lib/model";
import { FakeProvider, type Script } from "./helpers";

let db: DatabaseSync;
let convId: string;
beforeEach(() => {
  db = openDatabase(":memory:");
  convId = repo.createConversation(db).id;
});

const isRaw = (r: { mode?: string }) => r.mode === "raw";
const chatText = (r: { context: { content: string }[] }) => r.context.map((c) => c.content).join("\n");
// Default script: plain chat answers; evaluator passes; analysis returns nothing durable.
const base =
  (extra?: (req: ModelRequest, n: number) => string | Error | undefined): Script =>
  (req, n) => {
    const custom = extra?.(req, n);
    if (custom !== undefined) return custom;
    if (isRaw(req)) {
      if (req.request.includes("evaluating an AI assistant")) return '{"criteria":[{"name":"answers_request","pass":true,"reason":"ok"}],"verdict":"pass","missing_ids":[]}';
      if (req.request.includes("context-management")) return '{"results":[]}';
      return "{}";
    }
    return `Answer #${n} to: ${req.request.slice(0, 40)}`;
  };
const say = async (p: FakeProvider, text: string, dev?: { forceEvalFailure?: "optimized" | "all" }) => runTurn(db, p, { conversationId: convId, content: text, dev });

describe("real conversation flow", () => {
  it("starts empty, persists both messages and a run, and reconstructs the trace", async () => {
    expect(repo.listMessages(db, convId)).toHaveLength(0);
    const p = new FakeProvider(base());
    const out = await say(p, "Hello there, please introduce yourself briefly.");
    const msgs = repo.listMessages(db, convId);
    expect(msgs.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(msgs[1].content).toMatch(/^Answer #1/);
    expect(msgs[1].runId).toBe(out.run.id);
    // The first request has no history: the model receives only the request.
    expect(p.calls[0].context).toHaveLength(0);
    const stored = repo.getRun(db, out.run.id)!;
    expect(stored.trace.requestAnalysis.request).toMatch(/Hello there/);
    expect(stored.trace.evaluation.status).toBe("PASS");
    expect(repo.getConversation(db, convId)!.title).toMatch(/^Hello there/);
    expect(db.prepare("SELECT COUNT(*) AS n FROM context_decision WHERE run_id = ?").get(out.run.id)).toEqual({ n: 0 });
  });

  it("extracts memory, sends it on later turns, omits unrelated history, and shrinks relative context", async () => {
    const p = new FakeProvider(base());
    await say(p, "We decided to use PostgreSQL 17 for the database.");
    await say(p, "Tell me something about the history of bicycles in a few sentences, with some detail.");
    await say(p, "Now explain what a monad is in functional programming, again in some detail please.");
    await say(p, "Write a short poem about the sea and its many moods, please.");
    const memory = repo.listMemory(db, convId);
    expect(memory).toHaveLength(1);
    expect(memory[0]).toMatchObject({ key: "database", value: "PostgreSQL 17", type: "decision" });
    expect(memory[0].sourceIds).toHaveLength(1);

    const last = await say(p, "Which database did we decide to use?");
    const sent = chatText(p.calls.filter((c) => !isRaw(c)).at(-1)!);
    expect(sent).toMatch(/PostgreSQL 17/);
    expect(sent).not.toMatch(/bicycles|monad/);
    expect(last.trace.compilation.counts.omit).toBeGreaterThan(0);
    expect(last.run.tokensAvoided).toBeGreaterThan(0);
    expect(last.run.originalTokens).toBe(last.run.compiledTokens + last.run.tokensAvoided);
    const s = last.run.savings;
    expect(s.omission + s.memory + s.compression + s.deduplication).toBe(last.run.tokensAvoided);
  });

  it("keeps a protected constraint verbatim even when it is unrelated to the request", async () => {
    const p = new FakeProvider(base());
    await say(p, "Always answer in formal English and never use slang.");
    for (const t of ["Explain photosynthesis in some detail please, covering light reactions.", "Summarise the causes of the French revolution in several sentences.", "Describe how a bicycle gear system works in a good amount of detail."]) await say(p, t);
    const out = await say(p, "What is 12 times 12?");
    expect(chatText(p.calls.filter((c) => !isRaw(c)).at(-1)!)).toMatch(/Always answer in formal English/);
    expect(out.trace.protection.items).toHaveLength(1);
    expect(out.trace.protection.items[0].reason).toMatch(/explicit user constraint/);
  });

  it("collapses repeated pasted logs and reports compression", async () => {
    const p = new FakeProvider(base());
    const log = "2025-03-01T10:00:00Z ERROR payment-service: connection refused to redis:6379 (ECONNREFUSED) while processing order 4711, retrying in 5s";
    for (let i = 0; i < 4; i++) await say(p, log);
    await say(p, "Something unrelated about baking sourdough bread at home.");
    const out = await say(p, "Why does the payment-service keep hitting ECONNREFUSED on redis?");
    expect(out.trace.compression.groups.length + out.trace.compression.deduplicated.length).toBeGreaterThan(0);
    expect(out.run.savings.deduplication + out.run.savings.compression).toBeGreaterThan(0);
  });
});

describe("batched semantic steps", () => {
  it("classifies all pending ambiguous messages in ONE call, persists results, and never repeats them", async () => {
    const batchSizes: number[] = [];
    const p = new FakeProvider(
      base((req) => {
        if (isRaw(req) && req.request.includes("context-management")) {
          const items = JSON.parse(req.request.slice(req.request.indexOf("Messages:\n") + 10)) as { id: string; text: string }[];
          batchSizes.push(items.length);
          if (batchSizes.length === 1) return new ProviderError("timeout", "first attempt fails, leaving the message pending");
          return JSON.stringify({
            results: items.map((it) => ({ id: it.id, type: "fact", protected: false, protection_reason: "", memory: [{ key: "audit_timing", value: "rollout waits for the audit", type: "decision", op: "set" }], complete: true })),
          });
        }
      }),
    );
    await say(p, "Our rollout should probably wait until the audit is finished next quarter.");
    await say(p, "The migration should include a rollback plan before we touch production data next month.");
    await say(p, "What should we do first?");
    expect(batchSizes).toEqual([1, 2]); // the retry batches both pending messages into a single call
    const ann = [...repo.getAnnotations(db, convId).values()].filter((a) => a.classMethod === "semantic");
    expect(ann).toHaveLength(2);
    expect(repo.listMemory(db, convId).find((m) => m.key === "audit_timing")?.sourceIds).toHaveLength(2);
    await say(p, "And after that?");
    expect(batchSizes).toEqual([1, 2]); // nothing pending: the two cached classifications are not repeated
  });

  it("falls back to deterministic behavior when the semantic call fails", async () => {
    const p = new FakeProvider(base((req) => (isRaw(req) && req.request.includes("context-management") ? new ProviderError("timeout", "slow") : undefined)));
    await say(p, "Our rollout should probably wait until the audit is finished next quarter.");
    const out = await say(p, "What next?");
    expect(out.trace.utilityCalls.some((u) => !u.ok)).toBe(true);
    expect(out.assistantMessage.content).toMatch(/^Answer/);
  });

  it("uses model summaries for long relevant messages, guards against invention, and reuses the cache", async () => {
    const long = "The `reconcile_ledger` job runs nightly and compares ledger totals against processor payouts. ".repeat(14) + "It alerts when the drift exceeds 25 dollars.";
    let summaryCalls = 0;
    const p = new FakeProvider(
      base((req) => {
        if (isRaw(req) && req.request.startsWith("Summarize each message")) {
          summaryCalls++;
          const items = JSON.parse(req.request.slice(req.request.indexOf("Messages:\n") + 10)) as { id: string }[];
          return JSON.stringify({ summaries: items.map((i) => ({ id: i.id, summary: "The `reconcile_ledger` job compares ledger totals with processor payouts nightly; alerts when drift exceeds 25 dollars." })) });
        }
      }),
    );
    await say(p, long);
    await say(p, "Unrelated chatter about the weather forecast for the coming weekend at the beach.");
    await say(p, "Another unrelated note about my favourite sourdough starter recipe and hydration levels.");
    const out = await say(p, "Explain how the billing reconciliation job detects ledger drift against payouts.");
    expect(summaryCalls).toBe(1);
    expect(out.trace.compression.groups.some((g) => g.method === "semantic")).toBe(true);
    await say(p, "Remind me what the billing reconciliation drift alert threshold is for ledger totals.");
    expect(summaryCalls).toBe(1);
    const rows = db.prepare("SELECT source_ids, original_tokens, compressed_tokens, summary, reason FROM compressed_group WHERE method = 'semantic'").all() as { original_tokens: number; compressed_tokens: number }[];
    expect(rows.length).toBe(1);
    expect(rows[0].compressed_tokens).toBeLessThan(rows[0].original_tokens);
  });
});

describe("evaluation and fallback", () => {
  const seed = async (p: FakeProvider) => {
    await say(p, "Never share customer emails with third parties.");
    await say(p, "Tell me about the moon landing in a good amount of detail please, with dates.");
    await say(p, "Explain how transistors work in a good amount of detail please, with analogies.");
  };

  it("expands retrieval and retries once when the first attempt fails, persisting the failed answer", async () => {
    const p = new FakeProvider(base());
    await seed(p);
    const before = p.calls.length;
    const out = await say(p, "Who may receive customer emails?", { forceEvalFailure: "optimized" });
    const chats = p.calls.slice(before).filter((c) => !isRaw(c));
    expect(chats).toHaveLength(2);
    expect(out.trace.evaluation.fallbackLevel).toBe(1);
    expect(out.trace.evaluation.attempts.map((a) => a.level)).toEqual(["optimized", "expanded"]);
    expect(out.trace.evaluation.attempts[0].passed).toBe(false);
    expect(out.run).toMatchObject({ evaluationStatus: "FAIL", fallbackApplied: true, fallbackLevel: 1 });
    const rows = db.prepare("SELECT level, passed, response FROM run_attempt WHERE run_id = ? ORDER BY idx").all(out.run.id) as { level: string; passed: number; response: string }[];
    expect(rows.map((r) => r.level)).toEqual(["optimized", "expanded"]);
    expect(rows[0].response).toBeTruthy();
    expect(out.assistantMessage.content).toBe(rows[1].response);
  });

  it("executes the full context when the retry also fails", async () => {
    const p = new FakeProvider(base());
    await seed(p);
    const before = p.calls.length;
    const out = await say(p, "Who may receive customer emails?", { forceEvalFailure: "all" });
    const chats = p.calls.slice(before).filter((c) => !isRaw(c));
    expect(chats).toHaveLength(3);
    expect(chats[2].context.filter((c) => !c.section)).toHaveLength(6); // all six prior messages
    expect(out.trace.evaluation.fallbackLevel).toBe(2);
    expect(out.run.tokensAvoided).toBe(0);
    expect(out.run.savings).toEqual({ omission: 0, memory: 0, compression: 0, deduplication: 0 });
    expect(out.assistantMessage.content).toBe(out.trace.evaluation.attempts[2].response);
  });

  it("treats a semantic evaluator failure verdict as a failed attempt and reports the missing context", async () => {
    let evals = 0;
    const p = new FakeProvider(
      base((req) => {
        if (isRaw(req) && req.request.includes("evaluating an AI assistant") && req.request.includes("Who may receive")) {
          evals++;
          return evals === 1
            ? '{"criteria":[{"name":"no_missing_context","pass":false,"reason":"answer ignores earlier info"}],"verdict":"fail","missing_ids":[]}'
            : '{"criteria":[],"verdict":"pass","missing_ids":[]}';
        }
      }),
    );
    await seed(p);
    const out = await say(p, "Who may receive customer emails?");
    expect(out.trace.evaluation.fallbackLevel).toBe(1);
    expect(out.trace.evaluation.checks.some((c) => c.layer === "semantic" && !c.passed)).toBe(true);
  });

  it("skips the semantic evaluator when nothing was removed", async () => {
    const p = new FakeProvider(base());
    await say(p, "Hi, this is my first message to you.");
    const out = await say(p, "And this is the second one.");
    expect(out.trace.evaluation.semanticEvaluatorUsed).toBe(false);
    expect(out.trace.evaluation.semanticSkipReason).toMatch(/No economic benefit from semantic optimization/);
  });
});

describe("failure handling", () => {
  it("persists nothing for a request whose model call fails, and returns the error", async () => {
    const p = new FakeProvider((req) => (isRaw(req) ? "{}" : new ProviderError("timeout", "Claude Code did not respond")));
    await expect(say(p, "Hello?")).rejects.toMatchObject({ code: "timeout" });
    expect(repo.listMessages(db, convId)).toHaveLength(0);
    expect(repo.dashboardStats(db).requests).toBe(0);
  });
  it("rejects empty messages and unknown conversations", async () => {
    const p = new FakeProvider(base());
    await expect(say(p, "   ")).rejects.toMatchObject({ code: "invalid" });
    await expect(runTurn(db, p, { conversationId: "nope", content: "hi" })).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("dashboard", () => {
  it("aggregates only persisted runs", async () => {
    expect(repo.dashboardStats(db)).toMatchObject({ requests: 0, estimated: { runs: 0, avgReductionPercent: null }, counted: { runs: 0, avgReductionPercent: null }, evaluationPassRate: null });
    const p = new FakeProvider(base());
    await say(p, "First message for the dashboard test, nothing special here.");
    await say(p, "Second message for the dashboard test, also nothing special.", { forceEvalFailure: "optimized" });
    const s = repo.dashboardStats(db);
    expect(s.requests).toBe(2);
    expect(s.evaluationPassRate).toBe(0.5);
    expect(s.fallbackCount).toBe(1);
    expect(s.actualUsage.outputTokens).toBeGreaterThan(0);
    expect(repo.listRunSummaries(db, 10)).toHaveLength(2);
  });
});
