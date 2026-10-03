/** 线上 P3 清理：撤销 smoke 任务 batch + 重排 supersede 其学习块，输出最终状态（只清理 smoke 数据） */
import { getDb } from "../../src/repositories/db";
import { undoBatch } from "../../src/workflows/undo";
import { rebuildPlan } from "../../src/workflows/plan";

const db = getDb();
const batches = db
  .prepare(
    `SELECT DISTINCT b.id FROM agent_action_batches b
     JOIN agent_action_changes c ON c.batch_id = b.id
     JOIN tasks t ON t.id = c.entity_id
     WHERE b.command = 'create_or_update_task' AND b.status = 'applied' AND t.title LIKE '%复习完操作系统%'`,
  )
  .all() as Array<{ id: string }>;

for (const b of batches) console.log("undo", b.id, JSON.stringify(undoBatch(b.id)));
const plan = rebuildPlan(new Date());
console.log("rebuild placed:", plan.placed);
const left = db.prepare(`SELECT COUNT(*) AS n FROM plan_sessions WHERE status IN ('planned','tentative')`).get() as { n: number };
const tasks = db.prepare(`SELECT title FROM tasks WHERE title LIKE '%复习完操作系统%'`).all();
console.log("planned sessions left:", left.n, "smoke tasks left:", JSON.stringify(tasks));
