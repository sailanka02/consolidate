// Demo authentication: signed HTTP-only session cookie, every data route protected, login page gated on the server.
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as configGET } from "@/app/api/config/route";
import { GET as convListGET, POST as convCreatePOST } from "@/app/api/conversations/route";
import { DELETE as convDELETE, GET as convGET } from "@/app/api/conversations/[id]/route";
import { POST as messagePOST } from "@/app/api/conversations/[id]/messages/route";
import { GET as dashboardGET } from "@/app/api/dashboard/route";
import { GET as healthGET } from "@/app/api/health/route";
import { POST as loginPOST } from "@/app/api/auth/login/route";
import { POST as logoutPOST } from "@/app/api/auth/logout/route";
import { GET as runGET } from "@/app/api/runs/[id]/route";
import LoginScreen from "@/components/LoginScreen";
import AppShell from "@/components/AppShell";
import { authRequired, cookieValue, createSessionToken, passwordMatches, requireAuth, SESSION_COOKIE, verifySessionToken } from "@/lib/auth";
import { resetRateLimits } from "@/lib/ratelimit";

const PASSWORD = "correct horse battery staple";
const url = (p: string, init?: RequestInit) => new Request(`http://demo.test${p}`, init);
const ctx = (id = "x") => ({ params: Promise.resolve({ id }) }) as never;
const cookieFor = (env = process.env) => `${SESSION_COOKIE}=${createSessionToken(env)!}`;

beforeAll(() => {
  vi.stubEnv("CONSOLIDATE_DB_PATH", join(mkdtempSync(join(tmpdir(), "consolidate-auth-")), "test.db"));
});
beforeEach(() => {
  vi.stubEnv("CONSOLIDATE_DEMO_PASSWORD", PASSWORD);
  resetRateLimits();
});
afterEach(() => vi.unstubAllEnvs());

describe("session tokens", () => {
  it("round-trips, and rejects tampering, expiry, other keys and garbage", () => {
    const now = Date.now();
    const t = createSessionToken(process.env, now)!;
    expect(verifySessionToken(t, process.env, now + 1000)).toBe(true);
    expect(verifySessionToken(t, process.env, now + 13 * 3600 * 1000)).toBe(false); // expired (12h default)
    const [v, exp, sig] = t.split(".");
    expect(verifySessionToken(`${v}.${Number(exp) + 3_600_000}.${sig}`, process.env, now)).toBe(false); // extended expiry
    expect(verifySessionToken(`${v}.${exp}.${"0".repeat(64)}`, process.env, now)).toBe(false);
    for (const junk of ["", "abc", "v1.1.2", null, undefined]) expect(verifySessionToken(junk as never, process.env, now)).toBe(false);
    vi.stubEnv("CONSOLIDATE_DEMO_PASSWORD", "a different password entirely");
    expect(verifySessionToken(t, process.env, now + 1000)).toBe(false); // rotating the password signs everyone out
  });

  it("uses CONSOLIDATE_SESSION_SECRET when provided", () => {
    vi.stubEnv("CONSOLIDATE_SESSION_SECRET", "s3cret-signing-key");
    const t = createSessionToken()!;
    expect(verifySessionToken(t)).toBe(true);
    vi.stubEnv("CONSOLIDATE_DEMO_PASSWORD", "rotated but secret unchanged");
    expect(verifySessionToken(t)).toBe(true);
  });

  it("compares passwords without accepting near matches or non-strings", () => {
    expect(passwordMatches(PASSWORD)).toBe(true);
    for (const bad of ["", PASSWORD + " ", PASSWORD.toUpperCase(), undefined, 123, null]) expect(passwordMatches(bad as never)).toBe(false);
    vi.stubEnv("CONSOLIDATE_DEMO_PASSWORD", "");
    expect(passwordMatches("")).toBe(false); // no configured password never matches anything
  });

  it("parses cookies", () => {
    expect(cookieValue("a=1; consolidate_session=abc; b=2", SESSION_COOKIE)).toBe("abc");
    expect(cookieValue(null, SESSION_COOKIE)).toBeNull();
    expect(cookieValue("consolidate_sessionX=abc", SESSION_COOKIE)).toBeNull();
  });
});

describe("requireAuth", () => {
  it("blocks without a session, allows with one", () => {
    expect(requireAuth(url("/api/x"))!.status).toBe(401);
    expect(requireAuth(url("/api/x", { headers: { cookie: "consolidate_session=forged" } }))!.status).toBe(401);
    expect(requireAuth(url("/api/x", { headers: { cookie: cookieFor() } }))).toBeNull();
  });
  it("is off in local development without a password, and fails CLOSED in production without one", () => {
    vi.stubEnv("CONSOLIDATE_DEMO_PASSWORD", "");
    expect(authRequired()).toBe(false);
    expect(requireAuth(url("/api/x"))).toBeNull();
    vi.stubEnv("NODE_ENV", "production");
    expect(authRequired()).toBe(true);
    expect(requireAuth(url("/api/x", { headers: { cookie: "consolidate_session=anything" } }))!.status).toBe(401);
  });
});

describe("every route that exposes data or spends money rejects an unauthenticated request", () => {
  const cases: [string, () => Promise<Response>][] = [
    ["GET /api/conversations", () => convListGET(url("/api/conversations"))],
    ["POST /api/conversations", () => convCreatePOST(url("/api/conversations", { method: "POST" }))],
    ["GET /api/conversations/:id", () => convGET(url("/api/conversations/x"), ctx())],
    ["DELETE /api/conversations/:id", () => convDELETE(url("/api/conversations/x", { method: "DELETE" }), ctx())],
    ["POST /api/conversations/:id/messages", () => messagePOST(url("/api/conversations/x/messages", { method: "POST", body: JSON.stringify({ content: "hi" }) }), ctx())],
    ["POST messages (benchmark)", () => messagePOST(url("/api/conversations/x/messages", { method: "POST", body: JSON.stringify({ content: "hi", benchmark: true }) }), ctx())],
    ["GET /api/runs/:id", () => runGET(url("/api/runs/x"), ctx())],
    ["GET /api/dashboard", () => dashboardGET(url("/api/dashboard"))],
    ["GET /api/config", () => configGET(url("/api/config"))],
  ];
  it.each(cases)("%s -> 401", async (_name, call) => {
    const res = await call();
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ code: "unauthorized" });
  });

  it("the same routes work with a valid session (data is served, not just the gate)", async () => {
    const h = { headers: { cookie: cookieFor() } };
    const created = await convCreatePOST(url("/api/conversations", { method: "POST", ...h }));
    expect(created.status).toBe(201);
    const { conversation } = await created.json();
    expect((await (await convListGET(url("/api/conversations", h))).json()).conversations.map((c: { id: string }) => c.id)).toContain(conversation.id);
    expect((await convGET(url("/api/conversations/" + conversation.id, h), ctx(conversation.id))).status).toBe(200);
    expect((await dashboardGET(url("/api/dashboard", h))).status).toBe(200);
    expect((await configGET(url("/api/config", h))).status).toBe(200);
    expect((await runGET(url("/api/runs/none", h), ctx("none"))).status).toBe(404);
    expect((await convDELETE(url("/api/conversations/" + conversation.id, { method: "DELETE", ...h }), ctx(conversation.id))).status).toBe(200);
  });
});

describe("login and logout", () => {
  const login = (password: unknown, ip = "1.2.3.4") => loginPOST(url("/api/auth/login", { method: "POST", headers: { "x-forwarded-for": ip }, body: JSON.stringify({ password }) }));

  it("a wrong password fails and sets no cookie", async () => {
    const res = await login("nope");
    expect(res.status).toBe(401);
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("the right password sets an HTTP-only, SameSite=Strict, expiring cookie that authenticates later requests", async () => {
    const res = await login(PASSWORD);
    expect(res.status).toBe(200);
    const set = res.headers.get("set-cookie")!;
    expect(set).toMatch(/^consolidate_session=v1\.\d+\.[0-9a-f]{64};/);
    expect(set).toContain("HttpOnly");
    expect(set).toContain("SameSite=Strict");
    expect(set).toContain("Path=/");
    expect(set).toMatch(/Max-Age=43200/); // 12 hours
    expect(set).not.toContain("Secure"); // local http; production below
    expect(JSON.stringify(await res.json())).not.toContain(PASSWORD);
    expect(set).not.toContain(PASSWORD);
    const token = /consolidate_session=([^;]+)/.exec(set)![1];
    expect(requireAuth(url("/api/x", { headers: { cookie: `consolidate_session=${token}` } }))).toBeNull();
  });

  it("the cookie is Secure in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    expect((await login(PASSWORD)).headers.get("set-cookie")).toContain("Secure");
    expect((await logoutPOST()).headers.get("set-cookie")).toMatch(/Secure/);
  });

  it("logout clears the cookie", async () => {
    const set = (await logoutPOST()).headers.get("set-cookie")!;
    expect(set).toMatch(/^consolidate_session=;/);
    expect(set).toContain("Max-Age=0");
    expect(set).toContain("HttpOnly");
  });

  it("repeated wrong passwords are rate limited (429 with Retry-After)", async () => {
    for (let i = 0; i < 8; i++) expect((await login("wrong", "9.9.9.9")).status).toBe(401);
    const blocked = await login(PASSWORD, "9.9.9.9"); // even the right password is refused during the lockout
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get("retry-after"))).toBeGreaterThan(0);
    expect((await login(PASSWORD, "8.8.8.8")).status).toBe(200); // another visitor is unaffected
  });
});

describe("health endpoint", () => {
  it("is public, touches only SQLite, and reveals nothing", async () => {
    const res = await healthGET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok", database: "ok" });
  });
});

describe("the page itself is gated on the server", () => {
  let token: string | undefined;
  beforeAll(() => {
    vi.doMock("next/headers", () => ({ cookies: async () => ({ get: (n: string) => (n === SESSION_COOKIE && token ? { value: token } : undefined) }) }));
  });
  it("shows the login screen without a session, and the app with one", async () => {
    const { default: Home } = await import("@/app/page");
    token = undefined;
    expect(((await Home()) as { type: unknown }).type).toBe(LoginScreen);
    token = "forged";
    expect(((await Home()) as { type: unknown }).type).toBe(LoginScreen);
    token = createSessionToken()!;
    expect(((await Home()) as { type: unknown; props: { authEnabled: boolean } }).type).toBe(AppShell);
    expect(((await Home()) as { props: { authEnabled: boolean } }).props.authEnabled).toBe(true);
  });
  it("the login screen contains a password field and no secret", () => {
    const html = renderToStaticMarkup(createElement(LoginScreen));
    expect(html).toContain('type="password"');
    expect(html).toContain("Sign in");
    expect(html).not.toContain(PASSWORD);
  });
});

describe("secrets never reach client code", () => {
  it("no component or page references the password, the API key, or server env", () => {
    const files = [...readdirSync("components").map((f) => join("components", f)), "app/page.tsx", "app/layout.tsx", "lib/client.ts", "lib/format.ts"];
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      expect(src, f).not.toMatch(/CONSOLIDATE_DEMO_PASSWORD|ANTHROPIC_API_KEY|CONSOLIDATE_SESSION_SECRET/);
      if (f.startsWith("components/")) expect(src, f).not.toMatch(/process\.env/);
    }
    expect(readFileSync(".env.example", "utf8")).not.toMatch(/^\s*NEXT_PUBLIC_\w+=/m); // never an exposed variable
  });
});
