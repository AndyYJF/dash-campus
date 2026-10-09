import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { getConfig, SUPPORTED_MODEL_PROTOCOLS } from "@/config";
import { getDb, getSchemaVersion } from "@/repositories/db";
import { runMigrations } from "@/scripts/migrate-lib";
import { instanceTimezone, localDateInTz } from "@/domain/time";
import { DEMO_LIMITS } from "@/domain/demo";
import { getAiBudget, usageToday } from "@/workflows/ai-budget";
import { modelCapabilitiesView, runModelCapabilityProbe } from "@/workflows/model-capabilities";
import { exportsDir } from "@/workflows/exports";
import { seedDemoData, DEMO_SEED_VERSION } from "@/workflows/demo-seed";
import { AI_NEWS_SCHEDULE_KEY } from "@/contracts/ai-news";
import { MODEL_CAPABILITIES_SETTINGS_KEY } from "@/contracts/model-capabilities";

/**
 * 演示实例的数据生命周期（docs/demo-mode.md）。
 * - 演示标记：settings 里的一行，只由本文件的重置写入。DEMO_MODE=1 的 web/worker 只肯连带标记的库，
 *   重置也只肯清带标记（或全新、没有主人）的库——两头都防“把演示模式指到正式库上”。
 * - 重置：一个事务里清空业务表、放回迁移自带的默认行、重新写入按当天日期生成的合成示例。
 *   访客会话与当天的 AI 调用账目保留：重置不踢人，也不能用来刷新额度。
 *   模型端点的探测结果和最近的资讯盘点也保留：它们来自真实的端点与订阅源，不是访客能改的内容，重做一遍只是白花调用。
 */

export const DEMO_MARKER_KEY = "demoInstance";

export type DemoMarker = { seedVersion: number; seededAt: string; seededLocalDate: string };

export function readDemoMarker(database: Database.Database = getDb()): DemoMarker | null {
  const has = database.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='settings'`).get();
  if (!has) return null;
  const row = database.prepare(`SELECT value_json FROM settings WHERE key = ?`).get(DEMO_MARKER_KEY) as { value_json: string } | undefined;
  return row ? (JSON.parse(row.value_json) as DemoMarker) : null;
}

/**
 * 启动检查：演示模式与数据库必须对得上，否则进程退出。
 * 演示模式连到没有标记的库 = 可能是正式库，会把私人数据免登录公开；
 * 普通模式连到演示库 = 没有可用密码，也不该当正式库用。
 */
export function demoStartupProblem(database: Database.Database = getDb()): string | null {
  const demo = getConfig().DEMO_MODE;
  const marker = readDemoMarker(database);
  if (demo && !marker) {
    return "DEMO_MODE=1，但这个数据库不是演示库（没有演示标记）。演示实例必须使用单独的数据目录：先运行 scripts/demo-seed.sh 建立演示库；绝不要把演示模式指向正式数据库。";
  }
  if (!demo && marker) {
    return "这个数据库是演示库（带演示标记），但没有设置 DEMO_MODE=1。正式实例请使用自己的数据库。";
  }
  return null;
}

/** 重置时原样保留的表：结构版本、实例运行状态、主人与访客会话、AI 调用账目（另按日期裁剪） */
const KEPT_TABLES = new Set(["schema_version", "instance_state", "owner", "sessions", "ai_request_ledger", "ai_usage"]);

/** 重置时保留的设置项：模型端点能力（探测一次约 5 次请求）、资讯当天是否已排过定时更新 */
const KEPT_SETTINGS = [MODEL_CAPABILITIES_SETTINGS_KEY, AI_NEWS_SCHEDULE_KEY];
/** 保留最近几期已生成的资讯盘点 */
const KEPT_NEWS_RUNS = 2;

type DefaultRows = Array<{ table: string; rows: Array<Record<string, unknown>> }>;
let defaultRowsCache: { version: number; rows: DefaultRows } | null = null;

/** 迁移自带的默认行（如现成的实践模板、规划偏好的初始行）：从一份内存里的空库读出来，不手抄 */
function migrationDefaultRows(): DefaultRows {
  const version = getSchemaVersion() ?? 0;
  if (defaultRowsCache?.version === version) return defaultRowsCache.rows;
  const blank = new Database(":memory:");
  try {
    runMigrations(blank);
    const tables = blank.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`).all() as Array<{ name: string }>;
    const rows: DefaultRows = [];
    for (const { name } of tables) {
      if (KEPT_TABLES.has(name)) continue;
      const found = blank.prepare(`SELECT * FROM "${name}"`).all() as Array<Record<string, unknown>>;
      if (found.length) rows.push({ table: name, rows: found });
    }
    defaultRowsCache = { version, rows };
    return rows;
  } finally {
    blank.close();
  }
}

export type DemoResetResult = { seededAt: string; seedVersion: number };

/**
 * 把演示库恢复成初始示例。拒绝在不是演示库的库上执行（已有主人却没有演示标记）。
 * 整个过程是一个 IMMEDIATE 事务：web 与 worker 要么看到旧数据，要么看到完整的新示例。
 */
export function resetDemoData(now: Date = new Date()): DemoResetResult {
  const db = getDb();
  const defaults = migrationDefaultRows();
  const result = db
    .transaction((): DemoResetResult => {
      const marker = readDemoMarker(db);
      const owner = db.prepare(`SELECT id FROM owner WHERE id = 1`).get();
      if (!marker && owner) {
        throw new Error("拒绝重置：这个数据库已有主人且没有演示标记，看起来是正式库。演示数据只写入单独的演示库。");
      }
      const keptSettings = db.prepare(`SELECT * FROM settings WHERE key IN (${KEPT_SETTINGS.map(() => "?").join(", ")})`).all(...KEPT_SETTINGS) as Array<Record<string, unknown>>;
      const keptNews = db.prepare(`SELECT * FROM ai_news_runs WHERE status IN ('ready', 'empty') ORDER BY generated_at DESC, rowid DESC LIMIT ?`).all(KEPT_NEWS_RUNS) as Array<Record<string, unknown>>;
      // 外键检查推迟到提交：表之间互相引用，清空顺序不必手排
      db.pragma("defer_foreign_keys = ON");
      const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`).all() as Array<{ name: string }>;
      for (const { name } of tables) if (!KEPT_TABLES.has(name)) db.prepare(`DELETE FROM "${name}"`).run();
      for (const { table, rows } of defaults) {
        for (const row of rows) {
          const cols = Object.keys(row);
          db.prepare(`INSERT INTO "${table}" (${cols.map((c) => `"${c}"`).join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`).run(...cols.map((c) => row[c] as never));
        }
      }
      // 资讯对应的后台任务已随 jobs 清掉，保留的盘点不再指向它
      for (const row of [...keptSettings.map((r) => ["settings", r] as const), ...keptNews.reverse().map((r) => ["ai_news_runs", { ...r, job_id: null }] as const)]) {
        const cols = Object.keys(row[1]);
        db.prepare(`INSERT INTO "${row[0]}" (${cols.map((c) => `"${c}"`).join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`).run(...cols.map((c) => (row[1] as Record<string, unknown>)[c] as never));
      }
      // 账目只留当天：额度按当天计数，保留它重置才不会把已用次数清零
      const today = localDateInTz(now, instanceTimezone());
      db.prepare(`DELETE FROM ai_request_ledger WHERE local_date <> ?`).run(today);
      db.prepare(`DELETE FROM ai_usage WHERE local_date <> ?`).run(today);
      // 已过期/撤销的访客会话顺手清掉
      db.prepare(`DELETE FROM sessions WHERE revoked_at IS NOT NULL OR expires_at <= ?`).run(now.toISOString());
      if (!owner) {
        // 演示库的主人没有可用密码：哈希是随机串，登录接口在演示模式下也已关闭
        db.prepare(`INSERT INTO owner (id, password_hash, created_at, setup_completed_at) VALUES (1, ?, ?, ?)`).run(`demo-no-login:${crypto.randomBytes(24).toString("hex")}`, now.toISOString(), now.toISOString());
      }
      seedDemoData(now);
      const value: DemoMarker = { seedVersion: DEMO_SEED_VERSION, seededAt: now.toISOString(), seededLocalDate: today };
      db.prepare(`INSERT INTO settings (key, value_json, version, updated_at) VALUES (?, ?, 1, ?)`).run(DEMO_MARKER_KEY, JSON.stringify(value), now.toISOString());
      return { seededAt: value.seededAt, seedVersion: value.seedVersion };
    })
    .immediate();
  clearExportFiles();
  return result;
}

/** 导出记录已随业务表清空，磁盘上的导出文件也一并删掉（只删导出目录里的文件，目录本身和别处不动） */
function clearExportFiles(): void {
  const dir = exportsDir();
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isFile()) fs.rmSync(path.join(dir, entry.name), { force: true });
  }
}

/** 今天该不该自动恢复：过了每日恢复钟点，而上次恢复还在这个钟点之前；或示例数据版本变了（升级后） */
export function demoResetDue(now: Date = new Date()): boolean {
  const marker = readDemoMarker();
  if (!marker) return false;
  if (marker.seedVersion !== DEMO_SEED_VERSION) return true;
  return new Date(marker.seededAt).getTime() < lastResetPoint(now).getTime();
}

/** 最近一个已经过去的每日恢复时刻（实例时区的 DEMO_RESET_HOUR 点整） */
export function lastResetPoint(now: Date): Date {
  const hour = getConfig().DEMO_RESET_HOUR;
  const tz = instanceTimezone();
  let point = zonedHour(localDateInTz(now, tz), hour, tz);
  if (point.getTime() > now.getTime()) point = zonedHour(localDateInTz(new Date(now.getTime() - 86_400_000), tz), hour, tz);
  return point;
}

export function nextResetPoint(now: Date): Date {
  const hour = getConfig().DEMO_RESET_HOUR;
  const tz = instanceTimezone();
  const today = zonedHour(localDateInTz(now, tz), hour, tz);
  return today.getTime() > now.getTime() ? today : zonedHour(localDateInTz(new Date(now.getTime() + 86_400_000), tz), hour, tz);
}

/** 某个本地日期的整点对应的时刻：用时区偏移反推，夏令时切换日最多差一小时，对“每天恢复一次”没有影响 */
function zonedHour(localDate: string, hour: number, tz: string): Date {
  const guess = new Date(`${localDate}T${String(hour).padStart(2, "0")}:00:00Z`);
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).formatToParts(guess);
  const get = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  const shown = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"));
  return new Date(guess.getTime() - (shown - guess.getTime()));
}

/** 数据库文件占用（含 WAL）：公开实例上传不设门槛，超过上限就提前恢复 */
export function demoDatabaseBytes(): number {
  const file = path.resolve(getConfig().DATABASE_PATH);
  return [file, `${file}-wal`].reduce((sum, f) => sum + (fs.existsSync(f) ? fs.statSync(f).size : 0), 0);
}

export const DEMO_MAX_DATABASE_BYTES = 400 * 1024 * 1024;

/** worker 每趟轮询调用：到点或库太大就恢复示例。返回是否执行了恢复 */
export function maintainDemo(now: Date = new Date()): boolean {
  if (!getConfig().DEMO_MODE) return false;
  if (!demoResetDue(now) && demoDatabaseBytes() <= DEMO_MAX_DATABASE_BYTES) return false;
  resetDemoData(now);
  // 清掉的数据还占着文件页：收回空间，下一次才量得准
  try {
    getDb().pragma("wal_checkpoint(TRUNCATE)");
    if (demoDatabaseBytes() > DEMO_MAX_DATABASE_BYTES / 2) getDb().exec("VACUUM");
  } catch {
    // 有读者占着时收不回来，下一趟再试
  }
  return true;
}

export type DemoStatus =
  | { demo: false; demoUrl: string | null }
  | {
      demo: true;
      demoUrl: null;
      seededAt: string | null;
      nextResetAt: string;
      resetHour: number;
      /** 手动恢复还要等多少秒；0 表示现在可以 */
      resetCooldownSeconds: number;
      ai: { used: number; limit: number; configured: boolean };
    };

/** 公开状态：登录页与演示条用。不含任何密钥或业务数据 */
export function demoStatus(now: Date = new Date()): DemoStatus {
  const cfg = getConfig();
  if (!cfg.DEMO_MODE) return { demo: false, demoUrl: cfg.DEMO_URL ?? null };
  const marker = readDemoMarker();
  const sinceSeed = marker ? now.getTime() - new Date(marker.seededAt).getTime() : Infinity;
  return {
    demo: true,
    demoUrl: null,
    seededAt: marker?.seededAt ?? null,
    nextResetAt: nextResetPoint(now).toISOString(),
    resetHour: cfg.DEMO_RESET_HOUR,
    resetCooldownSeconds: Math.max(0, Math.ceil((DEMO_LIMITS.resetCooldownMs - sinceSeed) / 1000)),
    ai: { used: usageToday().modelCalls, limit: getAiBudget().budget.dailyModelCalls, configured: Boolean(cfg.MODEL_PROTOCOL) },
  };
}

/**
 * worker 启动时调用：演示实例上访客不能点“重新探测”（会白花调用），所以配了真实模型而还没有
 * 与当前端点匹配的探测结论时，由 worker 自己探测一次（约 5 次请求，计入当天额度）；结论在恢复示例时保留。
 */
export async function ensureDemoModelCapabilities(): Promise<"skipped" | "probed" | "failed"> {
  const cfg = getConfig();
  if (!cfg.DEMO_MODE || !cfg.MODEL_PROTOCOL || !SUPPORTED_MODEL_PROTOCOLS.includes(cfg.MODEL_PROTOCOL)) return "skipped";
  if (modelCapabilitiesView(cfg).state === "current") return "skipped";
  try {
    return (await runModelCapabilityProbe()).ok ? "probed" : "failed";
  } catch {
    return "failed";
  }
}
