/** P5 线上验证：plan_maintenance 排队与执行状态 + 方向页 snapshot 摘要 */
import { getDb } from "../../src/repositories/db";

const db = getDb();
console.log("maintenance jobs:", JSON.stringify(db.prepare(`SELECT type, status, dedupe_key, result_json FROM jobs WHERE type = 'plan_maintenance' ORDER BY created_at DESC LIMIT 3`).all()));
console.log("recent sessions:", JSON.stringify(db.prepare(`SELECT status, COUNT(*) AS n FROM plan_sessions GROUP BY status`).all()));
console.log("candidates:", JSON.stringify(db.prepare(`SELECT COUNT(*) AS n FROM candidates WHERE status = 'proposed'`).get()));
