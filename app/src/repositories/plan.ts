import crypto from "node:crypto";
import { getDb } from "./db";
import type { Prefs } from "@/domain/budget";

/** plan_sessions / planning_preferences 仓储。写函数须在调用方事务内使用。 */

function now(): string {
  return new Date().toISOString();
}

export function getPrefs(): Prefs {
  const r = getDb().prepare(`SELECT * FROM planning_preferences WHERE id = 1`).get() as Record<string, unknown>;
  return {
    workdayStart: r.workday_start as string,
    workdayEnd: r.workday_end as string,
    weekendStart: r.weekend_start as string,
    weekendEnd: r.weekend_end as string,
    meals: JSON.parse(r.meals_json as string),
    commuteMinutes: r.commute_minutes as number,
    dailyLimitMinutes: r.daily_limit_minutes as number,
    minBlockMinutes: r.min_block_minutes as number,
    bufferPercent: r.buffer_percent as number,
    status: r.status as Prefs["status"],
    version: r.version as number,
  };
}

export function confirmPrefs(): void {
  getDb().prepare(`UPDATE planning_preferences SET status = 'confirmed', version = version + 1, updated_at = ? WHERE id = 1`).run(now());
}

export type PlanSessionRow = {
  id: string;
  taskId: string;
  title?: string;
  startUtc: string;
  endUtc: string;
  timezone: string;
  status: string;
  locked: boolean;
  batchId: string | null;
  version: number;
  reason: string;
  kind: "work" | "starter";
  origin: "agent" | "user";
};

function mapSession(r: Record<string, unknown>): PlanSessionRow {
  return {
    id: r.id as string,
    taskId: r.task_id as string,
    startUtc: r.start_utc as string,
    endUtc: r.end_utc as string,
    timezone: r.timezone as string,
    status: r.status as string,
    locked: Boolean(r.locked),
    batchId: (r.batch_id as string) ?? null,
    version: r.version as number,
    reason: (r.reason as string) ?? "",
    kind: ((r.kind as string) ?? "work") as PlanSessionRow["kind"],
    origin: ((r.origin as string) ?? "agent") as PlanSessionRow["origin"],
  };
}

export function listSessionsInRange(startUtc: string, endUtc: string): PlanSessionRow[] {
  const rows = getDb()
    .prepare(`SELECT * FROM plan_sessions WHERE end_utc > ? AND start_utc < ? AND status != 'superseded' ORDER BY start_utc`)
    .all(startUtc, endUtc) as Array<Record<string, unknown>>;
  return rows.map(mapSession);
}

export function getSession(id: string): PlanSessionRow | null {
  const r = getDb().prepare(`SELECT * FROM plan_sessions WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
  return r ? mapSession(r) : null;
}

export function sessionFromRow(r: Record<string, unknown>): PlanSessionRow {
  return mapSession(r);
}

/** 单块 supersede（重排时只作用于不再有效的块；完成/进行中/受保护块由调用方排除） */
export function supersedeSession(id: string): void {
  getDb().prepare(`UPDATE plan_sessions SET status = 'superseded', version = version + 1, updated_at = ? WHERE id = ?`).run(now(), id);
}

export function insertSession(input: { taskId: string; startUtc: string; endUtc: string; timezone: string; batchId: string; reason?: string; kind?: "work" | "starter"; origin?: "agent" | "user" }): string {
  const id = crypto.randomUUID();
  getDb()
    .prepare(
      `INSERT INTO plan_sessions (id, task_id, start_utc, end_utc, timezone, status, batch_id, reason, kind, origin, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'planned', ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, input.taskId, input.startUtc, input.endUtc, input.timezone, input.batchId, input.reason ?? "", input.kind ?? "work", input.origin ?? "agent", now(), now());
  return id;
}

export function setSessionStatus(id: string, expectedVersion: number, patch: { status?: string; locked?: boolean }): "ok" | "stale" | "not_found" {
  const cur = getSession(id);
  if (!cur) return "not_found";
  if (cur.version !== expectedVersion) return "stale";
  const r = getDb()
    .prepare(`UPDATE plan_sessions SET status = ?, locked = ?, version = version + 1, updated_at = ? WHERE id = ? AND version = ?`)
    .run(patch.status ?? cur.status, patch.locked === undefined ? (cur.locked ? 1 : 0) : patch.locked ? 1 : 0, now(), id, expectedVersion);
  return r.changes === 1 ? "ok" : "stale";
}
