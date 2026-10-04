import crypto from "node:crypto";
import { getDb } from "./db";
import { nowDate } from "@/domain/clock";

/** focus 计时仓储（§5.1：最多 1 个进行中，由部分唯一索引兜底）。须在调用方事务内使用。 */

export type FocusRow = {
  id: string;
  taskId: string | null;
  note: string;
  startedAt: string;
  accumulatedMinutes: number;
  status: "in_progress" | "paused" | "completed";
  version: number;
};

function map(r: Record<string, unknown>): FocusRow {
  return {
    id: r.id as string,
    taskId: (r.task_id as string | null) ?? null,
    note: r.note as string,
    startedAt: r.started_at as string,
    accumulatedMinutes: r.accumulated_minutes as number,
    status: r.status as FocusRow["status"],
    version: r.version as number,
  };
}

export function getInProgressFocus(): FocusRow | null {
  const r = getDb().prepare(`SELECT * FROM focus_sessions WHERE status = 'in_progress'`).get() as Record<string, unknown> | undefined;
  return r ? map(r) : null;
}

export function getFocusSession(id: string): FocusRow | null {
  const r = getDb().prepare(`SELECT * FROM focus_sessions WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
  return r ? map(r) : null;
}

/** 启动计时；已有进行中返回 null（调用方转 409） */
export function startFocus(input: { taskId?: string | null; note: string; planSessionId?: string | null }): FocusRow | null {
  if (getInProgressFocus()) return null;
  const id = crypto.randomUUID();
  const now = nowDate().toISOString();
  getDb()
    .prepare(`INSERT INTO focus_sessions (id, task_id, note, started_at, accumulated_minutes, status, version, plan_session_id, created_at, updated_at) VALUES (?, ?, ?, ?, 0, 'in_progress', 1, ?, ?, ?)`)
    .run(id, input.taskId ?? null, input.note, now, input.planSessionId ?? null, now, now);
  return getFocusSession(id);
}

/** 停止计时（版本条件更新）；返回累计分钟数，过期版本 'stale'，非进行中 'not_open' */
export function stopFocus(
  id: string,
  expectedVersion: number,
): { kind: "ok"; minutes: number; startedAt: string; taskId: string | null; note: string } | { kind: "stale" | "not_open" } {
  const row = getFocusSession(id);
  if (!row || row.status === "completed") return { kind: "not_open" };
  const now = nowDate();
  const elapsed = row.status === "in_progress" ? Math.max(0, Math.round((now.getTime() - new Date(row.startedAt).getTime()) / 60000)) : 0;
  const minutes = row.accumulatedMinutes + elapsed;
  const r = getDb()
    .prepare(`UPDATE focus_sessions SET status = 'completed', accumulated_minutes = ?, version = version + 1, updated_at = ? WHERE id = ? AND version = ? AND status != 'completed'`)
    .run(minutes, now.toISOString(), id, expectedVersion);
  if (r.changes === 0) return { kind: "stale" };
  return { kind: "ok", minutes, startedAt: row.startedAt, taskId: row.taskId, note: row.note };
}
