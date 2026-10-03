import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { LEGACY_MAX_BYTES, legacySnapshotSchema } from "@/contracts/legacy";
import { sanitizeLegacyTask } from "@/domain/legacy";

/** 同机运维：仅读取旧库，不加载旧 .env，不打开新平台库。WAL 下用一致读事务。 */
export function readTodoSnapshot(dbPath: string, sourceId: string, timezone: string) {
  const db = new Database(path.resolve(dbPath), { readonly: true, fileMustExist: true });
  try {
    db.pragma("query_only = ON"); db.pragma("busy_timeout = 5000");
    const columns = new Set((db.prepare("PRAGMA table_info(tasks)").all() as { name: string }[]).map((r) => r.name));
    const required = ["id", "title", "note", "start_at", "due_at", "done", "done_at", "priority", "project", "quick", "created_at", "updated_at"];
    if (required.some((c) => !columns.has(c))) throw new Error("旧 tasks 表缺少必要字段，请核对旧工具版本");
    const optional = ["pinned", "external_id", "external_rev"].map((c) => columns.has(c) ? c : `${c === "pinned" ? "0" : "NULL"} AS ${c}`);
    const tasks = db.transaction(() => {
      const count = (db.prepare("SELECT count(*) AS count FROM tasks").get() as { count: number }).count;
      if (count > 5000) throw new Error("旧任务超过5000条，请先设计分批迁移，工具不会截断");
      return db.prepare(`SELECT ${[...required, ...optional].join(",")} FROM tasks ORDER BY id`).all();
    }).deferred();
    const snapshot = legacySnapshotSchema.parse({ format: "todo-web.sqlite.v1", sourceId, timezone, exportedAt: new Date().toISOString(), tasks });
    return { ...snapshot, tasks: snapshot.tasks.map(sanitizeLegacyTask) };
  } finally { db.close(); }
}

export function writeTodoSnapshot(file: string, snapshot: ReturnType<typeof readTodoSnapshot>) {
  const text = JSON.stringify(snapshot, null, 2) + "\n";
  if (Buffer.byteLength(text) > LEGACY_MAX_BYTES) throw new Error("快照超过10 MiB，工具不会截断");
  const destination = path.resolve(file);
  fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
  const temp = `${destination}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temp, text, { mode: 0o600, flag: "wx" });
  try { fs.renameSync(temp, destination); } catch (e) { fs.unlinkSync(temp); throw e; }
}

function main() {
  const args = process.argv.slice(2);
  const get = (flag: string) => { const at = args.indexOf(flag); return at < 0 ? undefined : args[at + 1]; };
  const db = get("--db"), out = get("--out"), source = get("--source"), timezone = get("--timezone");
  if (!db || !out || !source || !timezone) throw new Error("用法：npm run legacy:snapshot -- --db OLD_DB --out data/legacy/todo.snapshot.json --source todo-main --timezone Asia/Shanghai");
  if (path.resolve(db) === path.resolve(out)) throw new Error("输出路径不能是旧数据库");
  const snapshot = readTodoSnapshot(db, source, timezone);
  writeTodoSnapshot(out, snapshot);
  console.log(JSON.stringify({ format: snapshot.format, sourceId: source, timezone, tasks: snapshot.tasks.length, done: snapshot.tasks.filter((t) => t.done).length, redacted: true }));
}
// 导出函数供真实 SQLite 测试；CLI 异常不打印业务正文。
if (process.argv[1] && path.basename(process.argv[1]) === "legacy-snapshot.ts") {
  try { main(); } catch { console.error("快照生成失败：检查参数、旧库权限、必要字段、时区和数据上限。未修改旧数据库。"); process.exitCode = 1; }
}
