import { getDb } from "@/repositories/db";
import { instanceTimezone, localDateInTz, mondayOf, wallTimeToUtc, addDays } from "@/domain/time";
import { nowDate } from "@/domain/clock";
import { getPrefs, listSessionsInRange } from "@/repositories/plan";
import { listOpenQuestions } from "@/repositories/questions";
import { getInProgressFocus } from "@/repositories/focus-timer";
import { getPlanningRevision } from "@/repositories/proposals";
import { dayLedger, eventsForDay, latestPlanConflicts, latestPlanUnscheduled, type DayLedger } from "./plan";

/**
 * 统一 snapshot（MASTER-PLAN §6.1/§8）：dashboard/week/direction 共用同一预算账本与会话数据；
 * snapshotRevision 相同输入必然相同，页面不得拼出矛盾数字。GET 纯读取，无副作用。
 */

export function snapshotRevision(): string {
  const prefs = getPrefs();
  const batch = getDb().prepare(`SELECT id FROM agent_action_batches WHERE command = 'plan_sessions' ORDER BY created_at DESC, rowid DESC LIMIT 1`).get() as { id: string } | undefined;
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

/** 页面用的预算视图：字段全部来自共享账本（与排程同一计算器），不在这里另算 */
function budgetView(l: DayLedger, source: string) {
  return {
    cDay: l.cDay,
    bDay: l.bDay,
    actualMinutes: l.actualMinutes,
    estimatedMinutes: l.estimatedMinutes,
    provisionalMinutes: l.provisionalMinutes,
    otherActivityMinutes: l.otherActivityMinutes,
    committedFutureMinutes: l.pFuture,
    futureBudget: l.futureBudget,
    futureCapacity: l.futureCapacity,
    dailyLimit: l.policy.dailyLimit,
    source: l.policy.tentative ? "tentative" : source,
  };
}

/** 时间线用的课程/固定活动/待核对预留：与预算扣除的是同一批区间 */
function eventViews(date: string, tz: string) {
  return eventsForDay(date, tz)
    .map((e) => ({
      id: e.id,
      title: e.title,
      startUtc: new Date(e.interval[0]).toISOString(),
      endUtc: new Date(e.interval[1]).toISOString(),
      kind: e.kind,
      location: e.location ?? "",
      teacher: e.teacher ?? "",
      courseId: e.courseId ?? null,
      sourceDate: e.sourceDate ?? null,
      origin: e.origin ?? null,
    }))
    .sort((a, b) => (a.startUtc < b.startUtc ? -1 : a.startUtc > b.startUtc ? 1 : 0));
}

/** 日期头：公历日类型、教学周、停课/补课/待核对说明及出处 */
function calendarView(l: DayLedger) {
  const c = l.calendar;
  return {
    civilType: c.civil.type,
    civilName: c.civil.name,
    civilKnown: c.civil.known,
    civilSourceUrl: c.civil.sourceUrl,
    teachingWeek: c.teachingWeek,
    phase: c.phase,
    teachingStatus: c.teaching.status,
    teachingNote: c.teaching.note,
    sourceTeachingDate: c.teaching.sourceTeachingDate,
    schoolEvents: c.schoolEvents.map((e) => ({ kind: e.kind, title: e.title })),
    policyNotes: l.policy.notes,
    noStudy: l.policy.noStudy,
  };
}

function daySessions(date: string, tz: string) {
  const [first, last] = dayRangeUtc(date, tz);
  return listSessionsInRange(first, last).filter((s) => s.status !== "superseded").map(sessionView);
}

export function dashboardSnapshot(dateLocal: string, asOf: Date) {
  const tz = instanceTimezone();
  const prefs = getPrefs();
  const ledger = dayLedger(dateLocal, asOf, prefs, tz);
  return {
    snapshotRevision: snapshotRevision(),
    asOf: asOf.toISOString(),
    date: dateLocal,
    today: {
      courseMinutes: ledger.courseMinutes,
      eventMinutes: ledger.eventMinutes,
      fixedMinutes: ledger.fixedMinutes,
      calendar: calendarView(ledger),
      events: eventViews(dateLocal, tz),
      sessions: daySessions(dateLocal, tz),
      budget: budgetView(ledger, prefs.status),
    },
    questions: listOpenQuestions(3).map((q) => ({ id: q.id, prompt: q.prompt, version: q.version })),
    focus: (() => {
      const f = getInProgressFocus();
      return f ? { id: f.id, note: f.note, startedAt: f.startedAt, version: f.version } : null;
    })(),
    recentChanges: recentBatches(),
  };
}

export function weekSnapshot(mondayLocal: string, asOf: Date) {
  const tz = instanceTimezone();
  const prefs = getPrefs();
  const days = Array.from({ length: 7 }, (_, i) => {
    const date = addDays(mondayLocal, i);
    const ledger = dayLedger(date, asOf, prefs, tz);
    return {
      date,
      courseMinutes: ledger.courseMinutes,
      fixedMinutes: ledger.fixedMinutes,
      cDay: ledger.cDay,
      bDay: ledger.bDay,
      budget: budgetView(ledger, prefs.status),
      calendar: calendarView(ledger),
      events: eventViews(date, tz),
      sessions: daySessions(date, tz),
    };
  });
  return {
    snapshotRevision: snapshotRevision(),
    asOf: asOf.toISOString(),
    monday: mondayLocal,
    days,
    weekBudget: days.reduce((a, d) => a + d.cDay, 0),
    unscheduled: latestPlanUnscheduled(),
    conflicts: latestPlanConflicts(),
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
  const candidates = db
    .prepare(`SELECT title, deliverable, fit_reason, evidence_status, canonical_url FROM candidates WHERE status = 'proposed' ORDER BY updated_at DESC LIMIT 3`)
    .all() as Array<{ title: string; deliverable: string; fit_reason: string; evidence_status: string; canonical_url: string | null }>;
  return {
    snapshotRevision: snapshotRevision(),
    asOf: asOf.toISOString(),
    goals: goals.map((g) => ({ id: g.id, title: g.title, status: g.status })),
    practice: practice.map((p) => ({ id: p.id, occurredOn: p.occurred_on, actualMinutes: p.actual_minutes, note: p.note })),
    evidenceState: practice.length ? "has_evidence" : "no_evidence",
    candidates: candidates.map((c) => ({ title: c.title, deliverable: c.deliverable, fitReason: c.fit_reason, evidenceStatus: c.evidence_status, canonicalUrl: c.canonical_url })),
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
  return localDateInTz(nowDate(), instanceTimezone());
}
