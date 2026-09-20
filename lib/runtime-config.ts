// Deployment configuration rules. Pure functions of an environment object (defaulting to process.env) so every rule is
// unit-testable, and nothing here reads, logs or returns a secret's VALUE.
import { isAbsolute, relative, resolve } from "node:path";

export type Env = Record<string, string | undefined>;

export const isProduction = (env: Env = process.env) => env.NODE_ENV === "production";

// Developer controls (failure injection) exist only outside production, even if the flag is set by mistake on a server.
export const devToolsEnabled = (env: Env = process.env) => env.CONSOLIDATE_DEV_TOOLS === "1" && env.NODE_ENV !== "production";

// Positive-integer env var with a default; invalid values fall back to the default (production validation reports them).
export function intEnv(env: Env, name: string, fallback: number): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

// The most tokens a single model request may carry. A request above it is refused before any paid generation; nothing is
// truncated and no protected context is dropped to make it fit.
export const DEFAULT_MAX_REQUEST_TOKENS = 100_000;
export const maxRequestTokens = (env: Env = process.env) => intEnv(env, "CONSOLIDATE_MAX_REQUEST_TOKENS", DEFAULT_MAX_REQUEST_TOKENS);

export const MIN_PASSWORD_LENGTH = 8;
const INT_VARS = ["CONSOLIDATE_MAX_REQUEST_TOKENS", "CONSOLIDATE_CHAT_LIMIT_PER_10_MIN", "CONSOLIDATE_CHAT_LIMIT_PER_HOUR", "CONSOLIDATE_BENCHMARK_LIMIT_PER_HOUR", "CONSOLIDATE_SESSION_HOURS"];
const onRailway = (env: Env) => !!(env.RAILWAY_ENVIRONMENT_NAME || env.RAILWAY_ENVIRONMENT || env.RAILWAY_PROJECT_ID);
const blank = (v: string | undefined) => !v || !v.trim();

export class ProductionConfigError extends Error {
  readonly code = "config";
  constructor(public issues: string[]) {
    super(`Consolidate is misconfigured for production:\n - ${issues.join("\n - ")}`);
  }
}

// Everything a production server must have before it accepts a request. Messages name variables, never values.
export function productionConfigIssues(env: Env = process.env): string[] {
  if (!isProduction(env)) return [];
  const issues: string[] = [];
  const provider = env.MODEL_PROVIDER?.trim() || "";
  if (provider !== "anthropic-api") {
    issues.push(`MODEL_PROVIDER is ${provider ? `"${provider}"` : "not set"}; production requires MODEL_PROVIDER=anthropic-api (the local Claude Code CLI cannot run on a server).`);
  }
  for (const name of ["ANTHROPIC_API_KEY", "ANTHROPIC_MODEL", "ANTHROPIC_UTILITY_MODEL"]) if (blank(env[name])) issues.push(`${name} is required.`);
  const pw = env.CONSOLIDATE_DEMO_PASSWORD ?? "";
  if (blank(pw)) issues.push("CONSOLIDATE_DEMO_PASSWORD is required (the public URL spends API credits and holds conversation data).");
  else if (pw.trim().length < MIN_PASSWORD_LENGTH) issues.push(`CONSOLIDATE_DEMO_PASSWORD must be at least ${MIN_PASSWORD_LENGTH} characters.`);

  const db = env.CONSOLIDATE_DB_PATH?.trim();
  if (!db) issues.push("CONSOLIDATE_DB_PATH is required (for example /data/consolidate.db on a persistent volume).");
  else if (!isAbsolute(db)) issues.push("CONSOLIDATE_DB_PATH must be an absolute path on the persistent volume.");
  else if (onRailway(env) && env.CONSOLIDATE_ALLOW_EPHEMERAL_DB !== "1") {
    // On Railway the database must live on an attached volume, or every redeploy silently wipes it.
    const mount = env.RAILWAY_VOLUME_MOUNT_PATH?.trim();
    if (!mount) issues.push("No Railway volume is attached to this service, so the database would be erased on every deploy. Add a volume mounted at /data (or set CONSOLIDATE_ALLOW_EPHEMERAL_DB=1 to accept data loss).");
    else {
      const rel = relative(resolve(mount), resolve(db));
      if (rel.startsWith("..") || isAbsolute(rel)) issues.push(`CONSOLIDATE_DB_PATH is not inside the attached volume (${mount}); the database would not persist.`);
    }
  }
  for (const name of INT_VARS) {
    const raw = env[name]?.trim();
    if (raw && !(Number.isInteger(Number(raw)) && Number(raw) > 0)) issues.push(`${name} must be a positive integer.`);
  }
  return issues;
}

export function assertProductionConfig(env: Env = process.env): void {
  const issues = productionConfigIssues(env);
  if (issues.length) throw new ProductionConfigError(issues);
}
