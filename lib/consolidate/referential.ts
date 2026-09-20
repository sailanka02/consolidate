// Referential-object requests: "what do these failures have in common?", "why did those requests fail?", "what's wrong
// with this output?". The request points at an artifact or event the user recently presented, and it shares almost no
// vocabulary with it, so lexical retrieval cannot find the antecedent (the log lines say "failed", the question says
// "failures"). This module is a generic deterministic signal:
//
//   demonstrative / referential language  +  an artifact/event noun  +  a recent, type-compatible block of messages
//
// It detects the reference and selects the antecedent: the most recent coherent block of compatible messages within a
// bounded recent window. It never scores by vocabulary, never restores older unrelated history, and abstains (selects
// nothing) when there is no plausible antecedent. Pure functions; no I/O.
import type { ContentType, Role } from "../types";

export type ReferentialKind = "error" | "output" | "code" | "decision" | "any";

export type ReferentialObject = {
  kind: ReferentialKind;
  noun: string; // the artifact/event noun as written ("failures")
  phrase: string; // the referring phrase as written ("these failures")
};

// ---- 1. detecting the reference ----

// Artifact/event nouns by what they refer to. Roots + optional plural; this is a small semantic lexicon, not a phrase list.
const NOUNS: [ReferentialKind, RegExp][] = [
  ["error", /^(failures?|failed|errors?|exceptions?|warnings?|crash(?:es)?|faults?|timeouts?|bugs?|issues?|problems?|stack ?traces?)$/],
  ["output", /^(logs?|traces?|outputs?|results?|responses?|requests?|messages?|lines?|entries|entry|events?|records?|reports?|readings?|metrics?)$/],
  ["code", /^(code|snippets?|functions?|quer(?:y|ies)|scripts?|implementations?|methods?|classes|class|configs?|configurations?|commands?)$/],
  ["decision", /^(decisions?|choices?|requirements?|constraints?|rules?|preferences?)$/],
];
const kindOf = (w: string): ReferentialKind | null => NOUNS.find(([, re]) => re.test(w))?.[0] ?? null;

const DEICTIC = new Set(["these", "those", "this", "that"]);
// Words that end a noun phrase: after one of these, a later noun no longer belongs to the demonstrative.
const NP_BREAK = new Set("the a an my our your his her its their of to for in on at by with and or is are was were be it we i you they so but if as than then do does did have has had can could should would will what which who how why when where".split(" "));
const BACK_REF = new Set(["previous", "last", "preceding", "earlier", "recent", "latest"]);
const AFTER_REF = new Set(["above", "earlier", "before"]);

const words = (t: string) => t.toLowerCase().replace(/[’]/g, "'").match(/[a-z][a-z'-]*/g) ?? [];

export function detectReferentialObject(request: string): ReferentialObject | null {
  const w = words(request);
  // "these failures", "this output", "those requests", "these error logs": a demonstrative, then up to two modifiers, then the noun.
  for (let i = 0; i < w.length; i++) {
    if (!DEICTIC.has(w[i])) continue;
    let head: { noun: string; kind: ReferentialKind; end: number } | null = null;
    for (let j = i + 1; j < Math.min(w.length, i + 4); j++) {
      const k = kindOf(w[j]);
      if (k) head = { noun: w[j], kind: k, end: j }; // keep going: "these error logs" is about the logs
      else if (head || NP_BREAK.has(w[j])) break;
    }
    if (head) return { kind: head.kind, noun: head.noun, phrase: w.slice(i, head.end + 1).join(" ") };
  }
  // "the errors above", "the logs from earlier", "the previous errors", "my last request".
  for (let i = 0; i < w.length; i++) {
    const k = kindOf(w[i]);
    if (!k) continue;
    const bi = w[i - 1] && BACK_REF.has(w[i - 1]) ? i - 1 : w[i - 2] && BACK_REF.has(w[i - 2]) && !NP_BREAK.has(w[i - 1]) ? i - 2 : -1;
    const after = w[i + 1] && AFTER_REF.has(w[i + 1]);
    if (bi >= 0 || after) return { kind: k, noun: w[i], phrase: w.slice(bi >= 0 ? bi : i, after ? i + 2 : i + 1).join(" ") };
  }
  const t = w.join(" ");
  // "why is this failing / why did it crash": the subject is a recent artifact and the verb says it is an error.
  const m = t.match(/\bwhy (?:is|are|was|were|did|does|do) (?:this|these|that|those|it)\b(?:\s+\w+){0,2}?\s+(fail\w*|crash\w*|break\w*|broke\w*|error\w*|throw\w*|not working)\b/);
  if (m) return { kind: "error", noun: m[1], phrase: m[0] };
  // "what happened here", "what went wrong there".
  const h = t.match(/\bwhat (?:happened|went wrong|is going on|s going on)(?: (?:here|there|above|just now|with (?:this|that|it)))\b/);
  if (h) return { kind: "any", noun: "this", phrase: h[0] };
  return null;
}

// ---- 2. what counts as a compatible antecedent ----

export type AntecedentMessage = { id: string; role: Role; content: string; contentType: ContentType };

const LEVEL_PREFIX = /^\s*\[?(?:ERROR|WARN(?:ING)?|FATAL|CRITICAL|SEVERE|Traceback|Exception|Error:|Uncaught)\b/im;
const STACK_FRAME = /\bat\s+[\w$.<>]+\s*\(|File ".+", line \d+|\bat [\w./\\-]+:\d+(?::\d+)?\b/;
const ERROR_WORD = /\b(error|exception|failed|failure|fatal|traceback|timed? ?out|timeout|refused|denied|panic|unhandled|segfault|crash(?:ed)?|unreachable|exceeded)\b/i;
const KEY_VALUE = /\b[\w.-]+=\S+/g;

// A pasted error/log artifact: a log level or traceback marker, a stack frame, or structured key=value output naming an error.
export function looksLikeErrorEvidence(text: string): boolean {
  if (LEVEL_PREFIX.test(text) || STACK_FRAME.test(text)) return true;
  return ERROR_WORD.test(text) && (text.match(KEY_VALUE)?.length ?? 0) >= 2;
}
const looksLikePastedOutput = (text: string) => text.split("\n").filter((l) => l.trim()).length >= 3 || (text.match(KEY_VALUE)?.length ?? 0) >= 3;

export function isCompatibleAntecedent(kind: ReferentialKind, m: AntecedentMessage): boolean {
  const logLike = m.contentType === "log" || m.contentType === "tool_output";
  const pasted = m.role === "user"; // artifacts are things the user brought; assistant prose is not one
  const err = (pasted && looksLikeErrorEvidence(m.content)) || logLike;
  switch (kind) {
    case "error":
      return err;
    case "output":
      return err || (pasted && looksLikePastedOutput(m.content));
    case "code":
      return err || (pasted && m.contentType === "code");
    case "decision":
      return pasted && (m.contentType === "constraint" || m.contentType === "decision" || m.contentType === "preference" || m.contentType === "fact") && !looksLikeErrorEvidence(m.content);
    case "any":
      return err || (pasted && (m.contentType === "code" || looksLikePastedOutput(m.content)));
  }
}

// ---- 3. selecting the antecedent block ----

// Only recent history is searched, and only one coherent block is brought back.
export const ANTECEDENT_WINDOW = 12; // most recent history messages considered
export const ANTECEDENT_MAX_MESSAGES = 6;
export const ANTECEDENT_MAX_TOKENS = 2000; // est. tokens, newest first

export type AntecedentSelection = { candidateIds: string[]; selectedIds: string[] };

// The most recent block of compatible USER messages. Assistant replies in between are transparent (log, reply, log, reply...),
// but a user message that is not compatible ends the block once it has started: an older run of similar logs beyond a topic
// break is a different episode, not what "these" refers to. Nothing compatible in the window -> nothing selected (abstain).
export function selectAntecedents(kind: ReferentialKind, messages: AntecedentMessage[], tokens: number[]): AntecedentSelection {
  const from = Math.max(0, messages.length - ANTECEDENT_WINDOW);
  const candidateIds: string[] = [];
  const picked: number[] = [];
  let started = false;
  let budget = ANTECEDENT_MAX_TOKENS;
  for (let i = messages.length - 1; i >= from; i--) {
    const m = messages[i];
    if (m.role !== "user") continue;
    if (!isCompatibleAntecedent(kind, m)) {
      if (started) break;
      continue;
    }
    started = true;
    candidateIds.push(m.id);
    if (picked.length >= ANTECEDENT_MAX_MESSAGES || (picked.length > 0 && tokens[i] > budget)) continue;
    picked.push(i);
    budget -= tokens[i];
  }
  return { candidateIds, selectedIds: picked.sort((a, b) => a - b).map((i) => messages[i].id) };
}
