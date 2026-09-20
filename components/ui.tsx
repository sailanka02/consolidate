// Shared visual primitives and the color system. Color carries meaning, used sparingly:
//   kept/protected blue · remembered purple · brought back cyan · compressed amber · removed gray
//   positive/pass green · fallback/warning orange · failure/negative economics red
import type { ReactNode } from "react";
import type { CardKind } from "@/lib/consolidate/explain";
import { fmt } from "@/lib/format";

export type Tone = "good" | "warn" | "bad" | "neutral" | "info";

// Full literal class names so Tailwind can see them.
export const MECH: Record<CardKind, { text: string; soft: string; ring: string; bar: string; dot: string; edge: string }> = {
  kept: { text: "text-sky-300", soft: "bg-sky-500/10", ring: "ring-sky-500/25", bar: "bg-sky-400", dot: "bg-sky-400", edge: "border-l-sky-400/70" },
  remembered: { text: "text-violet-300", soft: "bg-violet-500/10", ring: "ring-violet-500/25", bar: "bg-violet-400", dot: "bg-violet-400", edge: "border-l-violet-400/70" },
  brought_back: { text: "text-cyan-300", soft: "bg-cyan-500/10", ring: "ring-cyan-500/25", bar: "bg-cyan-400", dot: "bg-cyan-400", edge: "border-l-cyan-400/70" },
  compressed: { text: "text-amber-300", soft: "bg-amber-500/10", ring: "ring-amber-500/25", bar: "bg-amber-400", dot: "bg-amber-400", edge: "border-l-amber-400/70" },
  removed: { text: "text-zinc-400", soft: "bg-zinc-500/10", ring: "ring-zinc-500/25", bar: "bg-zinc-500", dot: "bg-zinc-500", edge: "border-l-zinc-500/60" },
};

export const TONE: Record<Tone, { text: string; soft: string; ring: string; bar: string }> = {
  good: { text: "text-emerald-400", soft: "bg-emerald-500/10", ring: "ring-emerald-500/25", bar: "bg-emerald-400" },
  warn: { text: "text-orange-400", soft: "bg-orange-500/10", ring: "ring-orange-500/25", bar: "bg-orange-400" },
  bad: { text: "text-red-400", soft: "bg-red-500/10", ring: "ring-red-500/25", bar: "bg-red-400" },
  info: { text: "text-sky-300", soft: "bg-sky-500/10", ring: "ring-sky-500/25", bar: "bg-sky-400" },
  neutral: { text: "text-zinc-300", soft: "bg-zinc-500/10", ring: "ring-zinc-500/20", bar: "bg-zinc-500" },
};

export function Panel({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`rounded-2xl bg-zinc-900/60 ring-1 ring-white/[0.06] ${className}`}>{children}</div>;
}

export const Eyebrow = ({ children, className = "" }: { children: ReactNode; className?: string }) => (
  <p className={`text-[11px] font-medium uppercase tracking-[0.14em] text-zinc-500 ${className}`}>{children}</p>
);

export function Pill({ tone = "neutral", children }: { tone?: Tone; children: ReactNode }) {
  const t = TONE[tone];
  return <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ${t.soft} ${t.text} ${t.ring}`}>{children}</span>;
}

// A horizontal bar whose width is value / max of the row it sits in.
export function Bar({ value, max, className = "bg-emerald-400", height = "h-3" }: { value: number; max: number; className?: string; height?: string }) {
  const w = max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : 0;
  return (
    <div className={`${height} w-full overflow-hidden rounded-full bg-white/[0.05]`}>
      <div className={`bar-grow h-full rounded-full ${className}`} style={{ width: `${w}%` }} />
    </div>
  );
}

// FULL vs SENT: the before/after comparison used in the trace summary and the dashboard hero.
export function CompareBars({ full, sent, fullLabel = "Full context", sentLabel = "Consolidate", unit = "tokens", size = "md" }: { full: number; sent: number; fullLabel?: string; sentLabel?: string; unit?: string; size?: "md" | "lg" }) {
  const h = size === "lg" ? "h-5" : "h-3.5";
  return (
    <div className="space-y-2.5" role="img" aria-label={`${fullLabel} ${fmt(full)} ${unit}, ${sentLabel} ${fmt(sent)} ${unit}`}>
      <div>
        <div className="mb-1 flex justify-between text-xs">
          <span className="text-zinc-400">{fullLabel}</span>
          <span className="font-mono text-zinc-300">{fmt(full)}</span>
        </div>
        <Bar value={full} max={Math.max(full, sent)} className="bg-zinc-500" height={h} />
      </div>
      <div>
        <div className="mb-1 flex justify-between text-xs">
          <span className="text-emerald-300">{sentLabel}</span>
          <span className="font-mono text-emerald-300">{fmt(sent)}</span>
        </div>
        <Bar value={sent} max={Math.max(full, sent)} className="bg-gradient-to-r from-emerald-500 to-teal-400" height={h} />
      </div>
    </div>
  );
}

// Expandable section with the technical detail behind a plain-language summary.
export function Disclosure({ title, children, open = false, className = "" }: { title: ReactNode; children: ReactNode; open?: boolean; className?: string }) {
  return (
    <details open={open} className={`group ${className}`}>
      <summary className="flex cursor-pointer list-none items-center gap-1.5 text-xs text-zinc-500 transition-colors hover:text-zinc-300">
        <span className="inline-block text-[10px] transition-transform group-open:rotate-90">▶</span>
        {title}
      </summary>
      <div className="reveal mt-2">{children}</div>
    </details>
  );
}

export function Stat({ label, value, sub, tone = "neutral" }: { label: string; value: ReactNode; sub?: ReactNode; tone?: Tone }) {
  return (
    <div>
      <Eyebrow>{label}</Eyebrow>
      <div className={`mt-1 font-mono text-2xl font-semibold tabular-nums ${TONE[tone].text}`}>{value}</div>
      {sub && <div className="mt-0.5 text-xs text-zinc-500">{sub}</div>}
    </div>
  );
}

export function Spinner({ className = "" }: { className?: string }) {
  return <span className={`inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-zinc-600 border-t-sky-400 ${className}`} aria-hidden />;
}
