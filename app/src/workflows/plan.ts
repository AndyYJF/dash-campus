import { getDb } from "@/repositories/db";
import { occurrences } from "@/domain/calendar-occurrences";
import { addDays, instanceTimezone, localDateInTz, mondayOf, wallTimeToUtc } from "@/domain/time";
import { dayBudget, minutesOf, next7Days, subtractIntervals, type Interval, type Prefs } from "@/domain/budget";
import { placeTasks, type SchedDay, type SchedTask, type Unscheduled } from "@/domain/scheduler";
import { getPrefs, insertSession, listSessionsInRange, supersedeFutureSessions } from "@/repositories/plan";
import { createBatch, addChange } from "@/repositories/journal";
import { COMMAND_POLICY_VERSION } from "@/contracts/commands";

/** 重排（MASTER-PLAN §6.2）：supersede 旧未来块 + 贪心放置 + journal，单事务原子。 */

export type RebuildResult = { kind: "planned"; batchId: string; placed: number; unscheduled: Unscheduled[] };

export function rebuildPlan(asOf: Date): RebuildResult {
  const tz = instanceTimezone();
  const prefs = getPrefs();
  const fromLocal = localDateInTz(asOf, tz);
  const days = buildSchedDays(fromLocal, asOf, prefs, tz);
  const tasks = listSchedulableTasks();
  const { placements, unscheduled } = placeTasks(tasks, days, { minBlock: prefs.minBlockMinutes, maxBlock: 90 });

  return getDb()
    .transaction((): RebuildResult => {
      const superseded = supersedeFutureSessions(asOf.toISOString());
      const batchId = createBatch({
        command: "plan_sessions",
        reason: JSON.stringify({ placed: placements.length, unscheduled }),
        intakeId: null,
        itemId: null,
        policyVersion: COMMAND_POLICY_VERSION,
        instanceEpoch: 0,
      });
      for (const s of superseded) {
        addChange(batchId, { entityKind: "plan_session", entityId: s.id, action: "update", before: { status: "planned" }, after: { status: "superseded" }, beforeVersion: s.version, afterVersion: s.version + 1 });
      }
      for (const p of placements) {
        const id = insertSession({ taskId: p.taskId, startUtc: new Date(p.start).toISOString(), endUtc: new Date(p.end).toISOString(), timezone: tz, batchId });
        addChange(batchId, { entityKind: "plan_session", entityId: id, action: "create", after: { taskId: p.taskId, start: p.start, end: p.end }, afterVersion: 1 });
      }
      return { kind: "planned", batchId, placed: placements.length, unscheduled };
    })
    .immediate();
}

/** 未来 7 天的可排区间：W 扣除已承诺（锁定/进行中的未来块），第 0 天裁到 asOf 之后 */
export function buildSchedDays(fromLocal: string, asOf: Date, prefs: Prefs, tz: string): SchedDay[] {
  return next7Days(fromLocal).map((date) => {
    const { w, cDay } = dayBudget(date, prefs, tz, eventsForDay(date, tz));
    const committed = committedIntervals(date, tz, asOf);
    let free = subtractIntervals(w, committed);
    if (date === fromLocal) free = free.map(([s, e]) => [Math.max(s, asOf.getTime()), e] as Interval).filter(([s, e]) => e > s);
    return { date, free, cDay };
  });
}

export function dayView(date: string, prefs: Prefs, tz: string): { w: Interval[]; cDay: number; courseMinutes: number; eventMinutes: number } {
  return dayBudget(date, prefs, tz, eventsForDay(date, tz));
}

/** 当日固定活动区间（fixed_events 展开）；isCourse = 由课程投影产生（用于通勤扣除与课程占用显示） */
function eventsForDay(date: string, tz: string): Array<{ interval: Interval; isCourse: boolean }> {
  const db = getDb();
  const first = wallTimeToUtc(date, "00:00", tz).getTime();
  const last = wallTimeToUtc(addDays(date, 1), "00:00", tz).getTime();
  const courseIds = new Set(
    (db.prepare(`SELECT DISTINCT fixed_event_id FROM course_meeting_projections`).all() as Array<{ fixed_event_id: string }>).map((r) => r.fixed_event_id),
  );
  const rows = db.prepare(`SELECT * FROM fixed_events`).all() as Array<Record<string, unknown>>;
  const out: Array<{ interval: Interval; isCourse: boolean }> = [];
  for (const r of rows) {
    const rule = {
      id: r.id as string,
      title: r.title as string, weekday: r.weekday as number,
      localStart: r.local_start as string, localEnd: r.local_end as string, timezone: r.timezone as string,
      eventDate: (r.event_date as string) ?? null, validFrom: (r.valid_from as string) ?? null, validUntil: (r.valid_until as string) ?? null,
    };
    for (const [s, e] of occurrences(rule, first, last)) out.push({ interval: [s, e], isCourse: courseIds.has(r.id as string) });
  }
  return out;
}

/** 已承诺的未来块（锁定或进行中；普通 planned 会被 supersede 不占位） */
function committedIntervals(date: string, tz: string, asOf: Date): Interval[] {
  const first = wallTimeToUtc(date, "00:00", tz).toISOString();
  const last = wallTimeToUtc(addDays(date, 1), "00:00", tz).toISOString();
  return listSessionsInRange(first, last)
    .filter((s) => (s.locked && s.status === "planned") || s.status === "in_progress")
    .filter((s) => new Date(s.endUtc).getTime() > asOf.getTime())
    .map((s) => [new Date(s.startUtc).getTime(), new Date(s.endUtc).getTime()] as Interval);
}

function listSchedulableTasks(): SchedTask[] {
  const rows = getDb()
    .prepare(`SELECT id, title, estimate_minutes, due_local_date, priority, created_at FROM tasks WHERE status IN ('todo','doing') AND archived_at IS NULL`)
    .all() as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    id: r.id as string,
    title: r.title as string,
    estimateMinutes: (r.estimate_minutes as number) ?? null,
    dueLocalDate: (r.due_local_date as string) ?? null,
    priority: r.priority as SchedTask["priority"],
    createdAt: r.created_at as string,
  }));
}

/** 最近一次重排的未排原因（week 端点展示用） */
export function latestPlanUnscheduled(): Unscheduled[] {
  const r = getDb().prepare(`SELECT reason FROM agent_action_batches WHERE command = 'plan_sessions' ORDER BY created_at DESC LIMIT 1`).get() as { reason: string } | undefined;
  if (!r) return [];
  try {
    return (JSON.parse(r.reason) as { unscheduled?: Unscheduled[] }).unscheduled ?? [];
  } catch {
    return [];
  }
}

export function mondayOfDate(dateLocal: string): string {
  return mondayOf(dateLocal);
}

export function dayMinutes(ws: Interval[]): number {
  return minutesOf(ws);
}
