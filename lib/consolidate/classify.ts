// Context classification. Deterministic rules settle obvious cases; anything they cannot settle is flagged
// `ambiguous` and later resolved by one batched semantic call (semantic.ts). Results are persisted, never recomputed.
import { detectProtection, WEAK_CONSTRAINT_RE } from "./protection";
import { extractStatements } from "./memory";
import { hasFence, isQuestionOrRequest, sentencesOf, wordCount } from "./text";
import type { Annotation, ContentType, HistoryMessage, Role } from "../types";

export const CONTENT_TYPES: ContentType[] = ["fact", "decision", "preference", "constraint", "code", "log", "tool_output", "discussion", "other"];

export const CONTENT_TYPE_METHOD = "deterministic rules; ambiguous user statements resolved by one batched model call, then cached";

const LOG_LINE_RE = /^\s*(?:\[?\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}|\[?\d{2}:\d{2}:\d{2}|\S*\s?\b(?:INFO|WARN(?:ING)?|ERROR|DEBUG|FATAL|TRACE)\b[:\]\s])/;
const STACK_LINE_RE = /^\s+at\s+\S+.*(?:\(|:)\d+/;
const TOOL_RE = /^\s*(?:\$ |> |npm (?:ERR|WARN)|error TS\d+|Traceback \(most recent call last\)|\d+ (?:passing|passed|failed|failing)|exit code \d+|Process finished|make: \*\*\*|fatal: |command not found|Segmentation fault)|\berror TS\d+\b|\bTraceback \(most recent call last\)|\b(?:tests?|specs?) (?:passed|failed)\b/im;
const CODE_LINE_RE = /^\s{2,}\S|[;{}]\s*$|^\s*(?:import|export|const|let|var|def|class|function|return|if|for|while|#include|SELECT|INSERT|CREATE|<\w+)\b/;
const DECISION_RE = /\b(?:we|i)(?:'ve| have)?\s+(?:decided|agreed|chosen|chose|settled on|opted)\b|\blet'?s (?:go with|use|stick with)\b|\b(?:we|i)(?:'ll| will|'re| are) (?:go with|going with|use|using)\b|\bwe (?:switched|moved|migrated) to\b|^\s*decision:/i;
const PREFERENCE_RE = /\b(?:i|we)\s+(?:prefer|like|love|hate|dislike|enjoy)\b|\bi'd (?:rather|prefer|like)\b|\bmy favou?rite\b|\bprefer(?:red)?\b/i;
const FACTUAL_CUE_RE = /\b(?:my|our) \w+ (?:is|are)\b|\bi(?:'m| am) (?:a|an)\b|\bi (?:live|work)\b|\bwe(?:'re| are)? (?:building|using|use|running)\b|\b(?:is|are|was|were) (?:set|named|called|located)\b/i;
// Cues that a declarative sentence may carry something durable that our patterns did not capture.
const DURABLE_CUE_RE = /\b(?:should|need to|needs to|have to|going to|plan(?:ning)? to|will be|deadline|budget|target|goal|because|since|our|my|we're|we are|i'm|i am|version|v\d|\d{2,})\b/i;

export type Deterministic = { contentType: ContentType; ambiguous: boolean };

export function classifyDeterministic(m: { role: Role; content: string }): Deterministic {
  const text = m.content.trim();
  const lines = text.split("\n").filter((l) => l.trim());
  const count = (re: RegExp) => lines.filter((l) => re.test(l)).length;

  if (m.role === "system" || m.role === "developer") {
    const p = detectProtection(m);
    return { contentType: p?.level === "critical" || /^\s*(prefer|always|write|use|keep|follow)\b/i.test(text) ? "constraint" : "fact", ambiguous: false };
  }
  if (count(LOG_LINE_RE) >= 2 || count(STACK_LINE_RE) >= 2 || (lines.length === 1 && LOG_LINE_RE.test(text) && /\d{4}-\d{2}-\d{2}|\b(ERROR|WARN|FATAL)\b/.test(text))) return { contentType: "log", ambiguous: false };
  if (TOOL_RE.test(text)) return { contentType: "tool_output", ambiguous: false };
  if (hasFence(text) || (lines.length >= 3 && count(CODE_LINE_RE) / lines.length > 0.6)) return { contentType: "code", ambiguous: false };
  if (m.role === "assistant") return { contentType: wordCount(text) < 4 ? "other" : "discussion", ambiguous: false };

  // user message
  const sentences = sentencesOf(text);
  const statements = sentences.filter((s) => !isQuestionOrRequest(s));
  if (detectProtection(m)) return { contentType: "constraint", ambiguous: false };
  if (statements.some((s) => DECISION_RE.test(s))) return { contentType: "decision", ambiguous: false };
  if (statements.some((s) => PREFERENCE_RE.test(s))) return { contentType: "preference", ambiguous: false };
  const { statements: extracted } = extractStatements(text);
  if (extracted.length) return { contentType: extracted.some((s) => s.type === "preference") ? "preference" : extracted.some((s) => s.type === "decision") ? "decision" : "fact", ambiguous: false };
  if (statements.some((s) => FACTUAL_CUE_RE.test(s))) return { contentType: "fact", ambiguous: false };
  if (wordCount(text) < 4) return { contentType: "other", ambiguous: false };
  // A declarative statement, long enough to matter, with cues of durable content that no rule captured.
  const declarative = statements.filter((s) => wordCount(s) >= 6);
  const ambiguous = declarative.some((s) => DURABLE_CUE_RE.test(s) || WEAK_CONSTRAINT_RE.test(s));
  return { contentType: "discussion", ambiguous };
}

// Full deterministic annotation of one message (classification, protection, memory completeness).
export function annotateMessage(m: { role: Role; content: string }): Annotation {
  const { contentType, ambiguous } = classifyDeterministic(m);
  const protection = detectProtection(m);
  const memoryComplete = m.role === "user" && !protection && extractStatements(m.content).complete;
  return { contentType, classMethod: ambiguous ? "heuristic" : "deterministic", protection, memoryComplete, ambiguous };
}

export const annotationOf = (m: HistoryMessage): Annotation => m.annotation ?? annotateMessage(m);
