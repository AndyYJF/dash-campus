import { getDb } from "@/repositories/db";
import { getFocusSession, stopFocus } from "@/repositories/focus-timer";
import { insertPracticeEntry } from "@/repositories/practice";
import { localDateInTz, instanceTimezone } from "@/domain/time";
import { matchTask } from "@/domain/task-text";
import { nowDate } from "@/domain/clock";

/**
 * focus 停止 → 实践记录（MASTER-PLAN §6.3，REPAIR-PLAN §5.2）：
 * - 超过 4 小时或跨日：先给出具体时段和候选分钟，由主人确认、修正或放弃，不直接当实际投入；
 * - 与手动记录是否同一次，看活动证据（同一个任务，或同样的活动说明），不看分钟是否接近；
 *   数学 40 分钟和羽毛球 38 分钟是两件事；
 * - 合并是可核对的：主人说“不是同一次”可以再分开。
 */

export type StopResult =
  | { kind: "ok"; merged: boolean; minutes: number; practiceId: string; mergedNote: string | null }
  | { kind: "discarded" }
  | { kind: "needs_confirmation"; minutes: number; startedAt: string; reason: "long" | "cross_day" }
  | { kind: "invalid_minutes"; max: number }
  | { kind: "stale" }
  | { kind: "not_open" };

const MERGE_TOLERANCE_MIN = 10;
const CONFIRM_THRESHOLD_MIN = 4 * 60;
const NON_STUDY = /跑步|跑了|羽毛球|篮球|足球|乒乓|健身|游泳|打球|锻炼|运动/;

function sameActivity(a: string, b: string): boolean {
  return Boolean(a.trim()) && matchTask(a, [{ id: "x", title: b }]).kind === "one";
}

export function stopFocusAndRecord(id: string, expectedVersion: number, opts: boolean | { confirm?: boolean; minutes?: number | null; discard?: boolean } = false): StopResult {
  const o = typeof opts === "boolean" ? { confirm: opts } : opts;
  const row = getFocusSession(id);
  if (!row || row.status === "completed") return { kind: "not_open" };
  if (row.version !== expectedVersion) return { kind: "stale" };
  const tz = instanceTimezone();
  const now = nowDate();
  const elapsed = row.accumulatedMinutes + (row.status === "in_progress" ? Math.max(0, Math.round((now.getTime() - new Date(row.startedAt).getTime()) / 60000)) : 0);
  const crossDay = localDateInTz(new Date(row.startedAt), tz) !== localDateInTz(now, tz);
  const decided = o.confirm || o.discard || (o.minutes !== undefined && o.minutes !== null);
  if ((elapsed > CONFIRM_THRESHOLD_MIN || crossDay) && !decided) {
    return { kind: "needs_confirmation", minutes: elapsed, startedAt: row.startedAt, reason: elapsed > CONFIRM_THRESHOLD_MIN ? "long" : "cross_day" };
  }
  if (o.minutes !== undefined && o.minutes !== null && (o.minutes < 1 || o.minutes > Math.max(1, elapsed))) return { kind: "invalid_minutes", max: elapsed };

  const db = getDb();
  return db.transaction((): StopResult => {
    const r = stopFocus(id, expectedVersion);
    if (r.kind !== "ok") return { kind: r.kind };
    const sessionId = (db.prepare(`SELECT plan_session_id FROM focus_sessions WHERE id = ?`).get(id) as { plan_session_id: string | null }).plan_session_id;
    if (sessionId) {
      // 从行动卡开始的计时：停下就是这一段结束（只完成学习块，不完成任务）
      db.prepare(`UPDATE plan_sessions SET status = 'completed', version = version + 1, updated_at = ? WHERE id = ? AND status IN ('planned','tentative','in_progress')`).run(now.toISOString(), sessionId);
    }
    if (o.discard) return { kind: "discarded" };
    const minutes = o.minutes ?? r.minutes;
    db.prepare(`UPDATE focus_sessions SET accumulated_minutes = ? WHERE id = ?`).run(minutes, id);
    const occurredOn = localDateInTz(new Date(r.startedAt), tz);
    const manual = db
      .prepare(`SELECT id, task_id, actual_minutes, note FROM practice_entries WHERE occurred_on = ? AND minutes_origin = 'user_reported' AND focus_session_id IS NULL ORDER BY created_at DESC`)
      .all(occurredOn) as Array<{ id: string; task_id: string | null; actual_minutes: number | null; note: string }>;
    const candidate = manual.find(
      (p) => p.actual_minutes !== null && Math.abs(p.actual_minutes - minutes) <= MERGE_TOLERANCE_MIN && (r.taskId ? p.task_id === r.taskId : !p.task_id && sameActivity(r.note, p.note)),
    );
    if (candidate) {
      db.prepare(`UPDATE practice_entries SET note = note || ?, focus_session_id = ?, updated_at = ? WHERE id = ?`).run(`（计时确认 ${minutes} 分钟）`, id, now.toISOString(), candidate.id);
      return { kind: "ok", merged: true, minutes, practiceId: candidate.id, mergedNote: candidate.note };
    }
    const practiceId = insertPracticeEntry({ occurredOn, actualMinutes: minutes, note: r.note || "计时实践", taskId: r.taskId, minutesOrigin: "timer", focusSessionId: id, planSessionId: sessionId, category: NON_STUDY.test(r.note) ? "other" : "study" });
    return { kind: "ok", merged: false, minutes, practiceId, mergedNote: null };
  })();
}

/** “不是同一次”：把合并进手动记录的那次计时重新记成独立的一条 */
export function splitFocusMerge(focusId: string): { kind: "split"; practiceId: string } | { kind: "not_merged" } {
  const db = getDb();
  return db.transaction(() => {
    const focus = getFocusSession(focusId);
    const merged = db.prepare(`SELECT id, note FROM practice_entries WHERE focus_session_id = ? AND minutes_origin = 'user_reported'`).get(focusId) as { id: string; note: string } | undefined;
    if (!focus || !merged) return { kind: "not_merged" as const };
    db.prepare(`UPDATE practice_entries SET note = ?, focus_session_id = NULL, updated_at = ? WHERE id = ?`).run(merged.note.replace(/（计时确认 \d+ 分钟）$/, ""), new Date().toISOString(), merged.id);
    const practiceId = insertPracticeEntry({ occurredOn: localDateInTz(new Date(focus.startedAt), instanceTimezone()), actualMinutes: focus.accumulatedMinutes, note: focus.note || "计时实践", taskId: focus.taskId, minutesOrigin: "timer", focusSessionId: focusId, category: NON_STUDY.test(focus.note) ? "other" : "study" });
    return { kind: "split" as const, practiceId };
  })();
}
