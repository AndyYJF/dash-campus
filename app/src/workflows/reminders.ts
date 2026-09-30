import { getDb } from "@/repositories/db";
import { createJob } from "@/repositories/jobs";
import { cancelQueuedForTask } from "@/repositories/deliveries";
import { REMINDER_JOB_TYPE, reminderJobPayloadSchema } from "@/contracts/jobs";
import { reminderTriggerUtc, reminderActive } from "@/domain/reminders";
import type { TaskRow } from "@/repositories/planning";

/**
 * 任务提醒同步（计划 v1.2 第 8.2 节）。
 * 必须在任务写入的同一事务内调用：取消旧未准入提醒 → 只建立触发时间在当前时刻之后的新提醒。
 * 过去触发点不建 job，由 notifications 查询进入"今日待处理"；due=none 不建提醒。
 * 重复打开同一状态不会走到这里（不递增 revision，调用方保证）。
 */

export function refreshReminders(task: TaskRow, nowIso: string): void {
  const db = getDb();
  // 旧未准入提醒（queued）取消；running 的由准入时的 revision 校验拦截（F12 前半）
  db.prepare(
    `UPDATE jobs SET status = 'cancelled', updated_at = ?
     WHERE type = ? AND task_id = ? AND status = 'queued'`,
  ).run(nowIso, REMINDER_JOB_TYPE, task.id);
  cancelQueuedForTask(task.id);

  if (!reminderActive(task)) return;
  const trigger = reminderTriggerUtc(task.due);
  // 只建立触发时间在当前时刻之后的新版本提醒
  if (!trigger || trigger <= nowIso) return;

  const payload = reminderJobPayloadSchema.parse({
    taskId: task.id,
    reminderRevision: task.reminderRevision,
    triggerAt: trigger,
  });
  createJob({
    type: REMINDER_JOB_TYPE,
    taskId: task.id,
    // 按 taskId+revision 去重：同一 revision 重复同步不重复建 job（F22）
    dedupeKey: `reminder:${task.id}:${task.reminderRevision}`,
    runAt: trigger,
    payload,
  });
}
