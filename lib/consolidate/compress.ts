// Deduplication and deterministic compression. Extractive: representations are made only of original message
// text (verbatim lines, counts, and selected sentences), so nothing is invented.
import { createHash } from "node:crypto";
import { termsMatch, tokenize } from "./relevance";
import { estimateText } from "./tokens";
import { exactTokens } from "./text";
import type { ContentType, Role } from "../types";

export type PoolItem = { id: string; role: Role; content: string; contentType: ContentType };
export type Group = { ids: string[]; kind: "duplicate" | "related_logs"; event?: string };

// Equivalence signature: case/whitespace and timestamps are ignored; every other value (numbers, ids) still counts.
export const signature = (s: string) =>
  s
    .toLowerCase()
    .replace(/\d{4}-\d{2}-\d{2}[t ]\d{2}:\d{2}:\d{2}(\.\d+)?z?/g, "#t")
    .replace(/\b\d{1,2}:\d{2}:\d{2}(\.\d+)?\b/g, "#t")
    .replace(/\s+/g, " ")
    .trim();

// Template signature for near-identical repeated logs/tool output: also masks numbers, hex ids, uuids and quoted values.
export const templateSignature = (s: string) =>
  signature(s)
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "#u")
    .replace(/\b0x[0-9a-f]+\b|\b[0-9a-f]{12,}\b/g, "#h")
    .replace(/(["'])[^"'\n]{1,60}\1/g, "#s")
    .replace(/\d+(?:\.\d+)?/g, "#n");

// Primary error/event of a log line: the earliest match of an env-style name, error code, or exception name.
const EVENT_RES = [/\b[A-Z][A-Z0-9]*_[A-Z0-9_]+\b/, /\bE(?!RROR\b)[A-Z]{4,}\b/, /\b\w+(?:Error|Exception)\b/, /\bCrashLoopBackOff\b/, /\berror TS\d+\b/i];
export function primaryEvent(text: string): string | null {
  const hits = EVENT_RES.map((re) => text.match(re)).filter((m): m is RegExpMatchArray => !!m);
  return hits.sort((a, b) => a.index! - b.index!)[0]?.[0] ?? null;
}

const isLogish = (t: ContentType) => t === "log" || t === "tool_output";

export function findGroups(pool: PoolItem[]): Group[] {
  const groups: Group[] = [];
  const grouped = new Set<string>();
  const add = (members: PoolItem[], event?: string) => {
    const distinct = new Set(members.map((m) => signature(m.content)));
    groups.push({ ids: members.map((m) => m.id), kind: distinct.size === 1 ? "duplicate" : "related_logs", event });
    members.forEach((m) => grouped.add(m.id));
  };
  const bucket = (items: PoolItem[], keyOf: (m: PoolItem) => string | null) => {
    const map = new Map<string, PoolItem[]>();
    for (const m of items) {
      const k = keyOf(m);
      if (k) map.set(k, [...(map.get(k) ?? []), m]);
    }
    return map;
  };

  // Logs / tool output that share a template (same line with different numbers, ids, ...).
  for (const members of bucket(pool.filter((m) => isLogish(m.contentType)), (m) => `${m.role}|${templateSignature(m.content)}`).values()) {
    if (members.length >= 2) add(members, primaryEvent(members[0].content) ?? undefined);
  }
  // Related logs: same role, same primary event.
  for (const [key, members] of bucket(pool.filter((m) => isLogish(m.contentType) && !grouped.has(m.id)), (m) => {
    const e = primaryEvent(m.content);
    return e ? `${m.role}|${e}` : null;
  })) {
    if (members.length >= 2) add(members, key.split("|")[1]);
  }
  // Everything else: equivalent copies of the same message.
  for (const members of bucket(pool.filter((m) => !grouped.has(m.id)), (m) => `${m.role}|${signature(m.content)}`).values()) {
    if (members.length > 1) add(members);
  }
  return groups;
}

export function representGroup(group: Group, contents: string[], isLog: boolean): string {
  const distinct = new Map<string, { text: string; n: number }>();
  for (const c of contents) {
    const sig = signature(c);
    const cur = distinct.get(sig);
    if (cur) cur.n++;
    else distinct.set(sig, { text: c.trim(), n: 1 });
  }
  const parts = [...distinct.values()];
  if (group.kind === "duplicate") return `Repeated ${isLog ? "log" : "message"} (${contents.length}x): ${parts[0].text}`;
  const fmt = (p: { text: string; n: number }) => (p.n > 1 ? `${p.text} (×${p.n})` : p.text);
  const label = group.event ? `${contents.length}x, ${group.event}` : `${contents.length}x`;
  if (parts.length <= 3) return `Related logs (${label}): ${parts.map(fmt).join(" | ")}`;
  return `Related logs (${label}; ${parts.length - 2} similar lines omitted between first and last): ${fmt(parts[0])} | ${fmt(parts[parts.length - 1])}`;
}

// Text whose exact wording likely matters: code spans, urls, env names, paths, file names.
const EXACT_RE = /`|https?:|\b[A-Z][A-Z0-9]*_[A-Z0-9_]+\b|\S+\/\S+|\b\w+\.(?:ts|tsx|js|json|md|css|ya?ml)\b/;
export const needsExactWording = (s: string) => EXACT_RE.test(s);

// Extractive summary: keep the highest-information sentences (request-term overlap, numbers, proper nouns)
// within a token budget, in original order.
export function summarizeExtractive(texts: string[], request: string, budgetTokens: number): string | null {
  const queryTerms = tokenize(request);
  const sentences = texts.flatMap((t) => t.trim().split(/(?<=[.!?])\s+/)).filter(Boolean);
  const scored = sentences.map((text, order) => {
    const terms = tokenize(text);
    const overlap = terms.filter((t) => queryTerms.some((q) => termsMatch(t, q))).length;
    const numbers = (text.match(/\d+/g) ?? []).length;
    const proper = (text.match(/(?<=\s)[A-Z][a-zA-Z]+/g) ?? []).length;
    return { text, order, score: overlap * 3 + numbers + proper * 0.5, cost: estimateText(text) + 1 };
  });
  const picked: typeof scored = [];
  let used = 0;
  for (const s of [...scored].sort((a, b) => b.score - a.score || a.order - b.order)) {
    if (used + s.cost > budgetTokens) continue;
    picked.push(s);
    used += s.cost;
  }
  if (!picked.length || picked.length === sentences.length) return null;
  return picked.sort((a, b) => a.order - b.order).map((s) => s.text).join(" ");
}

// Content-addressed key for cached compressed representations.
export const cacheKeyFor = (kind: string, sources: { id: string; content: string }[]) =>
  createHash("sha256").update(kind + "\n" + sources.map((s) => `${s.id}:${createHash("sha256").update(s.content).digest("hex")}`).join("\n")).digest("hex").slice(0, 32);

// Guard against invented content: every number and exact identifier in a model-written summary must occur in its sources.
export function summaryIsFaithful(summary: string, sources: string[]): { ok: boolean; invented: string[] } {
  const haystack = sources.join("\n").toLowerCase();
  // Bare "a/b" words are prose shorthand (and/or), not identifiers; real paths carry an extension or a leading slash.
  const identifiers = exactTokens(summary).filter((t) => !/^[\w-]+\/[\w-]+$/.test(t));
  const claims = [...identifiers, ...(summary.match(/\b\d[\d,.]*\b/g) ?? [])];
  const invented = [...new Set(claims)].filter((c) => !haystack.includes(c.toLowerCase().replace(/[,.]+$/, "")));
  return { ok: invented.length === 0, invented };
}
