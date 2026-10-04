import { getDb } from "./db";
import { resolveTaskKind, pendingReason, type ResolvedTaskKind } from "@/domain/task-admission";

export type PendingTask = { taskId: string; title: string; kind: ResolvedTaskKind; reason: string; dueLocalDate: string | null; dueAt: string | null };

/** Pure read: the dashboard must not create questions or write classification on GET. */
export function pendingTasks(): PendingTask[] {
  const rows = getDb().prepare(`SELECT id, title, task_kind, due_local_date, due_at FROM tasks
    WHERE status IN ('todo','doing','blocked') AND archived_at IS NULL
    ORDER BY CASE WHEN due_at IS NULL AND due_local_date IS NULL THEN 1 ELSE 0 END,
      COALESCE(due_local_date, substr(due_at, 1, 10)), priority DESC, created_at, id`).all() as Array<{
      id: string; title: string; task_kind: string; due_local_date: string | null; due_at: string | null;
    }>;
  return rows.flatMap((r) => {
    const kind = resolveTaskKind({ title: r.title, taskKind: r.task_kind });
    return kind === "study" ? [] : [{ taskId: r.id, title: r.title, kind, reason: pendingReason(kind), dueLocalDate: r.due_local_date, dueAt: r.due_at }];
  });
}

export function taskAdmitted(id: string): boolean {
  const row = getDb().prepare("SELECT title, task_kind FROM tasks WHERE id = ?").get(id) as { title: string; task_kind: string } | undefined;
  return Boolean(row && resolveTaskKind({ title: row.title, taskKind: row.task_kind }) === "study");
}
