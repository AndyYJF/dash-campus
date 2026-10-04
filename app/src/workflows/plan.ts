import { getDb } from "@/repositories/db";
import { occurrences } from "@/domain/calendar-occurrences";
import { addDays, instanceTimezone, localDateInTz, mondayOf, wallTimeToUtc } from "@/domain/time";
import { dayBudget, futureCapacity, mergeIntervals, minutesOf, next7Days, subtractIntervals, type Interval, type Prefs } from "@/domain/budget";
import { MAX_BLOCKS_PER_TASK, placeTasks, type SchedDay, type SchedTask, type Unscheduled } from "@/domain/scheduler";
import { getPrefs, insertSession, listSessionsInRange, sessionFromRow, supersedeSession, type PlanSessionRow } from "@/repositories/plan";
import { createBatch, addChange } from "@/repositories/journal";
import { COMMAND_POLICY_VERSION } from "@/contracts/commands";

/**
 * 共享预算账本 + 差异重排（MASTER-PLAN §6.1/§6.2，REPAIR-PLAN §4.2–§4.5）。
 * 页面快照与排程都只走 dayLedger；重排保留仍然有效的旧块（ID/时段不变），只对变化的部分 supersede/新增。
 */

const DAY_MS = 86_400_000;
const GAP_MS = 10 * 60000;
const ACTIVE_STATUSES = ["tentative", "planned", "in_progress"];

export type DayEvent = { id: string; title: string; interval: Interval; isCourse: boolean };

export type DayLedger = {
  date: string;
  w: Interval[];
  cDay: number;
  courseMinutes: number;
  eventMinutes: number;
  /** 没有课程语义来源的固定活动占用（旧课表等，仍扣空档，待核对） */
  fixedMinutes: number;
  /** 已记录的实际学习（practice，category=study） */
  actualMinutes: number;
  /** 已完成块没有对应实际记录时暂扣的计划分钟 */
  estimatedMinutes: number;
  /** 进行中/已过时未反馈块的已流逝部分：暂占预算，不是实际记录 */
  provisionalMinutes: number;
  /** 非学习活动记录（运动等），不消耗学习预算 */
  otherActivityMinutes: number;
  bDay: number;
  wFutureMinutes: number;
  pFuture: number;
  futureBudget: number;
  futureCapacity: number;
};

export type PlanConflict = { sessionId: string; taskId: string; reason: "overlaps_fixed" };
export type RebuildResult = {
  kind: "planned";
  /** 没有任何块变化且未排原因不变时为 null：相同事实重算不产生新批次 */
  batchId: string | null;
  changed: boolean;
  placed: number;
  kept: number;
  superseded: number;
  unscheduled: Unscheduled[];
  conflicts: PlanConflict[];
};

function dayRange(date: string, tz: string): Interval {
  return [wallTimeToUtc(date, "00:00", tz).getTime(), wallTimeToUtc(addDays(date, 1), "00:00", tz).getTime()];
}

function clipMinutes(s: number, e: number, lo: number, hi: number): number {
  return Math.max(0, Math.min(e, hi) - Math.max(s, lo)) / 60000;
}

/**
 * 当日账本。sessions 缺省读库；重排时传入“决定保留的块”以得到同口径的剩余容量。
 * 同一任务当天已有实际记录时，该任务的完成块/已流逝部分不再另扣（同活动只扣一次，按任务关联而非分钟相近）。
 */
export function dayLedger(date: string, asOf: Date, prefs: Prefs, tz: string, sessions?: PlanSessionRow[]): DayLedger {
  const [first, last] = dayRange(date, tz);
  const asOfMs = asOf.getTime();
  const events = eventsForDay(date, tz);
  const { w, cDay, courseMinutes, eventMinutes } = dayBudget(date, prefs, tz, events);
  const fixedMinutes = minutesOf(mergeIntervals(events.filter((e) => !e.isCourse).map((e) => [Math.max(e.interval[0], first), Math.min(e.interval[1], last)] as Interval).filter(([s, e]) => e > s)));

  const practice = getDb().prepare(`SELECT task_id, actual_minutes, category FROM practice_entries WHERE occurred_on = ?`).all(date) as Array<{ task_id: string | null; actual_minutes: number | null; category: string }>;
  let actual = 0;
  let other = 0;
  const tasksWithActual = new Set<string>();
  for (const p of practice) {
    if (p.actual_minutes === null) continue;
    if (p.category !== "study") {
      other += p.actual_minutes;
      continue;
    }
    actual += p.actual_minutes;
    if (p.task_id) tasksWithActual.add(p.task_id);
  }

  const rows = (sessions ?? listSessionsInRange(new Date(first).toISOString(), new Date(last).toISOString())).filter((s) => Date.parse(s.endUtc) > first && Date.parse(s.startUtc) < last);
  let estimated = 0;
  let provisional = 0;
  let pFuture = 0;
  for (const s of rows) {
    const start = Date.parse(s.startUtc);
    const end = Date.parse(s.endUtc);
    if (s.status === "completed") {
      if (!tasksWithActual.has(s.taskId)) estimated += clipMinutes(start, end, first, last);
    } else if (ACTIVE_STATUSES.includes(s.status)) {
      if (!tasksWithActual.has(s.taskId)) provisional += clipMinutes(start, end, first, Math.min(last, asOfMs));
      pFuture += clipMinutes(start, end, Math.max(first, asOfMs), last);
    }
  }
  const bDay = Math.round(actual + estimated + provisional);
  const wFuture = w.map(([s, e]) => [Math.max(s, asOfMs), e] as Interval).filter(([s, e]) => e > s);
  const future = futureCapacity({ cDay, bDay, wFutureMinutes: minutesOf(wFuture), pFutureMinutes: Math.round(pFuture), bufferPercent: prefs.bufferPercent });
  return {
    date, w, cDay, courseMinutes, eventMinutes, fixedMinutes,
    actualMinutes: actual, estimatedMinutes: Math.round(estimated), provisionalMinutes: Math.round(provisional), otherActivityMinutes: other,
    bDay, wFutureMinutes: minutesOf(wFuture), pFuture: Math.round(pFuture),
    futureBudget: future.futureBudget, futureCapacity: future.futureCapacity,
  };
}

type PlanTask = SchedTask & { effortMode: "deliverable" | "time_budget" };

/** 重排：保留有效旧块 → 只为缺口新增 → journal，单事务原子。 */
export function rebuildPlan(asOf: Date): RebuildResult {
  return getDb().transaction((): RebuildResult => rebuildInTx(asOf)).immediate();
}

function rebuildInTx(asOf: Date): RebuildResult {
  const db = getDb();
  const tz = instanceTimezone();
  const prefs = getPrefs();
  const asOfMs = asOf.getTime();
  const fromLocal = localDateInTz(asOf, tz);
  const horizon = next7Days(fromLocal);
  const tasks = listSchedulableTasks(tz);
  const taskById = new Map(tasks.map((t) => [t.id, t]));
  const spent = spentMinutesByTask();

  const active = (db
    .prepare(`SELECT * FROM plan_sessions WHERE status IN ('tentative','planned','in_progress') AND end_utc > ? ORDER BY start_utc, id`)
    .all(asOf.toISOString()) as Array<Record<string, unknown>>).map(sessionFromRow);

  // 1) 决定保留哪些旧块。受保护（已开始/锁定/24h 内）一律保留；其余只在仍然有效时保留。
  const base = new Map(horizon.map((date) => [date, dayLedger(date, asOf, prefs, tz, [])] as const));
  const pastUsed = new Map(horizon.map((date) => [date, dayLedger(date, asOf, prefs, tz).bDay] as const));
  const dayCapacity = (date: string): number => {
    const b = base.get(date)!;
    return futureCapacity({ cDay: b.cDay, bDay: pastUsed.get(date)!, wFutureMinutes: b.wFutureMinutes, pFutureMinutes: 0, bufferPercent: prefs.bufferPercent }).futureBudget;
  };
  const keptDay = new Map<string, number>(horizon.map((d) => [d, 0]));
  const keptTask = new Map<string, { minutes: number; blocks: number }>();
  const kept: PlanSessionRow[] = [];
  const dropped: PlanSessionRow[] = [];
  const conflicts: PlanConflict[] = [];
  const closed = closedTaskIds(active.map((s) => s.taskId));

  const keep = (s: PlanSessionRow) => {
    const start = Date.parse(s.startUtc);
    const end = Date.parse(s.endUtc);
    kept.push(s);
    for (const date of horizon) {
      const [first, last] = dayRange(date, tz);
      keptDay.set(date, keptDay.get(date)! + clipMinutes(start, end, Math.max(first, asOfMs), last));
    }
    const k = keptTask.get(s.taskId) ?? { minutes: 0, blocks: 0 };
    // 已开始的块整块算作该任务的在途承诺（已流逝部分是暂占，不另外补排）
    keptTask.set(s.taskId, { minutes: k.minutes + (end - start) / 60000, blocks: k.blocks + 1 });
  };
  const isProtected = (s: PlanSessionRow) => s.status === "in_progress" || s.locked || Date.parse(s.startUtc) <= asOfMs + DAY_MS;

  for (const s of active.filter(isProtected)) {
    // 任务已完成/取消/归档：未开始的块不再有意义；进行中的保留，由用户结束
    if (closed.has(s.taskId) && s.status !== "in_progress") {
      dropped.push(s);
      continue;
    }
    keep(s);
    const date = localDateInTz(new Date(s.startUtc), tz);
    if (eventsForDay(date, tz).some((e) => e.interval[0] < Date.parse(s.endUtc) && e.interval[1] > Date.parse(s.startUtc))) {
      conflicts.push({ sessionId: s.id, taskId: s.taskId, reason: "overlaps_fixed" });
    }
  }
  for (const s of active.filter((x) => !isProtected(x))) {
    const task = taskById.get(s.taskId);
    if (!task || !stillValid(s, task)) dropped.push(s);
    else keep(s);
  }

  function stillValid(s: PlanSessionRow, task: PlanTask): boolean {
    const start = Date.parse(s.startUtc);
    const end = Date.parse(s.endUtc);
    const minutes = (end - start) / 60000;
    if (task.dueAtMs != null && end > task.dueAtMs) return false;
    const demand = remainingDemand(task, spent);
    if (demand !== null && (keptTask.get(task.id)?.minutes ?? 0) + minutes > demand) return false;
    if (kept.some((k) => Date.parse(k.startUtc) < end && Date.parse(k.endUtc) > start)) return false;
    const date = localDateInTz(new Date(start), tz);
    const ledger = base.get(date);
    if (!ledger) return true; // 超出本轮规划范围：不评估当日约束
    if (subtractIntervals([[start, end]], ledger.w).length > 0) return false; // 不再落在可安排窗口内（新课程/作息变化）
    return keptDay.get(date)! + minutes <= dayCapacity(date);
  }

  // 2) 为缺口新增：空闲区间扣掉保留块（含块间休息），当日容量扣掉保留的未来分钟
  const keptPadded = kept.map((s) => [Date.parse(s.startUtc) - GAP_MS, Date.parse(s.endUtc) + GAP_MS] as Interval);
  const days: SchedDay[] = horizon.map((date) => {
    let free = subtractIntervals(base.get(date)!.w, keptPadded);
    if (date === fromLocal) free = free.map(([s, e]) => [Math.max(s, asOfMs), e] as Interval).filter(([s, e]) => e > s);
    return { date, free, cDay: Math.max(0, Math.floor(dayCapacity(date) - keptDay.get(date)!)) };
  });
  const needs: SchedTask[] = [];
  const unscheduled: Unscheduled[] = [];
  for (const t of tasks) {
    const k = keptTask.get(t.id) ?? { minutes: 0, blocks: 0 };
    const demand = remainingDemand(t, spent);
    if (demand === null) {
      if (k.blocks === 0) needs.push({ ...t, estimateMinutes: null });
      continue;
    }
    if (demand === 0) {
      // deliverable 投入已达估时仍未完成：不无依据再排满原估时，等用户报告剩余
      if (t.effortMode === "deliverable") unscheduled.push({ taskId: t.id, title: t.title, reason: "needs_remaining_estimate" });
      continue;
    }
    const need = Math.round(demand - k.minutes);
    if (need > 0) needs.push({ ...t, estimateMinutes: need, maxNewBlocks: Math.max(0, MAX_BLOCKS_PER_TASK - k.blocks) });
  }
  const placed = placeTasks(needs, days, { minBlock: prefs.minBlockMinutes, maxBlock: 90 });
  unscheduled.push(...placed.unscheduled);

  // 3) 落库。没有块变化且结论与上次相同则不写新批次。
  const summary = JSON.stringify({ unscheduled, conflicts });
  const changed = dropped.length > 0 || placed.placements.length > 0;
  const result = { kind: "planned" as const, changed, placed: placed.placements.length, kept: kept.length, superseded: dropped.length, unscheduled, conflicts };
  if (!changed && summary === latestPlanSummary()) return { ...result, batchId: null };

  const batchId = createBatch({
    command: "plan_sessions",
    reason: JSON.stringify({ placed: placed.placements.length, kept: kept.length, unscheduled, conflicts }),
    intakeId: null,
    itemId: null,
    policyVersion: COMMAND_POLICY_VERSION,
    instanceEpoch: 0,
  });
  for (const s of dropped) {
    supersedeSession(s.id);
    addChange(batchId, { entityKind: "plan_session", entityId: s.id, action: "update", before: { status: s.status }, after: { status: "superseded" }, beforeVersion: s.version, afterVersion: s.version + 1 });
  }
  for (const p of placed.placements) {
    const id = insertSession({ taskId: p.taskId, startUtc: new Date(p.start).toISOString(), endUtc: new Date(p.end).toISOString(), timezone: tz, batchId });
    addChange(batchId, { entityKind: "plan_session", entityId: id, action: "create", after: { taskId: p.taskId, start: p.start, end: p.end }, afterVersion: 1 });
  }
  return { ...result, batchId };
}

/** 已确认投入：任务关联的学习记录 + 没有对应实际记录的已完成块（同一任务同一天只取其一） */
function spentMinutesByTask(): Map<string, number> {
  const db = getDb();
  const tz = instanceTimezone();
  const spent = new Map<string, number>();
  const daysWithActual = new Set<string>();
  const practice = db.prepare(`SELECT task_id, occurred_on, actual_minutes FROM practice_entries WHERE task_id IS NOT NULL AND actual_minutes IS NOT NULL AND category = 'study'`).all() as Array<{ task_id: string; occurred_on: string; actual_minutes: number }>;
  for (const p of practice) {
    spent.set(p.task_id, (spent.get(p.task_id) ?? 0) + p.actual_minutes);
    daysWithActual.add(`${p.task_id}|${p.occurred_on}`);
  }
  const done = db.prepare(`SELECT task_id, start_utc, end_utc FROM plan_sessions WHERE status = 'completed'`).all() as Array<{ task_id: string; start_utc: string; end_utc: string }>;
  for (const s of done) {
    if (daysWithActual.has(`${s.task_id}|${localDateInTz(new Date(s.start_utc), tz)}`)) continue;
    spent.set(s.task_id, (spent.get(s.task_id) ?? 0) + (Date.parse(s.end_utc) - Date.parse(s.start_utc)) / 60000);
  }
  return spent;
}

/** 剩余需求：估时 − 已确认投入；未知估时为 null */
function remainingDemand(task: PlanTask, spent: Map<string, number>): number | null {
  if (task.estimateMinutes === null) return null;
  return Math.max(0, task.estimateMinutes - Math.round(spent.get(task.id) ?? 0));
}

function closedTaskIds(ids: string[]): Set<string> {
  const out = new Set<string>();
  const stmt = getDb().prepare(`SELECT status, archived_at FROM tasks WHERE id = ?`);
  for (const id of new Set(ids)) {
    const r = stmt.get(id) as { status: string; archived_at: string | null } | undefined;
    if (!r || r.archived_at || r.status === "done" || r.status === "cancelled") out.add(id);
  }
  return out;
}

function latestPlanSummary(): string {
  const prev = latestPlanReason();
  return JSON.stringify({ unscheduled: prev.unscheduled ?? [], conflicts: prev.conflicts ?? [] });
}

/** 当日固定活动区间（fixed_events 展开）；isCourse = 由课程投影产生（用于通勤扣除与课程占用显示） */
export function eventsForDay(date: string, tz: string): DayEvent[] {
  const db = getDb();
  const [first, last] = dayRange(date, tz);
  const courseIds = new Set(
    (db.prepare(`SELECT DISTINCT fixed_event_id FROM course_meeting_projections`).all() as Array<{ fixed_event_id: string }>).map((r) => r.fixed_event_id),
  );
  // A03：当日有停课例外的课程不占时
  const exceptedCourses = new Set(
    (db.prepare(`SELECT course_name FROM course_event_exceptions WHERE event_date = ?`).all(date) as Array<{ course_name: string }>).map((r) => r.course_name),
  );
  const rows = db.prepare(`SELECT * FROM fixed_events ORDER BY id`).all() as Array<Record<string, unknown>>;
  const out: DayEvent[] = [];
  for (const r of rows) {
    const title = r.title as string;
    if (exceptedCourses.size && [...exceptedCourses].some((name) => title.startsWith(name))) continue;
    const rule = {
      id: r.id as string,
      title, weekday: r.weekday as number,
      localStart: r.local_start as string, localEnd: r.local_end as string, timezone: r.timezone as string,
      eventDate: (r.event_date as string) ?? null, validFrom: (r.valid_from as string) ?? null, validUntil: (r.valid_until as string) ?? null,
    };
    for (const [s, e] of occurrences(rule, first, last)) out.push({ id: r.id as string, title, interval: [s, e], isCourse: courseIds.has(r.id as string) });
  }
  return out;
}

function listSchedulableTasks(tz: string): PlanTask[] {
  const rows = getDb()
    .prepare(`SELECT id, title, estimate_minutes, due_kind, due_local_date, due_timezone, due_at, priority, created_at, effort_mode FROM tasks WHERE status IN ('todo','doing') AND archived_at IS NULL ORDER BY created_at, id`)
    .all() as Array<Record<string, unknown>>;
  return rows.map((r) => {
    const dueAt = (r.due_at as string) ?? null;
    const dueDate = (r.due_local_date as string) ?? null;
    const dueTz = (r.due_timezone as string) ?? tz;
    const instant = r.due_kind === "instant" && dueAt;
    return {
      id: r.id as string,
      title: r.title as string,
      estimateMinutes: (r.estimate_minutes as number) ?? null,
      dueLocalDate: instant ? localDateInTz(new Date(dueAt), tz) : dueDate,
      dueAtMs: instant ? Date.parse(dueAt) : dueDate ? wallTimeToUtc(addDays(dueDate, 1), "00:00", dueTz).getTime() : null,
      priority: r.priority as SchedTask["priority"],
      createdAt: r.created_at as string,
      effortMode: r.effort_mode as PlanTask["effortMode"],
    };
  });
}

/** 最近一次重排的未排原因与受保护块冲突（week 端点展示用） */
function latestPlanReason(): { unscheduled?: Unscheduled[]; conflicts?: PlanConflict[] } {
  const r = getDb().prepare(`SELECT reason FROM agent_action_batches WHERE command = 'plan_sessions' ORDER BY created_at DESC, rowid DESC LIMIT 1`).get() as { reason: string } | undefined;
  if (!r) return {};
  try {
    return JSON.parse(r.reason) as { unscheduled?: Unscheduled[]; conflicts?: PlanConflict[] };
  } catch {
    return {};
  }
}

export function latestPlanUnscheduled(): Unscheduled[] {
  return latestPlanReason().unscheduled ?? [];
}

export function latestPlanConflicts(): PlanConflict[] {
  return latestPlanReason().conflicts ?? [];
}

export function mondayOfDate(dateLocal: string): string {
  return mondayOf(dateLocal);
}

export function dayMinutes(ws: Interval[]): number {
  return minutesOf(ws);
}
