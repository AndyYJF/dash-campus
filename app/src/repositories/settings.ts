import { getDb } from "@/repositories/db";

/**
 * settings repository（计划 v1.2 第 3、4.2 节）。
 * 非敏感设置保存在数据库，键唯一，带整数 version 供乐观锁。
 */

export type SettingEntry<T> = { value: T | null; version: number };

function now(): string {
  return new Date().toISOString();
}

/** 读取设置；行不存在时返回 { value: null, version: 0 }（0 表示尚未创建） */
export function getSetting(key: string): SettingEntry<unknown> {
  const db = getDb();
  const row = db.prepare(`SELECT value_json, version FROM settings WHERE key = ?`).get(key) as
    | { value_json: string; version: number }
    | undefined;
  if (!row) return { value: null, version: 0 };
  return { value: JSON.parse(row.value_json) as unknown, version: row.version };
}

/** 更新/创建设置，expectedVersion 乐观锁；version 0 表示首次创建 */
export function updateSetting(
  key: string,
  value: unknown,
  expectedVersion: number,
): { version: number } | "conflict" {
  const db = getDb();
  if (expectedVersion === 0) {
    try {
      db.prepare(
        `INSERT INTO settings (key, value_json, version, updated_at) VALUES (?, ?, 1, ?)`,
      ).run(key, JSON.stringify(value), now());
      return { version: 1 };
    } catch (e) {
      if ((e as { code?: string }).code === "SQLITE_CONSTRAINT_PRIMARYKEY") {
        return "conflict";
      }
      throw e;
    }
  }
  const r = db
    .prepare(
      `UPDATE settings SET value_json = ?, version = version + 1, updated_at = ?
       WHERE key = ? AND version = ?`,
    )
    .run(JSON.stringify(value), now(), key, expectedVersion);
  if (r.changes === 0) return "conflict";
  const row = db.prepare(`SELECT version FROM settings WHERE key = ?`).get(key) as {
    version: number;
  };
  return { version: row.version };
}
