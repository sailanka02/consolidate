"use client";

// The Context Trace for people, not compiler engineers. Three questions, top to bottom:
//   what did Consolidate do? why? what was the impact?
// Every number comes from the persisted trace; the technical names (KEEP, scores, IDs...) live behind "Technical details".
import { useState } from "react";
import { TechnicalStages } from "./ContextTrace";
import { Bar, CompareBars, Disclosure, Eyebrow, MECH, Panel, Pill, Spinner, Stat, TONE, type Tone } from "./ui";
import { buildAttempts, buildDecisionCards, decisionBasis, decisionCounts, KIND_LABEL, summarizeTrace, understanding, type AttemptView, type CardKind, type DecisionCard } from "@/lib/consolidate/explain";
import { fmt, pct, secs, usd } from "@/lib/format";
import type { ContextTrace as Trace } from "@/lib/types";

export default function TraceView({ trace, loading }: { trace: Trace | null; loading?: boolean }) {
  return (
    <section className="flex h-full min-h-0 flex-col overflow-hidden rounded-2xl bg-zinc-900/40 ring-1 ring-white/[0.06]">
      <header className="flex items-center justify-between border-b border-white/[0.06] px-5 py-3.5">
        <h2 className="text-sm font-semibold text-zinc-100">Context Trace</h2>
        <span className="text-xs text-zinc-500">{loading ? <span className="flex items-center gap-2"><Spinner /> working…</span> : trace ? "what Consolidate did for this message" : "no request yet"}</span>
      </header>
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
        {trace ? <TraceContent t={trace} /> : <EmptyTrace loading={loading} />}
      </div>
    </section>
  );
}

function EmptyTrace({ loading }: { loading?: boolean }) {
  if (loading) {
    return (
      <div className="space-y-3" aria-busy>
        {[120, 80, 96].map((h) => (
          <div key={h} className="animate-pulse rounded-2xl bg-white/[0.03]" style={{ height: h }} />
        ))}
      </div>
    );
  }
  return (
    <div className="flex h-full min-h-[260px] flex-col items-center justify-center px-8 text-center">
      <div className="mb-3 grid h-11 w-11 place-items-center rounded-2xl bg-sky-500/10 text-lg text-sky-300 ring-1 ring-sky-500/25">◎</div>
      <p className="text-sm font-medium text-zinc-200">Nothing to show yet</p>
      <p className="mt-1 max-w-xs text-xs leading-relaxed text-zinc-500">Send a message. For every request Consolidate shows how much context it trimmed, what it kept and why, and whether the answer passed a quality check.</p>
    </div>
  );
}

export function TraceContent({ t }: { t: Trace }) {
  const summary = summarizeTrace(t);
  const attempts = buildAttempts(t);
  return (
    <>
      <SummaryCard t={t} />
      <UnderstandingSection t={t} />
      <DecisionsSection t={t} />
      <FinalContextSection t={t} />
      <QualitySection t={t} attempts={attempts} finalPercent={summary.percent} counted={summary.counted} />
    </>
  );
}

// ---------------------------------------------------------------- summary

export function SummaryCard({ t }: { t: Trace }) {
  const s = summarizeTrace(t);
  const good = s.percent > 0;
  const heroTone: Tone = good ? "good" : s.percent < 0 ? "bad" : "neutral";
  const approx = s.counted ? "" : "≈ ";
  return (
    <Panel className="overflow-hidden">
      <div className="h-1 bg-gradient-to-r from-emerald-500/70 via-teal-400/60 to-sky-500/50" />
      <div className="space-y-5 p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Eyebrow>Context optimization</Eyebrow>
          {s.counted ? <Pill tone="good">Counted by Anthropic</Pill> : <Pill tone="warn">Estimated{s.countNote ? ` · ${s.countNote}` : ""}</Pill>}
        </div>

        <div>
          <p className={`font-mono text-4xl font-semibold tracking-tight tabular-nums ${TONE[heroTone].text}`} data-testid="hero-percent">
            {approx}
            {pct(Math.abs(s.percent))} <span className="text-lg font-medium uppercase tracking-wider">{good ? "smaller" : s.percent < 0 ? "larger" : "no reduction"}</span>
          </p>
          <p className="mt-1 text-sm text-zinc-400">
            <span className="font-mono text-zinc-200">{fmt(Math.abs(s.avoided))}</span> tokens {s.avoided >= 0 ? "avoided" : "added"} for this request
          </p>
        </div>

        <CompareBars full={s.full} sent={s.sent} />

        <dl className="grid grid-cols-1 gap-3 border-t border-white/[0.06] pt-4 text-sm sm:grid-cols-3">
          <div>
            <dt className="text-xs text-zinc-500">Quality check</dt>
            <dd className={`mt-0.5 font-medium ${TONE[s.quality.tone].text}`}>{s.quality.tone === "good" ? "✓ " : s.quality.tone === "warn" ? "↻ " : "✗ "}{s.quality.label}</dd>
          </div>
          <div>
            <dt className="text-xs text-zinc-500">Fallback</dt>
            <dd className={`mt-0.5 font-medium ${s.fallback === "None" ? "text-zinc-300" : "text-orange-400"}`}>{s.fallback}</dd>
          </div>
          <div>
            <dt className="text-xs text-zinc-500">Net input savings</dt>
            <dd className={`mt-0.5 font-mono font-medium ${s.netUsd == null ? "text-zinc-500" : s.netUsd >= 0 ? "text-emerald-400" : "text-red-400"}`}>{usd(s.netUsd, { sign: true })}</dd>
          </div>
        </dl>

        {s.fellBack && (
          <p className="rounded-xl bg-orange-500/10 px-3.5 py-2.5 text-xs leading-relaxed text-orange-200 ring-1 ring-orange-500/20">
            Consolidate first made this request <strong>{pct(s.initialPercent)}</strong> smaller ({fmt(s.full)} → {fmt(s.initialSent)}). The quality check then sent more context, so the request behind the answer you received is <strong>{pct(s.percent)}</strong> smaller. Both are shown below.
          </p>
        )}
        {s.netUsd != null && s.netUsd < 0 && (
          <p className="text-xs leading-relaxed text-zinc-500">Net savings are negative here: the cost of Consolidate’s own model calls{s.fellBack || s.regenerated ? " and the discarded first answer" : ""} was larger than the input tokens it saved. That is common for short conversations, where there is little to remove.</p>
        )}
      </div>
    </Panel>
  );
}

// ---------------------------------------------------------------- section shell

function Section({ n, title, summary, children, technical }: { n: number; title: string; summary?: React.ReactNode; children: React.ReactNode; technical?: React.ReactNode }) {
  return (
    <Panel className="p-5">
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <h3 className="flex items-baseline gap-2.5 text-sm font-semibold text-zinc-100">
          <span className="font-mono text-[11px] font-normal text-zinc-600">{n}</span>
          {title}
        </h3>
        {summary && <span className="text-xs text-zinc-500">{summary}</span>}
      </div>
      <div className="space-y-3">{children}</div>
      {technical && <div className="mt-4 border-t border-white/[0.05] pt-3"><Disclosure title="Technical details">{technical}</Disclosure></div>}
    </Panel>
  );
}

// ---------------------------------------------------------------- 1 understanding

function UnderstandingSection({ t }: { t: Trace }) {
  const u = understanding(t);
  const line = (n: number, one: string, many: string, tone: Tone = "neutral") => (
    <li className="flex items-center gap-2.5 text-sm text-zinc-300">
      <span className={`h-1.5 w-1.5 rounded-full ${TONE[tone].bar}`} />
      <span><span className="font-mono text-zinc-100">{fmt(n)}</span> {n === 1 ? one : many}</span>
    </li>
  );
  return (
    <Section n={1} title="Understanding" summary={t.requestAnalysis.task} technical={<TechnicalStages t={t} only={[1, 2, 3]} />}>
      <p className="rounded-xl bg-white/[0.03] px-3.5 py-2.5 text-sm text-zinc-300">
        <span className="text-zinc-500">Your message · </span>“{t.requestAnalysis.request.length > 160 ? t.requestAnalysis.request.slice(0, 160) + "…" : t.requestAnalysis.request}”
      </p>
      {u.messagesReviewed === 0 ? (
        <p className="text-sm text-zinc-400">This is the first message, so there was no earlier conversation to review.</p>
      ) : (
        <ul className="space-y-1.5">
          {line(u.messagesReviewed, "previous message reviewed", "previous messages reviewed")}
          {line(u.protectedCount, "requirement protected", "requirements protected", "info")}
          {line(u.memoryCount, "persistent fact remembered", "persistent facts remembered")}
        </ul>
      )}
      {u.reference && (
        <p className="text-xs leading-relaxed text-cyan-300/90">
          {u.reference.found > 0
            ? `Your message refers to “${u.reference.phrase}”, so Consolidate looked for what you recently presented and found ${u.reference.found} matching message${u.reference.found === 1 ? "" : "s"}.`
            : `Your message refers to “${u.reference.phrase}”, but nothing recent looked like what it points at, so Consolidate did not guess.`}
        </p>
      )}
      {u.followUp && !u.reference && <p className="text-xs leading-relaxed text-cyan-300/90">This reads as a follow-up to something said earlier, so Consolidate searched the earlier conversation by meaning to find what it refers to.</p>}
    </Section>
  );
}

// ---------------------------------------------------------------- 2 decisions

const KIND_ORDER: CardKind[] = ["kept", "remembered", "brought_back", "compressed", "removed"];
const SHOW_FIRST = 3;

function DecisionsSection({ t }: { t: Trace }) {
  const basis = decisionBasis(t, 0);
  const cards = buildDecisionCards(basis);
  const counts = decisionCounts(cards, basis);
  const hadFallback = t.evaluation.attempts.length > 1;
  const tiles: [CardKind, number][] = [["kept", counts.kept], ["remembered", counts.remembered], ["brought_back", counts.brought_back], ["compressed", counts.compressed], ["removed", counts.removed]];
  const empty = t.requestAnalysis.historyScanned === 0;
  return (
    <Section n={2} title="Context decisions" summary={empty ? undefined : `${t.requestAnalysis.historyScanned} messages sorted`} technical={<TechnicalStages t={t} only={[4, 5, 6, 7]} />}>
      {empty ? (
        <p className="text-sm text-zinc-400">Nothing to decide yet. Decisions start once the conversation has history.</p>
      ) : (
        <>
          <div className="grid grid-cols-5 gap-2">
            {tiles.map(([k, n]) => (
              <div key={k} className={`rounded-xl px-2 py-2.5 text-center ring-1 ${n ? `${MECH[k].soft} ${MECH[k].ring}` : "bg-white/[0.02] ring-white/[0.05]"}`}>
                <div className={`font-mono text-xl font-semibold tabular-nums ${n ? MECH[k].text : "text-zinc-600"}`}>{n}</div>
                <div className="mt-0.5 text-[10px] leading-tight text-zinc-500">{KIND_LABEL[k]}</div>
              </div>
            ))}
          </div>
          {basis.basis === "reconstructed" ? (
            <p className="text-xs text-zinc-500">This run was saved before detailed decisions were recorded, so the cards describe the context that was finally sent.</p>
          ) : hadFallback ? (
            <p className="text-xs text-zinc-500">These are Consolidate’s first choices (attempt 1). What changed afterwards is under Quality check.</p>
          ) : null}
          {KIND_ORDER.map((k) => {
            const group = cards.filter((c) => c.kind === k);
            return group.length ? <CardGroup key={k} kind={k} cards={group} /> : null;
          })}
        </>
      )}
    </Section>
  );
}

function CardGroup({ kind, cards }: { kind: CardKind; cards: DecisionCard[] }) {
  const [all, setAll] = useState(false);
  const shown = all ? cards : cards.slice(0, SHOW_FIRST);
  const m = MECH[kind];
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 pt-1">
        <span className={`h-2 w-2 rounded-full ${m.dot}`} />
        <h4 className={`text-xs font-semibold uppercase tracking-wider ${m.text}`}>{KIND_LABEL[kind]}</h4>
        <span className="text-xs text-zinc-600">{cards.length}</span>
      </div>
      {shown.map((c) => (
        <DecisionCardView key={c.key} c={c} />
      ))}
      {cards.length > SHOW_FIRST && (
        <button onClick={() => setAll(!all)} className="text-xs text-sky-400/80 transition-colors hover:text-sky-300">
          {all ? "Show fewer" : `Show ${cards.length - SHOW_FIRST} more`}
        </button>
      )}
    </div>
  );
}

export function DecisionCardView({ c }: { c: DecisionCard }) {
  const m = MECH[c.kind];
  const t = c.technical;
  const sig = t.signals;
  return (
    <article className={`rounded-xl border-l-2 ${m.edge} bg-white/[0.025] p-3.5 transition-colors hover:bg-white/[0.04]`} data-kind={c.kind}>
      <div className="flex items-center gap-2">
        <span className={`rounded-md px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider ${m.soft} ${m.text}`}>{c.label}</span>
        {c.who && <span className="text-[11px] text-zinc-600">{c.who === "You" ? "you said" : "Claude replied"}</span>}
      </div>
      <p className="mt-2 text-sm leading-snug text-zinc-100">{c.headline}</p>
      {c.detail && <p className={`mt-0.5 text-sm ${c.kind === "remembered" ? "font-medium text-violet-300" : "text-zinc-400"}`}>{c.detail}</p>}
      <dl className="mt-2.5 space-y-1.5 text-xs">
        <div>
          <dt className="inline font-medium text-zinc-500">Why? </dt>
          <dd className="inline text-zinc-300">{c.why}</dd>
        </div>
        {c.source && (
          <div>
            <dt className="inline font-medium text-zinc-500">Source </dt>
            <dd className="inline text-zinc-400">{c.source}</dd>
          </div>
        )}
        {c.before != null && c.after != null ? (
          <div className="flex gap-4 pt-0.5 font-mono text-[11px]">
            <span className="text-zinc-500">Before <span className="text-zinc-300">{fmt(c.before)}</span></span>
            <span className="text-zinc-500">After <span className="text-zinc-300">{fmt(c.after)}</span></span>
            {c.saved != null && <span className="text-zinc-500">Saved <span className="text-emerald-400">{fmt(c.saved)}</span></span>}
          </div>
        ) : (
          <div>
            <dt className="inline font-medium text-zinc-500">Impact </dt>
            <dd className={`inline ${c.kind === "removed" ? "text-emerald-400/90" : "text-zinc-300"}`}>{c.impact}</dd>
          </div>
        )}
      </dl>
      <Disclosure title="Technical details" className="mt-2.5">
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 rounded-lg bg-black/25 p-2.5 font-mono text-[11px] text-zinc-400">
          <dt className="text-zinc-600">action</dt><dd>{t.action}{t.continuity ? " · continuity" : ""}</dd>
          <dt className="text-zinc-600">reason</dt><dd>{t.reason}</dd>
          {t.score != null && (<><dt className="text-zinc-600">score</dt><dd>{t.score.toFixed(2)}</dd></>)}
          {sig && (<><dt className="text-zinc-600">signals</dt><dd>lexical {sig.lexical.toFixed(2)} · type {sig.typeFactor.toFixed(2)} · importance {sig.importance.toFixed(2)} · recency {sig.recency.toFixed(2)} · memory {sig.memory.toFixed(2)} · semantic {sig.semantic.toFixed(2)}</dd></>)}
          {t.matched.length > 0 && (<><dt className="text-zinc-600">matched</dt><dd>{t.matched.join(", ")}</dd></>)}
          {t.contentType && (<><dt className="text-zinc-600">type</dt><dd>{t.contentType}{t.classMethod ? ` · ${t.classMethod}` : ""}</dd></>)}
          {t.protection && (<><dt className="text-zinc-600">protection</dt><dd>{t.protection}</dd></>)}
          {t.duplicateOf && (<><dt className="text-zinc-600">duplicate of</dt><dd>{t.duplicateOf}</dd></>)}
          {t.groupId && (<><dt className="text-zinc-600">group</dt><dd>{t.groupId}</dd></>)}
          <dt className="text-zinc-600">{t.ids.length > 1 ? "source ids" : "id"}</dt><dd className="break-all">{t.ids.join(", ") || "—"}</dd>
        </dl>
      </Disclosure>
    </article>
  );
}

// ---------------------------------------------------------------- 3 final context

function FinalContextSection({ t }: { t: Trace }) {
  const s = summarizeTrace(t);
  const c = t.compilation;
  const costs = c.costs;
  return (
    <Section n={3} title="Final context" summary={s.counted ? "provider-counted" : "estimated"} technical={<TechnicalStages t={t} only={[8]} />}>
      <div className="grid grid-cols-3 gap-3">
        <Stat label="Full" value={fmt(s.full)} sub="tokens" />
        <Stat label="Sent" value={fmt(s.sent)} sub="tokens" tone="info" />
        <Stat label="Avoided" value={fmt(s.avoided)} sub={pct(s.percent)} tone={s.avoided > 0 ? "good" : s.avoided < 0 ? "bad" : "neutral"} />
      </div>
      {costs ? (
        <div className="rounded-xl bg-black/20 p-3.5 text-xs">
          <Eyebrow className="mb-2">Money for this request</Eyebrow>
          <MoneyRow label="Gross input savings" value={costs.grossInputSavingsUsd} />
          <MoneyRow label="Optimizer cost" value={-costs.optimizerCostUsd} />
          <MoneyRow label="Discarded-attempt cost" value={-costs.fallbackWasteCostUsd} />
          <div className="my-2 border-t border-white/10" />
          <div className="flex items-baseline justify-between">
            <span className="font-medium text-zinc-200">Net input savings</span>
            <span className={`font-mono text-base font-semibold ${costs.netSavingsUsd >= 0 ? "text-emerald-400" : "text-red-400"}`}>{usd(costs.netSavingsUsd, { sign: true })}</span>
          </div>
        </div>
      ) : (
        <p className="text-xs text-zinc-500">No cost figure for this request{s.counted ? ": the model is not in the pricing table." : ": costs need provider-counted tokens."}</p>
      )}
      <div className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-zinc-500">
        <span>Compiler <span className="font-mono text-zinc-300">{secs(c.compilerLatencyMs)}</span></span>
        {c.tokenCount && <span>Token counting <span className="font-mono text-zinc-300">{secs(c.tokenCount.latencyMs)}</span></span>}
        <span>Claude <span className="font-mono text-zinc-300">{secs(c.modelLatencyMs)}</span></span>
      </div>
    </Section>
  );
}

function MoneyRow({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex items-baseline justify-between py-0.5 text-zinc-400">
      <span>{label}</span>
      <span className={`font-mono ${value > 0 ? "text-emerald-400" : value < 0 ? "text-orange-400" : "text-zinc-500"}`}>{usd(value, { sign: true })}</span>
    </div>
  );
}

// ---------------------------------------------------------------- 4 quality check + attempts

function QualitySection({ t, attempts, finalPercent, counted }: { t: Trace; attempts: AttemptView[]; finalPercent: number; counted: boolean }) {
  const s = summarizeTrace(t);
  const ev = t.evaluation;
  return (
    <Section n={4} title="Quality check" summary={<span className={TONE[s.quality.tone].text}>{s.quality.label}</span>} technical={<TechnicalStages t={t} only={[9]} />}>
      <p className="text-sm text-zinc-300">
        {ev.status === "PASS" ? "The first answer passed the check. No fallback was required." : s.quality.detail + "."}
      </p>
      {ev.semanticEvaluatorUsed === false && ev.semanticSkipReason && <p className="text-xs text-zinc-500">The answer check was skipped: {ev.semanticSkipReason}.</p>}
      <ol className="space-y-2.5">
        {attempts.map((a) => (
          <AttemptCard key={a.n} a={a} />
        ))}
      </ol>
      {attempts.length > 1 && (
        <div className="flex items-baseline justify-between rounded-xl bg-white/[0.03] px-3.5 py-2.5">
          <Eyebrow>Final</Eyebrow>
          <span className="text-sm text-zinc-200">
            <span className={`font-mono text-base font-semibold ${finalPercent > 0 ? "text-emerald-400" : "text-zinc-300"}`}>{counted ? "" : "≈ "}{pct(finalPercent)}</span> context reduction
          </span>
        </div>
      )}
    </Section>
  );
}

function AttemptCard({ a }: { a: AttemptView }) {
  const tone: Tone = a.passed ? "good" : a.category === "MISSING_CONTEXT" ? "warn" : "bad";
  return (
    <li className="rounded-xl bg-white/[0.025] p-3.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-[11px] font-bold uppercase tracking-wider text-zinc-400">Attempt {a.n} <span className="ml-1 font-medium normal-case tracking-normal text-zinc-500">· {a.title}</span></span>
        <Pill tone={tone}>{a.passed ? "✓ " : ""}{a.verdict}</Pill>
      </div>
      <div className="mt-2 flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <span className="font-mono text-sm text-zinc-200">
          {a.full != null ? `${fmt(a.full)} → ${fmt(a.sent)}` : `${fmt(a.sent)} tokens`}
          {!a.counted && <span className="ml-1 text-[10px] text-zinc-600">est.</span>}
        </span>
        {a.percent != null && a.level !== "full" && <span className={`font-mono text-xs ${a.percent > 0 ? "text-emerald-400" : "text-zinc-500"}`}>{pct(a.percent)} smaller</span>}
        {a.level === "full" && <span className="text-xs text-zinc-500">nothing removed</span>}
      </div>
      {a.full != null && <div className="mt-2"><Bar value={a.sent} max={Math.max(a.full, a.sent)} className={a.percent && a.percent > 0 ? "bg-gradient-to-r from-emerald-500 to-teal-400" : "bg-zinc-500"} height="h-1.5" /></div>}
      {a.why && (
        <p className="mt-2.5 text-xs leading-relaxed text-zinc-400">
          <span className="font-medium text-zinc-500">Why? </span>{a.why}
        </p>
      )}
      {a.added && (
        <div className="mt-2.5 text-xs text-zinc-400">
          <p><span className="font-medium text-zinc-500">Added </span>{a.added.length === 0 ? "nothing — the same context was used again with a corrective instruction." : `${a.added.length} ${a.added.length === 1 ? "message" : "messages"}, ~${fmt(a.addedTokens)} tokens`}</p>
          {a.added.length > 0 && (
            <ul className="mt-1 space-y-0.5 pl-3">
              {a.added.map((x, i) => (
                <li key={i} className="list-disc text-zinc-500 marker:text-cyan-400/60">{x.title} <span className="font-mono text-[11px] text-zinc-600">~{fmt(x.tokens)} tok</span></li>
              ))}
            </ul>
          )}
        </div>
      )}
      <Disclosure title="Claude’s answer for this attempt" className="mt-2.5">
        <p className="max-h-60 overflow-y-auto whitespace-pre-wrap rounded-lg bg-black/25 p-2.5 text-xs leading-relaxed text-zinc-400">{a.response.length > 1500 ? a.response.slice(0, 1500) + "…" : a.response}</p>
        {a.routing && (
          <p className="mt-1.5 font-mono text-[11px] text-zinc-600">
            routing: keep {a.routing.keep} · memory {a.routing.memory} · retrieve {a.routing.retrieve} · compress {a.routing.compress} · omit {a.routing.omit}
          </p>
        )}
      </Disclosure>
    </li>
  );
}
