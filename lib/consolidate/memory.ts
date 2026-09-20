// Structured memory: durable facts, decisions, preferences, state and constraints stated in a conversation.
// Deterministic extraction handles obvious statements; ambiguous durable information is extracted by a batched
// model call (semantic.ts) that feeds the same `applyStatements` merge. Casual or ephemeral talk yields nothing.
import { estimateText, estimateMessages } from "./tokens";
import { isQuestionOrRequest, sentencesOf, wordCount } from "./text";
import { strongConstraintSentence } from "./protection";
import type { MemoryItem, MemoryStatement } from "../types";

export const slug = (s: string) => s.toLowerCase().replace(/`/g, "").replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
const clean = (s: string) => s.replace(/`/g, "").replace(/\s+/g, " ").trim().replace(/[.;:!]+$/, "");

const KEY_ALIASES: Record<string, string> = { db: "database", datastore: "database", auth: "authentication", lang: "language", env: "environment", repo: "repository" };
export const canonicalKey = (k: string) =>
  slug(k)
    .split("_")
    .map((w) => KEY_ALIASES[w] ?? w)
    .join("_");

// Small lexicon so "using Next.js for the frontend" becomes frontend_framework and "PostgreSQL 17" becomes database.
const CATEGORIES: [RegExp, string][] = [
  [/\b(next\.?js|react|vue|angular|svelte|express|django|rails|flask|nestjs|fastapi|spring)\b/i, "framework"],
  [/\b(postgres(?:ql)?|mysql|mariadb|mongodb|sqlite|dynamodb|cockroachdb)\b/i, "database"],
  [/\b(redis|memcached)\b/i, "cache"],
  [/\b(aws|gcp|azure|vercel|heroku|fly\.io)\b/i, "cloud"],
  [/\b(python|typescript|javascript|rust|golang|go|java|kotlin|swift|ruby|c\+\+|c#)\b/i, "language"],
];

function keyFor(value: string, target: string | undefined, fallbackPrefix: string): string {
  const category = CATEGORIES.find(([re]) => re.test(value))?.[1];
  const t = target ? canonicalKey(target) : "";
  if (t) return category && !t.endsWith(category) ? `${t}_${category}` : t;
  return category ?? `${fallbackPrefix}_${slug(value).split("_").slice(0, 3).join("_")}`;
}

const NOT_SUBJECT = /^(it|this|that|there|these|those|which|what|who|how|why|i|we|you|they|he|she|here|one|everything|nothing|something)\b/i;
const EPHEMERAL_SUBJECT = /^(?:the |this |that |my )?(?:test|tests|build|error|errors|bug|output|result|results|log|logs|issue|problem|page|code|response|answer|question|thing|weather|day|time|server|app|function|file|command|script|line|message|screen)s?$/i;
const EPHEMERAL_VALUE = /^(?:failing|failed|broken|working|fine|good|bad|slow|fast|weird|confusing|done|ready|late|stuck|down|up|running|crashing|great|ok|okay|nice|hard|easy|not\b.*|still\b.*|just\b.*|about\b.*|like\b.*|so\b.*|too\b.*|very\b.*|really\b.*|kind of\b.*|sort of\b.*|a bit\b.*|maybe\b.*|probably\b.*|no\b.*)$/i;
const validSubject = (s: string) => wordCount(s) <= 4 && !NOT_SUBJECT.test(s.trim()) && !EPHEMERAL_SUBJECT.test(s.trim());
const validValue = (s: string, max: number) => wordCount(s) <= max && !EPHEMERAL_VALUE.test(s.trim());

type Pattern = { re: RegExp; build: (m: RegExpMatchArray) => MemoryStatement | null };
// Reasons attached to a durable value ("PostgreSQL 16 because of hosting limits") are not part of the value.
const trimClause = (v: string) => v.split(/[,;]?\s+(?:because|due to|since|as|so that|which|but|though)\b/i)[0].trim();
const st = (key: string, value: string, type: MemoryStatement["type"], confidence: number, op: MemoryStatement["op"] = "set"): MemoryStatement | null => {
  const v = type === "constraint" ? value : trimClause(value);
  return key && v ? { key, value: v, type, confidence, op } : null;
};

const PATTERNS: Pattern[] = [
  // KEY=VALUE (optionally "Set KEY=VALUE")
  { re: /^(?:set\s+)?`?([A-Za-z][\w.]{1,40})\s*=\s*([^\s`]{1,60})`?$/i, build: (m) => st(canonicalKey(m[1]), clean(m[2]), "state", 0.9) },
  // "We no longer use X" / "we stopped using X"
  {
    re: /^we(?:'ve| have)?\s+(?:no longer\s+(?:use|using)|stopped using|dropped|removed)\s+(.+?)(?:\s+for\s+(?:the\s+)?(.+))?$/i,
    build: (m) => st(keyFor(m[1], m[2], "uses"), clean(m[1]), "fact", 0.85, "remove"),
  },
  // "We decided to use X [for Y]"
  {
    re: /^(?:actually,?\s+)?(?:we|i)(?:'ve| have)?\s+(?:decided|agreed|chosen|chose|settled)\s+(?:to\s+(?:use|go with|adopt)\s+|on\s+|to\s+)(.+?)(?:\s+for\s+(?:the\s+)?(.+))?$/i,
    build: (m) => st(keyFor(m[1], m[2], "decision"), clean(m[1]), "decision", 0.9),
  },
  // "We're going with X" / "let's go with X" / "we'll use X"
  {
    re: /^(?:(?:we|i)(?:'re| are|'ll| will)\s+(?:going with|using|use|go with)|let'?s\s+(?:go with|use|stick with))\s+(.+?)(?:\s+for\s+(?:the\s+)?(.+))?$/i,
    build: (m) => st(keyFor(m[1], m[2], "decision"), clean(m[1]), "decision", 0.85),
  },
  // "We switched/moved/migrated to X"
  {
    re: /^(?:actually,?\s+)?we(?:'ve| have)?\s+(?:switched|moved|migrated)\s+(?:over\s+)?to\s+(.+?)(?:\s+for\s+(?:the\s+)?(.+))?$/i,
    build: (m) => st(keyFor(m[1], m[2], "decision"), clean(m[1]), "decision", 0.9),
  },
  // "We use / we're using X [for Y]"
  {
    re: /^we(?:'re| are)?\s+(?:currently\s+)?(?:using|use|run|running)\s+(.+?)(?:\s+for\s+(?:the\s+)?(.+))?$/i,
    build: (m) => st(keyFor(m[1], m[2], "uses"), clean(m[1]), "fact", 0.85),
  },
  // "We're building X"
  {
    re: /^(?:we|i)(?:'re| am| are)\s+(?:building|making|creating|developing|working on)\s+(.{3,80})$/i,
    build: (m) => (validValue(m[1], 12) ? st("project", clean(m[1]), "fact", 0.75) : null),
  },
  // Personal / situational facts.
  { re: /^i(?:'m| am)\s+(?:a|an|the)\s+(.{3,60})$/i, build: (m) => (/^(?:bit|little|lot|fan|beginner at)\b/i.test(m[1]) ? null : st("user_role", clean(m[1]), "fact", 0.75)) },
  { re: /^i\s+(?:live|am based|'m based)\s+in\s+(.{2,40})$/i, build: (m) => st("user_location", clean(m[1]), "fact", 0.8) },
  { re: /^i\s+work\s+(?:at|for)\s+(.{2,50})$/i, build: (m) => st("user_workplace", clean(m[1]), "fact", 0.8) },
  { re: /^i\s+work\s+on\s+(.{2,60})$/i, build: (m) => st("user_project", clean(m[1]), "fact", 0.75) },
  // Preferences.
  {
    re: /^(?:(?:we|i)\s+)?(?:prefer|like to use|would rather use|'d rather use)\s+(.+)$/i,
    build: (m) => {
      const lead = clean(m[1]).split(/\s+/).filter((w) => !/^(and|or|the|a|an|of|in|to)$/i.test(w)).slice(0, 2).join(" ");
      return st(`preference_${slug(lead)}`, clean(m[1]), "preference", 0.8);
    },
  },
  // Directive constraints: "Always X", "Never X", "Do not X", "Make sure X".
  {
    re: /^(?:please\s+)?((?:always|never|do not|don't|dont|make sure|ensure|avoid|only use|use only)\b.{3,160})$/i,
    build: (m) => st(`rule_${slug(m[1]).split("_").slice(0, 4).join("_")}`, clean(m[1]), "constraint", 0.85),
  },
  // "X must / shall (not) ..."
  {
    re: /^(?:the\s+)?(.{2,40}?)\s+(must(?:\s+not)?|shall(?:\s+not)?)\s+(.+)$/i,
    build: (m) => (validSubject(m[1]) ? st(`${canonicalKey(m[1])}_requirement`, clean(`${m[2].toLowerCase()} ${m[3]}`), "constraint", 0.75) : null),
  },
  // "X uses Y"
  { re: /^(?:the\s+)?(.{2,40}?)\s+uses\s+(.{1,80})$/i, build: (m) => (validSubject(m[1]) && validValue(m[2], 10) ? st(canonicalKey(m[1]), clean(m[2]), "fact", 0.75) : null) },
  // "X is Y" / "the deadline is June 3"
  {
    re: /^(?:the\s+)?(.{2,40}?)\s+(?:is|are)\s+(?:now\s+|currently\s+)?(.{1,60})$/i,
    build: (m) => (validSubject(m[1]) && validValue(m[2], 8) ? st(canonicalKey(m[1]), clean(m[2]), /^(?:my|our)\b/i.test(m[1]) ? "fact" : "state", 0.75) : null),
  },
];

const PREFIX = /^(?:internal note|note|fyi|update|reminder|for the record|heads up|just so we're aligned|actually|btw|by the way)\s*[,:]?\s+/i;

export type Extraction = {
  statements: MemoryStatement[];
  // Every sentence of the message was durable and captured: routing the message to MEMORY drops nothing.
  complete: boolean;
};

// Deterministic extraction from one message's text.
export function extractStatements(content: string): Extraction {
  const sentences = sentencesOf(content).map((s) => s.replace(PREFIX, "").trim()).filter(Boolean);
  const statements: MemoryStatement[] = [];
  let uncaptured = content.includes("```");
  for (const raw of sentences) {
    const sentence = raw.replace(/[.!]+$/, "");
    if (isQuestionOrRequest(sentence) && !/^(?:do not|don't|dont)\b/i.test(sentence)) {
      uncaptured = true;
      continue;
    }
    let hit: MemoryStatement | null = null;
    for (const { re, build } of PATTERNS) {
      const m = sentence.match(re);
      if (m && (hit = build(m))) break;
    }
    if (hit) statements.push(hit);
    else uncaptured = true;
  }
  // A strong user constraint the patterns missed still deserves a memory entry (its original text stays protected).
  if (!statements.some((s) => s.type === "constraint")) {
    const c = strongConstraintSentence(content);
    if (c) statements.push({ key: `rule_${slug(c).split("_").slice(0, 4).join("_")}`, value: clean(c), type: "constraint", confidence: 0.7, op: "set" });
  }
  return { statements, complete: statements.length > 0 && !uncaptured };
}

const CATEGORY_NAMES = new Set(CATEGORIES.map(([, name]) => name));
const lastSegment = (k: string) => k.split("_").pop() ?? k;

// "database" and "metadata_database" describe the same slot: a statement about a category joins the single
// existing item of that category instead of creating a competing one.
function resolveKey(existing: Map<string, MemoryItem>, key: string): string {
  if (existing.has(key)) return key;
  const cat = lastSegment(key);
  if (!CATEGORY_NAMES.has(cat)) return key;
  const same = [...existing.values()].filter((m) => m.active && lastSegment(m.key) === cat);
  return same.length === 1 ? same[0].key : key;
}

export type MemoryChange = { key: string; value: string; type: MemoryItem["type"]; change: "created" | "updated" | "unchanged" | "removed"; sourceIds: string[]; previousValue?: string };

// Merge statements into existing memory. Same key + same value: dedupe (sources merged, confidence up).
// Same key + new value: the newer statement supersedes (old value kept as provenance). "remove" deactivates.
export function applyStatements(
  existing: MemoryItem[],
  incoming: { sourceId: string; statements: MemoryStatement[] }[],
  mkId: () => string,
): { items: MemoryItem[]; changes: MemoryChange[]; touched: MemoryItem[] } {
  const byKey = new Map(existing.map((m) => [m.key, { ...m, sourceIds: [...m.sourceIds], previousValues: [...m.previousValues] }]));
  const touched = new Set<string>();
  const changes = new Map<string, MemoryChange>();
  for (const { sourceId, statements } of incoming) {
    for (const s of statements) {
      const key = resolveKey(byKey, canonicalKey(s.key) || s.key);
      const cur = byKey.get(key);
      const record = (change: MemoryChange["change"], item: MemoryItem, previousValue?: string) => {
        touched.add(key);
        changes.set(key, { key, value: item.value, type: item.type, change, sourceIds: item.sourceIds, ...(previousValue ? { previousValue } : {}) });
      };
      if (s.op === "remove") {
        if (cur?.active) {
          cur.active = false;
          if (!cur.sourceIds.includes(sourceId)) cur.sourceIds.push(sourceId);
          record("removed", cur);
        }
        continue;
      }
      if (!cur) {
        const item: MemoryItem = { id: mkId(), key, value: s.value, type: s.type, sourceIds: [sourceId], confidence: s.confidence, active: true, previousValues: [] };
        byKey.set(key, item);
        record("created", item);
        continue;
      }
      if (!cur.sourceIds.includes(sourceId)) cur.sourceIds.push(sourceId);
      if (!cur.active) {
        Object.assign(cur, { value: s.value, type: s.type, confidence: s.confidence, active: true });
        record("created", cur);
      } else if (cur.value.toLowerCase() === s.value.toLowerCase()) {
        cur.confidence = Math.min(0.99, Math.max(cur.confidence, s.confidence) + 0.05);
        if (!changes.has(key)) record("unchanged", cur);
        else touched.add(key);
      } else {
        const previous = cur.value;
        cur.previousValues = [...cur.previousValues, previous];
        Object.assign(cur, { value: s.value, type: s.type, confidence: s.confidence });
        record("updated", cur, previous);
      }
    }
  }
  const items = [...byKey.values()];
  return { items, changes: [...changes.values()], touched: items.filter((i) => touched.has(i.key)) };
}

export const memoryLine = (m: Pick<MemoryItem, "key" | "value">) => `${m.key}: ${m.value}`;
export const formatMemoryBlock = (items: Pick<MemoryItem, "key" | "value">[]) => `STRUCTURED MEMORY\n${items.map(memoryLine).join("\n")}`;
export const memoryLineTokens = (m: Pick<MemoryItem, "key" | "value">) => estimateText(memoryLine(m)) + 1;
export const memoryBlockTokens = (items: Pick<MemoryItem, "key" | "value">[]) => (items.length ? estimateMessages([{ content: formatMemoryBlock(items) }]) : 0);
