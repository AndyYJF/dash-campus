import { getDb } from "@/repositories/db";
import { createJob } from "@/repositories/jobs";
import { cancelQueuedForTask } from "@/repositories/deliveries";
import { REMINDER_JOB_TYPE, reminderJobPayloadSchema } from "@/contracts/jobs";
import { reminderTriggerUtc, reminderActive } from "@/domain/reminders";
import type { TaskRow } from "@/repositories/planning";
import { dueBoundaryUtc } from "@/domain/time";
import { adjustForQuiet, reminderPolicy } from "@/workflows/reminder-policy";

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
  // 提醒策略：主人关掉截止提醒就不建；暂停中的任务不提醒；安静时段内的触发点推迟/提前，不在夜里发
  const policy = reminderPolicy();
  if (!policy.deadlineReminders) return;
  const paused = (db.prepare(`SELECT paused_until FROM tasks WHERE id = ?`).get(task.id) as { paused_until: string | null } | undefined)?.paused_until;
  if (paused && paused > nowIso.slice(0, 10)) return;
  const raw = reminderTriggerUtc(task.due, task.reminderLeadMinutes ?? policy.defaultLeadMinutes);
  const trigger = raw ? adjustForQuiet(raw, dueBoundaryUtc(task.due), nowIso, policy) : null;
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

/** 策略变化后让既有提醒与新策略一致：所有未结束、有截止的任务重排一遍提醒（同版本去重，不会重复发） */
export function refreshAllReminders(nowIso: string): number {
  const db = getDb();
  const ids = db.prepare(`SELECT id FROM tasks WHERE archived_at IS NULL AND status NOT IN ('done','cancelled') AND due_kind != 'none'`).all() as Array<{ id: string }>;
  let n = 0;
  for (const { id } of ids) {
    // 策略变了：递增提醒版本，旧版本的在途任务在准入时会被拦下
    db.prepare(`UPDATE tasks SET reminder_revision = reminder_revision + 1 WHERE id = ?`).run(id);
    const row = db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(id) as Record<string, unknown>;
    refreshReminders(taskFromRow(row), nowIso);
    n++;
  }
  return n;
}

function taskFromRow(r: Record<string, unknown>): TaskRow {
  const kind = r.due_kind as string;
  const due =
    kind === "date"
      ? { kind: "date" as const, localDate: r.due_local_date as string, timezone: r.due_timezone as string }
      : kind === "instant"
        ? { kind: "instant" as const, at: r.due_at as string, timezone: r.due_timezone as string }
        : { kind: "none" as const };
  return { id: r.id as string, status: r.status as TaskRow["status"], archivedAt: (r.archived_at as string | null) ?? null, due, reminderLeadMinutes: (r.reminder_lead_minutes as number | null) ?? null, reminderRevision: r.reminder_revision as number } as TaskRow;
}
