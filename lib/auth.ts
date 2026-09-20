// Shared-password demo authentication: one demo account, no signup, no OAuth.
//
// A successful login sets an HTTP-only, SameSite=Strict (and Secure in production) cookie holding a signed expiry:
//   v1.<expiresAtMs>.<hex HMAC-SHA256>
// Sessions are stateless (no session table) and every check runs in the Node runtime, in each route handler and in the
// page itself, so nothing depends on a proxy layer or shared module state. The signing key is derived from
// CONSOLIDATE_SESSION_SECRET when set, otherwise from the demo password (so rotating the password signs everyone out).
// The password is only ever read on the server and is never sent to the browser.
import "server-only";
import { createHash, createHmac, scryptSync, timingSafeEqual } from "node:crypto";
import { intEnv, isProduction, type Env } from "./runtime-config";

export const SESSION_COOKIE = "consolidate_session";
const DEFAULT_SESSION_HOURS = 12;

const password = (env: Env) => env.CONSOLIDATE_DEMO_PASSWORD?.trim() || "";

// Auth is mandatory in production (a missing password then locks everything, it never opens it) and opt-in locally.
export const authRequired = (env: Env = process.env) => isProduction(env) || password(env) !== "";

export const sessionSeconds = (env: Env = process.env) => intEnv(env, "CONSOLIDATE_SESSION_HOURS", DEFAULT_SESSION_HOURS) * 3600;

let keyCache: { base: string; key: Buffer } | null = null;
function signingKey(env: Env): Buffer | null {
  const base = env.CONSOLIDATE_SESSION_SECRET?.trim() || password(env);
  if (!base) return null; // no password configured: no session can be valid
  if (keyCache?.base !== base) keyCache = { base, key: scryptSync(base, "consolidate-session-v1", 32) };
  return keyCache.key;
}

const digest = (s: string) => createHash("sha256").update(s).digest();

// Constant-time comparison of the submitted password with the configured one.
export function passwordMatches(input: unknown, env: Env = process.env): boolean {
  const expected = password(env);
  if (!expected || typeof input !== "string") return false;
  return timingSafeEqual(digest(input), digest(expected));
}

const sign = (key: Buffer, payload: string) => createHmac("sha256", key).update(payload).digest("hex");

export function createSessionToken(env: Env = process.env, now = Date.now()): string | null {
  const key = signingKey(env);
  if (!key) return null;
  const payload = `v1.${now + sessionSeconds(env) * 1000}`;
  return `${payload}.${sign(key, payload)}`;
}

export function verifySessionToken(token: string | null | undefined, env: Env = process.env, now = Date.now()): boolean {
  const key = signingKey(env);
  if (!key || !token) return false;
  const m = /^(v1\.(\d{10,16}))\.([0-9a-f]{64})$/.exec(token);
  if (!m || Number(m[2]) <= now) return false;
  const good = Buffer.from(sign(key, m[1]), "hex");
  const given = Buffer.from(m[3], "hex");
  return good.length === given.length && timingSafeEqual(good, given);
}

export function cookieValue(header: string | null, name: string): string | null {
  for (const part of (header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

const attrs = (env: Env) => `Path=/; HttpOnly; SameSite=Strict${isProduction(env) ? "; Secure" : ""}`;
export const sessionCookie = (token: string, env: Env = process.env) => `${SESSION_COOKIE}=${token}; ${attrs(env)}; Max-Age=${sessionSeconds(env)}`;
export const clearedSessionCookie = (env: Env = process.env) => `${SESSION_COOKIE}=; ${attrs(env)}; Max-Age=0`;

export function isAuthenticatedRequest(req: Request, env: Env = process.env): boolean {
  if (!authRequired(env)) return true;
  return verifySessionToken(cookieValue(req.headers.get("cookie"), SESSION_COOKIE), env);
}

// Route handlers call this first: null means "proceed", otherwise return the 401.
export function requireAuth(req: Request, env: Env = process.env): Response | null {
  if (isAuthenticatedRequest(req, env)) return null;
  return Response.json({ error: "Sign in required.", code: "unauthorized" }, { status: 401, headers: { "Cache-Control": "no-store" } });
}
