// LIVE smoke tests against the real Anthropic API. Skipped unless RUN_LIVE=1 (they spend real money, a few cents).
//   RUN_LIVE=1 npx vitest run tests/live --reporter=verbose
// Reads MODEL_PROVIDER / ANTHROPIC_API_KEY / ANTHROPIC_MODEL / ANTHROPIC_UTILITY_MODEL from .env.local.
import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { openDatabase } from "@/lib/db";
import * as repo from "@/lib/db/repo";
import { runTurn } from "@/lib/engine/turn";
import { configuredModels } from "@/lib/model/config";
import { AnthropicApiProvider } from "@/lib/model/anthropic-api";
import { buildMessagesPayload } from "@/lib/model/prompt";

const live = process.env.RUN_LIVE === "1";
if (live && existsSync(".env.local")) process.loadEnvFile(".env.local");

const LOG = Array.from({ length: 40 }, (_, i) => `2026-09-20T10:${String(i).padStart(2, "0")}:11Z INFO worker-3 job=sync-${1000 + i} status=ok rows=${i * 37} duration=${120 + i}ms`).join("\n");
const TURNS = [
  "Hi! I'm building a billing service. We decided to use PostgreSQL 17 for the database, and the backend is Node 22 with Fastify.",
  "Important rule: every money amount must be stored as integer cents, never floating point. Keep that in mind for everything you suggest.",
  `Here are some worker logs from last night, ignore unless relevant:\n${LOG}`,
  "Tell me briefly what an idempotency key is and why payment APIs use them.",
  "Explain database connection pooling in a few sentences.",
  "What is the difference between a mutex and a semaphore? Keep it short.",
  `More logs from the second worker:\n${LOG.replaceAll("worker-3", "worker-7")}`,
  "Give me a two-sentence summary of the CAP theorem.",
  "Now, which database did we pick and how should I store the price field in the invoices table? Give the column definition.",
];

describe.skipIf(!live)("live Anthropic API", () => {
  it("minimal real request: main model, utility model, and exact token count", async () => {
    const p = new AnthropicApiProvider();
    const { main, utility } = configuredModels();
    console.log("configured main model:", main, "| utility model:", utility);
    const r = await p.generate({ mode: "raw", context: [], request: "Reply with exactly the word: ok", timeoutMs: 60_000 });
    console.log("main   ->", JSON.stringify({ response: r.response, model: r.model, usage: r.usage, latencyMs: r.latencyMs }));
    expect(r.response.length).toBeGreaterThan(0);
    const u = await p.generate({ mode: "raw", context: [], request: "Reply with exactly the word: ok", tier: "utility", timeoutMs: 60_000 });
    console.log("utility->", JSON.stringify({ response: u.response, model: u.model, usage: u.usage, latencyMs: u.latencyMs }));
    expect(u.response.length).toBeGreaterThan(0);
    const req = { context: [{ id: "a", role: "user" as const, content: "My name is Ada." }], request: "What is my name?" };
    const counted = await p.countTokens(req);
    console.log("count_tokens ->", counted, "for payload", JSON.stringify(buildMessagesPayload(req)).length, "chars");
    expect(counted).toBeGreaterThan(0);
  }, 180_000);

  it("fresh real conversation: full pipeline end to end", async () => {
    const db = openDatabase(":memory:");
    const provider = new AnthropicApiProvider();
    const conv = repo.createConversation(db);
    const rows: unknown[] = [];
    let last!: Awaited<ReturnType<typeof runTurn>>;
    for (const [i, content] of TURNS.entries()) {
      last = await runTurn(db, provider, { conversationId: conv.id, content });
      const tc = last.trace.compilation.tokenCount!;
      rows.push({ turn: i + 1, source: tc.source, full: tc.fullTokens, compiled: tc.compiledTokens, reductionPct: tc.reductionPercent, estFull: tc.fullEstimate, estCompiled: tc.compiledEstimate, eval: last.trace.evaluation.status, fallback: last.run.fallbackLevel, utilityCalls: last.trace.utilityCalls.length });
    }
    console.table(rows);
    const c = last.trace.compilation;
    console.log("FINAL TURN REPORT\n" + JSON.stringify({
      mainModel: c.model, utilityModel: c.utilityModel,
      countSource: c.tokenCount?.source, countError: c.tokenCount?.error,
      originalCounted: c.tokenCount?.fullTokens, compiledCounted: c.tokenCount?.compiledTokens, reductionPercent: c.tokenCount?.reductionPercent,
      estimatedOriginal: c.tokenCount?.fullEstimate, estimatedCompiled: c.tokenCount?.compiledEstimate,
      actualUsage: c.usage, costs: c.costs,
      compilerLatencyMs: c.compilerLatencyMs, modelLatencyMs: c.modelLatencyMs, countLatencyMs: c.tokenCount?.latencyMs,
      evaluation: last.trace.evaluation.status, fallback: last.trace.evaluation.fallbackLevel,
      utilityCalls: last.trace.utilityCalls.map((u) => ({ kind: u.kind, model: u.model, in: u.inputTokens, out: u.outputTokens, costUsd: u.costUsd, ok: u.ok, error: u.error })),
      answer: last.assistantMessage.content,
    }, null, 2));
    const stats = repo.dashboardStats(db);
    console.log("DASHBOARD\n" + JSON.stringify({ counted: stats.counted, estimated: stats.estimated, estimatorAccuracy: stats.estimatorAccuracy, costs: stats.costs, utility: stats.utility, fallbackRate: stats.fallbackRate }, null, 2));
    expect(last.assistantMessage.content.length).toBeGreaterThan(0);
  }, 900_000);
});
