// What to do after the evaluator has judged an attempt. Pure and deterministic: given the category and the evidence the
// evaluator supplied, decide whether a second generation is justified. Consolidate is a context compiler, not a general
// answer critic, so only failures that Consolidate's context choices can plausibly have caused, or an instruction that
// demonstrably applies to THIS request, may cost another Sonnet generation. Everything else is returned as a warning.
//
//   PASS                   none
//   MISSING_CONTEXT        bounded context expansion (then full context if still missing)        [never blocked]
//   CHECK_FAILED           bounded expansion, then full context                                    [never blocked]
//   ANSWER_QUALITY         none: informational warning
//   INSTRUCTION_VIOLATION  one corrective regeneration ONLY with all four proofs, else a warning   [proven: never blocked]
//   UNSUPPORTED_CLAIM      one corrective regeneration ONLY when tied to a compiler choice, else a warning
//   UNCERTAIN              expansion ONLY when a specific omitted message was named, else a warning
import type { FailureCategory, RetryKind } from "../types";
import { termsMatch, tokenize } from "./relevance";
import { CURRENT_REQUEST_SOURCE, type MissingContextEvidence, type Requirement, type SemanticVerdict } from "./semantic";

export type ExpansionPlan = { includeIds: string[]; incremental?: { minScore: number } };

export type RetryProposal = {
  kind: RetryKind;
  reason: string;
  purpose?: "context" | "instruction" | "grounding";
  optional: boolean; // optional retries are subject to the economic guard
  warningOnly: boolean; // the evaluator flagged something Consolidate did not cause: shown as a warning, status is not a failure
  warning?: string;
  plan?: ExpansionPlan;
  guidance?: string;
};

export type ProposeInput = {
  category: FailureCategory;
  verdict: Pick<SemanticVerdict, "violation" | "contextLink"> & { missingContext?: MissingContextEvidence | null } | null;
  payloadText?: string[]; // everything the attempt was actually shown (protected, memory, compressed, retrieved): information present there is not "missing"
  missingIds: string[]; // omitted messages the evaluator named (already validated against the omitted list)
  requirements: Requirement[];
  request: string;
  semanticReason?: string; // the evaluator's own words for what it flagged
  alreadyRegenerated?: boolean; // a corrective regeneration already happened for this request
  revisionsOf?: (sourceId: string) => string[]; // user statements newer than the cited source, ending with the current request
};

// A newer user statement that revises the same subject supersedes an older instruction ("The database will be PostgreSQL 17"
// then "Actually, change the metadata database to PostgreSQL 16"). The older text is then no longer in force, and an answer that
// follows the newer statement cannot violate it. Deterministic: an update marker plus real vocabulary overlap with the instruction.
const REVISION_MARKER = /\b(actually|instead|no longer|changes?|changed|changing|switch(?:es|ed|ing)?|replace[sd]?|replacing|update[sd]?|rather than|scratch that|on second thought|never mind|from now on|not anymore)\b/i;
const MIN_SHARED_TERMS = 2;
export function revisesInstruction(instruction: string, statement: string): boolean {
  if (!REVISION_MARKER.test(statement)) return false;
  const want = [...new Set(tokenize(instruction))];
  const have = tokenize(statement);
  return want.filter((t) => have.some((h) => termsMatch(h, t))).length >= MIN_SHARED_TERMS;
}

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n).trimEnd() + "…" : s);

// The four pieces that must ALL be present before a violated instruction may cost a retry. Returns what is missing.
export function violationProblems(v: SemanticVerdict["violation"] | undefined, requirements: Requirement[], request: string, revisionsOf?: (sourceId: string) => string[]): string[] {
  if (!v) return ["no violation details were given"];
  const problems: string[] = [];
  // 1. the exact instruction  2. its source (a listed requirement, or the current request itself)
  const sourceText = v.sourceId === CURRENT_REQUEST_SOURCE ? request : requirements.find((r) => r.id === v.sourceId)?.text;
  if (v.instruction.length < 4) problems.push("no exact instruction was quoted");
  if (!v.sourceId) problems.push("no source id was cited");
  else if (sourceText === undefined) problems.push("the cited source id does not exist");
  else if (v.instruction.length >= 4) {
    const want = [...new Set(tokenize(v.instruction))];
    const have = tokenize(sourceText);
    const covered = want.filter((t) => have.some((h) => termsMatch(h, t))).length;
    if (want.length && covered / want.length < 0.6) problems.push("the quoted instruction does not appear in its cited source");
  }
  // A source that a newer user statement (or the current request) revises is no longer in force.
  if (v.sourceId && v.sourceId !== CURRENT_REQUEST_SOURCE && v.instruction.length >= 4 && (revisionsOf?.(v.sourceId) ?? [request]).some((s) => revisesInstruction(v.instruction, s))) {
    problems.push("a newer user statement revises this instruction, so the older text is no longer in force");
  }
  // 3. concise evidence of the violation
  if (v.evidence.length < 8) problems.push("no concrete evidence of the violation was given");
  // 4. confirmation that it applies to the CURRENT request
  if (!v.applies || !v.appliesBecause) problems.push("it was not confirmed that the instruction applies to the current request");
  return problems;
}

// Speculation is a property of the evidence the evaluator states ("evidence_strength"); wording is only a second veto.
const SPECULATIVE_WORDING = /\b(likely|might|may (?:also )?(?:help|contain|include|be)|could (?:help|make|improve|contain|be)|possibly|perhaps|probably|maybe|potentially)\b/i;
const COVERED = 0.85;

// A MISSING_CONTEXT may cost a second generation only with concrete, material, non-redundant evidence. Returns what is missing.
export function missingContextProblems(mc: MissingContextEvidence | null | undefined, missingIds: string[], payloadText: string[] = []): string[] {
  const problems: string[] = [];
  if (!missingIds.length) problems.push("no real missing source id was named");
  if (!mc) return [...problems, "no structured evidence was given"];
  if (mc.missingInformation.length < 8) problems.push("the exact missing information was not stated");
  if (mc.answerProblem.length < 8) problems.push("no material problem in the answer was stated");
  if (mc.causalLink.length < 8) problems.push("no causal link from the missing information to the problem was stated");
  if (mc.evidenceStrength !== "concrete") problems.push("the evidence is speculative");
  else if (SPECULATIVE_WORDING.test(`${mc.missingInformation} ${mc.answerProblem} ${mc.causalLink}`)) problems.push("the evidence is worded as speculation");
  // The information must not already be represented in what the answer was shown.
  const want = [...new Set(tokenize(mc.missingInformation))];
  if (want.length >= 2 && payloadText.length) {
    const have = tokenize(payloadText.join(" \n "));
    if (want.filter((t) => have.some((h) => termsMatch(h, t))).length / want.length >= COVERED) problems.push("the information is already represented in the payload (protected, memory, compressed or retrieved context)");
  }
  return problems;
}

export function proposeRetry(i: ProposeInput): RetryProposal {
  const warn = (why: string, reason: string): RetryProposal => ({ kind: "none", reason, optional: false, warningOnly: true, warning: `Quality warning — no context failure detected${why ? `: ${clip(why, 240)}` : ""}` });
  const expand = (plan: ExpansionPlan, reason: string, optional: boolean): RetryProposal => ({ kind: "context_expansion", reason, purpose: "context", optional, warningOnly: false, plan });
  const correct = (guidance: string, purpose: "instruction" | "grounding", reason: string, optional: boolean): RetryProposal =>
    i.alreadyRegenerated
      ? { kind: "none", reason: "The answer was already regenerated once with a corrective instruction; it is not regenerated again.", optional, warningOnly: false }
      : { kind: "corrective_regeneration", reason, purpose, optional, warningOnly: false, guidance };

  switch (i.category) {
    case "PASS":
      return { kind: "none", reason: "Passed: no retry needed.", optional: false, warningOnly: false };

    // Safe paths, unchanged: proven missing context (or a broken deterministic check) is always repaired.
    case "MISSING_CONTEXT": {
      const problems = missingContextProblems(i.verdict?.missingContext, i.missingIds, i.payloadText);
      if (problems.length) return warn(i.semanticReason ?? "the answer may lack context", `A missing-context claim was not actionable (${problems.join("; ")}), so no retry was made.`);
      return expand({ includeIds: i.missingIds }, `The evaluator named omitted messages with concrete evidence: ${clip(i.verdict!.missingContext!.missingInformation, 120)}`, false);
    }
    case "CHECK_FAILED":
      return expand({ includeIds: [], incremental: { minScore: 0 } }, "A deterministic check failed.", false);

    case "ANSWER_QUALITY":
      return warn(i.semanticReason ?? "the answer could be improved", "ANSWER_QUALITY is informational: nothing about the context was shown to cause it, so the first answer is returned and no second generation is paid for.");

    case "INSTRUCTION_VIOLATION": {
      const problems = violationProblems(i.verdict?.violation, i.requirements, i.request, i.revisionsOf);
      const v = i.verdict?.violation;
      if (problems.length || !v) return warn(i.semanticReason ?? "an instruction may not have been followed", `An instruction violation was not proven (${problems.join("; ")}), so no retry was made.`);
      const where = v.sourceId === CURRENT_REQUEST_SOURCE ? "your current request" : "a standing requirement";
      const guidance = `Your previous reply did not follow this instruction from ${where}: "${clip(v.instruction, 200)}". Evidence: ${clip(v.evidence, 200)}. Answer again and follow it.`;
      return correct(guidance, "instruction", `Proven violation of an applicable instruction ("${clip(v.instruction, 80)}", source ${v.sourceId}).`, false);
    }

    case "UNSUPPORTED_CLAIM": {
      const link = i.verdict?.contextLink;
      if (!link) return warn(i.semanticReason ?? "the answer stated something the conversation does not support", "The unsupported claim was not tied to a context-selection choice (a generic hallucination), so no retry was made.");
      if (link.kind === "omitted_context") {
        return i.missingIds.length
          ? expand({ includeIds: i.missingIds }, `The unsupported claim was tied to omitted context: ${clip(link.explanation, 120)}`, true)
          : warn(link.explanation, "The claim was tied to omitted context but no specific omitted message was identified, so no retry was made.");
      }
      const guidance = `Your previous reply stated things the provided context does not support (${link.kind.replace("_", " ")}: ${clip(link.explanation, 200)}). Answer again and ground every statement about the conversation in the provided context; if the context does not contain something, say so instead of guessing.`;
      return correct(guidance, "grounding", `The unsupported claim was tied to a compiler choice (${link.kind.replace("_", " ")}).`, true);
    }

    case "UNCERTAIN":
      return i.missingIds.length
        ? expand({ includeIds: i.missingIds }, "The evaluator could not tell, and named specific omitted messages that might matter.", true)
        : warn(i.semanticReason ?? "the answer could not be validated", "The evaluator was uncertain and named no specific omitted message, so nothing was added and no retry was made.");
  }
}
