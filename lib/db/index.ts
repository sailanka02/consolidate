// SQLite persistence. Uses Node's built-in `node:sqlite`, so there is no external database server and no native
// addon to compile. The schema is created and migrated automatically on first use (PRAGMA user_version).
import "server-only";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

// Each entry migrates from version i to i+1.
const MIGRATIONS: string[] = [
  `
  CREATE TABLE conversation (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE message (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    conversation_id TEXT NOT NULL REFERENCES conversation(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('user','assistant')),
    content TEXT NOT NULL,
    created_at TEXT NOT NULL,
    local_token_estimate INTEGER NOT NULL
  );
  CREATE INDEX message_conversation ON message(conversation_id, seq);

  -- Cached analysis of a message: classification, protection, memory-extraction state. Computed once.
  CREATE TABLE message_annotation (
    message_id TEXT PRIMARY KEY REFERENCES message(id) ON DELETE CASCADE,
    content_type TEXT NOT NULL,
    class_method TEXT NOT NULL,
    ambiguous INTEGER NOT NULL DEFAULT 0,
    protected INTEGER NOT NULL DEFAULT 0,
    protection_level TEXT,
    protection_reason TEXT,
    protection_method TEXT,
    memory_complete INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE memory_item (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversation(id) ON DELETE CASCADE,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    type TEXT NOT NULL,
    source_ids TEXT NOT NULL,
    confidence REAL NOT NULL,
    previous_values TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    UNIQUE (conversation_id, key)
  );

  -- Persisted compressed representations, reused so old history is not summarized twice.
  CREATE TABLE compressed_group (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversation(id) ON DELETE CASCADE,
    cache_key TEXT NOT NULL,
    kind TEXT NOT NULL,
    method TEXT NOT NULL,
    source_ids TEXT NOT NULL,
    original_tokens INTEGER NOT NULL,
    compressed_tokens INTEGER NOT NULL,
    summary TEXT NOT NULL,
    reason TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (conversation_id, cache_key)
  );

  CREATE TABLE compiler_run (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversation(id) ON DELETE CASCADE,
    user_message_id TEXT NOT NULL,
    assistant_message_id TEXT,
    original_tokens INTEGER NOT NULL,
    compiled_tokens INTEGER NOT NULL,
    tokens_avoided INTEGER NOT NULL,
    reduction_percent REAL NOT NULL,
    compiler_latency_ms INTEGER NOT NULL,
    model_latency_ms INTEGER NOT NULL,
    evaluation_status TEXT NOT NULL,
    fallback_applied INTEGER NOT NULL,
    fallback_level INTEGER NOT NULL DEFAULT 0,
    fallback_reason TEXT,
    provider_input_tokens INTEGER,
    provider_output_tokens INTEGER,
    saved_omission INTEGER NOT NULL,
    saved_memory INTEGER NOT NULL,
    saved_compression INTEGER NOT NULL,
    saved_deduplication INTEGER NOT NULL,
    provider TEXT,
    model TEXT,
    trace_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX compiler_run_conversation ON compiler_run(conversation_id, created_at);

  -- One row per model attempt of a request: optimized, expanded retry, full context. Failed answers stay here.
  CREATE TABLE run_attempt (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL REFERENCES compiler_run(id) ON DELETE CASCADE,
    idx INTEGER NOT NULL,
    level TEXT NOT NULL,
    passed INTEGER NOT NULL,
    reason TEXT NOT NULL,
    context_tokens INTEGER NOT NULL,
    response TEXT NOT NULL,
    model_latency_ms INTEGER NOT NULL,
    provider_input_tokens INTEGER,
    provider_output_tokens INTEGER
  );

  -- Per-message compiler decision for each run (queryable form of the Context Trace).
  CREATE TABLE context_decision (
    run_id TEXT NOT NULL REFERENCES compiler_run(id) ON DELETE CASCADE,
    message_id TEXT NOT NULL,
    action TEXT NOT NULL,
    content_type TEXT NOT NULL,
    score REAL NOT NULL,
    protected INTEGER NOT NULL,
    reason TEXT NOT NULL,
    tokens INTEGER NOT NULL,
    group_id TEXT,
    duplicate_of TEXT,
    PRIMARY KEY (run_id, message_id)
  );
  `,
  // v2: provider-counted context sizes, actual usage incl. cache, cost accounting, internal call ledger, benchmark.
  // Additive only. For pre-existing rows original_tokens/compiled_tokens stay the local estimates they always were
  // (count_source defaults to 'local_estimate').
  `
  ALTER TABLE compiler_run ADD COLUMN count_source TEXT NOT NULL DEFAULT 'local_estimate';
  ALTER TABLE compiler_run ADD COLUMN count_error TEXT;
  ALTER TABLE compiler_run ADD COLUMN full_estimate_tokens INTEGER;
  ALTER TABLE compiler_run ADD COLUMN compiled_estimate_tokens INTEGER;
  ALTER TABLE compiler_run ADD COLUMN cache_creation_tokens INTEGER;
  ALTER TABLE compiler_run ADD COLUMN cache_read_tokens INTEGER;
  ALTER TABLE compiler_run ADD COLUMN pricing_model TEXT;
  ALTER TABLE compiler_run ADD COLUMN utility_model TEXT;
  ALTER TABLE compiler_run ADD COLUMN full_input_cost_usd REAL;
  ALTER TABLE compiler_run ADD COLUMN compiled_input_cost_usd REAL;
  ALTER TABLE compiler_run ADD COLUMN gross_input_savings_usd REAL;
  ALTER TABLE compiler_run ADD COLUMN optimizer_cost_usd REAL;
  ALTER TABLE compiler_run ADD COLUMN fallback_waste_cost_usd REAL;
  ALTER TABLE compiler_run ADD COLUMN net_savings_usd REAL;
  ALTER TABLE compiler_run ADD COLUMN generation_cost_usd REAL;
  ALTER TABLE compiler_run ADD COLUMN generation_input_cost_usd REAL;
  ALTER TABLE compiler_run ADD COLUMN generation_output_cost_usd REAL;
  ALTER TABLE compiler_run ADD COLUMN benchmark_json TEXT;

  ALTER TABLE run_attempt ADD COLUMN counted_input_tokens INTEGER;
  ALTER TABLE run_attempt ADD COLUMN cache_creation_tokens INTEGER;
  ALTER TABLE run_attempt ADD COLUMN cache_read_tokens INTEGER;
  ALTER TABLE run_attempt ADD COLUMN cost_usd REAL;
  ALTER TABLE run_attempt ADD COLUMN model TEXT;

  -- Every internal Consolidate model call (classification/memory, retrieval, compression, evaluation).
  CREATE TABLE utility_call (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL REFERENCES compiler_run(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    purpose TEXT NOT NULL,
    model TEXT,
    ok INTEGER NOT NULL,
    latency_ms INTEGER NOT NULL,
    input_tokens INTEGER,
    output_tokens INTEGER,
    cache_creation_tokens INTEGER,
    cache_read_tokens INTEGER,
    cost_usd REAL,
    error TEXT
  );
  CREATE INDEX utility_call_run ON utility_call(run_id);
  `,
  // v3: what the first compile achieved before any fallback (original_tokens/compiled_tokens/reduction_percent keep
  // describing the request that produced the returned answer), the first attempt's failure category, and per-attempt
  // detail (routing, reduction, context added). Additive only; NULL on older rows.
  `
  ALTER TABLE compiler_run ADD COLUMN initial_compiled_tokens INTEGER;
  ALTER TABLE compiler_run ADD COLUMN initial_reduction_percent REAL;
  ALTER TABLE compiler_run ADD COLUMN failure_category TEXT;
  ALTER TABLE run_attempt ADD COLUMN failure_category TEXT;
  ALTER TABLE run_attempt ADD COLUMN detail_json TEXT;
  `,
  // v4: the cost-aware fast path decision (why a request was or was not optimized). Additive only; NULL on older rows.
  `
  ALTER TABLE compiler_run ADD COLUMN economic_decision TEXT;
  ALTER TABLE compiler_run ADD COLUMN economic_reason TEXT;
  ALTER TABLE compiler_run ADD COLUMN expected_gross_savings_usd REAL;
  ALTER TABLE compiler_run ADD COLUMN expected_evaluation_cost_usd REAL;
  ALTER TABLE compiler_run ADD COLUMN economics_margin REAL;
  ALTER TABLE compiler_run ADD COLUMN economics_source TEXT;
  ALTER TABLE compiler_run ADD COLUMN potential_compiled_tokens INTEGER;
  `,
  // v5: the explicit retry decision after the first attempt, and the informational quality warning. Additive only.
  `
  ALTER TABLE compiler_run ADD COLUMN retry_decision TEXT;
  ALTER TABLE compiler_run ADD COLUMN retry_decision_reason TEXT;
  ALTER TABLE compiler_run ADD COLUMN expected_retry_cost_usd REAL;
  ALTER TABLE compiler_run ADD COLUMN context_changed INTEGER;
  ALTER TABLE compiler_run ADD COLUMN quality_warning TEXT;
  `,
];

export function migrate(db: DatabaseSync) {
  const row = db.prepare("PRAGMA user_version").get() as { user_version: number };
  for (let v = row.user_version; v < MIGRATIONS.length; v++) {
    db.exec("BEGIN");
    try {
      db.exec(MIGRATIONS[v]);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  }
}

export function openDatabase(path: string): DatabaseSync {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  migrate(db);
  return db;
}

const globalForDb = globalThis as unknown as { __consolidateDb?: DatabaseSync };

// One connection per server process (survives dev-server module reloads).
export function getDb(): DatabaseSync {
  return (globalForDb.__consolidateDb ??= openDatabase(resolve(process.env.CONSOLIDATE_DB_PATH || ".consolidate/consolidate.db")));
}
