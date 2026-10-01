import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { getSchemaVersion } from "@/repositories/db";

/**
 * 运维 CLI 共用（计划 10.2）。只处理显式参数给出的路径，不打印任何密钥。
 * 任何一步失败都抛出可读错误，调用方以非零码退出。
 */

export class OpsError extends Error {}

export const BACKUP_MANIFEST = "manifest.json";
export const BACKUP_DB_FILE = "dash-campus.db";

export type BackupManifest = {
  format: "dash-campus.backup";
  formatVersion: 1;
  createdAt: string;
  appVersion: string;
  schemaVersion: number | null;
  file: string;
  sha256: string;
  sizeBytes: number;
};

export function sha256File(p: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
}

/** worker 心跳：最近 20 秒内有写入视为仍在运行（轮询间隔 5 秒） */
export function workerLooksAlive(dbPath: string, now = Date.now()): string | null {
  if (!fs.existsSync(dbPath)) return null;
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const t = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='instance_state'`).get();
    if (!t) return null;
    const r = db.prepare(`SELECT worker_heartbeat_at AS h FROM instance_state WHERE id = 1`).get() as { h: string | null } | undefined;
    if (r?.h && now - new Date(r.h).getTime() < 20_000) return r.h;
    return null;
  } finally {
    db.close();
  }
}

/**
 * web 是否仍在运行：GET /api/v1/health 返回本应用自己的健康响应（service = dash-campus）才算。
 * 生产的 APP_BASE_URL 经过反向代理，web 停止后代理仍会回 502 等页面，不能把"有响应"当成"在运行"。
 * 数据库异常时 health 返回 503 但仍带 service 字段，这种情况 web 确实在运行，照样拒绝。
 */
export async function webLooksAlive(baseUrl: string): Promise<boolean> {
  try {
    const ctl = AbortSignal.timeout(2000);
    const res = await fetch(new URL("/api/v1/health", baseUrl), { signal: ctl });
    const body = (await res.json().catch(() => null)) as { service?: unknown } | null;
    return body?.service === "dash-campus";
  } catch {
    return false;
  }
}

export async function assertStopped(dbPath: string, baseUrl: string): Promise<void> {
  const hb = workerLooksAlive(dbPath);
  if (hb) throw new OpsError(`worker 仍在运行（最近心跳 ${hb}）。请先运行 scripts/stop.sh 并确认退出`);
  if (await webLooksAlive(baseUrl)) {
    throw new OpsError(`web 仍在响应 ${baseUrl}。请先运行 scripts/stop.sh 并确认退出`);
  }
}

/** 一致快照：SQLite 在线备份 API 写出单个完整文件（含 WAL 中已提交内容），不直接复制主文件 */
export async function snapshotDatabase(srcPath: string, destPath: string): Promise<void> {
  const db = new Database(srcPath, { fileMustExist: true });
  try {
    await db.backup(destPath);
  } finally {
    db.close();
  }
}

export function readSchemaVersion(dbPath: string): number | null {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    return getSchemaVersion(db);
  } finally {
    db.close();
  }
}

export function readManifest(dir: string): BackupManifest {
  const p = path.join(dir, BACKUP_MANIFEST);
  if (!fs.existsSync(p)) throw new OpsError(`不是有效的备份目录：缺少 ${BACKUP_MANIFEST}（${dir}）`);
  const m = JSON.parse(fs.readFileSync(p, "utf8")) as BackupManifest;
  if (m.format !== "dash-campus.backup") throw new OpsError("备份清单格式不认识");
  return m;
}

export function timestamp(d = new Date()): string {
  return d.toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "-");
}
