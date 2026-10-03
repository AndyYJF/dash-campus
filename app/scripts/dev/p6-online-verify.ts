/** P6 补强线上验证：legacy 排程迁移结果 + focus 表 + focus start/stop 冒烟 */
import { getDb } from "../../src/repositories/db";

const db = getDb();
console.log("schema:", JSON.stringify(db.prepare("SELECT MAX(version) AS v FROM schema_version").get()));
console.log("plan_sessions by locked:", JSON.stringify(db.prepare("SELECT locked, status, COUNT(*) AS n FROM plan_sessions GROUP BY locked, status").all()));
console.log("legacy-migrated:", JSON.stringify(db.prepare("SELECT COUNT(*) AS n FROM plan_sessions WHERE batch_id IS NULL AND locked = 1").get()));
console.log("focus table:", JSON.stringify(db.prepare("SELECT name FROM sqlite_master WHERE name = 'focus_sessions'").get()));
console.log("tasks with old schedule remaining:", JSON.stringify(db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE scheduled_start IS NOT NULL AND archived_at IS NULL").get()));
