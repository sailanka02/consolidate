// Deterministic evaluation layer. Works on any conversation: it verifies the compiled context against what the
// compiler itself decided and against what the request references. (The bounded semantic evaluator that judges
// the model's answer is in semantic.ts; the fallback policy that combines both lives in the engine.)
import { exactTokens } from "./text";
import { itemCoverage, tokenize } from "./relevance";
import type { CompileResult, EvalCheck, EvalResult, HistoryMessage, MemoryItem } from "../types";

const ok = (name: string, passed: boolean, reason: string): EvalCheck => ({ name, passed, reason, layer: "deterministic" });

// Every message reaches the compiled context through exactly one route (exact, memory, or compressed group).
function routedOnce(result: CompileResult, messages: HistoryMessage[]): boolean {
  const seen = new Map<string, number>();
  const bump = (id: string) => seen.set(id, (seen.get(id) ?? 0) + 1);
  result.decisions.filter((d) => d.action === "KEEP" || d.action === "RETRIEVE").forEach((d) => bump(d.id));
  result.decisions.filter((d) => d.action === "MEMORY").forEach((d) => bump(d.id));
  result.groups.forEach((g) => g.sourceIds.forEach(bump));
  return messages.every((m) => {
    const d = result.decisions.find((x) => x.id === m.id)!;
    return d.action === "OMIT" ? !seen.has(m.id) : seen.get(m.id) === 1;
  });
}

export function evaluateContext(result: CompileResult, messages: HistoryMessage[], memory: MemoryItem[], request: string): EvalResult {
  const byId = new Map(messages.map((m) => [m.id, m]));
  const compiled = new Map(result.compiledContext.map((c) => [c.id, c]));
  const compiledText = result.compiledContext.map((c) => c.content).join("\n").toLowerCase();
  const checks: EvalCheck[] = [];

  const protectedIds = result.decisions.filter((d) => d.protected).map((d) => d.id);
  const lost = protectedIds.filter((id) => compiled.get(id)?.content !== byId.get(id)!.content);
  checks.push(
    ok(
      "Protected context retained verbatim",
      lost.length === 0,
      lost.length ? `protected message(s) missing or altered: ${lost.join(", ")}` : `${protectedIds.length} protected message(s) present and unaltered`,
    ),
  );

  const lossy = result.groups.filter((g) => g.sourceIds.some((id) => protectedIds.includes(id)));
  checks.push(ok("Protected context not lossy-compressed", lossy.length === 0, lossy.length ? `groups touching protected sources: ${lossy.map((g) => g.id).join(", ")}` : "no compression group contains a protected source"));

  const leaked = result.decisions.filter((d) => d.action === "OMIT" && compiled.has(d.id)).map((d) => d.id);
  checks.push(ok("Omitted context not sent", leaked.length === 0, leaked.length ? `omitted messages present in context: ${leaked.join(", ")}` : "no omitted message reaches the model"));

  checks.push(ok("Every message routed exactly once", routedOnce(result, messages), "each message reaches the context through exactly one route, or is omitted"));

  checks.push(
    ok(
      "Compiled context is non-empty and valid",
      messages.length === 0 || result.compiledContext.length > 0,
      messages.length === 0 ? "no history: only the current request is sent" : `${result.compiledContext.length} context entries plus the current request`,
    ),
  );

  // Memory the request refers to must be available, either as a memory line or through a retained source.
  const requestTerms = [...new Set(tokenize(request))];
  const referenced = memory.filter((m) => m.active && requestTerms.length > 0 && itemCoverage(m, requestTerms) > 0);
  const retained = new Set([...compiled.keys(), ...result.groups.flatMap((g) => g.sourceIds)]);
  const missingMemory = referenced.filter((m) => !compiledText.includes(m.value.toLowerCase()) && !m.sourceIds.some((id) => retained.has(id)));
  checks.push(
    ok(
      "Memory referenced by the request is present",
      missingMemory.length === 0,
      missingMemory.length ? `missing: ${missingMemory.map((m) => m.key).join(", ")}` : referenced.length ? `${referenced.length} referenced memory item(s) available` : "request references no stored memory",
    ),
  );

  // Identifiers the request mentions that exist in history must still be findable in the compiled context.
  const historyText = messages.map((m) => m.content.toLowerCase());
  const identifiers = exactTokens(request).filter((t) => t.length >= 3);
  const unresolved = identifiers.filter((t) => historyText.some((h) => h.includes(t.toLowerCase())) && !compiledText.includes(t.toLowerCase()));
  checks.push(
    ok(
      "Identifiers in the request remain resolvable",
      unresolved.length === 0,
      unresolved.length ? `mentioned in history but absent from compiled context: ${unresolved.join(", ")}` : identifiers.length ? `${identifiers.length} identifier(s) resolvable` : "request names no specific identifiers",
    ),
  );

  return { passed: checks.every((c) => c.passed), checks };
}

const MIN_RESPONSE_CHARS = 2;

// Deterministic answer checks (the semantic evaluator covers meaning).
export function evaluateAnswer(response: string, error?: string): EvalCheck[] {
  return [
    ok("Model call completed", !error, error ?? "provider returned a response"),
    ok("Answer is non-empty", response.trim().length >= MIN_RESPONSE_CHARS, `${response.trim().length} characters returned`),
  ];
}
