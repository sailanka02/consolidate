// Production configuration rules, dev-tool lockout, rate limiting, the request-size guard, the health failure path and railway.toml.
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as loginPOST } from "@/app/api/auth/login/route";
import { GET as configGET } from "@/app/api/config/route";
import { POST as messagePOST } from "@/app/api/conversations/[id]/messages/route";
import { createSessionToken, SESSION_COOKIE } from "@/lib/auth";
import { openDatabase } from "@/lib/db";
import * as repo from "@/lib/db/repo";
import { runTurn, TurnError } from "@/lib/engine/turn";
import { checkRate, clientIp, generationRules, rateLimited, resetRateLimits } from "@/lib/ratelimit";
import { assertProductionConfig, DEFAULT_MAX_REQUEST_TOKENS, devToolsEnabled, maxRequestTokens, ProductionConfigError, productionConfigIssues } from "@/lib/runtime-config";
import { devForceFailure, errorResponse } from "@/lib/server";
import { FakeProvider } from "./helpers";

const GOOD = {
  NODE_ENV: "production",
  MODEL_PROVIDER: "anthropic-api",
  ANTHROPIC_API_KEY: "sk-ant-test-secret-value",
  ANTHROPIC_MODEL: "claude-sonnet-5",
  ANTHROPIC_UTILITY_MODEL: "claude-haiku-4-5",
  CONSOLIDATE_DB_PATH: "/data/consolidate.db",
  CONSOLIDATE_DEMO_PASSWORD: "a-long-demo-password",
};

describe("production configuration", () => {
  it("accepts a complete configuration", () => {
    expect(productionConfigIssues(GOOD)).toEqual([]);
    expect(() => assertProductionConfig(GOOD)).not.toThrow();
  });

  it("fails clearly with MODEL_PROVIDER=claude-code (or unset)", () => {
    for (const provider of ["claude-code", undefined, ""]) {
      const issues = productionConfigIssues({ ...GOOD, MODEL_PROVIDER: provider });
      expect(issues.join(" ")).toMatch(/MODEL_PROVIDER.*production requires MODEL_PROVIDER=anthropic-api/);
    }
    expect(() => assertProductionConfig({ ...GOOD, MODEL_PROVIDER: "claude-code" })).toThrow(ProductionConfigError);
  });

  it("requires the key, both models, the password (min length) and an absolute database path", () => {
    for (const [name, msg] of [["ANTHROPIC_API_KEY", /ANTHROPIC_API_KEY is required/], ["ANTHROPIC_MODEL", /ANTHROPIC_MODEL is required/], ["ANTHROPIC_UTILITY_MODEL", /ANTHROPIC_UTILITY_MODEL is required/], ["CONSOLIDATE_DEMO_PASSWORD", /CONSOLIDATE_DEMO_PASSWORD is required/], ["CONSOLIDATE_DB_PATH", /CONSOLIDATE_DB_PATH is required/]] as const) {
      expect(productionConfigIssues({ ...GOOD, [name]: undefined }).join(" ")).toMatch(msg);
      expect(productionConfigIssues({ ...GOOD, [name]: "   " }).join(" ")).toMatch(msg);
    }
    expect(productionConfigIssues({ ...GOOD, CONSOLIDATE_DEMO_PASSWORD: "short" }).join(" ")).toMatch(/at least 8 characters/);
    expect(productionConfigIssues({ ...GOOD, CONSOLIDATE_DB_PATH: "data/x.db" }).join(" ")).toMatch(/absolute path/);
    expect(productionConfigIssues({ ...GOOD, CONSOLIDATE_MAX_REQUEST_TOKENS: "lots" }).join(" ")).toMatch(/CONSOLIDATE_MAX_REQUEST_TOKENS must be a positive integer/);
  });

  it("reports every problem at once and never prints a secret value", () => {
    const env = { ...GOOD, MODEL_PROVIDER: "claude-code", CONSOLIDATE_DEMO_PASSWORD: "short", ANTHROPIC_MODEL: undefined };
    let message = "";
    try {
      assertProductionConfig(env);
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/MODEL_PROVIDER/);
    expect(message).toMatch(/CONSOLIDATE_DEMO_PASSWORD/);
    expect(message).toMatch(/ANTHROPIC_MODEL/);
    expect(message).not.toContain("sk-ant-test-secret-value"); // the API key value is never printed
    expect(message).not.toMatch(/=\s*short\b/); // nor is the rejected password
  });

  it("does nothing outside production (local development keeps working)", () => {
    expect(productionConfigIssues({ NODE_ENV: "development", MODEL_PROVIDER: "claude-code" })).toEqual([]);
    expect(productionConfigIssues({})).toEqual([]);
  });

  describe("Railway: the database must be on an attached volume", () => {
    const railway = { ...GOOD, RAILWAY_ENVIRONMENT_NAME: "production" };
    it("refuses to start with no volume, or a database outside it", () => {
      expect(productionConfigIssues(railway).join(" ")).toMatch(/No Railway volume is attached/);
      expect(productionConfigIssues({ ...railway, RAILWAY_VOLUME_MOUNT_PATH: "/data", CONSOLIDATE_DB_PATH: "/app/consolidate.db" }).join(" ")).toMatch(/not inside the attached volume/);
      expect(productionConfigIssues({ ...railway, RAILWAY_VOLUME_MOUNT_PATH: "/data", CONSOLIDATE_DB_PATH: "/data/../tmp/x.db" }).join(" ")).toMatch(/not inside the attached volume/);
    });
    it("accepts a database inside the volume, and an explicit ephemeral override", () => {
      expect(productionConfigIssues({ ...railway, RAILWAY_VOLUME_MOUNT_PATH: "/data" })).toEqual([]);
      expect(productionConfigIssues({ ...railway, RAILWAY_VOLUME_MOUNT_PATH: "/data/" })).toEqual([]);
      expect(productionConfigIssues({ ...railway, CONSOLIDATE_ALLOW_EPHEMERAL_DB: "1" })).toEqual([]);
    });
  });
});

describe("developer tools can never appear in production", () => {
  afterEach(() => vi.unstubAllEnvs());
  it("needs the flag AND a non-production environment", () => {
    expect(devToolsEnabled({ NODE_ENV: "development", CONSOLIDATE_DEV_TOOLS: "1" })).toBe(true);
    expect(devToolsEnabled({ NODE_ENV: "development", CONSOLIDATE_DEV_TOOLS: "0" })).toBe(false);
    expect(devToolsEnabled({ NODE_ENV: "development" })).toBe(false);
    expect(devToolsEnabled({ NODE_ENV: "production", CONSOLIDATE_DEV_TOOLS: "1" })).toBe(false); // set by mistake on the server
  });
  it("failure injection in a request body is ignored in production", () => {
    const body = { forceEvalFailure: "all" };
    expect(devForceFailure(body, { NODE_ENV: "development", CONSOLIDATE_DEV_TOOLS: "1" })).toBe("all");
    expect(devForceFailure(body, { NODE_ENV: "production", CONSOLIDATE_DEV_TOOLS: "1" })).toBeUndefined();
    expect(devForceFailure({ forceEvalFailure: "bogus" }, { NODE_ENV: "development", CONSOLIDATE_DEV_TOOLS: "1" })).toBeUndefined();
  });
  it("/api/config reports devTools:false in production even with the flag set, so the UI never renders the control", async () => {
    vi.stubEnv("CONSOLIDATE_DEMO_PASSWORD", "a-long-demo-password");
    vi.stubEnv("CONSOLIDATE_DEV_TOOLS", "1");
    const cookie = `${SESSION_COOKIE}=${createSessionToken()!}`;
    expect((await (await configGET(new Request("http://x/api/config", { headers: { cookie } }))).json()).devTools).toBe(true); // vitest runs with NODE_ENV=test
    vi.stubEnv("NODE_ENV", "production");
    const prod = await (await configGET(new Request("http://x/api/config", { headers: { cookie: `${SESSION_COOKIE}=${createSessionToken()!}` } }))).json();
    expect(prod.devTools).toBe(false);
  });
});

describe("rate limits", () => {
  beforeEach(() => resetRateLimits());
  afterEach(() => vi.unstubAllEnvs());
  const send = (ip: string, benchmark = false, now = 0) => checkRate(generationRules(ip, benchmark, {}), now);

  it("limits ordinary messages per visitor (20 per 10 minutes) and recovers when the window passes", () => {
    for (let i = 0; i < 20; i++) expect(send("a", false, i * 1000).ok).toBe(true);
    const blocked = send("a", false, 21_000);
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.retryAfterSec).toBeGreaterThan(0);
    expect(send("b", false, 21_000).ok).toBe(true); // another visitor is unaffected
    expect(send("a", false, 10 * 60_000 + 5000).ok).toBe(true); // the window slid
  });

  it("a global cap bounds total spend even when a client rotates addresses", () => {
    let ok = 0;
    for (let i = 0; i < 200; i++) if (send(`ip-${i}`, false, i).ok) ok++;
    expect(ok).toBe(120);
  });

  it("benchmark mode is much stricter (3 per visitor per hour, 6 in total) and also counts as a message", () => {
    expect([1, 2, 3].map(() => send("a", true).ok)).toEqual([true, true, true]);
    expect(send("a", true).ok).toBe(false);
    expect(send("a", false).ok).toBe(true); // ordinary chat is still available
    for (const ip of ["b", "c"]) for (let i = 0; i < 3; i++) send(ip, true);
    expect(send("d", true).ok).toBe(false); // the demo-wide benchmark cap (6) is reached
  });

  it("a refused request is not counted, and env variables tune the limits", () => {
    const rules = generationRules("z", false, { CONSOLIDATE_CHAT_LIMIT_PER_10_MIN: "2" });
    expect([checkRate(rules, 0).ok, checkRate(rules, 1).ok, checkRate(rules, 2).ok, checkRate(rules, 3).ok]).toEqual([true, true, false, false]);
    expect(checkRate(rules, 10 * 60_000 + 1).ok).toBe(true); // only the 2 admitted requests were recorded
  });

  it("answers 429 with Retry-After", async () => {
    const r = { ok: false as const, retryAfterSec: 42, label: "3 benchmark runs per hour per visitor" };
    const res = rateLimited(r);
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("42");
    expect(await res.json()).toMatchObject({ code: "rate_limit", retryAfterSec: 42 });
  });

  it("client address comes from X-Forwarded-For (first entry), else X-Real-IP", () => {
    expect(clientIp(new Request("http://x", { headers: { "x-forwarded-for": "1.1.1.1, 10.0.0.1" } }))).toBe("1.1.1.1");
    expect(clientIp(new Request("http://x", { headers: { "x-real-ip": "2.2.2.2" } }))).toBe("2.2.2.2");
    expect(clientIp(new Request("http://x"))).toBe("local");
  });

  it("the messages route enforces the benchmark limit before any model work (no spend is possible)", async () => {
    vi.stubEnv("CONSOLIDATE_DB_PATH", join(mkdtempSync(join(tmpdir(), "consolidate-rl-")), "t.db"));
    vi.stubEnv("CONSOLIDATE_DEMO_PASSWORD", "a-long-demo-password");
    const cookie = `${SESSION_COOKIE}=${createSessionToken()!}`;
    const post = (benchmark: boolean) => messagePOST(new Request("http://x/api/conversations/nope/messages", { method: "POST", headers: { cookie, "x-forwarded-for": "7.7.7.7" }, body: JSON.stringify({ content: "hi", benchmark }) }), { params: Promise.resolve({ id: "nope" }) } as never);
    const statuses = [];
    for (let i = 0; i < 4; i++) statuses.push((await post(true)).status);
    expect(statuses).toEqual([404, 404, 404, 429]); // the conversation does not exist, so nothing reached a model; the 4th is refused first
    const limited = await post(true);
    expect(limited.status).toBe(429);
    expect((await limited.json()).error).toMatch(/benchmark runs per hour/);
    vi.stubEnv("CONSOLIDATE_CHAT_LIMIT_PER_10_MIN", "1");
    resetRateLimits();
    expect([(await post(false)).status, (await post(false)).status]).toEqual([404, 429]);
  });

  it("sign-in attempts are limited too (see auth tests); loginPOST is exported", () => expect(typeof loginPOST).toBe("function"));
});

describe("request-size guard: refuse before paid generation, never truncate", () => {
  const isRaw = (r: { mode?: string }) => r.mode === "raw";
  const setup = (count?: number) => {
    const db = openDatabase(":memory:");
    const convId = repo.createConversation(db).id;
    const p = new FakeProvider((req) => (isRaw(req) ? "{}" : "an answer"), count === undefined ? {} : { api: { count: () => count } });
    return { db, convId, p };
  };
  afterEach(() => vi.unstubAllEnvs());

  it("defaults to 100,000 tokens and reads CONSOLIDATE_MAX_REQUEST_TOKENS", () => {
    expect(maxRequestTokens({})).toBe(DEFAULT_MAX_REQUEST_TOKENS);
    expect(maxRequestTokens({ CONSOLIDATE_MAX_REQUEST_TOKENS: "5000" })).toBe(5000);
    expect(maxRequestTokens({ CONSOLIDATE_MAX_REQUEST_TOKENS: "-3" })).toBe(DEFAULT_MAX_REQUEST_TOKENS);
  });

  it("an over-limit provider count fails before any generation, saves nothing, and says so plainly", async () => {
    const { db, convId, p } = setup(250_000);
    const err = await runTurn(db, p, { conversationId: convId, content: "Never delete the audit log. Please summarize our plan." }).catch((e) => e);
    expect(err).toBeInstanceOf(TurnError);
    expect(err.code).toBe("too_large");
    expect(err.message).toMatch(/250,000 tokens/);
    expect(err.message).toMatch(/CONSOLIDATE_MAX_REQUEST_TOKENS/);
    expect(err.message).toMatch(/no context was removed or shortened/i);
    expect(p.calls.filter((c) => !isRaw(c))).toHaveLength(0); // the paid generation never happened
    expect(repo.listMessages(db, convId)).toHaveLength(0); // nothing half-saved
    const res = errorResponse(err);
    expect(res.status).toBe(413);
  });

  it("uses the local estimate when the provider cannot count, and passes normal requests", async () => {
    vi.stubEnv("CONSOLIDATE_MAX_REQUEST_TOKENS", "20");
    const a = setup();
    await expect(runTurn(a.db, a.p, { conversationId: a.convId, content: "x".repeat(400) })).rejects.toMatchObject({ code: "too_large" });
    vi.unstubAllEnvs();
    const b = setup(300);
    const out = await runTurn(b.db, b.p, { conversationId: b.convId, content: "Hello there." });
    expect(out.assistantMessage.content).toBe("an answer");
  });
});

describe("health endpoint failure path", () => {
  it("returns 503 with no detail when the database is unavailable", async () => {
    vi.resetModules();
    vi.doMock("@/lib/db", () => ({ getDb: () => { throw new Error("SQLITE_CANTOPEN /data/consolidate.db secret-detail"); } }));
    const { GET } = await import("@/app/api/health/route");
    const res = await GET();
    expect(res.status).toBe(503);
    const text = JSON.stringify(await res.json());
    expect(text).toBe('{"status":"error","database":"error"}');
    vi.doUnmock("@/lib/db");
  });
});

describe("Railway files", () => {
  it("railway.toml sets the healthcheck, one replica and the start command", () => {
    const toml = readFileSync("railway.toml", "utf8");
    expect(toml).toMatch(/^healthcheckPath = "\/api\/health"/m);
    expect(toml).toMatch(/^numReplicas = 1\b/m);
    expect(toml).toMatch(/^startCommand = "npm start"/m);
    expect(existsSync(".node-version")).toBe(true);
    expect(Number(readFileSync(".node-version", "utf8").trim().split(".")[0])).toBeGreaterThanOrEqual(22);
  });
  it(".env.example documents every required variable with no secret values, and dev tools off", () => {
    const env = readFileSync(".env.example", "utf8");
    for (const name of ["MODEL_PROVIDER=anthropic-api", "ANTHROPIC_API_KEY=", "ANTHROPIC_MODEL=claude-sonnet-5", "ANTHROPIC_UTILITY_MODEL=claude-haiku-4-5", "CONSOLIDATE_DB_PATH=/data/consolidate.db", "CONSOLIDATE_DEMO_PASSWORD=", "CONSOLIDATE_DEV_TOOLS=0", "CONSOLIDATE_ECONOMICS_MARGIN=1.5"]) {
      expect(env.split("\n"), name).toContain(name);
    }
    expect(env).not.toMatch(/sk-ant-/);
  });
});
