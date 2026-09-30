import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getDb } from "@/repositories/db";
import { listJobs } from "@/repositories/jobs";
import { listDeliveries } from "@/repositories/deliveries";
import { requireOwner } from "@/workflows/auth-guard";
import { reminderTriggerUtc } from "@/domain/reminders";
import { REMINDER_JOB_TYPE } from "@/contracts/jobs";

export const dynamic = "force-dynamic";

/**
 * GET /api/v1/notifications —— 提醒待处理摘要（计划 8.2"过去触发点进入今日待处理"的最小实现）。
 * pendingReminders：活动任务的触发点已到、但当前 reminderRevision 尚无 accepted 投递；
 * upcomingReminders：排队中的未来提醒 job；
 * inFlightOldReminders：提交中/结果不确定的旧版本投递（改期后允许在途，提示"存在发送中的旧提醒"）。
 */
export function GET(request: NextRequest) {
  const auth = requireOwner(request);
  if (!auth.ok) return auth.response;
  const db = getDb();
  const nowIso = new Date().toISOString();

  const activeTasks = db
    .prepare(
      `SELECT id, title, due_kind, due_local_date, due_timezone, due_at, reminder_revision
       FROM tasks
       WHERE archived_at IS NULL AND status NOT IN ('done', 'cancelled') AND due_kind != 'none'`,
    )
    .all() as Array<{
    id: string;
    title: string;
    due_kind: "date" | "instant";
    due_local_date: string | null;
    due_timezone: string | null;
    due_at: string | null;
    reminder_revision: number;
  }>;

  const pendingReminders = [];
  for (const t of activeTasks) {
    const due =
      t.due_kind === "date"
        ? { kind: "date" as const, localDate: t.due_local_date!, timezone: t.due_timezone! }
        : { kind: "instant" as const, at: t.due_at!, timezone: t.due_timezone! };
    const trigger = reminderTriggerUtc(due);
    if (!trigger || trigger > nowIso) continue;
    const delivered = db
      .prepare(
        `SELECT 1 FROM deliveries
         WHERE task_id = ? AND reminder_revision = ? AND status = 'accepted'`,
      )
      .get(t.id, t.reminder_revision);
    if (delivered) continue;
    pendingReminders.push({
      taskId: t.id,
      title: t.title,
      due,
      triggerAt: trigger,
      reminderRevision: t.reminder_revision,
    });
  }

  const upcomingReminders = listJobs({ type: REMINDER_JOB_TYPE, status: "queued" })
    .filter((j) => j.taskId)
    .map((j) => {
      const task = db.prepare(`SELECT title FROM tasks WHERE id = ?`).get(j.taskId) as
        | { title: string }
        | undefined;
      return { jobId: j.id, taskId: j.taskId, title: task?.title ?? "(任务已删除)", runAt: j.runAt };
    });

  const inFlightOldReminders = db
    .prepare(
      `SELECT d.id, d.task_id, d.status, d.reminder_revision, t.reminder_revision AS current_revision, t.title
       FROM deliveries d JOIN tasks t ON t.id = d.task_id
       WHERE d.status IN ('submitting', 'unknown') AND d.reminder_revision < t.reminder_revision
       ORDER BY d.created_at DESC LIMIT 20`,
    )
    .all() as Array<{
    id: string;
    task_id: string;
    status: string;
    reminder_revision: number;
    current_revision: number;
    title: string;
  }>;

  const recentDeliveries = listDeliveries().map((d) => {
    const copy: Record<string, unknown> = { ...d };
    delete copy.snapshot;
    delete copy.leaseToken;
    return copy;
  });

  return NextResponse.json({
    asOf: nowIso,
    pendingReminders,
    upcomingReminders,
    inFlightOldReminders: inFlightOldReminders.map((d) => ({
      deliveryId: d.id,
      taskId: d.task_id,
      title: d.title,
      status: d.status,
      reminderRevision: d.reminder_revision,
      currentRevision: d.current_revision,
    })),
    recentDeliveries,
  });
}
