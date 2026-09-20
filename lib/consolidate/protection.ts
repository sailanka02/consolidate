// Protection detection: which context cannot safely be lost. Deterministic rules run first; a message they cannot
// settle is flagged ambiguous elsewhere and resolved by the semantic classifier (semantic.ts).
//
// Signals: system instructions, developer hard rules, explicit user constraints, strong requirements / policy
// statements, and exact code or configuration whose exact form was demanded.
import { hasFence, sentencesOf } from "./text";
import type { Protection, Role } from "../types";

// Hard requirement language (used for system/developer authority messages).
const HARD_RULE_RE = /\b(must|must not|never|shall|required|forbidden|prohibited|do not|don't|may not|policy|security)\b/i;

// User constraints. Imperative or modal forms only, so "I don't know why it fails" is not a constraint.
const DIRECTIVE_START =
  /^(?:(?:please|also|and|but|note that|remember(?: that)?|important|rule|constraint|requirement|from now on|going forward)[\s:,-]+)*(always|never|do not|don't|dont|make sure|ensure|must|only use|use only|avoid|stick to|keep it|no more than|at most|at least)\b/i;
const MODAL_HARD = /\b(must(?: not)?|shall(?: not)?|is required|are required|not allowed|forbidden|prohibited|under no circumstances|at all times|non-negotiable|cannot ever)\b/i;
const HABITUAL = /\b(?:we|you)\s+(?:always|never)\s+(?!know\b|think\b|see\b|understand\b|remember\b|had\b|get\b|have\b)/i;
const REPORTING = /^(?:i|we|they|he|she|it)\s+(?:(?:really|just|still|also)\s+)?(?:don't|do not|never|didn't|did not|can't|cannot|couldn't)\s+(?:know|think|see|understand|remember|get|like|care|have|want|mean|need)\b/i;
// "must" inside a report about something else ("it must have failed") is inference, not a requirement.
const INFERENCE = /\bmust have\b|\bmust be (?:a|an|the|because|due)\b|\bmust'?ve\b/i;

const EXACT_DEMAND = /\b(exactly|verbatim|word for word|as is|as-is|do not change|don't change|must match|use this (?:config|configuration|snippet|schema|template|code|prompt)|keep this (?:config|snippet|schema|template|code))\b/i;

// The sentence of a user message that states a strong constraint, or null.
export function strongConstraintSentence(content: string): string | null {
  for (const raw of sentencesOf(content)) {
    if (raw.includes("?") || REPORTING.test(raw) || INFERENCE.test(raw)) continue;
    if (DIRECTIVE_START.test(raw) || MODAL_HARD.test(raw) || HABITUAL.test(raw)) return raw;
  }
  return null;
}

// Weaker cues: possibly a constraint, possibly not. Marks a user message as ambiguous for the semantic classifier.
export const WEAK_CONSTRAINT_RE = /\b(should(?:n't| not)?|need(?:s)? to|has to|have to|only|let's (?:keep|stick|make sure)|no (?:more|less) than|needs? be|supposed to|expected to|prefer(?:red)?)\b/i;

export function detectProtection(m: { role: Role; content: string }): Protection | null {
  const hard = HARD_RULE_RE.test(m.content);
  if (m.role === "system") {
    return hard
      ? { level: "critical", reason: "system instruction with hard requirement / policy language", method: "deterministic" }
      : { level: "high", reason: "system instruction", method: "deterministic" };
  }
  if (m.role === "developer") {
    if (hard) return { level: "critical", reason: "application instruction with hard requirement / constraint language", method: "deterministic" };
    return null;
  }
  if (m.role !== "user") return null;
  const sentence = strongConstraintSentence(m.content);
  if (hasFence(m.content) && EXACT_DEMAND.test(m.content)) {
    return { level: "high", reason: "exact code/configuration required (user demanded the exact form)", method: "deterministic" };
  }
  if (sentence) {
    const snippet = sentence.length > 90 ? sentence.slice(0, 90) + "…" : sentence;
    return { level: "high", reason: `explicit user constraint: "${snippet}"`, method: "deterministic" };
  }
  return null;
}
