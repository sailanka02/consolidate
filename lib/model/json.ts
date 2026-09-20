// Structured (JSON) utility calls through any ModelProvider. Used by the semantic steps of the pipeline.
import { usageCost } from "./pricing";
import { ProviderError, type ModelProvider, type ModelResult } from "./types";
import type { UtilityCall, UtilityKind } from "../types";

// Pull the first JSON object out of a model reply (tolerates code fences and stray prose).
export function extractJson(text: string): unknown {
  const src = text.replace(/```(?:json)?/gi, "");
  // Scan for the first balanced {...} object (string-aware), so trailing prose or a second object is ignored.
  for (let start = src.indexOf("{"); start !== -1; start = src.indexOf("{", start + 1)) {
    let depth = 0;
    let inStr = false;
    for (let i = start; i < src.length; i++) {
      const ch = src[i];
      if (inStr) {
        if (ch === "\\") i++;
        else if (ch === '"') inStr = false;
      } else if (ch === '"') inStr = true;
      else if (ch === "{") depth++;
      else if (ch === "}" && --depth === 0) {
        try {
          return JSON.parse(src.slice(start, i + 1));
        } catch {
          break; // not valid JSON from this start; try the next "{"
        }
      }
    }
  }
  throw new ProviderError("malformed", "Model reply contained no JSON object.");
}

export async function generateJson<T>(
  provider: ModelProvider,
  kind: UtilityKind,
  purpose: string,
  prompt: string,
  parse: (raw: unknown) => T,
  timeoutMs = 120_000,
): Promise<{ value: T | null; call: UtilityCall }> {
  const started = performance.now();
  let r: ModelResult | undefined;
  try {
    r = await provider.generate({ mode: "raw", context: [], request: prompt, timeoutMs, tier: "utility" });
    const value = parse(extractJson(r.response));
    return { value, call: callRecord(kind, purpose, r, true) };
  } catch (e) {
    // A reply that arrived but could not be parsed was still billed: keep its usage and cost.
    const base = r ? callRecord(kind, purpose, r, false) : { kind, purpose, ok: false, latencyMs: Math.round(performance.now() - started) };
    return { value: null, call: { ...base, error: e instanceof Error ? e.message.slice(0, 200) : "unknown error" } };
  }
}

function callRecord(kind: UtilityKind, purpose: string, r: ModelResult, ok: boolean): UtilityCall {
  const u = r.usage;
  return {
    kind,
    purpose,
    ok,
    latencyMs: r.latencyMs,
    model: r.model,
    inputTokens: u?.inputTokens,
    outputTokens: u?.outputTokens,
    cacheCreationInputTokens: u?.cacheCreationInputTokens,
    cacheReadInputTokens: u?.cacheReadInputTokens,
    costUsd: u && r.apiBilled ? usageCost(r.model, u) : undefined,
  };
}
