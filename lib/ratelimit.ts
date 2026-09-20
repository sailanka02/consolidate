// In-memory sliding-window rate limiting for ONE server instance (no Redis). It exists to cap model spend on a shared demo
// URL, so every rule is checked before any paid call. A request is admitted only if it fits EVERY rule, and is then counted
// against all of them. The global rules hold even if a client spoofs its IP header.
import { intEnv, type Env } from "./runtime-config";

export type Rule = { key: string; limit: number; windowMs: number; label: string };
export type RateResult = { ok: true } | { ok: false; retryAfterSec: number; label: string };

const store = ((globalThis as unknown as { __consolidateRate?: Map<string, number[]> }).__consolidateRate ??= new Map<string, number[]>());
const MAX_KEYS = 5000;

export const resetRateLimits = () => store.clear();

export function checkRate(rules: Rule[], now = Date.now()): RateResult {
  let worst: { retry: number; label: string } | null = null;
  for (const r of rules) {
    const hits = (store.get(r.key) ?? []).filter((t) => t > now - r.windowMs);
    if (hits.length >= r.limit) {
      const retry = Math.max(1, Math.ceil((hits[0] + r.windowMs - now) / 1000));
      if (!worst || retry > worst.retry) worst = { retry, label: r.label };
    }
  }
  if (worst) return { ok: false, retryAfterSec: worst.retry, label: worst.label };
  for (const r of rules) {
    const hits = (store.get(r.key) ?? []).filter((t) => t > now - r.windowMs);
    hits.push(now);
    store.set(r.key, hits);
  }
  if (store.size > MAX_KEYS) for (const k of [...store.keys()].slice(0, store.size - MAX_KEYS)) store.delete(k);
  return { ok: true };
}

// Behind Railway's proxy the client address is in X-Forwarded-For. A spoofed header can only dodge the per-client rules;
// the global rules still bound total spend.
export function clientIp(req: Request): string {
  const xff = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return xff || req.headers.get("x-real-ip")?.trim() || "local";
}

const MIN10 = 10 * 60_000;
const HOUR = 3_600_000;

// Model-generating requests. Benchmark mode generates an extra full-context answer, so it also counts against much
// tighter benchmark rules.
export function generationRules(ip: string, benchmark: boolean, env: Env = process.env): Rule[] {
  const perClient10 = intEnv(env, "CONSOLIDATE_CHAT_LIMIT_PER_10_MIN", 20);
  const global1h = intEnv(env, "CONSOLIDATE_CHAT_LIMIT_PER_HOUR", 120);
  const rules: Rule[] = [
    { key: `chat:ip:${ip}`, limit: perClient10, windowMs: MIN10, label: `${perClient10} messages per 10 minutes per visitor` },
    { key: "chat:all", limit: global1h, windowMs: HOUR, label: `${global1h} messages per hour across the demo` },
  ];
  if (benchmark) {
    const b = intEnv(env, "CONSOLIDATE_BENCHMARK_LIMIT_PER_HOUR", 3);
    rules.push({ key: `bench:ip:${ip}`, limit: b, windowMs: HOUR, label: `${b} benchmark runs per hour per visitor` }, { key: "bench:all", limit: b * 2, windowMs: HOUR, label: `${b * 2} benchmark runs per hour across the demo` });
  }
  return rules;
}

export const loginRules = (ip: string): Rule[] => [
  { key: `login:ip:${ip}`, limit: 8, windowMs: MIN10, label: "8 sign-in attempts per 10 minutes" },
  { key: "login:all", limit: 40, windowMs: MIN10, label: "40 sign-in attempts per 10 minutes across the demo" },
];

export function rateLimited(r: Extract<RateResult, { ok: false }>, what = "requests"): Response {
  return Response.json(
    { error: `Rate limit reached (${r.label}). Try again in ${r.retryAfterSec} second${r.retryAfterSec === 1 ? "" : "s"}.`, code: "rate_limit", retryAfterSec: r.retryAfterSec, what },
    { status: 429, headers: { "Retry-After": String(r.retryAfterSec), "Cache-Control": "no-store" } },
  );
}
