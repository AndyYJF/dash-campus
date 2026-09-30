import fs from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import { getSchemaVersion } from "@/repositories/db";

/**
 * 迁移执行（migrate 命令与 restore 命令共用；两者都要求 web/worker 已停止）。
 * 约定：migrations/NNNN_name.sql，版本号 = 文件名数字部分，按序在一个事务里执行。
 */

export const MIGRATIONS_DIR = path.resolve(process.cwd(), "migrations");

export function listMigrations(): Array<{ version: number; file: string }> {
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d{4}_.*\.sql$/.test(f))
    .map((f) => ({ version: Number(f.slice(0, 4)), file: f }))
    .sort((a, b) => a.version - b.version);
}

export type MigrateResult =
  | { kind: "up_to_date"; version: number | null }
  | { kind: "migrated"; from: number | null; to: number; applied: string[] }
  | { kind: "too_new"; version: number; supported: number };

export function runMigrations(db: Database.Database): MigrateResult {
  const current = getSchemaVersion(db);
  const migrations = listMigrations();
  const latest = migrations.length ? migrations[migrations.length - 1].version : 0;
  if (current !== null && current > latest) return { kind: "too_new", version: current, supported: latest };

  const pending = migrations.filter((m) => current === null || m.version > current);
  if (pending.length === 0) return { kind: "up_to_date", version: current };

  const applied: string[] = [];
  db.transaction(() => {
    for (const m of pending) {
      db.exec(fs.readFileSync(path.join(MIGRATIONS_DIR, m.file), "utf8"));
      db.prepare(
        `INSERT INTO schema_version (id, version, applied_at) VALUES (1, ?, ?)
         ON CONFLICT(id) DO UPDATE SET version = excluded.version, applied_at = excluded.applied_at`,
      ).run(m.version, new Date().toISOString());
      applied.push(m.file);
    }
  })();
  return { kind: "migrated", from: current, to: getSchemaVersion(db)!, applied };
}
