/** 列出全部 batch id（undo 冒烟用） */
import { getDb } from "/app/src/repositories/db";

const rows = getDb().prepare("SELECT id FROM agent_action_batches ORDER BY created_at").all() as Array<{ id: string }>;
console.log(rows.map((r) => r.id).join(" "));
