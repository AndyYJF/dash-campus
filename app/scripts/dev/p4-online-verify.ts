/** P4 线上验证：ICS 事件落库 + 拿 batchId 列表（undo 清理由 p4-online-undo.sh 完成） */
import { getDb } from "../../src/repositories/db";

const db = getDb();
const events = db.prepare(`SELECT id, title, event_date, local_start FROM fixed_events WHERE title LIKE '%[smoke] ICS%'`).all() as Array<{ id: string; title: string; event_date: string; local_start: string }>;
console.log("smoke fixed_events:", JSON.stringify(events));

const batches = db
  .prepare(`SELECT DISTINCT b.id FROM agent_action_batches b JOIN agent_action_changes c ON c.batch_id = b.id JOIN entity_source_links l ON l.entity_id = c.entity_id WHERE l.external_id LIKE '%' AND b.status = 'applied' ORDER BY b.created_at DESC LIMIT 5`)
  .all() as Array<{ id: string }>;
console.log("recent batches:", JSON.stringify(batches.map((b) => b.id)));
