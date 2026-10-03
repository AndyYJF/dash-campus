import crypto from "node:crypto";
import { getDb } from "./db";

/** 实践记录仓储（P2 record_practice 命令落点；P3 计时/闭环复用同一表）。须在调用方事务内使用。 */

export function insertPracticeEntry(input: {
  occurredOn: string;
  actualMinutes: number | null;
  note: string;
  taskId?: string | null;
}): string {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  getDb()
    .prepare(
      `INSERT INTO practice_entries (id, task_id, occurred_on, actual_minutes, minutes_origin, note, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'user_reported', ?, ?, ?)`,
    )
    .run(id, input.taskId ?? null, input.occurredOn, input.actualMinutes, input.note, now, now);
  return id;
}
