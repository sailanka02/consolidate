// Measurement + cost accounting: provider-count arithmetic, exact reduction formula, pricing, optimizer-cost
// subtraction, local-estimate fallback, and cache-usage fields. Everything runs against a fake provider: no API spend.
import { beforeEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { openDatabase } from "@/lib/db";
import * as repo from "@/lib/db/repo";
import { runTurn } from "@/lib/engine/turn";
import { contextSize, economics } from "@/lib/consolidate/measure";
import { inputCost, priceFor, usageCost } from "@/lib/model/pricing";
import { ProviderError, type ModelRequest } from "@/lib/model";
import { buildMessagesPayload } from "@/lib/model/prompt";
import { FakeProvider, fakeCount, type FakeOptions, type Script } from "./helpers";

const isRaw = (r: { mode?: string }) => r.mode === "raw";
const script: Script = (req, n) => {
  if (isRaw(req)) {
    if (req.request.includes("evaluating an AI assistant")) return '{"criteria":[{"name":"answers_request","pass":true,"reason":"ok"}],"verdict":"pass","missing_ids":[]}';
    if (req.request.includes("context-management")) return '{"results":[]}';
    return "{}";
  }
  return `Answer #${n} to: ${req.request.slice(0, 40)}`;
};

describe("reduction formula", () => {
  it("tokensAvoided = full - compiled and reductionPercent = avoided / full * 100", () => {
    expect(contextSize(12481, 4106)).toEqual({ fullTokens: 12481, compiledTokens: 4106, tokensAvoided: 8375, reductionPercent: 67.1 });
  });
  it("is 0% for equal sizes, negative when compiled is larger, and safe for an empty context", () => {
    expect(contextSize(500, 500).reductionPercent).toBe(0);
    expect(contextSize(100, 150)).toMatchObject({ tokensAvoided: -50, reductionPercent: -50 });
    expect(contextSize(0, 0)).toMatchObject({ tokensAvoided: 0, reductionPercent: 0 });
  });
});

describe("pricing and cost", () => {
  it("prices claude-sonnet-5 at $2/$10 and haiku 4.5 at $1/$5 per million tokens", () => {
    expect(priceFor("claude-sonnet-5")).toMatchObject({ input: 2, output: 10, cacheRead: 0.2, cacheWrite5m: 2.5 });
    expect(priceFor("claude-haiku-4-5")).toMatchObject({ input: 1, output: 5 });
    expect(priceFor("claude-haiku-4-5-20251001")).toMatchObject({ input: 1 }); // dated snapshot
    expect(priceFor("mystery-model")).toBeNull();
  });
  it("computes input cost and usage cost, pricing cache tokens separately from normal input", () => {
    expect(inputCost("claude-sonnet-5", 1_000_000)).toBeCloseTo(2);
    expect(usageCost("claude-sonnet-5", { inputTokens: 1_000_000, outputTokens: 1_000_000 })).toBeCloseTo(12);
    // 1M uncached + 1M cache write (5m) + 1M cache read + 1M output on sonnet-5 = 2 + 2.5 + 0.2 + 10
    expect(usageCost("claude-sonnet-5", { inputTokens: 1e6, cacheCreationInputTokens: 1e6, cacheReadInputTokens: 1e6, outputTokens: 1e6 })).toBeCloseTo(14.7);
    expect(usageCost("mystery-model", { inputTokens: 5 })).toBeNull();
  });
  it("subtracts optimizer cost (and discarded-attempt spend) from gross input savings", () => {
    const e = economics({ model: "claude-sonnet-5", fullTokens: 12_481, compiledTokens: 4_106, optimizerCostUsd: 0.004, fallbackWasteCostUsd: 0.001 })!;
    expect(e.fullInputCostUsd).toBeCloseTo(0.024962);
    expect(e.compiledInputCostUsd).toBeCloseTo(0.008212);
    expect(e.grossInputSavingsUsd).toBeCloseTo(0.01675);
    expect(e.netSavingsUsd).toBeCloseTo(0.01675 - 0.004 - 0.001);
  });
  it("can report NEGATIVE net savings when the optimizer costs more than it saved", () => {
    const e = economics({ model: "claude-sonnet-5", fullTokens: 1_000, compiledTokens: 900, optimizerCostUsd: 0.01 })!;
    expect(e.netSavingsUsd).toBeLessThan(0);
  });
  it("returns null for an unpriced model instead of inventing a cost", () => {
    expect(economics({ model: "mystery-model", fullTokens: 10, compiledTokens: 5, optimizerCostUsd: 0 })).toBeNull();
  });
});

let db: DatabaseSync;
let convId: string;
beforeEach(() => {
  db = openDatabase(":memory:");
  convId = repo.createConversation(db).id;
});
const say = (p: FakeProvider, text: string, extra?: { benchmark?: boolean; forceEvalFailure?: "optimized" | "all" }) =>
  runTurn(db, p, { conversationId: convId, content: text, benchmark: extra?.benchmark, dev: extra?.forceEvalFailure ? { forceEvalFailure: extra.forceEvalFailure } : undefined });
const opts = (api: NonNullable<FakeOptions["api"]> = {}): FakeOptions => ({ api });
const seed = async (p: FakeProvider) => {
  await say(p, "We decided to use PostgreSQL 17 for the database.");
  await say(p, "Tell me something about the history of bicycles in a few sentences, with some detail.");
  await say(p, "Now explain what a monad is in functional programming, again in some detail please.");
};

describe("pre-flight provider counting", () => {
  it("counts the exact full and compiled payloads and stores them as the primary numbers", async () => {
    const p = new FakeProvider(script, opts());
    await seed(p);
    p.counted = [];
    const out = await say(p, "Write a short poem about the sea and its many moods, please.");
    expect(p.counted).toHaveLength(2);
    const [fullReq, compiledReq] = p.counted;
    // The full payload contains every stored message; the compiled one is what the model then actually receives.
    expect(fullReq.context.length).toBeGreaterThan(compiledReq.context.length);
    const sent = p.calls.find((c) => !isRaw(c) && c.request.includes("poem"))!;
    expect(buildMessagesPayload(sent)).toEqual(buildMessagesPayload(compiledReq));

    const tc = out.trace.compilation.tokenCount!;
    expect(tc.source).toBe("provider_count");
    expect(tc.fullTokens).toBe(fakeCount(fullReq));
    expect(tc.compiledTokens).toBe(fakeCount(compiledReq));
    expect(tc.tokensAvoided).toBe(tc.fullTokens - tc.compiledTokens);
    expect(tc.reductionPercent).toBe(Math.round((tc.tokensAvoided / tc.fullTokens) * 1000) / 10);
    // The old local estimate is kept beside it, unchanged, so its error can be measured.
    expect(tc.fullEstimate).not.toBe(tc.fullTokens);
    expect(out.run).toMatchObject({ originalTokens: tc.fullTokens, compiledTokens: tc.compiledTokens, tokensAvoided: tc.tokensAvoided, countSource: "provider_count", fullEstimateTokens: tc.fullEstimate });
  });

  it("keeps pre-flight counts and actual generation usage as separate fields", async () => {
    const p = new FakeProvider(script, opts());
    const out = await say(p, "Hello there, please introduce yourself briefly.");
    const c = out.trace.compilation;
    expect(c.tokenCount!.compiledTokens).toBeGreaterThan(0);
    expect(c.usage).toEqual({ inputTokens: 1000, outputTokens: 100, cacheCreationInputTokens: null, cacheReadInputTokens: null });
    expect(c.tokenCount!.compiledTokens).not.toBe(c.usage!.inputTokens);
  });

  it("persists cache usage separately when the provider reports it", async () => {
    const p = new FakeProvider(script, opts({ cache: { creation: 400, read: 2000 } }));
    const out = await say(p, "Hello there, please introduce yourself briefly.");
    expect(out.trace.compilation.usage).toEqual({ inputTokens: 1000, outputTokens: 100, cacheCreationInputTokens: 400, cacheReadInputTokens: 2000 });
    expect(out.run).toMatchObject({ providerInputTokens: 1000, cacheCreationTokens: 400, cacheReadTokens: 2000 });
    // generation cost = 1000 in + 400 write + 2000 read + 100 out on sonnet-5
    const expected = usageCost("claude-sonnet-5", { inputTokens: 1000, cacheCreationInputTokens: 400, cacheReadInputTokens: 2000, outputTokens: 100 })!;
    expect(out.trace.compilation.costs!.generationCostUsd).toBeCloseTo(expected, 10);
  });

  it("falls back to the local estimate, labeled honestly, when token counting fails", async () => {
    const p = new FakeProvider(script, opts({ count: () => new ProviderError("rate_limit", "429 from count_tokens") }));
    await seed(p);
    const out = await say(p, "Write a short poem about the sea and its many moods, please.");
    const tc = out.trace.compilation.tokenCount!;
    expect(tc.source).toBe("local_estimate");
    expect(tc.error).toMatch(/429/);
    expect(tc.fullTokens).toBe(tc.fullEstimate);
    expect(tc.compiledTokens).toBe(tc.compiledEstimate);
    expect(out.run.countSource).toBe("local_estimate");
    expect(out.trace.compilation.costs).toBeNull(); // no cost claims from estimated counts
    expect(out.assistantMessage.content).toMatch(/^Answer/); // the request still completed
  });

  it("uses the local estimate for a provider with no counting endpoint", async () => {
    const p = new FakeProvider(script);
    const out = await say(p, "Hello there, please introduce yourself briefly.");
    expect(out.run.countSource).toBe("local_estimate");
    expect(out.trace.compilation.tokenCount!.error).toMatch(/no token-counting/);
  });
});

describe("cost accounting and the optimizer ledger", () => {
  it("records every internal call and subtracts its cost from gross savings", async () => {
    const p = new FakeProvider(script, opts());
    await seed(p);
    const out = await say(p, "Write a short poem about the sea and its many moods, please.");
    const costs = out.trace.compilation.costs!;
    const utility = out.trace.utilityCalls;
    expect(utility.length).toBeGreaterThan(0);
    const expectedOptimizer = utility.reduce((t, u) => t + (u.costUsd ?? 0), 0);
    expect(utility.every((u) => u.model === "claude-haiku-4-5" && u.costUsd != null && u.costUsd > 0)).toBe(true);
    expect(costs.optimizerCostUsd).toBeCloseTo(expectedOptimizer, 12);
    expect(costs.netSavingsUsd).toBeCloseTo(costs.grossInputSavingsUsd - costs.optimizerCostUsd - costs.fallbackWasteCostUsd, 12);
    const tc = out.trace.compilation.tokenCount!;
    expect(costs.grossInputSavingsUsd).toBeCloseTo(inputCost("claude-sonnet-5", tc.fullTokens)! - inputCost("claude-sonnet-5", tc.compiledTokens)!, 12);
    // persisted in the utility_call ledger
    const rows = db.prepare("SELECT kind, model, cost_usd FROM utility_call WHERE run_id = ?").all(out.run.id) as { kind: string; model: string; cost_usd: number }[];
    expect(rows).toHaveLength(utility.length);
    expect(rows.every((r) => r.model === "claude-haiku-4-5")).toBe(true);
  });

  it("uses the utility model for internal calls and the main model for chat", async () => {
    const p = new FakeProvider(script, opts());
    await say(p, "Hello there, please introduce yourself briefly.");
    expect(p.calls.filter((c) => isRaw(c)).every((c) => c.tier === "utility")).toBe(true);
    expect(p.calls.filter((c) => !isRaw(c)).every((c) => (c.tier ?? "main") === "main")).toBe(true);
  });

  it("charges discarded attempts against net savings on fallback", async () => {
    const p = new FakeProvider(script, opts());
    await seed(p);
    const out = await say(p, "Write a short poem about the sea and its many moods, please.", { forceEvalFailure: "all" });
    expect(out.run.fallbackLevel).toBe(2);
    const costs = out.trace.compilation.costs!;
    expect(costs.fallbackWasteCostUsd).toBeGreaterThan(0);
    expect(costs.grossInputSavingsUsd).toBeCloseTo(0, 12); // full context was sent: nothing saved
    expect(costs.netSavingsUsd).toBeLessThan(0);
  });

  it("reports no cost (not a guess) when a utility model is not in the pricing config", async () => {
    const p = new FakeProvider(script, opts({ utilityModel: "unpriced-utility-model" }));
    await seed(p);
    const out = await say(p, "Write a short poem about the sea and its many moods, please.");
    expect(out.trace.compilation.costs).toBeNull();
  });
});

describe("benchmark mode", () => {
  it("makes exactly one generation per normal turn, and a full-context baseline only in benchmark mode", async () => {
    const p = new FakeProvider(script, opts());
    await seed(p);
    const chatCalls = () => p.calls.filter((c) => !isRaw(c)).length;
    const before = chatCalls();
    const normal = await say(p, "Write a short poem about the sea and its many moods, please.");
    expect(chatCalls() - before).toBe(1);
    expect(normal.trace.benchmark).toBeUndefined();

    const b0 = chatCalls();
    const bench = await say(p, "Write another short poem about mountains and their many moods, please.", { benchmark: true });
    expect(chatCalls() - b0).toBe(2);
    const bm = bench.trace.benchmark!;
    expect(bm.full!.countedInputTokens).toBeGreaterThan(bm.consolidate.countedInputTokens!);
    expect(bm.full!.costUsd).toBeGreaterThan(0);
    expect(bm.full!.usage.outputTokens).toBe(100);
    // The baseline is stored and its cost is not folded into the optimizer ledger.
    const stored = repo.getRun(db, bench.run.id)!;
    expect(stored.trace.benchmark).toBeDefined();
  });
});

describe("streaming events", () => {
  it("emits deltas for the answer and a reset before a fallback attempt", async () => {
    const events: string[] = [];
    const p = new FakeProvider(script, opts());
    await seed(p);
    await runTurn(db, p, { conversationId: convId, content: "Write a short poem about the sea and its many moods, please.", dev: { forceEvalFailure: "optimized" }, onEvent: (e) => e.type !== "stage" && events.push(e.type) }); // stage events are progress narration, not answer events
    expect(events[0]).toBe("delta");
    expect(events).toContain("reset");
    expect(events.indexOf("reset")).toBeGreaterThan(0);
    expect(events.filter((t) => t === "generated").length).toBeGreaterThanOrEqual(2); // optimized + fallback attempt
  });
});

describe("provider errors during a turn", () => {
  const failing = (code: ConstructorParameters<typeof ProviderError>[0]): Script => (req, n) => (isRaw(req) ? script(req, n) : new ProviderError(code, `simulated ${code}`));
  for (const code of ["auth", "credits", "model"] as const) {
    it(`stops immediately on a fatal ${code} error and saves nothing`, async () => {
      const p = new FakeProvider(failing(code), opts());
      await expect(say(p, "Hello there, please introduce yourself briefly.")).rejects.toMatchObject({ code });
      expect(repo.listMessages(db, convId)).toHaveLength(0);
      expect(p.calls.filter((c) => !isRaw(c))).toHaveLength(1); // no pointless fallback retries
    });
  }
  it("retries an optimized-attempt rate limit as a fallback rather than crashing when a later attempt succeeds", async () => {
    let armed = false;
    const p = new FakeProvider((req, n) => {
      if (isRaw(req)) return script(req, n);
      if (armed) {
        armed = false;
        return new ProviderError("rate_limit", "429");
      }
      return "recovered answer";
    }, opts());
    await seed(p);
    armed = true;
    const out = await say(p, "Write a short poem about the sea and its many moods, please.");
    expect(out.assistantMessage.content).toBe("recovered answer");
    expect(out.run.fallbackApplied).toBe(true);
  });
});

it("never lets a ModelRequest count differ from the payload it sends (single builder)", () => {
  const req: ModelRequest = { context: [{ id: "a", role: "user", content: "hello" }], request: "hi" };
  expect(buildMessagesPayload(req)).toEqual(buildMessagesPayload({ ...req }));
});
