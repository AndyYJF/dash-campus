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

/**
 * 方向页（REPAIR-PLAN §5.3）：最多 1 个主方向 + 2 个候选；每项都给来源、为什么适合、前置条件、第一步、待验证问题。
 * 建议只引用已有的实践记录——没有记录就说证据不足，不生成能力评分或保研概率。
 */
export function directionSnapshot(asOf: Date) {
  const db = getDb();
  const tz = instanceTimezone();
  const today = localDateInTz(asOf, tz);
  const goals = db
    .prepare(`SELECT id, title, status, priority, horizon FROM goals WHERE status IN ('active','paused') AND archived_at IS NULL ORDER BY priority DESC, created_at LIMIT 10`)
    .all() as Array<{ id: string; title: string; status: string; priority: number; horizon: string }>;
  const practice = db
    .prepare(`SELECT id, occurred_on, actual_minutes, note, blocker, category, project_id FROM practice_entries ORDER BY occurred_on DESC, created_at DESC LIMIT 10`)
    .all() as Array<{ id: string; occurred_on: string; actual_minutes: number | null; note: string; blocker: string; category: string; project_id: string | null }>;

  // 进行中的项目：试做的排前面；每个项目给有限的下一步和它自己的证据
  const projectRows = db
    .prepare(`SELECT id, title, question, expected_outcome, review_questions, status, engagement, trial_until, candidate_id FROM projects WHERE archived_at IS NULL AND status = 'active' ORDER BY (engagement = 'trial') DESC, created_at DESC LIMIT 3`)
    .all() as Array<{ id: string; title: string; question: string; expected_outcome: string; review_questions: string; status: string; engagement: string; trial_until: string | null; candidate_id: string | null }>;
  const since = addDays(today, -14);
  const projects = projectRows.map((p) => {
    const tasks = db.prepare(`SELECT id, title, status, estimate_minutes FROM tasks WHERE project_id = ? AND archived_at IS NULL ORDER BY created_at`).all(p.id) as Array<{ id: string; title: string; status: string; estimate_minutes: number | null }>;
    const open = tasks.filter((t) => t.status === "todo" || t.status === "doing");
    const next = db
      .prepare(`SELECT s.id, s.start_utc, s.end_utc, s.reason, t.title FROM plan_sessions s JOIN tasks t ON t.id = s.task_id WHERE t.project_id = ? AND s.status IN ('planned','tentative','in_progress') AND s.end_utc > ? ORDER BY s.start_utc LIMIT 3`)
      .all(p.id, asOf.toISOString()) as Array<{ id: string; start_utc: string; end_utc: string; reason: string; title: string }>;
    const evidence = db
      .prepare(`SELECT id, occurred_on, actual_minutes, note, blocker FROM practice_entries WHERE (project_id = ? OR task_id IN (SELECT id FROM tasks WHERE project_id = ?)) AND occurred_on >= ? AND category = 'study' ORDER BY occurred_on DESC, created_at DESC LIMIT 5`)
      .all(p.id, p.id, since) as Array<{ id: string; occurred_on: string; actual_minutes: number | null; note: string; blocker: string }>;
    const requirements = db.prepare(`SELECT r.title FROM resource_links l JOIN resources r ON r.id = l.resource_id WHERE l.entity_kind = 'project' AND l.entity_id = ? AND l.role = 'requirement' AND r.archived_at IS NULL`).all(p.id) as Array<{ title: string }>;
    const achievements = db.prepare(`SELECT r.title FROM resource_links l JOIN resources r ON r.id = l.resource_id WHERE l.entity_kind = 'project' AND l.entity_id = ? AND l.role = 'achievement' AND r.archived_at IS NULL`).all(p.id) as Array<{ title: string }>;
    const minutes = evidence.reduce((a, e) => a + (e.actual_minutes ?? 0), 0);
    const blocker = evidence.find((e) => e.blocker)?.blocker ?? "";
    const firstOpen = open[0];
    // 建议只由记录推出：有卡点先排障；没记录就承认证据不足
    const suggestion = !evidence.length
      ? `还没有这个项目的实践记录，现在判断不了适不适合。${firstOpen ? `先做第一步「${firstOpen.title}」。` : ""}`
      : blocker && evidence[0]!.blocker
        ? `最近 14 天记录了 ${evidence.length} 次、共 ${minutes} 分钟；最近一次卡在“${blocker.slice(0, 60)}”。下一步先用一小段时间处理这个卡点，再决定要不要继续。`
        : `最近 14 天记录了 ${evidence.length} 次、共 ${minutes} 分钟${firstOpen ? `；接着做「${firstOpen.title}」。` : "；现有步骤都做完了，可以说说感受，再决定继续、换一个还是转为正式投入。"}`;
    return {
      id: p.id,
      title: p.title,
      question: p.question,
      expectedOutcome: p.expected_outcome,
      openQuestions: p.review_questions ? p.review_questions.split("；").filter(Boolean).slice(0, 4) : [],
      engagement: p.engagement,
      trialUntil: p.trial_until,
      trialEnded: Boolean(p.trial_until && p.trial_until < today),
      openTasks: open.map((t) => ({ id: t.id, title: t.title, estimateMinutes: t.estimate_minutes })),
      nextSessions: next.map((n) => ({ id: n.id, title: n.title, startUtc: n.start_utc, endUtc: n.end_utc, reason: n.reason })),
      evidence: evidence.map((e) => ({ id: e.id, occurredOn: e.occurred_on, actualMinutes: e.actual_minutes, note: e.note, blocker: e.blocker })),
      requirements: requirements.map((r) => r.title),
      achievements: achievements.map((r) => r.title),
      suggestion,
    };
  });

  const candidates = db
    .prepare(`SELECT * FROM candidates WHERE status IN ('proposed','idea') AND project_id IS NULL ORDER BY updated_at DESC, id LIMIT 3`)
    .all() as Array<Record<string, unknown>>;
  const main = goals.find((g) => g.priority === 1 && g.status === "active") ?? null;
  const parse = <T,>(raw: unknown, fallback: T): T => {
    try {
      return raw ? (JSON.parse(raw as string) as T) : fallback;
    } catch {
      return fallback;
    }
  };
  return {
    snapshotRevision: snapshotRevision(),
    asOf: asOf.toISOString(),
    mainGoal: main ? { id: main.id, title: main.title } : null,
    goals: goals.map((g) => ({ id: g.id, title: g.title, status: g.status, primary: g.priority === 1 })),
    projects,
    practice: practice.map((p) => ({ id: p.id, occurredOn: p.occurred_on, actualMinutes: p.actual_minutes, note: p.note, blocker: p.blocker, category: p.category })),
    evidenceState: practice.length ? "has_evidence" : "no_evidence",
    // 已有进行中的项目时最多再展示 2 个候选；没有项目时最多 3 个
    candidates: candidates.slice(0, projects.length ? 2 : 3).map((c) => {
      const first = parse<{ title?: string; estimateMinutes?: number | null }>(c.first_task_json, {});
      const requirements = parse<Array<{ label: string; status: string; confirmedByOwner?: boolean }>>(c.requirements_json, []);
      return {
        id: c.id as string,
        version: c.version as number,
        title: c.title as string,
        question: c.question as string,
        deliverable: c.deliverable as string,
        fitReason: c.fit_reason as string,
        evidenceStatus: c.evidence_status as string,
        canonicalUrl: (c.canonical_url as string | null) ?? null,
        firstStep: first.title ? { title: first.title, estimateMinutes: first.estimateMinutes ?? null } : null,
        requirements: requirements.map((r) => ({ label: r.label, status: r.status === "met" && r.confirmedByOwner ? "met" : r.status === "unmet" ? "unmet" : "unknown" })),
        unknowns: parse<string[]>(c.unknowns_json, []),
      };
    }),
    honesty: practice.length
      ? "建议只引用上面的实践记录；没有记录的方面不编造，也不给能力评分或升学概率。"
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
