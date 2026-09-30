import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { getConfig } from "@/config";

/**
 * SQLite 连接管理：同机本地 WAL、外键启用、busy timeout。
 * 服务进程只检查 schema_version，不在启动时竞争改表；迁移由独立 migrate 命令执行。
 */

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (!db) {
    const cfg = getConfig();
    const dbPath = path.resolve(cfg.DATABASE_PATH);
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    db = new Database(dbPath);
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    db.pragma("busy_timeout = 5000");
    db.pragma("synchronous = NORMAL");
  }
  return db;
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}

/** 本版应用要求的 schema 版本（= migrations 最大编号；test/delivery.test.ts 校验二者一致） */
export const EXPECTED_SCHEMA_VERSION = 10;

/**
 * 服务进程启动检查（计划 10.1）：只检查不改表。
 * 不兼容时返回可读说明，调用方退出；迁移只由独立 migrate 命令执行。
 */
export function schemaProblem(database: Database.Database = getDb()): string | null {
  const v = getSchemaVersion(database);
  if (v === null) return "数据库尚未初始化：请先运行 scripts/migrate.sh（npm run migrate）";
  if (v < EXPECTED_SCHEMA_VERSION) {
    return `数据库 schema 版本 ${v} 低于应用要求的 ${EXPECTED_SCHEMA_VERSION}：请停止 web/worker → 备份 → 运行 scripts/migrate.sh → 再启动`;
  }
  if (v > EXPECTED_SCHEMA_VERSION) {
    return `数据库 schema 版本 ${v} 高于应用支持的 ${EXPECTED_SCHEMA_VERSION}：请升级应用，或从匹配版本的备份恢复`;
  }
  return null;
}

export function getSchemaVersion(database: Database.Database = getDb()): number | null {
  const table = database
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_version'")
    .get() as { name: string } | undefined;
  if (!table) return null;
  const row = database
    .prepare("SELECT version FROM schema_version WHERE id = 1")
    .get() as { version: number } | undefined;
  return row ? row.version : null;
}
