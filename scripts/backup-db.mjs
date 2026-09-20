// Consistent snapshot of the SQLite database (safe while the app is running; includes everything still in the WAL).
//   npm run backup -- /data/backups/consolidate-2026-01-01.db
// A plain `cp consolidate.db` is NOT a safe backup: recent writes may still be in consolidate.db-wal.
import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const src = resolve(process.env.CONSOLIDATE_DB_PATH || ".consolidate/consolidate.db");
const dest = process.argv[2] && resolve(process.argv[2]);
if (!dest) {
  console.error("Usage: npm run backup -- <destination.db>");
  process.exit(2);
}
if (!existsSync(src)) {
  console.error(`Database not found: ${src}`);
  process.exit(1);
}
if (existsSync(dest)) {
  console.error(`Refusing to overwrite an existing file: ${dest}`);
  process.exit(1);
}
mkdirSync(dirname(dest), { recursive: true });
const db = new DatabaseSync(src, { readOnly: true });
db.exec(`VACUUM INTO '${dest.replace(/'/g, "''")}'`);
db.close();
console.log(`Backed up ${src} -> ${dest}`);
