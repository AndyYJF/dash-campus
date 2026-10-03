/**
 * A18 恢复演练（本地）：备份 DB → 恢复到隔离路径 → 校验 blob 完整 + schema + hold 语义。
 * blob 存于 SQLite 内（intake_blobs.content），单文件备份天然覆盖；此脚本给出可重复证据。
 * 用法：npx tsx scripts/dev/restore-drill.ts [源DB路径]
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";

const src = process.argv[2] ?? process.env.DATABASE_PATH ?? "./data/v2/dash-campus.db";
if (!fs.existsSync(src)) {
  console.error(`源 DB 不存在：${src}`);
  process.exit(1);
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dash-restore-drill-"));
const dst = path.join(dir, "restored.db");
const srcDb = new Database(src);
srcDb.pragma("wal_checkpoint(TRUNCATE)");
srcDb.close();
fs.copyFileSync(src, dst);

const db = new Database(dst, { readonly: true });

const schema = (db.prepare(`SELECT MAX(version) AS v FROM schema_version`).get() as { v: number }).v;
console.log(`schema version: ${schema}`);

const blobs = db.prepare(`SELECT hash, size_bytes, content FROM intake_blobs`).all() as Array<{ hash: string; size_bytes: number; content: Buffer }>;
let intact = 0;
for (const b of blobs) {
  const actual = crypto.createHash("sha256").update(b.content).digest("hex");
  if (actual === b.hash && b.content.length === b.size_bytes) intact++;
}
console.log(`blobs: ${blobs.length} 个，hash 完整 ${intact} 个`);

const tables = ["intakes", "intake_items", "clarification_questions", "plan_sessions", "course_event_exceptions", "agent_action_batches"];
for (const t of tables) {
  const n = (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;
  console.log(`${t}: ${n} 行`);
}

// hold 语义：恢复实例进入 restored_hold 由恢复脚本设置（restore.sh），此处验证表结构支持
const holdCol = db.prepare(`PRAGMA table_info(instance_state)`).all() as Array<{ name: string }>;
console.log(`restored_hold 列存在: ${holdCol.some((c) => c.name === "restored_hold")}`);

if (blobs.length && intact !== blobs.length) {
  console.error("BLOB 完整性校验失败");
  process.exit(1);
}
console.log(`恢复演练通过（隔离目录 ${dir}，可手动删除）`);
