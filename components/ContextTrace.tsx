"use client";

import { createContext, useContext } from "react";
import type { ContentType, ContextTrace as Trace } from "@/lib/types";

// Which of the nine stages to render (all when unset). The plain-language trace shows each group of stages behind its own "Technical details".
const OnlyStages = createContext<number[] | null>(null);

const TYPE_LABEL: Record<ContentType, string> = {
  fact: "Facts",
  decision: "Decisions",
  preference: "Preferences",
  constraint: "Constraints",
  code: "Code",
  log: "Logs",
  tool_output: "Tool output",
  discussion: "Discussion",
  other: "Other",
};

const fmt = (n: number) => n.toLocaleString();
const secs = (ms: number) => `${(ms / 1000).toFixed(1)}s`;
const usd = (n: number | null | undefined) => (n == null ? "—" : `${n < 0 ? "−" : ""}$${Math.abs(n).toFixed(Math.abs(n) < 0.01 ? 5 : 4)}`);
const KIND_LABEL: Record<string, string> = { classification_memory: "classification + memory", semantic_retrieval: "retrieval", compression: "compression", evaluation: "evaluation" };

function Metric({ label, value, tone }: { label: string; value: React.ReactNode; tone?: string }) {
  return (
    <div className="rounded border border-zinc-800 px-2.5 py-1.5">
      <div className="font-mono text-[10px] uppercase tracking-wider text-zinc-600">{label}</div>
      <div className={`font-mono text-base font-semibold ${tone ?? "text-zinc-100"}`}>{value}</div>
    </div>
  );
}

function Stage({ n, title, summary, children }: { n: number; title: string; summary?: React.ReactNode; children: React.ReactNode }) {
  const only = useContext(OnlyStages);
  if (only && !only.includes(n)) return null;
  return (
    <details className="group rounded-xl bg-zinc-950/50 ring-1 ring-white/[0.05]">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 font-mono text-[11px] [&::-webkit-details-marker]:hidden">
        <span className="text-zinc-600 transition-transform group-open:rotate-90">▸</span>
        <span className="text-zinc-600">{String(n).padStart(2, "0")}</span>
        <span className="uppercase tracking-wider text-zinc-300">{title}</span>
        <span className="ml-auto text-zinc-500">{summary}</span>
      </summary>
      <div className="reveal space-y-2 border-t border-white/[0.05] px-3 py-2.5 text-sm">{children}</div>
    </details>
  );
}

// Plain-language view of the cost-aware fast path decision. A bypass is a good outcome, not an error.
function EconomicsBlock({ e }: { e: NonNullable<Trace["economics"]> }) {
  const skipped = e.decision === "bypass_full_context";
  const safety = e.decision === "safety_full_context";
  const src = e.source === "provider_count" ? "provider-counted" : "estimated";
  return (
    <div className={`rounded-lg px-3 py-2 font-mono text-[11px] ring-1 ${skipped ? "bg-sky-500/[0.06] ring-sky-500/20" : "bg-white/[0.02] ring-white/[0.05]"}`} data-testid="economics">
      <p className="text-zinc-200">
        {skipped ? "Optimization skipped" : safety ? "Full context used for safety" : e.decision === "equivalent_context" ? "Nothing to optimize" : "Optimization worthwhile"}
        <span className="ml-2 text-zinc-500">economic decision: {e.decision.replace(/_/g, " ")} · {src}</span>
      </p>
      <p className="mt-1 text-zinc-400">{e.reason}</p>
      {e.expectedGrossInputSavingsUsd != null && <Row k="potential savings"><span className="text-emerald-400">+{usd(e.expectedGrossInputSavingsUsd)}</span> ({fmt(e.tokensAvoided)} tokens)</Row>}
      {e.expectedEvaluationCostUsd != null && <Row k="validation cost"><span className="text-red-400">{usd(-e.expectedEvaluationCostUsd)}</span> expected ({e.evalUsageSource === "history" ? "recent average" : "default budget"}) × {e.margin} margin</Row>}
      {skipped && <Row k="decision">Use full context</Row>}
    </div>
  );
}

function Row({ k, children }: { k: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-3 font-mono text-[11px]">
      <span className="w-28 shrink-0 text-zinc-600">{k}</span>
      <span className="min-w-0 text-zinc-300">{children}</span>
    </div>
  );
}

const Note = ({ children }: { children: React.ReactNode }) => <p className="font-mono text-[11px] text-zinc-500">{children}</p>;
const Id = ({ children }: { children: React.ReactNode }) => <span className="mr-1.5 font-mono text-[11px] text-zinc-600">{children}</span>;

// Shows the first `limit` entries, the rest behind a native <details>.
function Capped<T>({ items, limit, render, label }: { items: T[]; limit: number; render: (t: T) => React.ReactNode; label: string }) {
  const rest = items.slice(limit);
  return (
    <>
      <ul className="space-y-2">{items.slice(0, limit).map(render)}</ul>
      {rest.length > 0 && (
        <details className="font-mono text-[11px]">
          <summary className="cursor-pointer text-sky-400/80 hover:text-sky-300">
            {label} ({items.length})
          </summary>
          <ul className="mt-2 max-h-72 space-y-2 overflow-y-auto pr-1">{rest.map(render)}</ul>
        </details>
      )}
    </>
  );
}

// The nine stages, exactly as recorded. `only` limits which are shown.
export function TechnicalStages({ t, only }: { t: Trace; only?: number[] }) {
  const { requestAnalysis: ra, classification: cl, compilation: c, evaluation: ev } = t;
  const maxCount = Math.max(1, ...Object.values(cl.counts));
  const evColor = ev.status === "PASS" ? "text-emerald-400" : "text-red-400";
  const savings = [
    ["Omission", c.savings.omission],
    ["Structured memory (net of block)", c.savings.memory],
    ["Compression", c.savings.compression],
    ["Deduplication", c.savings.deduplication],
  ] as const;
  const interesting = cl.items.filter((i) => i.contentType !== "discussion" && i.contentType !== "other");

  return (
    <OnlyStages.Provider value={only ?? null}>
      <Stage n={1} title="Request analysis" summary={ra.task}>
        <Row k="request">{ra.request.length > 200 ? ra.request.slice(0, 200) + "…" : ra.request}</Row>
        <Row k="task">{ra.task}</Row>
        <Row k="key terms">
          {ra.keyTerms.length ? ra.keyTerms.map((k) => <span key={k} className="mr-1.5 rounded bg-zinc-800 px-1.5 py-0.5 text-zinc-300">{k}</span>) : "no specific terms"}
        </Row>
        <Row k="history">{ra.historyScanned} messages · ~{fmt(ra.originalTokenEstimate)} tokens (est., incl. this request)</Row>
        <Row k="memory available">{ra.memoryAvailable} active item{ra.memoryAvailable === 1 ? "" : "s"}</Row>
      </Stage>

      <Stage n={2} title="Context classification" summary={`${cl.total} messages`}>
        {cl.total === 0 ? (
          <Note>No prior history: this is the first message of the conversation.</Note>
        ) : (
          <>
            <div className="grid grid-cols-1 gap-x-6 gap-y-1 sm:grid-cols-2">
              {(Object.keys(TYPE_LABEL) as ContentType[]).map((k) => (
                <div key={k} className="flex items-center gap-2 font-mono text-[11px]">
                  <span className="w-24 shrink-0 text-zinc-400">{TYPE_LABEL[k]}</span>
                  <span className="w-6 text-right text-zinc-200">{cl.counts[k]}</span>
                  <span className="h-1 flex-1 rounded bg-zinc-800">
                    <span className="block h-1 rounded bg-zinc-500" style={{ width: `${(cl.counts[k] / maxCount) * 100}%` }} />
                  </span>
                </div>
              ))}
            </div>
            <Note>
              {cl.methods.deterministic} deterministic · {cl.methods.semantic} semantic (cached) · {cl.methods.heuristic} pending semantic · {cl.newlyClassified} newly classified by the model this request
            </Note>
            {interesting.length > 0 && (
              <Capped
                items={interesting}
                limit={3}
                label="show all typed items"
                render={(i) => (
                  <li key={i.id} className="border-l-2 border-zinc-700 pl-2.5">
                    <p className="truncate text-zinc-400"><Id>{i.id}</Id>{i.preview}</p>
                    <p className="font-mono text-[11px] text-zinc-600">{i.contentType} · {i.method}</p>
                  </li>
                )}
              />
            )}
          </>
        )}
      </Stage>

      <Stage n={3} title="Protection" summary={<span className="text-sky-300">{t.protection.items.length} protected</span>}>
        {t.protection.items.length === 0 && <Note>No protected context in this conversation yet: nothing stated a constraint or requirement that must survive.</Note>}
        <Capped
          items={t.protection.items}
          limit={4}
          label="show all protected"
          render={(p) => (
            <li key={p.id} className="border-l-2 border-sky-500/60 pl-2.5">
              <p className="text-zinc-300"><span className="text-emerald-400">✓</span> <Id>{p.id}</Id>{p.preview}</p>
              <p className="font-mono text-[11px] text-zinc-500">{p.reason} · {p.method} · {p.level}</p>
            </li>
          )}
        />
      </Stage>

      <Stage n={4} title="Structured memory" summary={`${t.memory.totalActive} active · ${t.memory.injected.length} sent`}>
        {t.memory.changes.length === 0 ? <Note>No memory extraction required for this request.</Note> : (
          <ul className="space-y-1.5">
            {t.memory.changes.map((m) => (
              <li key={m.key} className="border-l-2 border-violet-500/60 pl-2.5">
                <p className="font-mono text-[11px] text-zinc-300">
                  <span className={m.change === "removed" ? "text-red-400" : m.change === "updated" ? "text-amber-400" : m.change === "created" ? "text-emerald-400" : "text-zinc-500"}>{m.change}</span>{" "}
                  {m.key} = <span className="text-violet-300">{m.value}</span>
                </p>
                <p className="font-mono text-[11px] text-zinc-600">
                  {m.type} · from {m.sourceIds.join(", ")}
                  {m.previousValue && <span className="text-amber-400/80"> · supersedes “{m.previousValue}”</span>}
                </p>
              </li>
            ))}
          </ul>
        )}
        {t.memory.injected.length === 0 ? (
          <Note>{t.memory.totalActive === 0 ? "No durable memory stored yet." : "No stored memory was needed in the compiled context for this request."}</Note>
        ) : (
          <div className="space-y-1 border-t border-zinc-800/80 pt-2">
            <p className="font-mono text-[11px] text-zinc-500">sent to Claude as structured memory:</p>
            {t.memory.injected.map((m) => (
              <p key={m.key} className="font-mono text-[11px] text-zinc-300">
                {m.key}: <span className="text-violet-300">{m.value}</span>{" "}
                <span className="text-zinc-600">({m.type}, conf {m.confidence.toFixed(2)}, {m.originalTokens}→{m.memoryTokens} tok)</span>
              </p>
            ))}
            <Note>block ~{t.memory.blockTokens} tok · net saved ~{t.memory.netTokensSaved} tok</Note>
          </div>
        )}
      </Stage>

      <Stage n={5} title="Retrieval" summary={<span className="text-emerald-300">{t.retrieval.items.length} retrieved</span>}>
        {t.retrieval.items.length === 0 && <Note>{cl.total === 0 ? "No prior history to retrieve." : "No historical message was retrieved verbatim for this request."}</Note>}
        {t.retrieval.semanticNote && <Note>{t.retrieval.semanticNote}</Note>}
        {t.retrieval.referential && (
          <Note>
            referential object “{t.retrieval.referential.phrase}” · type {t.retrieval.referential.kind} · candidates [{t.retrieval.referential.candidateIds.join(", ")}] · selected [{t.retrieval.referential.selectedIds.join(", ")}]
            {t.retrieval.referential.searchedIds && ` · searched [${t.retrieval.referential.searchedIds.join(", ")}]`}
          </Note>
        )}
        <Capped
          items={t.retrieval.items}
          limit={4}
          label="show all retrieved"
          render={(r) => (
            <li key={r.id} className="border-l-2 border-emerald-500/60 pl-2.5">
              <p className="text-zinc-300"><Id>{r.id}</Id>{r.preview}</p>
              <p className="flex flex-wrap items-center gap-x-2 font-mono text-[11px] text-zinc-500">
                <span className="text-zinc-200">{r.score.toFixed(2)}</span>
                <span className="h-1 w-14 rounded bg-zinc-800">
                  <span className="block h-1 rounded bg-emerald-500" style={{ width: `${Math.min(100, r.score * 100)}%` }} />
                </span>
                <span>lex {r.signals.lexical.toFixed(2)} · rec {r.signals.recency.toFixed(2)} · imp {r.signals.importance.toFixed(2)}{r.signals.memory > 0 && ` · mem ${r.signals.memory.toFixed(2)}`}{r.signals.semantic > 0 && ` · sem ${r.signals.semantic.toFixed(2)}`}</span>
              </p>
              <p className="font-mono text-[11px] text-zinc-600">{r.reason}</p>
            </li>
          )}
        />
      </Stage>

      <Stage n={6} title="Compression / deduplication" summary={`${t.compression.groups.length} groups · ${t.compression.deduplicated.length} duplicates`}>
        {t.compression.groups.length === 0 && t.compression.deduplicated.length === 0 && <Note>No compressible or duplicated context for this request.</Note>}
        <Capped
          items={t.compression.groups}
          limit={3}
          label="show all groups"
          render={(g) => (
            <li key={g.id} className="border-l-2 border-amber-500/50 pl-2.5">
              <p className="font-mono text-[11px] text-amber-300/90">
                {g.sourceIds.length} message{g.sourceIds.length === 1 ? "" : "s"} · {fmt(g.originalTokens)} → {fmt(g.compressedTokens)} tokens · {g.kind.replace("_", " ")} · {g.method}
                {g.cached && " · cached"}
              </p>
              <p className="text-zinc-300">{g.summary.length > 400 ? g.summary.slice(0, 400) + "…" : g.summary}</p>
              <p className="font-mono text-[11px] text-zinc-600">{g.reason} · sources: {g.sourceIds.join(", ")}</p>
            </li>
          )}
        />
        {t.compression.deduplicated.length > 0 && (
          <details className="font-mono text-[11px]">
            <summary className="cursor-pointer text-sky-400/80 hover:text-sky-300">duplicates dropped ({t.compression.deduplicated.length})</summary>
            <ul className="mt-1.5 space-y-1">
              {t.compression.deduplicated.map((d) => (
                <li key={d.id} className="text-zinc-500"><Id>{d.id}</Id>duplicate of {d.duplicateOf} · {d.tokens} tok</li>
              ))}
            </ul>
          </details>
        )}
      </Stage>

      <Stage n={7} title="Omission" summary={`${t.omission.totalCount} omitted · ~${fmt(t.omission.tokensRemoved)} tok`}>
        {t.omission.totalCount === 0 ? (
          <Note>{cl.total === 0 ? "No prior history to omit." : "Nothing was omitted: all history was needed for this request."}</Note>
        ) : (
          <>
            <Note>Largest first. Includes duplicates dropped as extra copies.</Note>
            <Capped
              items={t.omission.items}
              limit={3}
              label="view all omitted"
              render={(o) => (
                <li key={o.id} className="border-l-2 border-zinc-700 pl-2.5">
                  <p className="truncate text-zinc-400"><Id>{o.id}</Id>{o.preview}</p>
                  <p className="font-mono text-[11px] text-zinc-600">{o.tokens} tok · score {o.score.toFixed(2)} · {o.duplicate ? "duplicate" : "irrelevant"} · {o.reason}</p>
                </li>
              )}
            />
          </>
        )}
      </Stage>

      <Stage n={8} title="Compiled context" summary={<span className="text-emerald-400">−{c.reductionPercent}%</span>}>
        {t.economics && <EconomicsBlock e={t.economics} />}
        {c.tokenCount ? (
          <div className="grid grid-cols-2 gap-1.5">
            <Metric label="Original context" value={`${fmt(c.tokenCount.fullTokens)} tokens`} />
            <Metric label="Compiled context" value={`${fmt(c.tokenCount.compiledTokens)} tokens`} />
            <Metric label="Tokens avoided" value={fmt(c.tokenCount.tokensAvoided)} tone={c.tokenCount.tokensAvoided >= 0 ? "text-emerald-400" : "text-red-400"} />
            <Metric label="Reduction" value={`${c.tokenCount.reductionPercent.toFixed(2)}%`} tone={c.tokenCount.reductionPercent >= 0 ? "text-emerald-400" : "text-red-400"} />
            {c.tokenCount.initialCompiledTokens != null && (
              <>
                <Metric label="Initial compile (before any fallback)" value={`${fmt(c.tokenCount.fullTokens)} → ${fmt(c.tokenCount.initialCompiledTokens)} · ${c.tokenCount.initialReductionPercent.toFixed(1)}%`} tone={c.tokenCount.initialReductionPercent > 0 ? "text-emerald-400" : undefined} />
                <Metric label={ev.fallbackLevel > 0 ? "Final after fallback (the returned answer)" : "Final (the returned answer)"} value={`${fmt(c.tokenCount.fullTokens)} → ${fmt(c.tokenCount.compiledTokens)} · ${c.tokenCount.reductionPercent.toFixed(1)}%`} tone={c.tokenCount.reductionPercent > 0 ? "text-emerald-400" : "text-amber-400"} />
              </>
            )}
            <div className="col-span-2 rounded border border-zinc-800 px-2.5 py-1.5 font-mono text-[11px]">
              <span className="text-zinc-600">SOURCE </span>
              {c.tokenCount.source === "provider_count" ? (
                <span className="text-emerald-400">Anthropic token counter (exact request payload, {c.model ?? "configured model"})</span>
              ) : (
                <span className="text-amber-400">Local estimate — not provider-counted{c.tokenCount.error ? `: ${c.tokenCount.error}` : ""}</span>
              )}
            </div>
          </div>
        ) : (
          <div className="flex flex-wrap items-baseline gap-2 font-mono">
            <span className="text-zinc-400">{fmt(c.originalTokenEstimate)}</span>
            <span className="text-zinc-600">→</span>
            <span className="text-lg font-semibold text-zinc-100">{fmt(c.compiledTokenEstimate)}</span>
            <span className="text-[11px] text-zinc-600">tokens (local estimate, recorded before provider counting existed)</span>
            <span className="ml-auto text-emerald-400">{fmt(c.tokensAvoided)} avoided · {c.reductionPercent}%</span>
          </div>
        )}
        <div className="grid grid-cols-5 gap-1.5 font-mono text-[11px]">
          {(Object.entries(c.counts) as [string, number][]).map(([k, v]) => (
            <div key={k} className="rounded border border-zinc-800 px-2 py-1">
              <div className="text-zinc-600">{k.toUpperCase()}</div>
              <div className="text-zinc-200">{v}</div>
            </div>
          ))}
        </div>
        <div className="space-y-0.5">
          <p className="font-mono text-[11px] text-zinc-600">savings by mechanism (estimated, no double counting)</p>
          {savings.map(([label, s]) => (
            <div key={label} className="flex justify-between font-mono text-[11px]">
              <span className="text-zinc-400">{label}</span>
              <span className="text-zinc-200">{fmt(s)} tok</span>
            </div>
          ))}
        </div>
        <details className="font-mono text-[11px]">
          <summary className="cursor-pointer text-sky-400/80 hover:text-sky-300">details: actual usage, cost, estimator accuracy</summary>
          <div className="mt-1.5 space-y-0.5">
            <p className="text-zinc-600">ACTUAL completed-request usage (Anthropic-reported, all main-model attempts; separate from the pre-flight count)</p>
            <Row k="reported input">{c.providerInputTokens == null ? "not reported" : `${fmt(c.providerInputTokens)} tokens${c.tokenCount ? "" : " (includes runtime overhead)"}`}</Row>
            <Row k="reported output">{c.providerOutputTokens == null ? "not reported" : `${fmt(c.providerOutputTokens)} tokens`}</Row>
            {c.usage?.cacheCreationInputTokens != null && <Row k="cache writes">{fmt(c.usage.cacheCreationInputTokens)} tokens (priced separately)</Row>}
            {c.usage?.cacheReadInputTokens != null && <Row k="cache reads">{fmt(c.usage.cacheReadInputTokens)} tokens (priced separately)</Row>}
            {c.tokenCount && (
              <>
                <p className="pt-1 text-zinc-600">Old local estimator vs provider count</p>
                <Row k="estimate">
                  original {fmt(c.tokenCount.fullEstimate)} · compiled {fmt(c.tokenCount.compiledEstimate)}
                  {c.tokenCount.source === "provider_count" && c.tokenCount.fullTokens > 0 && ` (original off by ${(((c.tokenCount.fullEstimate - c.tokenCount.fullTokens) / c.tokenCount.fullTokens) * 100).toFixed(1)}%)`}
                </Row>
                <Row k="count latency">{c.tokenCount.latencyMs} ms (not part of compiler latency)</Row>
              </>
            )}
            {c.costs ? (
              <>
                <p className="pt-1 text-zinc-600">Cost ({c.costs.pricingModel}, input priced at the base rate, no caching assumed)</p>
                <Row k="full-context input">{usd(c.costs.fullInputCostUsd)}</Row>
                <Row k="compiled input">{usd(c.costs.compiledInputCostUsd)}</Row>
                <Row k="gross input saved"><span className="text-emerald-400">{usd(c.costs.grossInputSavingsUsd)}</span></Row>
                <Row k="optimizer cost">{usd(c.costs.optimizerCostUsd)} (internal Consolidate model calls{c.utilityModel ? ` on ${c.utilityModel}` : ""})</Row>
                {c.costs.fallbackWasteCostUsd > 0 && <Row k="discarded attempts">{usd(c.costs.fallbackWasteCostUsd)} (generation spend on answers replaced by fallback)</Row>}
                <Row k="net savings"><span className={c.costs.netSavingsUsd >= 0 ? "text-emerald-400" : "text-red-400"}>{usd(c.costs.netSavingsUsd)}</span></Row>
                <Row k="final response">{usd(c.costs.generationCostUsd)} (input {usd(c.costs.generationInputCostUsd)} · output {usd(c.costs.generationOutputCostUsd)}; reported separately, output length varies)</Row>
              </>
            ) : (
              <Row k="cost">not computed — requires provider-counted tokens and priced models</Row>
            )}
            <Row k="latency">compiler {c.compilerLatencyMs}ms · model {secs(c.modelLatencyMs)}</Row>
          </div>
        </details>
        {c.savings.omission + c.savings.memory + c.savings.compression + c.savings.deduplication === 0 && cl.total > 0 && <Note>No tokens were saved for this request{ev.fallbackLevel === 2 ? ": fallback sent the full context." : "."}</Note>}
      </Stage>

      <Stage n={9} title="Evaluation / fallback" summary={<span className={evColor}>{ev.status}{ev.fallbackApplied ? " · fallback" : ""}</span>}>
        <div className="flex items-baseline gap-3 font-mono">
          <span className={`text-lg font-semibold ${evColor}`}>{ev.status}</span>
          <span className="text-[11px] text-zinc-400">{ev.checks.filter((k) => k.passed).length} / {ev.checks.length} checks on the optimized answer</span>
        </div>
        <Row k="fallback">
          {ev.fallbackLevel === 0 ? "Not required" : <span className="text-amber-400">{ev.fallbackLevel === 1 ? "Level 1: expanded retrieval and retried" : "Level 2: full context used"}</span>}
        </Row>
        {ev.attempts.some((a) => a.level === "regenerated") && <Row k="regeneration"><span className="text-amber-400">Regenerated once with the same optimized context and a corrective instruction; no history added</span></Row>}
        {ev.fallbackReason && <Row k="reason">{ev.fallbackReason}</Row>}
        <Row k="semantic eval">{ev.semanticEvaluatorUsed ? "bounded model evaluator ran" : `skipped: ${ev.semanticSkipReason ?? "not needed"}`}</Row>
        <details className="font-mono text-[11px]" open={ev.status === "FAIL"}>
          <summary className="cursor-pointer text-sky-400/80 hover:text-sky-300">checks</summary>
          <ul className="mt-1.5 space-y-0.5">
            {ev.checks.map((k, i) => (
              <li key={i} className={k.passed ? "text-zinc-400" : "text-red-400"}>
                {k.passed ? "✓" : "✗"} {k.name}
                {k.reason && <span className="text-zinc-600"> — {k.reason}</span>}
              </li>
            ))}
          </ul>
        </details>
        {ev.attempts.length > 0 && (
          <div className="space-y-1.5 border-t border-zinc-800/80 pt-2">
            <p className="font-mono text-[11px] text-zinc-500">attempts (each stored independently)</p>
            {ev.attempts.map((a, i) => (
              <details key={i} className="font-mono text-[11px]" open={i === 0 && !a.passed}>
                <summary className="cursor-pointer text-zinc-300">
                  {i + 1}. {a.level} · {a.fullCountedTokens != null && a.countedInputTokens != null ? `${fmt(a.fullCountedTokens)} → ${fmt(a.countedInputTokens)} counted tok` : `${fmt(a.contextTokens)} est. tok`}
                  {a.reductionPercent != null && ` · ${a.reductionPercent.toFixed(1)}%`} · <span className={a.passed ? "text-emerald-400" : "text-red-400"}>{a.passed ? "passed" : `failed${a.failureCategory ? ` · ${a.failureCategory}` : ""}`}</span>
                </summary>
                {a.routing && <p className="mt-1 text-zinc-500">routing: keep {a.routing.keep} · memory {a.routing.memory} · retrieve {a.routing.retrieve} · compress {a.routing.compress} · omit {a.routing.omit}</p>}
                {a.contextAdded && (
                  <p className="mt-1 text-zinc-500">
                    context added vs previous attempt: {a.contextAdded.length} entr{a.contextAdded.length === 1 ? "y" : "ies"}, {fmt(a.contextAdded.reduce((t, x) => t + x.tokens, 0))} est. tok
                    {a.contextAdded.length > 0 && ` (${a.contextAdded.map((x) => x.id).join(", ")})`}
                  </p>
                )}
                {!a.passed && <p className="mt-1 text-red-300/80">{a.reason}</p>}
                <p className="mt-1 whitespace-pre-wrap font-sans text-xs text-zinc-400">{a.response.length > 700 ? a.response.slice(0, 700) + "…" : a.response}</p>
              </details>
            ))}
          </div>
        )}
        {t.utilityCalls.length > 0 && (
          <div className="border-t border-zinc-800/80 pt-2">
            <p className="font-mono text-[11px] text-zinc-500">model-assisted steps this request</p>
            {t.utilityCalls.map((u, i) => (
              <p key={i} className="font-mono text-[11px] text-zinc-500">
                <span className={u.ok ? "text-emerald-500" : "text-red-400"}>{u.ok ? "✓" : "✗"}</span> {KIND_LABEL[u.kind] ?? u.purpose} · {secs(u.latencyMs)}
                {u.model && ` · ${u.model}`}
                {u.inputTokens != null && ` · ${fmt(u.inputTokens)} in / ${fmt(u.outputTokens ?? 0)} out`}
                {u.costUsd != null && ` · ${usd(u.costUsd)}`}
                {u.note && ` · ${u.note}`}{u.error && ` · ${u.error}`}
              </p>
            ))}
          </div>
        )}
      </Stage>

      {t.benchmark && (
        <Stage n={10} title="Benchmark: full context vs Consolidate" summary={<span className="text-zinc-500">2 generations</span>}>
          {t.benchmark.baselineError && <Note>Baseline generation failed: {t.benchmark.baselineError}</Note>}
          <div className="grid grid-cols-2 gap-2">
            {([["Full context", t.benchmark.full], ["Consolidate", t.benchmark.consolidate]] as const).map(([label, side]) => (
              <div key={label} className="space-y-0.5 rounded border border-zinc-800 p-2 font-mono text-[11px]">
                <p className="text-zinc-300">{label}</p>
                {side ? (
                  <>
                    <p className="text-zinc-500">counted input {side.countedInputTokens == null ? "—" : fmt(side.countedInputTokens)}</p>
                    <p className="text-zinc-500">actual in/out {side.usage.inputTokens ?? "—"} / {side.usage.outputTokens ?? "—"}</p>
                    <p className="text-zinc-500">latency {secs(side.modelLatencyMs)} · cost {usd(side.costUsd)}</p>
                    <p className={side.checksPassed ? "text-emerald-400" : "text-red-400"}>{side.checksPassed ? "answer checks pass" : `failed: ${side.failedChecks.join(", ")}`}</p>
                    <details>
                      <summary className="cursor-pointer text-sky-400/80">answer</summary>
                      <p className="mt-1 whitespace-pre-wrap font-sans text-xs text-zinc-400">{side.response}</p>
                    </details>
                  </>
                ) : (
                  <p className="text-zinc-600">not available</p>
                )}
              </div>
            ))}
          </div>
          <Note>Answer quality is shown side by side; deterministic checks only. Baseline cost is a measurement cost and is excluded from optimizer cost and net savings.</Note>
        </Stage>
      )}
    </OnlyStages.Provider>
  );
}
