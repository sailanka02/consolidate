"use client";

// The dashboard's first screen answers one question: "is Consolidate actually helping?"
// Everything shown is read from persisted runs. Provider-counted totals lead; estimated runs are never mixed in.
import { useCallback, useEffect, useState } from "react";
import { Bar, CompareBars, Disclosure, Eyebrow, MECH, Panel, Pill, Spinner, TONE, type Tone } from "./ui";
import { fmt, pct, rate, secs, usd } from "@/lib/format";
import type { DashboardStats } from "@/lib/db/repo";
import type { RunSummary } from "@/lib/types";
import { reloadIfUnauthorized } from "@/lib/client";

type Mode = "total" | "average";
const KIND: Record<string, string> = { classification_memory: "Classification + memory extraction", semantic_retrieval: "Finding earlier context", compression: "Compression", evaluation: "Quality check" };

export default function Dashboard({ active }: { active: boolean }) {
  const [data, setData] = useState<{ stats: DashboardStats; recentRuns: RunSummary[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  // State is only set from the promise callbacks (never synchronously in the effect body).
  const load = useCallback(
    () =>
      fetch("/api/dashboard")
        .then((r) => {
          reloadIfUnauthorized(r);
          return r.json().then((d) => (r.ok ? d : Promise.reject(new Error(d.error ?? `HTTP ${r.status}`))));
        })
        .then((d) => {
          setError(null);
          setData(d);
        })
        .catch((e) => setError(e.message)),
    [],
  );
  useEffect(() => {
    if (active) void load();
  }, [active, load]);

  if (error) {
    return (
      <Panel className="mx-auto mt-10 max-w-md p-8 text-center">
        <p className="text-sm font-medium text-red-300">Couldn’t load the dashboard</p>
        <p className="mt-1 text-xs text-zinc-500">{error}</p>
        <button onClick={() => void load()} className="mt-4 rounded-lg bg-white/[0.06] px-3 py-1.5 text-xs text-zinc-200 hover:bg-white/10">Try again</button>
      </Panel>
    );
  }
  if (!data) return <DashboardSkeleton />;
  return <DashboardView stats={data.stats} recentRuns={data.recentRuns} />;
}

function DashboardSkeleton() {
  return (
    <div className="mx-auto max-w-6xl space-y-5" aria-busy>
      <div className="flex items-center gap-2 text-xs text-zinc-500"><Spinner /> Loading your results…</div>
      <div className="h-64 animate-pulse rounded-2xl bg-white/[0.03]" />
      <div className="grid gap-5 md:grid-cols-2">
        <div className="h-56 animate-pulse rounded-2xl bg-white/[0.03]" />
        <div className="h-56 animate-pulse rounded-2xl bg-white/[0.03]" />
      </div>
    </div>
  );
}

export function DashboardView({ stats: s, recentRuns }: { stats: DashboardStats; recentRuns: RunSummary[] }) {
  const [mode, setMode] = useState<Mode>("total");

  if (s.requests === 0) {
    return (
      <Panel className="mx-auto mt-10 max-w-lg p-10 text-center">
        <div className="mx-auto mb-4 grid h-12 w-12 place-items-center rounded-2xl bg-emerald-500/10 text-xl text-emerald-300 ring-1 ring-emerald-500/25">↘</div>
        <p className="text-base font-semibold text-zinc-100">No results yet</p>
        <p className="mt-1.5 text-sm leading-relaxed text-zinc-500">
          {s.conversations} conversation{s.conversations === 1 ? "" : "s"} exist, but no message has been through Consolidate. Send a message in Chat and its measured impact will appear here.
        </p>
      </Panel>
    );
  }

  const counted = s.counted.runs > 0;
  const base = counted ? s.counted : s.estimated; // provider-counted totals lead; estimates only if there is nothing else
  const n = base.runs;
  const avg = mode === "average";
  const per = (v: number, d: number) => (avg ? v / Math.max(1, d) : v);
  const approx = counted ? "" : "≈ ";
  const overallPct = base.originalTokens ? (base.tokensAvoided / base.originalTokens) * 100 : 0;
  const k = s.costs;
  const netTone: Tone = k.pricedRuns === 0 ? "neutral" : k.netSavingsUsd >= 0 ? "good" : "bad";
  const passTone: Tone = s.evaluationPassRate == null ? "neutral" : s.evaluationPassRate >= 0.9 ? "good" : s.evaluationPassRate >= 0.7 ? "warn" : "bad";
  const fbTone: Tone = (s.fallbackRate ?? 0) === 0 ? "good" : (s.fallbackRate ?? 0) <= 0.2 ? "warn" : "bad";

  return (
    <div className="mx-auto max-w-6xl space-y-5 pb-10">
      {/* ------------------------------------------------ impact hero */}
      <Panel className="relative overflow-hidden">
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(600px_220px_at_15%_0%,rgba(16,185,129,0.12),transparent_70%),radial-gradient(500px_220px_at_95%_0%,rgba(56,189,248,0.08),transparent_70%)]" />
        <div className="relative space-y-7 p-6 md:p-8">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <Eyebrow>Consolidate impact</Eyebrow>
              <p className="mt-1 text-xs text-zinc-500">
                {counted ? `Across ${fmt(n)} provider-counted request${n === 1 ? "" : "s"}` : `Across ${fmt(n)} estimated request${n === 1 ? "" : "s"} · Anthropic counts were unavailable`}
                {counted && s.estimated.runs > 0 && ` · ${s.estimated.runs} estimated request${s.estimated.runs === 1 ? "" : "s"} excluded`}
              </p>
            </div>
            <Toggle mode={mode} onChange={setMode} />
          </div>

          <div className="grid grid-cols-2 gap-x-6 gap-y-7 lg:grid-cols-5">
            <Hero label="Tokens avoided" tone={base.tokensAvoided >= 0 ? "good" : "bad"} value={`${approx}${fmt(per(base.tokensAvoided, n))}`} sub={avg ? "per request" : `${fmt(n ? base.tokensAvoided / n : 0)} per request`} big />
            <Hero label={avg ? "Avg context reduction" : "Overall context reduction"} tone={overallPct >= 0 ? "good" : "bad"} value={`${approx}${pct(avg ? (base.avgReductionPercent ?? 0) : overallPct)}`} sub={avg ? "mean of each request" : "of all input tokens"} big />
            <Hero
              label="Net money saved"
              tone={netTone}
              value={k.pricedRuns ? usd(avg ? k.netSavingsUsd / k.pricedRuns : k.netSavingsUsd, { sign: true }) : "—"}
              sub={k.pricedRuns ? (avg ? `per request · ${k.pricedRuns} priced` : `${usd(k.netSavingsUsd / k.pricedRuns, { sign: true })} per request`) : "needs a priced model"}
              big
            />
            <Hero label="Quality pass rate" tone={passTone} value={rate(s.evaluationPassRate)} sub={s.finalPassRate != null ? `${rate(s.finalPassRate)} after retries` : undefined} big />
            <Hero label="Fallback rate" tone={fbTone} value={rate(s.fallbackRate)} sub={`${s.fallbackCount} of ${s.requests}${s.regeneratedCount ? ` · ${s.regeneratedCount} regenerated` : ""}`} big />
          </div>

          <div className="border-t border-white/[0.06] pt-6">
            <div className="mb-3 grid grid-cols-3 gap-4 text-center">
              <Mini label={avg ? "Full context / request" : "Full context"} value={fmt(per(base.originalTokens, n))} />
              <Mini label={avg ? "Sent / request" : "Sent"} value={fmt(per(base.compiledTokens, n))} tone="info" />
              <Mini label={avg ? "Avoided / request" : "Avoided"} value={fmt(per(base.tokensAvoided, n))} tone={base.tokensAvoided >= 0 ? "good" : "bad"} />
            </div>
            <CompareBars full={per(base.originalTokens, n)} sent={per(base.compiledTokens, n)} size="lg" fullLabel={avg ? "Full context (avg)" : "Full context"} sentLabel={avg ? "Sent to Claude (avg)" : "Sent to Claude"} />
            <p className="mt-3 text-[11px] text-zinc-600">{counted ? "Token counts come from Anthropic’s token counter on the exact request payload; each request is measured after any fallback." : "Estimated with a local approximation because no provider count was available."}</p>
          </div>
        </div>
      </Panel>

      {/* ------------------------------------------------ money + time */}
      <div className="grid gap-5 lg:grid-cols-2">
        <MoneyPanel s={s} avg={avg} />
        <TimePanel s={s} avg={avg} />
      </div>

      {/* ------------------------------------------------ where savings come from + initial vs final */}
      <div className="grid gap-5 lg:grid-cols-2">
        <SavingsBySource s={s} />
        <Panel className="p-6">
          <Eyebrow>Before vs after fallbacks</Eyebrow>
          <p className="mt-1 text-xs leading-relaxed text-zinc-500">Consolidate’s first attempt versus the request that produced the answer you saw. They differ when a quality check sent more context.</p>
          <div className="mt-5 grid grid-cols-2 gap-4">
            <Hero label="First attempt" value={pct(base.avgInitialReductionPercent)} tone="good" sub="avg reduction" />
            <Hero label="Final request" value={pct(base.avgReductionPercent)} tone={(base.avgReductionPercent ?? 0) >= (base.avgInitialReductionPercent ?? 0) - 0.05 ? "good" : "warn"} sub="avg reduction" />
          </div>
        </Panel>
      </div>

      {/* ------------------------------------------------ recent runs */}
      <RecentRuns runs={recentRuns} />

      {/* ------------------------------------------------ technical */}
      <Panel className="p-6">
        <Disclosure title="Technical details: internal model calls, estimator accuracy, usage">
          <TechnicalDetails s={s} />
        </Disclosure>
      </Panel>
    </div>
  );
}

// ---------------------------------------------------------------- pieces

function Toggle({ mode, onChange }: { mode: Mode; onChange: (m: Mode) => void }) {
  const opt = (m: Mode, label: string) => (
    <button
      key={m}
      role="tab"
      aria-selected={mode === m}
      onClick={() => onChange(m)}
      className={`rounded-lg px-3.5 py-1.5 text-xs font-medium transition-colors ${mode === m ? "bg-white/10 text-zinc-100 shadow-sm" : "text-zinc-500 hover:text-zinc-300"}`}
    >
      {label}
    </button>
  );
  return <div role="tablist" className="flex gap-0.5 rounded-xl bg-black/30 p-1 ring-1 ring-white/[0.06]">{[opt("total", "Total"), opt("average", "Average")]}</div>;
}

function Hero({ label, value, sub, tone = "neutral", big }: { label: string; value: React.ReactNode; sub?: React.ReactNode; tone?: Tone; big?: boolean }) {
  return (
    <div>
      <Eyebrow>{label}</Eyebrow>
      <div className={`mt-1.5 font-mono font-semibold tabular-nums tracking-tight ${big ? "text-3xl md:text-4xl" : "text-2xl"} ${TONE[tone].text}`}>{value}</div>
      {sub && <div className="mt-1 text-xs text-zinc-500">{sub}</div>}
    </div>
  );
}

function Mini({ label, value, tone = "neutral" }: { label: string; value: string; tone?: Tone }) {
  return (
    <div>
      <div className="text-[11px] uppercase tracking-wider text-zinc-500">{label}</div>
      <div className={`mt-0.5 font-mono text-lg font-semibold tabular-nums ${TONE[tone].text}`}>{value}</div>
    </div>
  );
}

function MoneyPanel({ s, avg }: { s: DashboardStats; avg: boolean }) {
  const k = s.costs;
  const d = avg ? Math.max(1, k.pricedRuns) : 1;
  const row = (label: string, v: number, note?: string) => (
    <div className="flex items-baseline justify-between py-1.5 text-sm">
      <span className="text-zinc-400">{label}{note && <span className="ml-2 text-[11px] text-zinc-600">{note}</span>}</span>
      <span className={`font-mono tabular-nums ${v > 0 ? "text-emerald-400" : v < 0 ? "text-orange-400" : "text-zinc-500"}`}>{usd(v / d, { sign: true })}</span>
    </div>
  );
  const net = k.netSavingsUsd;
  const negative = k.pricedRuns > 0 && net < 0;
  return (
    <Panel className="p-6">
      <div className="flex items-center justify-between">
        <Eyebrow>Money · input cost</Eyebrow>
        <span className="text-[11px] text-zinc-600">{avg ? "per request" : "total"} · {k.pricedRuns} priced request{k.pricedRuns === 1 ? "" : "s"}</span>
      </div>
      {k.pricedRuns === 0 ? (
        <p className="mt-4 text-sm text-zinc-500">No cost data yet. Costs need provider-counted tokens and a model in the pricing table.</p>
      ) : (
        <>
          <div className="mt-3 divide-y divide-white/[0.05]">
            {row("Gross input savings", k.grossInputSavingsUsd, "full − sent")}
            {row("Optimizer cost", -k.optimizerCostUsd, "Consolidate’s own model calls")}
            {row("Fallback waste", -k.fallbackWasteCostUsd, "answers that were replaced")}
          </div>
          <div className={`mt-3 rounded-xl px-4 py-4 ring-1 ${negative ? "bg-red-500/[0.07] ring-red-500/25" : "bg-emerald-500/[0.07] ring-emerald-500/25"}`}>
            <div className="flex items-baseline justify-between">
              <span className="text-sm font-semibold text-zinc-100">Net input savings</span>
              <span className={`font-mono text-3xl font-semibold tabular-nums ${negative ? "text-red-400" : "text-emerald-400"}`} data-testid="net-savings">{usd(net / d, { sign: true })}</span>
            </div>
            {negative && (
              <p className="mt-2 text-xs leading-relaxed text-red-200/80">
                Not paying off yet. Optimizer calls ({usd(k.optimizerCostUsd)}) and discarded attempts ({usd(k.fallbackWasteCostUsd)}) cost more than the input tokens saved ({usd(k.grossInputSavingsUsd)}). Short conversations have little to remove; savings grow as history gets longer.
              </p>
            )}
          </div>
          <p className="mt-3 text-[11px] leading-relaxed text-zinc-600">
            Claude’s answers cost {usd(k.generationCostUsd / d)} {avg ? "per request" : "in total"} and are not changed by Consolidate. Output savings are only claimed with a benchmark baseline.
          </p>
        </>
      )}
    </Panel>
  );
}

function TimePanel({ s, avg }: { s: DashboardStats; avg: boolean }) {
  const parts: [string, number | null, string][] = [
    ["Compiler overhead", s.avgCompilerLatencyMs, "bg-sky-400"],
    ["Token counting", s.avgTokenCountLatencyMs, "bg-cyan-400"],
    ["Optimizer model calls", s.avgOptimizerLatencyMs, "bg-violet-400"],
    ["Claude’s response", s.avgModelLatencyMs, "bg-zinc-400"],
  ];
  const known = parts.filter((p): p is [string, number, string] => p[1] != null);
  const total = known.reduce((t, p) => t + p[1], 0);
  const b = s.benchmark;
  return (
    <Panel className="p-6">
      <div className="flex items-center justify-between">
        <Eyebrow>Time · where a request goes</Eyebrow>
        <span className="text-[11px] text-zinc-600">average per request</span>
      </div>
      <div className="mt-3 space-y-2.5">
        {known.map(([label, ms, color]) => (
          <div key={label}>
            <div className="mb-1 flex justify-between text-xs">
              <span className="text-zinc-400">{label}</span>
              <span className="font-mono text-zinc-300">{secs(ms)}</span>
            </div>
            <Bar value={ms} max={total} className={color} height="h-2" />
          </div>
        ))}
        <div className="flex items-baseline justify-between border-t border-white/[0.06] pt-2.5 text-sm">
          <span className="font-medium text-zinc-200">Total request</span>
          <span className="font-mono font-semibold text-zinc-100">{secs(total)}</span>
        </div>
      </div>
      <div className="mt-4 rounded-xl bg-white/[0.03] p-3.5">
        {b ? (
          <>
            <div className="flex items-center gap-2"><Pill tone="info">Benchmark runs only</Pill><span className="text-[11px] text-zinc-500">{b.runs} run{b.runs === 1 ? "" : "s"} with a full-context baseline</span></div>
            <div className="mt-2.5 flex items-baseline justify-between text-sm">
              <span className="text-zinc-400">Generation time saved {avg ? "per run" : "in total"}</span>
              <span className={`font-mono text-lg font-semibold ${b.savedMs >= 0 ? "text-emerald-400" : "text-red-400"}`} data-testid="time-saved">{b.savedMs >= 0 ? "+" : "−"}{secs(Math.abs(avg ? b.avgSavedMs : b.savedMs))}</span>
            </div>
            <p className="mt-1 text-[11px] text-zinc-600">Baseline {secs(b.baselineMs / b.runs)} vs Consolidate {secs(b.consolidatedMs / b.runs)} per run (Claude’s response time only).</p>
          </>
        ) : (
          <p className="text-xs leading-relaxed text-zinc-500">Time saved is only reported for Benchmark Mode runs, which also generate a full-context answer to compare against. Turn it on in Chat to measure it.</p>
        )}
      </div>
    </Panel>
  );
}

function SavingsBySource({ s }: { s: DashboardStats }) {
  const items: { label: string; v: number; color: string; hint: string }[] = [
    { label: "Removed", v: s.savings.omission, color: MECH.removed.bar, hint: "unrelated history dropped" },
    { label: "Remembered", v: s.savings.memory, color: MECH.remembered.bar, hint: "facts kept as short notes (net of the note)" },
    { label: "Compressed", v: s.savings.compression, color: MECH.compressed.bar, hint: "verbose history summarized" },
    { label: "Duplicates", v: s.savings.deduplication, color: MECH.compressed.bar, hint: "repeated messages folded" },
  ];
  const total = items.reduce((t, i) => t + i.v, 0);
  const max = Math.max(1, ...items.map((i) => Math.abs(i.v)));
  return (
    <Panel className="p-6">
      <div className="flex items-center justify-between">
        <Eyebrow>Where the savings come from</Eyebrow>
        <span className="text-[11px] text-zinc-600">{fmt(total)} tokens · estimated</span>
      </div>
      <div className="mt-4 space-y-3">
        {items.map((i) => (
          <div key={i.label}>
            <div className="mb-1 flex items-baseline justify-between text-xs">
              <span className="text-zinc-300">{i.label} <span className="text-[11px] text-zinc-600">{i.hint}</span></span>
              <span className="font-mono text-zinc-300">{fmt(i.v)}</span>
            </div>
            <Bar value={Math.abs(i.v)} max={max} className={i.v < 0 ? "bg-red-400" : i.color} height="h-2" />
          </div>
        ))}
      </div>
      <p className="mt-3 text-[11px] leading-relaxed text-zinc-600">Split by mechanism with a local estimator (Anthropic reports one total per request), so it will not add up exactly to the token total above.</p>
    </Panel>
  );
}

function RecentRuns({ runs }: { runs: RunSummary[] }) {
  const [all, setAll] = useState(false);
  const shown = all ? runs : runs.slice(0, 8);
  return (
    <Panel className="overflow-hidden">
      <div className="flex items-center justify-between px-6 pt-5">
        <Eyebrow>Recent requests</Eyebrow>
        <span className="text-[11px] text-zinc-600">{runs.length} shown</span>
      </div>
      <ul className="mt-3 divide-y divide-white/[0.05]">
        {shown.map((r) => {
          const fell = r.initialReductionPercent - r.finalReductionPercent > 0.05;
          const net = r.costs?.netSavingsUsd ?? null;
          return (
            <li key={r.id} className="grid items-center gap-x-6 gap-y-2 px-6 py-3.5 transition-colors hover:bg-white/[0.02] md:grid-cols-[minmax(0,1.3fr)_minmax(0,1.6fr)_auto]">
              <div className="min-w-0">
                <p className="truncate text-sm text-zinc-200">{r.conversationTitle}</p>
                <p className="text-[11px] text-zinc-600">{new Date(r.createdAt).toLocaleString()} · {r.countSource === "provider_count" ? "counted" : <span className="text-orange-400">estimated</span>}</p>
              </div>
              <div>
                <div className="flex items-baseline justify-between font-mono text-xs">
                  <span className="text-zinc-400">{fmt(r.originalTokens)} → <span className="text-zinc-100">{fmt(r.compiledTokens)}</span></span>
                  <span className={r.finalReductionPercent > 0 ? "text-emerald-400" : "text-zinc-500"}>{pct(r.finalReductionPercent)}</span>
                </div>
                <div className="mt-1"><Bar value={r.compiledTokens} max={Math.max(r.originalTokens, 1)} className="bg-gradient-to-r from-emerald-500 to-teal-400" height="h-1.5" /></div>
                {fell && <p className="mt-1 text-[11px] text-orange-300/90">first attempt {fmt(r.originalTokens)} → {fmt(r.initialCompiledTokens)} ({pct(r.initialReductionPercent)}), then more context was added</p>}
              </div>
              <div className="flex flex-wrap items-center gap-1.5 md:justify-end">
                <Pill tone={r.evaluationStatus === "PASS" ? "good" : r.fallbackLevel > 0 ? "warn" : "bad"}>{r.evaluationStatus === "PASS" ? "✓ Passed" : r.failureCategory && r.failureCategory !== "PASS" ? r.failureCategory.replace(/_/g, " ").toLowerCase().replace(/^\w/, (c) => c.toUpperCase()) : "Failed"}</Pill>
                {r.fallbackLevel > 0 && <Pill tone="warn">{r.fallbackLevel === 1 ? "More context added" : "Full context"}</Pill>}
                {r.economicDecision === "bypass_full_context" && <Pill tone="neutral">Optimization skipped — not economically worthwhile</Pill>}
                <span className={`min-w-[74px] text-right font-mono text-xs ${net == null ? "text-zinc-600" : net >= 0 ? "text-emerald-400" : "text-red-400"}`}>{usd(net, { sign: true })}</span>
              </div>
            </li>
          );
        })}
      </ul>
      {runs.length > 8 && (
        <button onClick={() => setAll(!all)} className="w-full border-t border-white/[0.05] py-3 text-xs text-sky-400/80 transition-colors hover:bg-white/[0.02] hover:text-sky-300">
          {all ? "Show fewer" : `Show all ${runs.length}`}
        </button>
      )}
    </Panel>
  );
}

function TechnicalDetails({ s }: { s: DashboardStats }) {
  const acc = s.estimatorAccuracy;
  const errPct = (est: number, real: number) => (real ? `${(((est - real) / real) * 100).toFixed(1)}%` : "—");
  const utilityTotal = s.utility.reduce((t, u) => t + u.costUsd, 0);
  return (
    <div className="space-y-6 text-xs text-zinc-400">
      <div className="grid gap-3 sm:grid-cols-3">
        <KV k="Requests" v={`${s.requests} (${s.counted.runs} counted · ${s.estimated.runs} estimated)`} />
        <KV k="Conversations" v={fmt(s.conversations)} />
        <KV k="Stored state" v={`${s.memoryItems} memory · ${s.compressedGroups} summaries`} />
        <KV k="Economic bypasses" v={`${s.economics.bypasses} request${s.economics.bypasses === 1 ? "" : "s"}`} />
        <KV k="Est. optimizer spend avoided" v={usd(s.economics.spendAvoidedUsd)} />
        <KV k="Actual API usage" v={s.actualUsage.runs ? `${fmt(s.actualUsage.inputTokens)} in / ${fmt(s.actualUsage.outputTokens)} out` : "not reported"} />
        {s.actualUsage.cacheCreationTokens + s.actualUsage.cacheReadTokens > 0 && <KV k="Cache" v={`${fmt(s.actualUsage.cacheCreationTokens)} write / ${fmt(s.actualUsage.cacheReadTokens)} read`} />}
        {acc && <KV k="Local estimator error" v={`${errPct(acc.estimatedFull, acc.countedFull)} full · ${errPct(acc.estimatedCompiled, acc.countedCompiled)} compiled (${acc.runs} req)`} />}
        {s.estimated.runs > 0 && <KV k="Estimated requests" v={`${fmt(s.estimated.tokensAvoided)} tokens avoided (estimate) over ${s.estimated.runs} req`} />}
      </div>
      <div>
        <div className="mb-2 flex items-baseline justify-between"><span className="font-medium text-zinc-300">Internal model calls</span><span>{usd(utilityTotal)} total</span></div>
        {s.utility.length === 0 ? (
          <p className="text-zinc-600">No internal model calls yet: deterministic logic handled every request so far.</p>
        ) : (
          <table className="w-full text-left font-mono text-[11px]">
            <thead className="text-zinc-600"><tr>{["Purpose", "Calls", "Failed", "In", "Out", "Cost"].map((h) => <th key={h} className="py-1 font-normal">{h}</th>)}</tr></thead>
            <tbody>
              {s.utility.map((u) => (
                <tr key={u.kind} className="border-t border-white/[0.05] text-zinc-300">
                  <td className="py-1.5">{KIND[u.kind] ?? u.kind}</td><td>{u.calls}</td><td className={u.failed ? "text-red-400" : ""}>{u.failed}</td><td>{fmt(u.inputTokens)}</td><td>{fmt(u.outputTokens)}</td>
                  <td>{u.unpricedCalls ? `${usd(u.costUsd)}+ (${u.unpricedCalls} unpriced)` : usd(u.costUsd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

const KV = ({ k, v }: { k: string; v: string }) => (
  <div className="rounded-lg bg-white/[0.03] px-3 py-2">
    <div className="text-[10px] uppercase tracking-wider text-zinc-600">{k}</div>
    <div className="mt-0.5 font-mono text-zinc-300">{v}</div>
  </div>
);
