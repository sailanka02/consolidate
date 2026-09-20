// Server-side composition root: the database connection and the model provider used by the API routes.
import "server-only";
import { getDb } from "./db";
import { getProvider, ProviderError } from "./model";
import { TurnError } from "./engine/turn";
import { assertProductionConfig, devToolsEnabled as devFlag, ProductionConfigError } from "./runtime-config";

let validated = false;
// Production refuses to serve model requests unless its configuration is complete (instrumentation.ts checks at startup;
// this is the same check as a second line of defence). Local development is unaffected.
export const runtime = () => {
  if (!validated) {
    assertProductionConfig();
    validated = true;
  }
  return { db: getDb(), provider: getProvider() };
};

// Failure injection: never in production, whatever the flag says (see runtime-config.ts).
export const devToolsEnabled = () => devFlag();

// The only place a request's developer-only fields are honoured.
export function devForceFailure(body: { forceEvalFailure?: unknown } | null, env: Record<string, string | undefined> = process.env): "optimized" | "all" | undefined {
  const v = body?.forceEvalFailure;
  return devFlag(env) && (v === "optimized" || v === "all") ? v : undefined;
}

const STATUS: Record<string, number> = { busy: 409, not_found: 404, invalid: 400, internal: 500, rate_limit: 429, credits: 402, timeout: 504, unauthorized: 401, too_large: 413, config: 503 };

export function errorResponse(e: unknown) {
  if (e instanceof ProductionConfigError) return Response.json({ error: e.message, code: "config" }, { status: 503 });
  if (e instanceof TurnError || e instanceof ProviderError) return Response.json({ error: e.message, code: e.code }, { status: STATUS[e.code] ?? 503 });
  return Response.json({ error: e instanceof Error ? e.message : "Unexpected error", code: "internal" }, { status: 500 });
}
