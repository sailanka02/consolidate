// Cost-aware fast path: when is semantic optimization (optimized generation + semantic evaluator) worth paying for?
// Pure policy tests plus engine tests against a fake provider and an in-memory SQLite DB. No API spend.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { openDatabase } from "@/lib/db";
import * as repo from "@/lib/db/repo";
import { runTurn } from "@/lib/engine/turn";
import {
  breakEvenTokens,
  decideEconomics,
  DEFAULT_ECONOMICS_MARGIN,
  DEFAULT_EVAL_INPUT_TOKENS,
  DEFAULT_EVAL_OUTPUT_TOKENS,
  economicsMargin,
  expectedEvalUsage,
  expectedEvaluationCostUsd,
  HISTORY_WINDOW,
  MIN_HISTORY_SAMPLES,
  type EconomicsInput,
} from "@/lib/consolidate/economics";
import { evaluateContext } from "@/lib/consolidate/evaluate";
import { inputCost } from "@/lib/model/pricing";
import { ProviderError, type ModelRequest } from "@/lib/model";
import { FakeProvider, type FakeOptions, type Script } from "./helpers";

// Wrap the deterministic context check so one test can force a structural failure; everything else passes through.
vi.mock("@/lib/consolidate/evaluate", async (orig) => {
  const actual = await orig<typeof import("@/lib/consolidate/evaluate")>();
  return { ...actual, evaluateContext: vi.fn(actual.evaluateContext) };
});

const isRaw = (r: { mode?: string }) => r.mode === "raw";
const isEval = (r: ModelRequest) => isRaw(r) && r.request.includes("evaluating an AI assistant");
const script: Script = (req, n) => {
  if (isRaw(req)) {
    if (isEval(req)) return '{"criteria":[{"name":"answers_request","pass":true,"reason":"ok"}],"verdict":"pass","missing_ids":[]}';
    if (req.request.includes("context-management")) return '{"results":[]}';
    return "{}";
  }
  return `Answer #${n} to: ${req.request.slice(0, 40)}`;
};

// Counts every character of the rendered context at `perChar` tokens: the full-vs-compiled difference (and so the gross
// savings) scales with it, which lets each test choose "tiny" or "large" savings without touching the compiler.
const charsOf = (r: ModelRequest) => r.context.reduce((t, c) => t + c.content.length, 0);
const counter = (perChar: number) => (r: ModelRequest) => Math.round(300 + charsOf(r) * perChar);

let db: DatabaseSync;
let convId: string;
const savedMargin = process.env.CONSOLIDATE_ECONOMICS_MARGIN;
beforeEach(() => {
  process.env.CONSOLIDATE_ECONOMICS_MARGIN = String(DEFAULT_ECONOMICS_MARGIN);
  db = openDatabase(":memory:");
  convId = repo.createConversation(db).id;
});
afterEach(() => {
  if (savedMargin === undefined) delete process.env.CONSOLIDATE_ECONOMICS_MARGIN;
  else process.env.CONSOLIDATE_ECONOMICS_MARGIN = savedMargin;
});

const say = (p: FakeProvider, text: string) => runTurn(db, p, { conversationId: convId, content: text });
const mkProvider = (perChar: number, api: FakeOptions["api"] = {}) => new FakeProvider(script, { api: { count: counter(perChar), ...api } });
// Several unrelated turns so that the compiler omits history on the last one (a reduction exists).
const seed = async (p: FakeProvider) => {
  await say(p, "We decided to use PostgreSQL 17 for the database.");
  await say(p, "Tell me something about the history of bicycles in a few sentences, with some detail.");
  await say(p, "Now explain what a monad is in functional programming, again in some detail please.");
  await say(p, "Write a short poem about the sea and its many moods, please.");
};
const mainCalls = (p: FakeProvider, needle: string) => p.calls.filter((c) => !isRaw(c) && c.request.includes(needle));
const evalCalls = (p: FakeProvider) => p.calls.filter(isEval);

const base: EconomicsInput = {
  source: "provider_count",
  fullTokens: 10_000,
  compiledTokens: 9_000,
  mainModel: "claude-sonnet-5",
  utilityModel: "claude-haiku-4-5",
  expectedEval: { inputTokens: 1500, outputTokens: 200, source: "default", samples: 0 },
  margin: 1.5,
};

describe("policy: expected costs", () => {
  it("uses a documented default until enough successful evaluations are persisted, then their recent mean", () => {
    expect(expectedEvalUsage([])).toMatchObject({ inputTokens: DEFAULT_EVAL_INPUT_TOKENS, outputTokens: DEFAULT_EVAL_OUTPUT_TOKENS, source: "default" });
    const few = Array.from({ length: MIN_HISTORY_SAMPLES - 1 }, () => ({ inputTokens: 9, outputTokens: 9 }));
    expect(expectedEvalUsage(few).source).toBe("default");
    const hist = [{ inputTokens: 1000, outputTokens: 100 }, { inputTokens: 2001, outputTokens: 201 }, { inputTokens: 1500, outputTokens: 150 }];
    expect(expectedEvalUsage(hist)).toMatchObject({ inputTokens: 1501, outputTokens: 151, source: "history", samples: 3 });
    // only the most recent window counts (input is newest first)
    const long = [...Array.from({ length: HISTORY_WINDOW }, () => ({ inputTokens: 100, outputTokens: 10 })), { inputTokens: 999999, outputTokens: 99999 }];
    expect(expectedEvalUsage(long)).toMatchObject({ inputTokens: 100, outputTokens: 10 });
  });

  it("prices the expected evaluation on the utility model, and is null when that model is unpriced", () => {
    const u = { inputTokens: 1500, outputTokens: 200, source: "default" as const, samples: 0 };
    expect(expectedEvaluationCostUsd("claude-haiku-4-5", u)).toBeCloseTo((1500 * 1 + 200 * 5) / 1e6, 12);
    expect(expectedEvaluationCostUsd("claude-haiku-4-5-20251001", u)).toBeCloseTo((1500 * 1 + 200 * 5) / 1e6, 12);
    expect(expectedEvaluationCostUsd("mystery-model", u)).toBeNull();
  });

  it("reads the margin from the environment with a documented default", () => {
    expect(economicsMargin({})).toBe(DEFAULT_ECONOMICS_MARGIN);
    expect(economicsMargin({ CONSOLIDATE_ECONOMICS_MARGIN: "2.25" })).toBe(2.25);
    expect(economicsMargin({ CONSOLIDATE_ECONOMICS_MARGIN: "nonsense" })).toBe(DEFAULT_ECONOMICS_MARGIN);
    expect(economicsMargin({ CONSOLIDATE_ECONOMICS_MARGIN: "-1" })).toBe(DEFAULT_ECONOMICS_MARGIN);
  });
});

describe("policy: decisions", () => {
  it("optimizes when gross savings exceed expected evaluation cost x margin, and bypasses just below it", () => {
    const cost = (1500 * 1 + 200 * 5) / 1e6; // 0.0025
    const need = breakEvenTokens("claude-sonnet-5", cost, 1.5)!; // tokens at $2/M that equal cost x 1.5
    expect(need).toBe(Math.ceil((cost * 1.5 * 1e6) / 2));
    const at = decideEconomics({ ...base, fullTokens: 20_000, compiledTokens: 20_000 - need });
    const below = decideEconomics({ ...base, fullTokens: 20_000, compiledTokens: 20_000 - need + 2 });
    expect(at.decision).toBe("optimized");
    expect(below.decision).toBe("bypass_full_context");
    expect(below.reason).toMatch(/smaller than the expected cost of validating/);
  });

  it("does not use the fixed 1,200-token or dollar cutoff: the break-even follows the configured prices (utility model)", () => {
    const input = { ...base, fullTokens: 20_000, compiledTokens: 20_000 - 2_000 }; // 2,000 tokens = $0.004 on sonnet-5
    expect(decideEconomics(input).decision).toBe("optimized"); // haiku evaluation ($0.0025 x 1.5 = $0.00375) < $0.004
    // a pricier utility model raises the expected validation cost and moves the break-even point above the same savings
    const pricier = decideEconomics({ ...input, utilityModel: "claude-sonnet-5" }); // (1500*2 + 200*10)/1e6 = 0.005 x 1.5
    expect(pricier.decision).toBe("bypass_full_context");
    expect(pricier.expectedEvaluationCostUsd!).toBeGreaterThan(decideEconomics(input).expectedEvaluationCostUsd!);
    expect(breakEvenTokens("claude-sonnet-5", pricier.expectedEvaluationCostUsd, 1.5)!).toBeGreaterThan(breakEvenTokens("claude-sonnet-5", decideEconomics(input).expectedEvaluationCostUsd, 1.5)!);
  });

  it("main model pricing changes the break-even point", () => {
    const input = { ...base, fullTokens: 20_000, compiledTokens: 20_000 - 1_500 }; // 1,500 tokens
    expect(decideEconomics({ ...input, mainModel: "claude-sonnet-5" }).decision).toBe("bypass_full_context"); // $0.003 < $0.00375
    expect(decideEconomics({ ...input, mainModel: "claude-opus-5" }).decision).toBe("optimized"); // $0.0075 >= $0.00375
    expect(breakEvenTokens("claude-opus-5", 0.0025, 1.5)!).toBeLessThan(breakEvenTokens("claude-sonnet-5", 0.0025, 1.5)!);
  });

  it("the margin is applied, not scattered: a larger margin bypasses what a smaller one optimizes", () => {
    const input = { ...base, fullTokens: 20_000, compiledTokens: 20_000 - 2_000 };
    expect(decideEconomics({ ...input, margin: 1 }).decision).toBe("optimized");
    expect(decideEconomics({ ...input, margin: 2 }).decision).toBe("bypass_full_context");
  });

  it("no reduction is an equivalent context whatever the prices", () => {
    expect(decideEconomics({ ...base, compiledTokens: 10_000 }).decision).toBe("equivalent_context");
    expect(decideEconomics({ ...base, compiledTokens: 10_500 }).decision).toBe("equivalent_context");
    expect(decideEconomics({ ...base, compiledTokens: 10_000 }).reason).toMatch(/No economic benefit from semantic optimization/);
  });

  it("a structural failure wins over economics, in both directions", () => {
    const failing = { structuralFailure: "Protected context retained verbatim: protected message(s) missing" };
    expect(decideEconomics({ ...base, compiledTokens: 5_000, ...failing }).decision).toBe("safety_full_context"); // profitable but unsafe
    expect(decideEconomics({ ...base, compiledTokens: 9_990, ...failing }).decision).toBe("safety_full_context"); // tiny and unsafe
    expect(decideEconomics({ ...base, compiledTokens: 10_000, ...failing }).decision).toBe("safety_full_context");
  });

  it("does not guess when a model is unpriced: it keeps today's optimized path", () => {
    const d = decideEconomics({ ...base, mainModel: "mystery-model" });
    expect(d.decision).toBe("optimized");
    expect(d.expectedGrossInputSavingsUsd).toBeNull();
    expect(d.reason).toMatch(/not in the pricing table/);
  });
});

describe("engine: no reduction (equivalent_context)", () => {
  it("skips the semantic evaluator and makes exactly one full-context generation", async () => {
    const p = mkProvider(1);
    await say(p, "Hello there, please introduce yourself briefly.");
    const out = await say(p, "And this is the second one.");
    // turn 2's history is only the previous exchange (continuity): nothing can be removed
    expect(out.trace.economics).toMatchObject({ decision: "equivalent_context", source: "provider_count" });
    expect(out.trace.economics!.reason).toMatch(/No economic benefit from semantic optimization/);
    expect(out.trace.evaluation.semanticEvaluatorUsed).toBe(false);
    expect(evalCalls(p)).toHaveLength(0);
    expect(mainCalls(p, "second one")).toHaveLength(1);
    expect(out.trace.evaluation.checks.every((c) => c.layer === "deterministic" && c.passed)).toBe(true); // deterministic checks still ran
  });
});

describe("engine: tiny reduction (bypass_full_context)", () => {
  it("skips the evaluator, generates once with the FULL context, and records why", async () => {
    const p = mkProvider(0.05); // ~30 tokens avoided: far below break-even
    await seed(p);
    p.calls = [];
    const out = await say(p, "Tell me another fun fact about the sea, please.");
    const e = out.trace.economics!;
    expect(e.decision).toBe("bypass_full_context");
    expect(e.expectedGrossInputSavingsUsd!).toBeLessThan(e.expectedEvaluationCostUsd! * e.margin);
    expect(e.tokensAvoided).toBeGreaterThan(0); // a reduction existed; it was not worth validating

    // no evaluator call, exactly one main-model generation, and it received every stored message
    expect(evalCalls(p)).toHaveLength(0);
    const mains = p.calls.filter((c) => !isRaw(c));
    expect(mains).toHaveLength(1);
    expect(mains[0].context.filter((c) => !c.section)).toHaveLength(repo.listMessages(db, convId).length - 2);
    expect(out.trace.evaluation.semanticEvaluatorUsed).toBe(false);
    expect(out.trace.evaluation.semanticSkipReason).toMatch(/smaller than the expected cost of validating/);
    expect(out.trace.evaluation.attempts).toHaveLength(1);
    expect(out.trace.evaluation.fallbackLevel).toBe(0);
    expect(out.trace.evaluation.status).toBe("PASS");
  });

  it("does not count a bypassed request as token or net savings", async () => {
    const p = mkProvider(0.05);
    await seed(p);
    const out = await say(p, "Tell me another fun fact about the sea, please.");
    expect(out.run).toMatchObject({ tokensAvoided: 0, reductionPercent: 0, compiledTokens: out.run.originalTokens, initialReductionPercent: 0 });
    expect(out.trace.compilation.savings).toEqual({ omission: 0, memory: 0, compression: 0, deduplication: 0 });
    expect(out.run.costs!.grossInputSavingsUsd).toBe(0);
    expect(out.run.costs!.optimizerCostUsd).toBe(0); // no evaluator, no other utility call on this turn
    expect(out.run.costs!.netSavingsUsd).toBe(0);
    expect(out.run.fallbackLevel).toBe(0);
  });

  it("no duplicate main-model generation, even with benchmark mode on", async () => {
    const p = mkProvider(0.05);
    await seed(p);
    p.calls = [];
    await runTurn(db, p, { conversationId: convId, content: "Tell me another fun fact about the sea, please.", benchmark: true });
    expect(p.calls.filter((c) => !isRaw(c))).toHaveLength(1);
  });
});

describe("engine: profitable reduction (optimized)", () => {
  it("runs the existing optimized + evaluator path and counts the savings", async () => {
    const p = mkProvider(20); // thousands of tokens avoided
    await seed(p);
    p.calls = [];
    const out = await say(p, "Tell me another fun fact about the sea, please.");
    const e = out.trace.economics!;
    expect(e.decision).toBe("optimized");
    expect(e.expectedGrossInputSavingsUsd!).toBeGreaterThanOrEqual(e.thresholdUsd!);
    expect(evalCalls(p)).toHaveLength(1);
    expect(out.trace.evaluation.semanticEvaluatorUsed).toBe(true);
    expect(out.trace.evaluation.attempts[0].level).toBe("optimized");
    expect(out.run.tokensAvoided).toBeGreaterThan(0);
    expect(out.run.costs!.grossInputSavingsUsd).toBeCloseTo(e.expectedGrossInputSavingsUsd!, 10);
  });
});

describe("engine: pricing and counting sources", () => {
  it("changing main model pricing flips the same request between bypass and optimized", async () => {
    const run = async (mainModel: string) => {
      db = openDatabase(":memory:");
      convId = repo.createConversation(db).id;
      const p = mkProvider(3, { mainModel }); // ~1,100 tokens avoided: below break-even on sonnet-5 (~1,875), above it on opus-5 (~750)
      await seed(p);
      return (await say(p, "Tell me another fun fact about the sea, please.")).trace.economics!;
    };
    const sonnet = await run("claude-sonnet-5");
    const opus = await run("claude-opus-5");
    expect(sonnet.tokensAvoided).toBe(opus.tokensAvoided);
    expect(opus.expectedGrossInputSavingsUsd!).toBeCloseTo(sonnet.expectedGrossInputSavingsUsd! * 2.5, 10);
    expect(opus.thresholdUsd).toBe(sonnet.thresholdUsd);
    expect(sonnet.tokensAvoided * 0.000002).toBeLessThan(sonnet.thresholdUsd!);
    expect(sonnet.decision).toBe("bypass_full_context");
    expect(opus.decision).toBe("optimized");
  });

  it("changing utility model pricing changes the expected validation cost the decision uses", async () => {
    const run = async (utilityModel: string) => {
      db = openDatabase(":memory:");
      convId = repo.createConversation(db).id;
      const p = mkProvider(0.05, { utilityModel });
      await seed(p);
      return (await say(p, "Tell me another fun fact about the sea, please.")).trace.economics!;
    };
    const haiku = await run("claude-haiku-4-5");
    const sonnet = await run("claude-sonnet-5");
    expect(sonnet.expectedEvaluationCostUsd!).toBeGreaterThan(haiku.expectedEvaluationCostUsd!);
  });

  it("uses provider-counted tokens when available, and never the local estimate", async () => {
    const p = mkProvider(0.05);
    await seed(p);
    const out = await say(p, "Tell me another fun fact about the sea, please.");
    const e = out.trace.economics!;
    const tc = out.trace.compilation.tokenCount!;
    expect(e.source).toBe("provider_count");
    expect(e.fullTokens).toBe(tc.fullTokens);
    expect(e.fullTokens).not.toBe(tc.fullEstimate);
    expect(e.wouldBeCompiledTokens).toBeLessThan(e.fullTokens);
    expect(e.expectedGrossInputSavingsUsd).toBeCloseTo(inputCost("claude-sonnet-5", e.fullTokens)! - inputCost("claude-sonnet-5", e.wouldBeCompiledTokens)!, 12);
  });

  it("falls back to the local estimate, marked as estimated, when provider counting fails", async () => {
    const p = new FakeProvider(script, { api: { count: () => new ProviderError("rate_limit", "429 from count_tokens") } });
    await seed(p);
    const out = await say(p, "Tell me another fun fact about the sea, please.");
    const e = out.trace.economics!;
    expect(e.source).toBe("local_estimate");
    expect(e.fullTokens).toBe(out.trace.compilation.tokenCount!.fullEstimate);
    expect(out.run.economicsSource).toBe("local_estimate");
    expect(out.assistantMessage.content).toMatch(/^Answer/); // the request still completed
  });

  it("keeps the normal path when the models cannot be priced (no API pricing information)", async () => {
    const p = new FakeProvider(script); // no api option: no models(), no counts
    await seed(p);
    const out = await say(p, "Tell me another fun fact about the sea, please.");
    expect(out.trace.economics!.decision).toBe("optimized");
    expect(out.trace.economics!.expectedGrossInputSavingsUsd).toBeNull();
  });

  it("developer failure injection still exercises the optimized path", async () => {
    const p = mkProvider(0.05);
    await seed(p);
    const out = await runTurn(db, p, { conversationId: convId, content: "Tell me another fun fact about the sea, please.", dev: { forceEvalFailure: "optimized" } });
    expect(out.trace.economics!.decision).toBe("optimized");
    expect(out.trace.evaluation.attempts[0].level).toBe("optimized");
  });
});

describe("engine: safety wins over economics", () => {
  it("a structural compile-time failure sends the full context, no optimized attempt, no evaluator, and is not an economic bypass", async () => {
    const p = mkProvider(20); // would be profitable
    await seed(p);
    p.calls = [];
    vi.mocked(evaluateContext).mockReturnValueOnce({ passed: false, checks: [{ name: "Protected context retained verbatim", passed: false, reason: "protected message(s) missing or altered: m_x", layer: "deterministic" }] });
    const out = await say(p, "Tell me another fun fact about the sea, please.");
    expect(out.trace.economics!.decision).toBe("safety_full_context");
    expect(out.trace.economics!.reason).toMatch(/regardless of economics/);
    expect(evalCalls(p)).toHaveLength(0);
    const mains = p.calls.filter((c) => !isRaw(c));
    expect(mains).toHaveLength(1);
    expect(mains[0].context).toHaveLength(repo.listMessages(db, convId).length - 2);
    expect(repo.dashboardStats(db).economics.bypasses).toBe(0);
  });
});

describe("engine: persisted and dashboard economics", () => {
  it("persists the decision on every run and aggregates bypasses without inflating savings", async () => {
    const p = mkProvider(0.05);
    await seed(p);
    const last = await say(p, "Tell me another fun fact about the sea, please.");
    const runs = repo.listRunSummaries(db, 10);
    expect(runs).toHaveLength(5);
    expect(runs.every((r) => r.economicDecision != null && r.economicsMargin === DEFAULT_ECONOMICS_MARGIN && r.economicsSource === "provider_count")).toBe(true);

    const stored = repo.getRun(db, last.run.id)!;
    expect(stored.summary).toMatchObject({ economicDecision: "bypass_full_context", potentialCompiledTokens: last.trace.economics!.wouldBeCompiledTokens });
    expect(stored.summary.economicDecisionReason).toMatch(/smaller than the expected cost/);
    expect(stored.summary.expectedGrossInputSavingsUsd).toBeCloseTo(last.trace.economics!.expectedGrossInputSavingsUsd!, 12);
    expect(stored.summary.expectedEvaluationCostUsd).toBeCloseTo(last.trace.economics!.expectedEvaluationCostUsd!, 12);
    expect(stored.trace.economics).toEqual(last.trace.economics);

    const s = repo.dashboardStats(db);
    const bypassed = runs.filter((r) => r.economicDecision === "bypass_full_context");
    expect(bypassed.length).toBeGreaterThan(0);
    expect(s.economics.decided).toBe(5);
    expect(s.economics.bypasses).toBe(bypassed.length);
    expect(s.economics.optimized + s.economics.bypasses + s.economics.equivalent + s.economics.safety).toBe(5);
    expect(s.economics.spendAvoidedUsd).toBeCloseTo(bypassed.reduce((t, r) => t + r.expectedEvaluationCostUsd!, 0), 12);
    // bypassed requests contribute zero to token reduction and gross savings
    expect(bypassed.every((r) => r.tokensAvoided === 0 && r.costs!.grossInputSavingsUsd === 0)).toBe(true);
    expect(s.counted.tokensAvoided).toBe(runs.reduce((t, r) => t + r.tokensAvoided, 0));
  });

  it("reads expected evaluation usage from persisted history, never from the request being decided", async () => {
    const p = mkProvider(20);
    await seed(p);
    const before = repo.recentEvaluationUsage(db, HISTORY_WINDOW);
    const out = await say(p, "Tell me another fun fact about the sea, please.");
    expect(out.trace.economics!.evalUsageSource).toBe(before.length >= MIN_HISTORY_SAMPLES ? "history" : "default");
    expect(out.trace.economics!.expectedEvalInputTokens).toBe(before.length >= MIN_HISTORY_SAMPLES ? 1000 : DEFAULT_EVAL_INPUT_TOKENS);
    expect(repo.recentEvaluationUsage(db, HISTORY_WINDOW).length).toBe(before.length + 1); // this run's own call is persisted only after it
  });
});
