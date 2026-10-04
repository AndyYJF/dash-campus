import crypto from "node:crypto";
import { getDb } from "./db";
import { markPlanStale } from "./proposals";

/** 实践记录仓储（P2 record_practice 命令落点；P3 计时/闭环复用同一表）。须在调用方事务内使用。 */

export function insertPracticeEntry(input: {
  occurredOn: string;
  actualMinutes: number | null;
  note: string;
  taskId?: string | null;
  category?: "study" | "other";
  planSessionId?: string | null;
  focusSessionId?: string | null;
  minutesOrigin?: "timer" | "user_reported";
  blocker?: string;
  projectId?: string | null;
}): string {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  getDb()
    .prepare(
      `INSERT INTO practice_entries (id, task_id, occurred_on, actual_minutes, minutes_origin, note, category, plan_session_id, focus_session_id, blocker, project_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, input.taskId ?? null, input.occurredOn, input.actualMinutes, input.minutesOrigin ?? "user_reported", input.note, input.category ?? "study", input.planSessionId ?? null, input.focusSessionId ?? null, input.blocker ?? "", input.projectId ?? null, now, now);
  // 新的实际投入会改变预算和剩余需求
  markPlanStale();
  return id;
}
