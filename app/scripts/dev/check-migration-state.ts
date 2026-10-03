/** 核对迁移状态（只读）：schema 版本与关键表是否存在 */
import { getDb } from "../../src/repositories/db";

const db = getDb();
console.log("schema:", JSON.stringify(db.prepare("SELECT MAX(version) AS v FROM schema_version").get()));
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'intake%' ORDER BY name").all();
console.log("intake tables:", JSON.stringify(tables));
const kinds = db.prepare("SELECT sql FROM sqlite_master WHERE name='intake_items'").get() as { sql: string };
console.log("items ddl has ics:", kinds.sql.includes("'ics'"));
