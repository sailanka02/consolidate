// npm run seed:demos   (explicit, one-time; never runs at app startup)
//   CONSOLIDATE_SEED_DEMOS=1 [CONSOLIDATE_SEED_ONLY=enterprise|bakery] [CONSOLIDATE_DB_PATH=...] [CONSOLIDATE_EXPORT_DIR=demo-exports] npm run seed:demos
// Runs each scenario's turns through the real engine against the database at CONSOLIDATE_DB_PATH, then exports graph-ready
// metrics read back from the persisted runs. It is executed through vitest only to reuse the project's TypeScript setup.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { it } from "vitest";
import { getDb } from "@/lib/db";
import * as repo from "@/lib/db/repo";
import { assertSeedAllowed, exportDemo, seedScenario, toCsv, type DemoExport } from "@/lib/demo/seed";
import { SCENARIOS } from "@/lib/demo/scenarios";
import { getProvider } from "@/lib/model";

if (existsSync(".env.local")) process.loadEnvFile(".env.local"); // does not override variables already set

it("seed demo conversations", async () => {
  assertSeedAllowed();
  const only = process.env.CONSOLIDATE_SEED_ONLY?.split(",").map((s) => s.trim()).filter(Boolean);
  const chosen = SCENARIOS.filter((s) => !only || only.includes(s.key));
  if (!chosen.length) throw new Error(`CONSOLIDATE_SEED_ONLY matched no scenario (known: ${SCENARIOS.map((s) => s.key).join(", ")}).`);
  const db = getDb();
  const provider = getProvider();
  const dir = process.env.CONSOLIDATE_EXPORT_DIR || "demo-exports";
  mkdirSync(dir, { recursive: true });
  const exports: DemoExport[] = [];
  for (const s of chosen) {
    if (!s.complete) console.warn(`NOTE: "${s.title}" has only the ${s.turns.length} turns supplied so far; seeding those and it will resume when more are added.`);
    const res = await seedScenario(db, provider, s, (n, t) => console.log(`[seed] ${s.key} turn ${n}/${t}`));
    console.log(`[seed] ${res.title}: ${res.action} (${res.turnsRun} turn(s) run) -> ${res.conversationId}`);
    const e = exportDemo(db, res.conversationId);
    exports.push(e);
    writeFileSync(join(dir, `${s.key}.json`), JSON.stringify(e, null, 2));
    writeFileSync(join(dir, `${s.key}.csv`), toCsv(e));
  }
  writeFileSync(join(dir, "summary.json"), JSON.stringify(exports.map((e) => ({ title: e.title, synthetic: e.synthetic, ...e.totals })), null, 2));
  console.log(`[seed] exported ${exports.length} scenario(s) to ${dir}/ (${repo.listConversations(db).length} conversations in the database)`);
}, 3_600_000);
