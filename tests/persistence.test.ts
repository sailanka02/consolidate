// SQLite persistence: the file survives closing and reopening (a restart or redeploy), parent directories are created,
// WAL stays on, and migrations are idempotent.
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { migrate, openDatabase } from "@/lib/db";
import * as repo from "@/lib/db/repo";

const dir = mkdtempSync(join(tmpdir(), "consolidate-persist-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("database persistence across restarts", () => {
  const path = join(dir, "nested", "volume", "consolidate.db"); // parent directories do not exist yet

  it("creates the parent directory, enables WAL, and applies every migration", () => {
    const db = openDatabase(path);
    expect(existsSync(path)).toBe(true);
    expect((db.prepare("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode).toBe("wal");
    expect((db.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number }).foreign_keys).toBe(1);
    expect((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version).toBeGreaterThanOrEqual(3);
    db.close();
  });

  it("conversations, messages, memory and run history survive a restart, and re-running migrations changes nothing", () => {
    const a = openDatabase(path);
    const conv = repo.createConversation(a);
    repo.insertMessage(a, { id: "m_1", conversationId: conv.id, role: "user", content: "We decided to use PostgreSQL 17.", localTokenEstimate: 10 });
    repo.saveMemory(a, conv.id, { id: "mem_1", key: "database", value: "PostgreSQL 17", type: "decision", sourceIds: ["m_1"], confidence: 0.9, active: true, previousValues: [] });
    const version = (a.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
    a.close(); // the process ends

    const b = openDatabase(path); // the next deploy opens the same file
    expect(repo.getConversation(b, conv.id)?.id).toBe(conv.id);
    expect(repo.listMessages(b, conv.id).map((m) => m.content)).toEqual(["We decided to use PostgreSQL 17."]);
    expect(repo.listMemory(b, conv.id).map((m) => m.value)).toEqual(["PostgreSQL 17"]);
    expect(repo.dashboardStats(b).conversations).toBeGreaterThanOrEqual(1);
    migrate(b);
    migrate(b); // idempotent
    expect((b.prepare("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(version);
    expect(repo.listMessages(b, conv.id)).toHaveLength(1);
    b.close();
  });

  it("a second process can open the same file while it is in use (WAL readers do not block)", () => {
    const a = openDatabase(path);
    const b = openDatabase(path);
    expect(repo.listConversations(b).length).toBe(repo.listConversations(a).length);
    a.close();
    b.close();
  });
});
