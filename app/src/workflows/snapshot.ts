import { getDb } from "@/repositories/db";
import { instanceTimezone, localDateInTz, mondayOf, wallTimeToUtc, addDays } from "@/domain/time";
import { futureCapacity, minutesOf, type Interval } from "@/domain/budget";
import { getPrefs, listSessionsInRange } from "@/repositories/plan";
import { listOpenQuestions } from "@/repositories/questions";
import { getPlanningRevision } from "@/repositories/proposals";
import { dayView, latestPlanUnscheduled } from "./plan";

/**
 * 统一 snapshot（MASTER-PLAN §6.1/§8）：dashboard/week/direction 共用同一预算账本与会话数据；
 * snapshotRevision 相同输入必然相同，页面不得拼出矛盾数字。GET 纯读取，无副作用。
 */

export function snapshotRevision(): string {
  const prefs = getPrefs();
  const batch = getDb().prepare(`SELECT id FROM agent_action_batches WHERE command = 'plan_sessions' ORDER BY created_at DESC LIMIT 1`).get() as { id: string } | undefined;
  return `${getPlanningRevision()}:${prefs.version}:${batch?.id ?? "none"}`;
}

function dayRangeUtc(date: string, tz: string): [string, string] {
  return [wallTimeToUtc(date, "00:00", tz).toISOString(), wallTimeToUtc(addDays(date, 1), "00:00", tz).toISOString()];
}

function sessionView(s: { id: string; taskId: string; startUtc: string; endUtc: string; status: string; locked: boolean; version: number }) {
  return {
    id: s.id,
    taskId: s.taskId,
    title: (getDb().prepare(`SELECT title FROM tasks WHERE id = ?`).get(s.taskId) as { title: string } | undefined)?.title ?? "",
    startUtc: s.startUtc,
    endUtc: s.endUtc,
    minutes: Math.round((new Date(s.endUtc).getTime() - new Date(s.startUtc).getTime()) / 60000),
    status: s.status,
    locked: s.locked,
    version: s.version,
  };
}

/** 当日预算账本：B_day = 已完成块计划分钟（estimated）+ 当日已记录实践分钟 */
function consumedMinutes(date: string, tz: string): number {
  const [first, last] = dayRangeUtc(date, tz);
  const sessions = listSessionsInRange(first, last).filter((s) => s.status === "completed");
  const sessionMinutes = sessions.reduce((a, s) => a + (new Date(s.endUtc).getTime() - new Date(s.startUtc).getTime()) / 60000, 0);
  const practice = getDb().prepare(`SELECT COALESCE(SUM(actual_minutes), 0) AS m FROM practice_entries WHERE occurred_on = ?`).get(date) as { m: number };
  return Math.round(sessionMinutes + practice.m);
}

export function dashboardSnapshot(dateLocal: string, asOf: Date) {
  const tz = instanceTimezone();
  const prefs = getPrefs();
  const view = dayView(dateLocal, prefs, tz);
  const [first, last] = dayRangeUtc(dateLocal, tz);
  const sessions = listSessionsInRange(first, last).filter((s) => s.status !== "superseded");
  const bDay = consumedMinutes(dateLocal, tz);
  const wFuture = view.w.map(([s, e]) => [Math.max(s, asOf.getTime()), e] as Interval).filter(([s, e]) => e > s);
  const pFuture = sessions
    .filter((s) => ["planned", "in_progress"].includes(s.status) && new Date(s.endUtc).getTime() > asOf.getTime())
    .reduce((a, s) => a + (new Date(s.endUtc).getTime() - Math.max(new Date(s.startUtc).getTime(), asOf.getTime())) / 60000, 0);
  const future = futureCapacity({ cDay: view.cDay, bDay, wFutureMinutes: minutesOf(wFuture), pFutureMinutes: Math.round(pFuture), bufferPercent: prefs.bufferPercent });
  return {
    snapshotRevision: snapshotRevision(),
    asOf: asOf.toISOString(),
    date: dateLocal,
    today: {
      courseMinutes: view.courseMinutes,
      eventMinutes: view.eventMinutes,
      sessions: sessions.map(sessionView),
      budget: { cDay: view.cDay, bDay, futureBudget: future.futureBudget, futureCapacity: future.futureCapacity, source: prefs.status },
    },
    questions: listOpenQuestions(3).map((q) => ({ id: q.id, prompt: q.prompt, version: q.version })),
    recentChanges: recentBatches(),
  };
}

export function weekSnapshot(mondayLocal: string, asOf: Date) {
  const tz = instanceTimezone();
  const prefs = getPrefs();
  const days = Array.from({ length: 7 }, (_, i) => {
    const date = addDays(mondayLocal, i);
    const view = dayView(date, prefs, tz);
    const [first, last] = dayRangeUtc(date, tz);
    const sessions = listSessionsInRange(first, last).filter((s) => s.status !== "superseded");
    return {
      date,
      courseMinutes: view.courseMinutes,
      cDay: view.cDay,
      bDay: consumedMinutes(date, tz),
      sessions: sessions.map(sessionView),
    };
  });
  return {
    snapshotRevision: snapshotRevision(),
    asOf: asOf.toISOString(),
    monday: mondayLocal,
    days,
    weekBudget: days.reduce((a, d) => a + d.cDay, 0),
    unscheduled: latestPlanUnscheduled(),
    source: prefs.status,
  };
}

export function directionSnapshot(asOf: Date) {
  const db = getDb();
  const goals = db
    .prepare(`SELECT id, title, status FROM goals WHERE status IN ('active','paused') ORDER BY created_at LIMIT 10`)
    .all() as Array<{ id: string; title: string; status: string }>;
  const practice = db
    .prepare(`SELECT id, occurred_on, actual_minutes, note FROM practice_entries ORDER BY occurred_on DESC, created_at DESC LIMIT 10`)
    .all() as Array<{ id: string; occurred_on: string; actual_minutes: number | null; note: string }>;
  return {
    snapshotRevision: snapshotRevision(),
    asOf: asOf.toISOString(),
    goals: goals.map((g) => ({ id: g.id, title: g.title, status: g.status })),
    practice: practice.map((p) => ({ id: p.id, occurredOn: p.occurred_on, actualMinutes: p.actual_minutes, note: p.note })),
    evidenceState: practice.length ? "has_evidence" : "no_evidence",
    candidates: [],
    honesty: practice.length
      ? "建议只引用上面的实践记录；没有记录的方面不编造。"
      : "还没有实践记录，方向建议缺少证据。先记录几次真实学习再来看这里。",
  };
}

function recentBatches() {
  const rows = getDb()
    .prepare(`SELECT id, command, status, created_at FROM agent_action_batches ORDER BY created_at DESC LIMIT 5`)
    .all() as Array<{ id: string; command: string; status: string; created_at: string }>;
  return rows.map((r) => ({ batchId: r.id, command: r.command, status: r.status, createdAt: r.created_at }));
}

export function weekMondayOf(dateLocal: string): string {
  return mondayOf(dateLocal);
}

export function todayLocal(): string {
  return localDateInTz(new Date(), instanceTimezone());
}
