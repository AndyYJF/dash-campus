import { getDb } from "@/repositories/db";
import { getFocusSession, stopFocus } from "@/repositories/focus-timer";
import { localDateInTz, instanceTimezone } from "@/domain/time";
import crypto from "node:crypto";

/**
 * focus 停止 → 实践记录（§6.3）：
 * - >4h 需显式确认才计入（未确认不消耗版本、保持进行中）；
 * - A08 合并：同日已有手动汇报且分钟差 ≤10min，视为同一实践——不新建记录，给原记录标注计时确认，actual 不翻倍。
 */

export type StopResult =
  | { kind: "ok"; merged: boolean; minutes: number }
  | { kind: "needs_confirmation"; minutes: number }
  | { kind: "stale" }
  | { kind: "not_open" };

const MERGE_TOLERANCE_MIN = 10;
const CONFIRM_THRESHOLD_MIN = 4 * 60;

export function stopFocusAndRecord(id: string, expectedVersion: number, confirm: boolean): StopResult {
  const row = getFocusSession(id);
  if (!row || row.status === "completed") return { kind: "not_open" };
  const previewMinutes = row.accumulatedMinutes + (row.status === "in_progress" ? Math.max(0, Math.round((Date.now() - new Date(row.startedAt).getTime()) / 60000)) : 0);
  if (previewMinutes > CONFIRM_THRESHOLD_MIN && !confirm) return { kind: "needs_confirmation", minutes: previewMinutes };

  const r = stopFocus(id, expectedVersion);
  if (r.kind !== "ok") return { kind: r.kind };
  const tz = instanceTimezone();
  const occurredOn = localDateInTz(new Date(r.startedAt), tz);
  const db = getDb();
  const manual = db
    .prepare(`SELECT id, actual_minutes FROM practice_entries WHERE occurred_on = ? AND minutes_origin = 'user_reported' ORDER BY created_at DESC`)
    .all(occurredOn) as Array<{ id: string; actual_minutes: number | null }>;
  const candidate = manual.find((p) => p.actual_minutes !== null && Math.abs(p.actual_minutes - r.minutes) <= MERGE_TOLERANCE_MIN);
  if (candidate) {
    db.prepare(`UPDATE practice_entries SET note = note || ?, updated_at = ? WHERE id = ?`).run(`（计时确认 ${r.minutes} 分钟）`, new Date().toISOString(), candidate.id);
    return { kind: "ok", merged: true, minutes: r.minutes };
  }
  const entryId = crypto.randomUUID();
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO practice_entries (id, task_id, occurred_on, actual_minutes, minutes_origin, note, created_at, updated_at) VALUES (?, ?, ?, ?, 'timer', ?, ?, ?)`).run(
    entryId,
    r.taskId,
    occurredOn,
    r.minutes,
    r.note || "计时实践",
    now,
    now,
  );
  return { kind: "ok", merged: false, minutes: r.minutes };
}
