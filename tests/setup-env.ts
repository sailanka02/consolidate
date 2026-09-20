// Runs before every test file. Tests must NEVER open the developer's real database (.consolidate/consolidate.db):
// any test that reaches getDb() through the default path gets its own throwaway file instead, even after
// vi.unstubAllEnvs() (which restores the value set here, not the shell's).
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.CONSOLIDATE_DB_PATH = join(mkdtempSync(join(tmpdir(), "consolidate-vitest-")), "test.db");
