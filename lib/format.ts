// Display formatting shared by the UI. Pure; nothing here computes a metric, it only renders one.
export const fmt = (n: number | null | undefined, d = 0) => (n == null ? "—" : n.toLocaleString("en-US", { maximumFractionDigits: d }));
export const pct = (n: number | null | undefined, d = 1) => (n == null ? "—" : `${n.toFixed(d)}%`);
export const rate = (r: number | null | undefined) => (r == null ? "—" : `${(r * 100).toFixed(0)}%`);
export const secs = (ms: number | null | undefined) => (ms == null ? "—" : ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`);

// Money is shown with a sign and enough precision that fractions of a cent stay visible.
export function usd(n: number | null | undefined, opts: { sign?: boolean } = {}): string {
  if (n == null) return "—";
  const a = Math.abs(n);
  const digits = a === 0 ? 2 : a < 0.01 ? 5 : a < 1 ? 4 : 2;
  const sign = n < 0 ? "−" : opts.sign && n > 0 ? "+" : "";
  return `${sign}$${a.toFixed(digits)}`;
}
