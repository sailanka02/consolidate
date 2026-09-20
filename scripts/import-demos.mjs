// Adds the two measured demo conversations (demo-data/demos.db, produced by `npm run seed:demos`) to an existing database.
//   npm run import-demos                       -> into CONSOLIDATE_DB_PATH (default .consolidate/consolidate.db)
//   npm run import-demos -- /data/consolidate.db
// Idempotent (skips conversations already present), never modifies existing rows, runs in one transaction.
// The target must already have been opened by the app once (so it is migrated to the same schema version).
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const source = resolve(process.env.CONSOLIDATE_DEMO_SNAPSHOT || "demo-data/demos.db");
const target = resolve(process.argv[2] || process.env.CONSOLIDATE_DB_PATH || ".consolidate/consolidate.db");
for (const [what, p] of [["Demo snapshot", source], ["Target database", target]]) {
  if (!existsSync(p)) { console.error(`${what} not found: ${p}`); process.exit(1); }
}

const db = new DatabaseSync(target);
db.exec("PRAGMA foreign_keys = ON");
db.exec(`ATTACH DATABASE '${source.replace(/'/g, "''")}' AS demo`);
const version = (schema) => db.prepare(`PRAGMA ${schema}.user_version`).get().user_version;
if (version("main") !== version("demo")) {
  console.error(`Schema mismatch: target is v${version("main")}, snapshot is v${version("demo")}. Start the app once so it migrates, then retry.`);
  process.exit(1);
}

// Copy every column except autoincrement ids (message.seq, run_attempt.id, utility_call.id), which the target assigns itself.
const AUTO = { message: ["seq"], run_attempt: ["id"], utility_call: ["id"] };
const cols = (t) => db.prepare(`PRAGMA main.table_info(${t})`).all().map((c) => c.name).filter((c) => !(AUTO[t] ?? []).includes(c));
const copy = (t, where) => {
  const c = cols(t).map((x) => `"${x}"`).join(", ");
  return db.prepare(`INSERT INTO main.${t} (${c}) SELECT ${c} FROM demo.${t} WHERE ${where}`).run().changes;
};

const wanted = db.prepare("SELECT id, title FROM demo.conversation ORDER BY created_at").all();
db.exec("BEGIN");
try {
  for (const { id, title } of wanted) {
    if (db.prepare("SELECT 1 FROM main.conversation WHERE id = ? OR title = ?").get(id, title)) { console.log(`skip (already present): ${title}`); continue; }
    const p = `'${id.replace(/'/g, "''")}'`;
    const n = {
      conversation: copy("conversation", `id = ${p}`),
      message: copy("message", `conversation_id = ${p}`),
      message_annotation: copy("message_annotation", `message_id IN (SELECT id FROM demo.message WHERE conversation_id = ${p})`),
      memory_item: copy("memory_item", `conversation_id = ${p}`),
      compressed_group: copy("compressed_group", `conversation_id = ${p}`),
      compiler_run: copy("compiler_run", `conversation_id = ${p}`),
      run_attempt: copy("run_attempt", `run_id IN (SELECT id FROM demo.compiler_run WHERE conversation_id = ${p})`),
      context_decision: copy("context_decision", `run_id IN (SELECT id FROM demo.compiler_run WHERE conversation_id = ${p})`),
      utility_call: copy("utility_call", `run_id IN (SELECT id FROM demo.compiler_run WHERE conversation_id = ${p})`),
    };
    console.log(`imported: ${title}  ${JSON.stringify(n)}`);
  }
  db.exec("COMMIT");
} catch (e) {
  db.exec("ROLLBACK");
  console.error(`Import failed, nothing was changed: ${e.message}`);
  process.exit(1);
}
