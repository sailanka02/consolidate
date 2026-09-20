// Does restoring one omitted message require restoring a neighbour to make it interpretable?
// Recovery asks "what minimum information is missing?", not "which whole exchange should come back?". A conversational
// partner is restored only when the named message cannot be understood without it, decided deterministically:
//
//   assistant message named -> the USER message before it, when the answer is short and context-dependent
//                              ("The second one.", "Yes, that works.") or points back at the question ("As you asked, ...").
//   user message named      -> the ASSISTANT message before it, when the user message is a short reply that only makes
//                              sense next to what it answers ("Yes, do that.", "The second one.").
//
// Adjacency alone is never a reason. Pure functions; no I/O.
import type { Role } from "../types";

// A reply whose meaning lives in the message it answers.
const DEPENDENT_START = /^(?:yes|yeah|yep|yup|no|nope|sure|ok(?:ay)?|right|exactly|correct|agreed|the (?:first|second|third|fourth|last|latter|former|other) (?:one|option|choice|approach)|(?:first|second|third|last) (?:one|option)|option \d|(?:go|going) with|do that|let'?s (?:do|go)|sounds good|that(?: one)?\b|this(?: one)?\b|those\b|these\b|it\b|both\b|neither\b|either\b)/i;
// An answer that refers back to its question.
const BACK_REFERENCE = /\b(?:your (?:question|request|last (?:message|question))|you asked|as you (?:asked|requested)|to answer (?:that|your)|in response to (?:that|your)|answering your)\b/i;

const words = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;

export const SHORT_ANSWER_WORDS = 40; // an assistant reply this short can be context-dependent
export const SHORT_REPLY_WORDS = 12; // a user reply this short can be context-dependent

export type Neighbour = { role: Role; content: string };
export type RequiredPartner = { index: number; why: string };

// The single neighbour needed to interpret message `i`, or null when the message stands on its own.
export function requiredPartner(messages: Neighbour[], i: number): RequiredPartner | null {
  const m = messages[i];
  const prev = messages[i - 1];
  if (!m || !prev || prev.role === m.role) return null;
  const text = m.content.trim();
  if (m.role === "assistant") {
    const short = words(text) <= SHORT_ANSWER_WORDS;
    if (short && DEPENDENT_START.test(text)) return { index: i - 1, why: "the answer is short and only makes sense next to the question it answers" };
    if (BACK_REFERENCE.test(text.slice(0, 240))) return { index: i - 1, why: "the answer refers back to the question it responds to" };
    return null;
  }
  if (m.role === "user" && words(text) <= SHORT_REPLY_WORDS && DEPENDENT_START.test(text)) {
    return { index: i - 1, why: "the message is a short reply that only makes sense next to the assistant message it answers" };
  }
  return null;
}
