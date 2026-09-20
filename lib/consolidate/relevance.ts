// Retrieval scoring: how relevant is each historical message (and each memory item) to the current request?
// Multiple signals, combined explicitly and reported per message so the trace can show them:
//   lexical     IDF-weighted term overlap, identifier-like / numeric / proper-noun terms weighted up
//   typeFactor  content-type prior (constraints/decisions/facts matter more, logs less)
//   memory      the message is the source of a structured-memory item that matches the request
//   importance  protected / durable content
//   recency     newer messages score slightly higher (only boosts already-related messages)
//   semantic    model-selected relevance, used only when lexical retrieval is insufficient
import type { ContentType, MemoryItem, Signals } from "../types";

const STOPWORDS = new Set(
  "a an and are as at be but by can could do does for from had has have how i if in into is it its just let lets me my no not of on or our please should so that the their then there these this to up us was we were what whats when which who why will with would you your now new get make use using also about any some tell give want need like know think really very did done said say says".split(" "),
);

// Common abbreviations, expanded before matching.
const ALIASES: Record<string, string> = { auth: "authentication", db: "database", repo: "repository", env: "environment", config: "configuration" };

// A user/assistant neighbor of a strongly relevant message travels with it (question <-> answer).
const PAIR_MIN_SCORE = 0.4;
const PAIR_DECAY = 0.7;
// A critical policy message that touches the request lends its other terms to the query, at reduced weight.
const EXPANSION_WEIGHT = 0.6;
const IMPORTANT_TERM_WEIGHT = 1.4;

// Words that co-occur with almost any topic ("what other issues", "the difference between", "have in common", "investigate first").
// A message that shares only these with the request is not about the same thing, so they carry a fraction of a normal term's weight.
// The retrieval threshold is unchanged; a message still needs a real, specific overlap to pass it.
const GENERIC_TERMS = ["failure", "issue", "problem", "difference", "different", "other", "between", "common", "first", "wrong", "similar", "same", "thing"];
const GENERIC_WEIGHT = 0.25;
const isGeneric = (t: string) => GENERIC_TERMS.some((g) => termsMatch(g, normalize(t)) || termsMatch(g, t));

const TYPE_FACTOR: Record<ContentType, number> = { constraint: 1.15, decision: 1.15, preference: 1.1, fact: 1.1, code: 1.05, discussion: 1, other: 1, tool_output: 0.9, log: 0.85 };

export type RelevanceScore = { score: number; signals: Signals; matched: string[]; pairedWith?: string };

// Light suffix stripping so flickering ~ flickers, failed ~ failure.
function stem(t: string): string {
  for (const suffix of ["ing", "ed", "es", "s"]) {
    const minStem = suffix === "s" ? 3 : 4;
    if (t.endsWith(suffix) && t.length - suffix.length >= minStem) return t.slice(0, -suffix.length);
  }
  return t;
}
const normalize = (t: string) => ALIASES[stem(t)] ?? stem(t);

export function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((t) => t.length > 1 && !STOPWORDS.has(t)).map(normalize);
}

// Terms that identify something specific: contain digits, underscores, dots, camelCase, ALLCAPS, or are proper nouns.
export function importantTerms(text: string): Set<string> {
  const out = new Set<string>();
  const words = text.match(/[A-Za-z0-9][A-Za-z0-9_.-]*/g) ?? [];
  words.forEach((w, i) => {
    const special = /\d|_|[a-z][A-Z]|^[A-Z]{2,}$/.test(w) || (/^[A-Z][a-z]+/.test(w) && i > 0);
    if (special) for (const part of w.split(/[_.-]+/)) tokenize(part).forEach((t) => out.add(t));
  });
  return out;
}

// Terms match if equal, or one is a prefix of the other (postgres ~ postgresql).
// Prefix needs 5+ chars so short words don't match ("drop" vs "dropdown").
export function termsMatch(a: string, b: string): boolean {
  if (a === b) return true;
  const [s, l] = a.length <= b.length ? [a, b] : [b, a];
  return s.length >= 5 && l.startsWith(s);
}

// Item-centric coverage: what fraction of a (short) memory item's own terms does the request mention?
// Used by both the compiler and the evaluator so they agree on what "the request references this memory" means.
export function itemCoverage(item: Pick<MemoryItem, "key" | "value">, requestTerms: string[]): number {
  const terms = [...new Set(tokenize(`${item.key.replace(/_/g, " ")} ${item.value}`))];
  const hit = terms.filter((t) => requestTerms.some((r) => termsMatch(t, r))).length;
  return terms.length && hit / terms.length >= 0.5 && (hit >= 2 || terms.length === 1) ? hit / terms.length : 0;
}

export type RelevanceInput = {
  messages: { id: string; role: string; content: string; contentType: ContentType; protectedLevel?: "critical" | "high" | null }[];
  request: string;
  memory: MemoryItem[];
  semantic?: Record<string, number>;
};

export type RelevanceOutput = { scores: RelevanceScore[]; requestTerms: string[]; memoryScores: Map<string, number> };

export function scoreRelevance({ messages, request, memory, semantic = {} }: RelevanceInput): RelevanceOutput {
  const requestTerms = [...new Set(tokenize(request))];
  const important = importantTerms(request);
  const docs = messages.map((m) => [...new Set(tokenize(m.content))]);
  const touchesRequest = (d: string) => requestTerms.some((t) => termsMatch(d, t));

  const expansion = new Set<string>();
  docs.forEach((doc, i) => {
    if (messages[i].protectedLevel === "critical" && doc.some(touchesRequest)) doc.forEach((d) => touchesRequest(d) || expansion.add(d));
  });
  const queryTerms = [...requestTerms, ...expansion];

  // Rarer terms carry more signal (smoothed IDF), squared so specific terms dominate common ones.
  const weights = new Map(
    queryTerms.map((t) => {
      const df = docs.filter((d) => d.some((x) => termsMatch(x, t))).length;
      const idf = Math.log(1 + (messages.length + 1) / (df + 1)) ** 2;
      return [t, idf * (expansion.has(t) ? EXPANSION_WEIGHT : 1) * (important.has(t) ? IMPORTANT_TERM_WEIGHT : 1) * (isGeneric(t) ? GENERIC_WEIGHT : 1)];
    }),
  );
  const totalWeight = requestTerms.reduce((sum, t) => sum + weights.get(t)!, 0) || 1;
  const overlap = (terms: string[]) => {
    const matched = queryTerms.filter((t) => terms.some((d) => termsMatch(d, t)));
    return { matched, score: Math.min(1, matched.reduce((sum, t) => sum + weights.get(t)!, 0) / totalWeight) };
  };

  // Memory items that match the request, and how strongly.
  const memoryScores = new Map<string, number>();
  for (const item of memory) {
    const requestCentric = requestTerms.length ? overlap([...new Set(tokenize(`${item.key.replace(/_/g, " ")} ${item.value}`))]).score : 0;
    memoryScores.set(item.id, Math.max(requestCentric, itemCoverage(item, requestTerms)));
  }
  const MEMORY_MATCH = 0.15;
  const memoryOfMessage = (id: string) => Math.max(0, ...memory.filter((m) => m.sourceIds.includes(id)).map((m) => memoryScores.get(m.id)!));
  const isMemorySource = (id: string) => memory.some((m) => m.sourceIds.includes(id));

  const raw = docs.map((doc) => overlap(doc));
  const n = messages.length;

  const scores = messages.map((m, i): RelevanceScore => {
    let lexical = raw[i].score;
    let pairedWith: string | undefined;
    if (!m.protectedLevel) {
      // Only a question and its reply pair up: user -> next assistant, assistant -> previous user.
      const j = m.role === "user" ? i + 1 : i - 1;
      const nb = messages[j];
      if (nb && !nb.protectedLevel && nb.role !== m.role && raw[j].score >= PAIR_MIN_SCORE && raw[j].score * PAIR_DECAY > lexical) {
        lexical = raw[j].score * PAIR_DECAY;
        pairedWith = nb.id;
      }
    }
    const typeFactor = TYPE_FACTOR[m.contentType];
    const lexT = Math.min(1, lexical * typeFactor);
    const mem = memoryOfMessage(m.id);
    const memMatch = mem >= MEMORY_MATCH ? Math.min(1, mem) : 0;
    const importance = m.protectedLevel ? 1 : isMemorySource(m.id) ? 0.6 : m.contentType === "decision" || m.contentType === "constraint" || m.contentType === "preference" ? 0.5 : 0.2;
    const recency = 0.5 ** ((n - 1 - i) / 8);
    const gate = lexT > 0 || memMatch > 0 ? 1 : 0;
    const sem = semantic[m.id] ?? 0;
    const combined = Math.min(1, lexT + 0.15 * memMatch + gate * (0.06 * importance + 0.06 * recency));
    const round = (x: number) => Math.round(x * 100) / 100;
    return {
      score: round(Math.max(sem, combined)),
      signals: { lexical: round(lexical), typeFactor, importance: round(importance), recency: round(recency), memory: round(memMatch), semantic: round(sem) },
      matched: raw[i].matched,
      pairedWith,
    };
  });
  return { scores, requestTerms, memoryScores };
}

export const RETRIEVE_THRESHOLD = 0.25;
// A memory item costs a few tokens, so weaker relevance justifies carrying it.
export const MEMORY_THRESHOLD = 0.15;
