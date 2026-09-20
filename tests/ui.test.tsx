// Component rendering (static markup, no DOM needed): the plain-language trace and the dashboard hero, built from real engine output.
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { DashboardView } from "@/components/Dashboard";
import { SummaryCard, TraceContent } from "@/components/TraceView";
import { openDatabase } from "@/lib/db";
import * as repo from "@/lib/db/repo";
import { runTurn } from "@/lib/engine/turn";
import { fmt, pct, usd } from "@/lib/format";
import type { ContextTrace } from "@/lib/types";
import { FakeProvider, type Script } from "./helpers";

let db: DatabaseSync;
let convId: string;
beforeEach(() => {
  db = openDatabase(":memory:");
  convId = repo.createConversation(db).id;
});
const isRaw = (r: { mode?: string }) => r.mode === "raw";
const filler = (n: number) => `Answer ${n}. ` + "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda. ".repeat(20);
const verdict = (category: string, o: { missing?: string[]; failing?: string } = {}) =>
  JSON.stringify({ criteria: [{ name: o.failing ?? "answers_request", pass: !o.failing, reason: o.failing ? "The answer ignores the earlier project." : "ok" }], category, missing_context: category === "MISSING_CONTEXT" && o.missing?.length ? { missing_information: "the moon landing dates from the omitted answer", answer_problem: "the answer gives the wrong dates for the moon landing", causal_link: "the omitted answer contains the correct dates the answer needs", evidence_strength: "concrete" } : null, missing_ids: o.missing ?? [] });
function provider(request: string, judge: (call: number) => string, counted = true) {
  let evals = 0;
  const script: Script = (req, n) => {
    if (isRaw(req)) {
      if (req.request.includes("evaluating an AI assistant")) return req.request.includes(request) ? judge(++evals) : verdict("PASS");
      if (req.request.includes("context-management")) return '{"results":[]}';
      return "{}";
    }
    return filler(n);
  };
  return new FakeProvider(script, counted ? { api: {} } : {});
}
const seed = async (p: FakeProvider) => {
  for (const t of ["i must use react for this", "Tell me about the moon landing with dates.", "Explain how transistors work with analogies.", "Describe the history of bicycles in some detail.", "Explain what a monad is in functional programming."]) await runTurn(db, p, { conversationId: convId, content: t });
};
const trace = (id: string): ContextTrace => repo.getRun(db, id)!.trace;
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

describe("trace summary card", () => {
  it("leads with the provider-counted reduction, both bars and the quality verdict", async () => {
    const request = "whats a hackathon";
    const p = provider(request, () => verdict("PASS"));
    await seed(p);
    const out = await runTurn(db, p, { conversationId: convId, content: request });
    const html = renderToStaticMarkup(<SummaryCard t={trace(out.run.id)} />);
    const t = text(html);
    expect(t).toContain("Context optimization");
    expect(t).toContain("Counted by Anthropic");
    expect(t).toContain(`${pct(out.run.reductionPercent)} smaller`);
    expect(t).toContain(`${fmt(out.run.tokensAvoided)} tokens avoided`);
    expect(t).toContain(fmt(out.run.originalTokens));
    expect(t).toContain(fmt(out.run.compiledTokens));
    expect(t).toContain("✓ Passed");
    expect(t).toMatch(/Fallback\s+None/);
    expect(html).toContain('role="img"'); // the before/after bar
    expect(t).not.toContain("first made this request");
  });

  it("labels numbers as estimated when the provider could not count", async () => {
    const request = "whats a hackathon";
    const p = provider(request, () => verdict("PASS"), false);
    await seed(p);
    const out = await runTurn(db, p, { conversationId: convId, content: request });
    const t = text(renderToStaticMarkup(<SummaryCard t={trace(out.run.id)} />));
    expect(t).toContain("Estimated");
    expect(t).not.toContain("Counted by Anthropic");
    expect(t).toMatch(/≈ [\d.]+% smaller/);
  });

  it("does not present the initial reduction as the final one after a fallback", async () => {
    const request = "Tell me something else interesting.";
    const p = provider(request, (call) => {
      if (call > 1) return verdict("PASS");
      const msgs = repo.listMessages(db, convId);
      const i = msgs.findIndex((m) => m.content.startsWith("Tell me about the moon"));
      return verdict("MISSING_CONTEXT", { failing: "no_missing_context", missing: [msgs[i + 1].id] });
    });
    await seed(p);
    const out = await runTurn(db, p, { conversationId: convId, content: request });
    const t = text(renderToStaticMarkup(<SummaryCard t={trace(out.run.id)} />));
    expect(t).toContain(`${pct(out.run.finalReductionPercent)} smaller`); // headline = what actually produced the answer
    expect(t).toContain(`first made this request ${pct(out.run.initialReductionPercent)} smaller`);
    expect(t).toContain("Passed after a retry");
    expect(t).toContain("More context added");
  });
});

describe("full trace", () => {
  it("shows four plain-language sections, cards with Why/Impact, and keeps technical names behind expanders", async () => {
    const request = "whats a hackathon";
    const p = provider(request, () => verdict("PASS"));
    await seed(p);
    const out = await runTurn(db, p, { conversationId: convId, content: request });
    const html = renderToStaticMarkup(<TraceContent t={trace(out.run.id)} />);
    const t = text(html);
    for (const heading of ["Understanding", "Context decisions", "Final context", "Quality check"]) expect(t).toContain(heading);
    expect(t).toContain("10 previous messages reviewed");
    expect(t).toContain("1 requirement protected");
    for (const label of ["Kept exactly", "Brought back", "Removed"]) expect(t).toContain(label);
    expect(t).toContain("Why?");
    expect(t).toMatch(/You stated this as a rule or requirement/);
    expect(t).toMatch(/Saved ~\d+ tokens/);
    // Technical detail exists but only inside <details> that are closed by default.
    expect(html).toContain("Technical details");
    expect(html).not.toMatch(/<details[^>]*\sopen/);
    // ...and the primary (outside-details) text avoids compiler vocabulary.
    const primary = text(html.replace(/<details[\s\S]*?<\/details>/g, ""));
    expect(primary).not.toMatch(/\b(OMIT|RETRIEVE|KEEP|COMPRESS)\b/);
    expect(primary).not.toMatch(/relevance|lexical|semantic/i);
  });

  it("shows every attempt of a fallback run, with what was added", async () => {
    const request = "Tell me something else interesting.";
    const p = provider(request, (call) => {
      if (call > 1) return verdict("PASS");
      const msgs = repo.listMessages(db, convId);
      const i = msgs.findIndex((m) => m.content.startsWith("Tell me about the moon"));
      return verdict("MISSING_CONTEXT", { failing: "no_missing_context", missing: [msgs[i + 1].id] });
    });
    await seed(p);
    const out = await runTurn(db, p, { conversationId: convId, content: request });
    const t = text(renderToStaticMarkup(<TraceContent t={trace(out.run.id)} />));
    expect(t).toContain("Attempt 1");
    expect(t).toContain("Attempt 2");
    expect(t).toContain("Missing context");
    expect(t).toContain("The answer ignores the earlier project.");
    expect(t).toContain("Missing context detected");
    expect(t).toMatch(/Needed The answer ignores the earlier project\./);
    expect(t).toMatch(/Added .*original message/);
    expect(t).toMatch(/Tokens added ~\d+ of a 800-token budget/);
    expect(t).toContain("The evaluator identified this specific omitted information as necessary.");
    expect(t).toMatch(/Final\s+[\d.]+% context reduction/);
    expect(t).toContain("These are Consolidate’s first choices (attempt 1)");
  });

  it("renders the first message (no history) without cards", async () => {
    const p = provider("hello", () => verdict("PASS"));
    const out = await runTurn(db, p, { conversationId: convId, content: "hello there" });
    const t = text(renderToStaticMarkup(<TraceContent t={trace(out.run.id)} />));
    expect(t).toContain("first message");
    expect(t).toContain("Nothing to decide yet");
  });
});

describe("dashboard", () => {
  it("shows the empty state before any request", () => {
    const t = text(renderToStaticMarkup(<DashboardView stats={repo.dashboardStats(db)} recentRuns={[]} />));
    expect(t).toContain("No results yet");
  });

  it("leads with the impact hero using persisted totals, and never fabricates time savings", async () => {
    const p = provider("zzz", () => verdict("PASS"));
    await seed(p);
    await runTurn(db, p, { conversationId: convId, content: "whats a hackathon" });
    const stats = repo.dashboardStats(db);
    const html = renderToStaticMarkup(<DashboardView stats={stats} recentRuns={repo.listRunSummaries(db, 25)} />);
    const t = text(html);
    // hero comes first
    expect(t.indexOf("Consolidate impact")).toBeLessThan(t.indexOf("Money"));
    for (const label of ["Tokens avoided", "Overall context reduction", "Net money saved", "Quality pass rate", "Fallback rate"]) expect(t).toContain(label);
    expect(t).toContain(fmt(stats.counted.tokensAvoided));
    expect(t).toContain(pct((stats.counted.tokensAvoided / stats.counted.originalTokens) * 100));
    expect(t).toContain(`${fmt(stats.counted.originalTokens)}`);
    expect(t).toContain("Total");
    expect(t).toContain("Average");
    // money breakdown labels
    for (const label of ["Gross input savings", "Optimizer cost", "Fallback waste", "Net input savings"]) expect(t).toContain(label);
    // time: parts shown, savings only for benchmark runs
    for (const label of ["Compiler overhead", "Token counting", "Total request"]) expect(t).toContain(label);
    expect(t).toContain("Time saved is only reported for Benchmark Mode runs");
    expect(t).not.toContain("Generation time saved");
  });

  it("shows benchmark time savings, clearly labelled, only when a baseline exists", async () => {
    const p = provider("zzz", () => verdict("PASS"));
    await seed(p);
    const r = await runTurn(db, p, { conversationId: convId, content: "whats a hackathon", benchmark: true });
    const bench = JSON.parse((db.prepare("SELECT benchmark_json FROM compiler_run WHERE id = ?").get(r.run.id) as { benchmark_json: string }).benchmark_json);
    bench.full.modelLatencyMs = 6000;
    bench.consolidate.modelLatencyMs = 4000;
    db.prepare("UPDATE compiler_run SET benchmark_json = ? WHERE id = ?").run(JSON.stringify(bench), r.run.id);
    const t = text(renderToStaticMarkup(<DashboardView stats={repo.dashboardStats(db)} recentRuns={repo.listRunSummaries(db, 25)} />));
    expect(t).toContain("Benchmark runs only");
    expect(t).toContain("Generation time saved in total");
    expect(t).toContain("+2.0 s");
  });

  it("shows negative net savings honestly, with the reason", async () => {
    const p = provider("zzz", () => verdict("PASS"));
    await seed(p);
    await runTurn(db, p, { conversationId: convId, content: "whats a hackathon" });
    const real = repo.dashboardStats(db);
    // Force the sign to exercise the rendering path; every other number is the persisted one.
    const stats = { ...real, costs: { ...real.costs, grossInputSavingsUsd: 0.001, optimizerCostUsd: 0.004, fallbackWasteCostUsd: 0.002, netSavingsUsd: -0.005 } };
    const html = renderToStaticMarkup(<DashboardView stats={stats} recentRuns={[]} />);
    const t = text(html);
    expect(t).toContain(usd(-0.005, { sign: true }));
    expect(t).toContain("Not paying off yet");
    expect(t).toContain("cost more than the input tokens saved");
    expect(html).toMatch(/text-red-400[^>]*data-testid="net-savings"/);
  });
});
