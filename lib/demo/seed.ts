// One-time demo seeding and export. Explicit only: nothing in the application imports this file, `npm run seed:demos` is the
// single entry point, and it refuses to run without CONSOLIDATE_SEED_DEMOS=1. Every turn goes through runTurn (the same engine
// as normal users, real provider, real counting); this module never writes a message, run, memory item or metric itself.
import type { DatabaseSync } from "node:sqlite";
import * as repo from "../db/repo";
import { runTurn } from "../engine/turn";
import type { ModelProvider } from "../model";
import type { DemoScenario } from "./scenarios";

export type Env = Record<string, string | undefined>;

export function assertSeedAllowed(env: Env = process.env): void {
  if (env.CONSOLIDATE_SEED_DEMOS !== "1") throw new Error("Refusing to seed demo conversations: set CONSOLIDATE_SEED_DEMOS=1 to run this explicit one-time script.");
  if (env.MODEL_PROVIDER !== "anthropic-api") throw new Error("Refusing to seed: demo turns must go through the real Anthropic provider (MODEL_PROVIDER=anthropic-api), never a stand-in.");
  if (!env.ANTHROPIC_API_KEY?.trim()) throw new Error("Refusing to seed: ANTHROPIC_API_KEY is not set.");
}

export type SeedResult = { key: string; title: string; conversationId: string; action: "created" | "resumed" | "skipped"; turnsRun: number; turnsTotal: number };

// Idempotent by exact title: an existing conversation is never duplicated. A partly seeded one (or one whose scenario has
// gained turns) is RESUMED from its next unsent turn, after checking that its history is exactly this scenario's prefix.
export async function seedScenario(db: DatabaseSync, provider: ModelProvider, s: DemoScenario, onTurn?: (n: number, total: number) => void): Promise<SeedResult> {
  const existing = repo.listConversations(db).filter((c) => c.title === s.title);
  if (existing.length > 1) throw new Error(`Found ${existing.length} conversations titled "${s.title}"; refusing to guess which one to continue.`);
  let conv = existing[0];
  let done = 0;
  if (conv) {
    const sent = repo.listMessages(db, conv.id).filter((m) => m.role === "user").map((m) => m.content);
    if (sent.some((t, i) => t !== s.turns[i]) || sent.length > s.turns.length) throw new Error(`"${s.title}" exists but its messages are not this scenario's turns; refusing to modify it.`);
    done = sent.length;
    if (done === s.turns.length) return { key: s.key, title: s.title, conversationId: conv.id, action: "skipped", turnsRun: 0, turnsTotal: s.turns.length };
  } else conv = repo.createConversation(db, s.title);

  for (let i = done; i < s.turns.length; i++) {
    await runTurn(db, provider, { conversationId: conv.id, content: s.turns[i] });
    // The engine titles a conversation from its first message; the demo title is the (only) demo marker.
    if (i === 0) repo.touchConversation(db, conv.id, s.title);
    onTurn?.(i + 1, s.turns.length);
  }
  return { key: s.key, title: s.title, conversationId: conv.id, action: done === 0 ? "created" : "resumed", turnsRun: s.turns.length - done, turnsTotal: s.turns.length };
}

// ---------------------------------------------------------------- export (read-only, from persisted runs)

export type TurnMetrics = {
  turn: number;
  prompt: string;
  countSource: string;
  fullTokens: number;
  initialCompiledTokens: number;
  finalCompiledTokens: number;
  initialReductionPercent: number;
  finalReductionPercent: number;
  tokensAvoided: number;
  economicDecision: string | null;
  evaluationStatus: string;
  failureCategory: string | null;
  retryDecision: string | null;
  contextChanged: boolean | null;
  qualityWarning: boolean;
  mainModelGenerations: number;
  evaluatorCalls: number;
  utilityCalls: number;
  grossSavingsUsd: number | null;
  optimizerCostUsd: number | null;
  fallbackWasteUsd: number | null;
  netSavingsUsd: number | null;
  generationCostUsd: number | null;
  compilerMs: number;
  tokenCountMs: number | null;
  modelMs: number;
  routing: { keep: number; memory: number; retrieve: number; compress: number; omit: number } | null;
  memoryItemsSent: number;
  referential: string | null;
};

export type DemoExport = {
  label: string;
  synthetic: true;
  title: string;
  conversationId: string;
  turns: TurnMetrics[];
  totals: { turns: number; fullTokens: number; finalCompiledTokens: number; tokensAvoided: number; weightedReductionPercent: number; grossSavingsUsd: number; optimizerCostUsd: number; fallbackWasteUsd: number; netSavingsUsd: number; generationCostUsd: number; mainModelGenerations: number; retries: number; fullContextRoutes: number; qualityWarnings: number };
  series: { labels: string[]; fullTokens: number[]; finalTokens: number[]; cumulativeFullTokens: number[]; cumulativeFinalTokens: number[]; cumulativeNetUsd: number[]; reductionPercent: number[] };
};

const num = (x: number | null | undefined) => x ?? 0;
const r = (x: number, d = 6) => Math.round(x * 10 ** d) / 10 ** d;

export function exportDemo(db: DatabaseSync, conversationId: string): DemoExport {
  const conv = repo.getConversation(db, conversationId)!;
  const ids = (db.prepare("SELECT id FROM compiler_run WHERE conversation_id = ? ORDER BY created_at, rowid").all(conversationId) as { id: string }[]).map((x) => x.id);
  const turns: TurnMetrics[] = ids.map((id, i) => {
    const { summary: s, trace: t } = repo.getRun(db, id)!;
    const a = t.evaluation.attempts;
    const prompt = t.requestAnalysis.request.replace(/\s+/g, " ");
    return {
      turn: i + 1,
      prompt: prompt.length > 90 ? prompt.slice(0, 90) + "…" : prompt,
      countSource: s.countSource,
      fullTokens: s.originalTokens,
      initialCompiledTokens: s.initialCompiledTokens,
      finalCompiledTokens: s.compiledTokens,
      initialReductionPercent: s.initialReductionPercent,
      finalReductionPercent: s.finalReductionPercent,
      tokensAvoided: s.tokensAvoided,
      economicDecision: t.economics?.decision ?? null,
      evaluationStatus: s.evaluationStatus,
      failureCategory: s.failureCategory,
      retryDecision: s.retryDecision,
      contextChanged: s.contextChanged,
      qualityWarning: !!s.qualityWarning,
      mainModelGenerations: a.length,
      evaluatorCalls: t.utilityCalls.filter((u) => u.kind === "evaluation").length,
      utilityCalls: t.utilityCalls.length,
      grossSavingsUsd: s.costs?.grossInputSavingsUsd ?? null,
      optimizerCostUsd: s.costs?.optimizerCostUsd ?? null,
      fallbackWasteUsd: s.costs?.fallbackWasteCostUsd ?? null,
      netSavingsUsd: s.costs?.netSavingsUsd ?? null,
      generationCostUsd: s.costs?.generationCostUsd ?? null,
      compilerMs: s.compilerLatencyMs,
      tokenCountMs: t.compilation.tokenCount?.latencyMs ?? null,
      modelMs: s.modelLatencyMs,
      routing: a[0]?.routing ?? null,
      memoryItemsSent: (a[0]?.memoryInjected ?? []).length,
      referential: t.retrieval.referential ? `${t.retrieval.referential.phrase} (${t.retrieval.referential.kind}, ${t.retrieval.referential.selectedIds.length} selected)` : null,
    };
  });
  const sum = (f: (t: TurnMetrics) => number) => turns.reduce((n, t) => n + f(t), 0);
  const full = sum((t) => t.fullTokens);
  const fin = sum((t) => t.finalCompiledTokens);
  let cf = 0, cs = 0, cn = 0;
  return {
    label: "Synthetic representative demo scenario (not a customer conversation)",
    synthetic: true,
    title: conv.title,
    conversationId,
    turns,
    totals: {
      turns: turns.length,
      fullTokens: full,
      finalCompiledTokens: fin,
      tokensAvoided: full - fin,
      weightedReductionPercent: full ? r(((full - fin) / full) * 100, 1) : 0,
      grossSavingsUsd: r(sum((t) => num(t.grossSavingsUsd))),
      optimizerCostUsd: r(sum((t) => num(t.optimizerCostUsd))),
      fallbackWasteUsd: r(sum((t) => num(t.fallbackWasteUsd))),
      netSavingsUsd: r(sum((t) => num(t.netSavingsUsd))),
      generationCostUsd: r(sum((t) => num(t.generationCostUsd))),
      mainModelGenerations: sum((t) => t.mainModelGenerations),
      retries: turns.filter((t) => t.mainModelGenerations > 1).length,
      fullContextRoutes: turns.filter((t) => t.economicDecision && t.economicDecision !== "optimized").length,
      qualityWarnings: turns.filter((t) => t.qualityWarning).length,
    },
    series: {
      labels: turns.map((t) => `T${t.turn}`),
      fullTokens: turns.map((t) => t.fullTokens),
      finalTokens: turns.map((t) => t.finalCompiledTokens),
      cumulativeFullTokens: turns.map((t) => (cf += t.fullTokens)),
      cumulativeFinalTokens: turns.map((t) => (cs += t.finalCompiledTokens)),
      cumulativeNetUsd: turns.map((t) => (cn = r(cn + num(t.netSavingsUsd)))),
      reductionPercent: turns.map((t) => t.finalReductionPercent),
    },
  };
}

export function toCsv(e: DemoExport): string {
  const cols = Object.keys(e.turns[0] ?? { turn: 0 }) as (keyof TurnMetrics)[];
  const cell = (v: unknown) => (v == null ? "" : typeof v === "object" ? JSON.stringify(v).replace(/"/g, '""') : String(v).includes(",") || String(v).includes('"') || String(v).includes("\n") ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  return [cols.join(","), ...e.turns.map((t) => cols.map((c) => { const v = t[c]; return typeof v === "object" && v !== null ? `"${JSON.stringify(v).replace(/"/g, '""')}"` : cell(v); }).join(","))].join("\n") + "\n";
}
