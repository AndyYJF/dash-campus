import { markPlanSynced } from "@/repositories/proposals";
import { getDb } from "@/repositories/db";
import { admitsLearning } from "@/domain/task-admission";
import { taskAdmitted } from "@/repositories/task-admission";
import { addDays, instanceTimezone, localDateInTz, mondayOf, wallTimeToUtc } from "@/domain/time";
import { baseWindows, dayBudget, futureCapacity, mergeIntervals, minutesOf, next7Days, subtractIntervals, type Interval, type Prefs } from "@/domain/budget";
import { MAX_BLOCKS_PER_TASK, placeTasks, type SchedDay, type SchedTask, type Unscheduled } from "@/domain/scheduler";
import { getPrefs, insertSession, listSessionsInRange, sessionFromRow, supersedeSession, type PlanSessionRow } from "@/repositories/plan";
import { createBatch, addChange } from "@/repositories/journal";
import { COMMAND_POLICY_VERSION } from "@/contracts/commands";
import { resolveDayPolicy, type DayPolicy } from "@/domain/day-policy";
import { activePolicyRules } from "@/repositories/calendar-facts";
import { calendarDay, type CalendarDay } from "@/workflows/calendar";

/**
 * 共享预算账本 + 差异重排（MASTER-PLAN §6.1/§6.2，REPAIR-PLAN §4.2–§4.5）。
 * 页面快照与排程都只走 dayLedger；重排保留仍然有效的旧块（ID/时段不变），只对变化的部分 supersede/新增。
 */

const DAY_MS = 86_400_000;
const GAP_MS = 10 * 60000;
const ACTIVE_STATUSES = ["tentative", "planned", "in_progress"];

export type DayEvent = {
  id: string;
  title: string;
  interval: Interval;
  /** course = 有效课程实例；fixed = 普通固定活动；pending = 学校安排待核对时的保守预留 */
  kind: "course" | "fixed" | "pending";
  isCourse: boolean;
  location?: string;
  teacher?: string;
  courseId?: string | null;
  /** 课程来自哪个原教学日期（补课/调课时与当天不同） */
  sourceDate?: string;
  origin?: "regular" | "makeup" | "moved";
};

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
  /** 当天口径的依据：日历（教学周/假日/补课）与时间政策 */
  calendar: CalendarDay;
  policy: DayPolicy;
};

/**
 * 受保护块（24h 内/锁定/已开始）出现问题时不擅自移动，只标出来给主人选择：
 * overlaps_fixed 与课程/固定活动重叠；outside_policy 落在已不安排学习的时段；over_budget 超出当日预算。
 */
export type PlanConflict = { sessionId: string; taskId: string; reason: "overlaps_fixed" | "outside_policy" | "over_budget" };
export type RebuildOptions = {
  /** 主人明确要求重新安排的日期：这些天里未锁定、未开始的块全部重排（不受 24h 保护） */
  replanDates?: string[];
  /** 这次重排由哪个变更批次引起、属于哪次对话与投递（撤销与结果展示用） */
  causedBy?: string | null;
  conversationId?: string | null;
  intakeId?: string | null;
};
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
  const calendar = calendarDay(date, tz);
  const events = eventsOf(calendar);
  const policy = resolveDayPolicy(date, prefs, activePolicyRules(), { isHoliday: calendar.civil.type === "holiday" });
  // 预算消费解析后的实际课程实例与交通；待核对的预留同样按课程加交通扣除
  const { w, cDay, eventMinutes } = dayBudget(date, prefs, tz, events.map((e) => ({ interval: e.interval, isCourse: e.kind !== "fixed" })), policy);
  const clip = (list: DayEvent[]) => minutesOf(mergeIntervals(list.map((e) => [Math.max(e.interval[0], first), Math.min(e.interval[1], last)] as Interval).filter(([s, e]) => e > s)));
  const courseMinutes = clip(events.filter((e) => e.kind === "course"));
  const fixedMinutes = clip(events.filter((e) => e.kind === "fixed"));

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
    calendar, policy,
  };
}

type PlanTask = SchedTask & {
  effortMode: "deliverable" | "time_budget";
  /** 截止只精确到日期（当天结束前都算）：解释里写成“X月X日截止”，不写成次日零点 */
  dueDateOnly: boolean;
  /** 主人报告的剩余需求及报告时刻：之后的投入从这里扣，不再用“估时 − 已花”硬推 */
  remainingMinutes: number | null;
  remainingReportedAt: string | null;
};

const STARTER_MINUTES = 25;
const BUSY_COURSE_MINUTES = 240;
const PART_WINDOWS: Record<string, [string, string]> = { morning: ["08:00", "12:00"], afternoon: ["13:00", "18:00"], evening: ["19:00", "23:00"] };

/** 重排：保留有效旧块 → 只为缺口新增 → journal，单事务原子。 */
export function rebuildPlan(asOf: Date, opts: RebuildOptions = {}): RebuildResult {
  return getDb()
    .transaction((): RebuildResult => {
      const result = rebuildInTx(asOf, opts);
      markPlanSynced();
      return result;
    })
    .immediate();
}

function rebuildInTx(asOf: Date, opts: RebuildOptions): RebuildResult {
  const db = getDb();
  const tz = instanceTimezone();
  const prefs = getPrefs();
  const asOfMs = asOf.getTime();
  const fromLocal = localDateInTz(asOf, tz);
  const horizon = next7Days(fromLocal);
  const tasks = listSchedulableTasks(tz, fromLocal);
  const taskById = new Map(tasks.map((t) => [t.id, t]));
  const spent = new Map(tasks.map((t) => [t.id, spentMinutes(t.id, t.remainingReportedAt)] as const));

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
  // 主人给过“这几天可以重新安排”的授权：范围内未锁定、未开始的块不再受 24h 保护；授权可撤回，撤回后恢复保护
  const rules = activePolicyRules();
  const granted = (date: string) => rules.some((r) => r.kind === "auto_reschedule" && (r.dateFrom ?? "") <= date && date <= (r.dateTo ?? ""));
  const replan = new Set(opts.replanDates ?? []);
  const sessionDate = (s: PlanSessionRow) => localDateInTz(new Date(s.startUtc), tz);
  const started = (s: PlanSessionRow) => s.status === "in_progress" || Date.parse(s.startUtc) <= asOfMs;
  // 主人亲自指定位置的块（origin=user）与锁定块一样不被自动挪动
  const isProtected = (s: PlanSessionRow) => started(s) || s.locked || s.origin === "user" || (Date.parse(s.startUtc) <= asOfMs + DAY_MS && !granted(sessionDate(s)) && !replan.has(sessionDate(s)));

  // Admission overrides 24h protection for unstarted automatic blocks only.
  // Owner-positioned, locked and already-started work is preserved.
  const invalidAuto = new Set(active.filter((s) => s.origin !== "user" && !s.locked && !started(s) && !taskAdmitted(s.taskId)).map((s) => s.id));
  dropped.push(...active.filter((s) => invalidAuto.has(s.id)));
  const admissibleActive = active.filter((s) => !invalidAuto.has(s.id));

  for (const s of admissibleActive.filter(isProtected)) {
    // 任务已完成/取消/归档：未开始的块不再有意义；进行中的保留，由用户结束
    if (closed.has(s.taskId) && s.status !== "in_progress") {
      dropped.push(s);
      continue;
    }
    const date = sessionDate(s);
    const start = Date.parse(s.startUtc);
    const end = Date.parse(s.endUtc);
    const ledger = base.get(date);
    const overBudget = ledger && !started(s) && keptDay.get(date)! + (end - start) / 60000 > dayCapacity(date);
    keep(s);
    if (started(s)) continue; // 已开始的块只保留已发生投入，不再评判
    if (eventsForDay(date, tz).some((e) => e.kind !== "pending" && e.interval[0] < end && e.interval[1] > start)) {
      conflicts.push({ sessionId: s.id, taskId: s.taskId, reason: "overlaps_fixed" });
    } else if (ledger && subtractIntervals([[start, end]], baseWindows(date, prefs, tz, ledger.policy)).length > 0) {
      conflicts.push({ sessionId: s.id, taskId: s.taskId, reason: "outside_policy" });
    } else if (overBudget) {
      conflicts.push({ sessionId: s.id, taskId: s.taskId, reason: "over_budget" });
    }
  }
  for (const s of admissibleActive.filter((x) => !isProtected(x))) {
    const task = taskById.get(s.taskId);
    if (!task || replan.has(sessionDate(s)) || !stillValid(s, task)) dropped.push(s);
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
  const part = rules.find((r) => r.kind === "preferred_window")?.value.part as string | undefined;
  const days: SchedDay[] = horizon.map((date) => {
    const ledger = base.get(date)!;
    let free = subtractIntervals(ledger.w, keptPadded);
    // 今天的新块从下一个整 5 分钟开始，不排出 14:52 这种零碎钟点
    if (date === fromLocal) free = free.map(([s, e]) => [Math.max(s, Math.ceil(asOfMs / 300_000) * 300_000), e] as Interval).filter(([s, e]) => e > s);
    const weekend = ledger.calendar.weekday >= 6;
    const preferred: Interval[] =
      part && PART_WINDOWS[part]
        ? [[wallTimeToUtc(date, PART_WINDOWS[part]![0], tz).getTime(), wallTimeToUtc(date, PART_WINDOWS[part]![1], tz).getTime()]]
        : part === "weekend" && weekend
          ? [dayRange(date, tz)]
          : [];
    return { date, free, cDay: Math.max(0, Math.floor(dayCapacity(date) - keptDay.get(date)!)), busy: ledger.courseMinutes >= BUSY_COURSE_MINUTES, preferred };
  });
  const needs: SchedTask[] = [];
  const unscheduled: Unscheduled[] = [];
  const starters = new Set<string>();
  for (const t of tasks) {
    const k = keptTask.get(t.id) ?? { minutes: 0, blocks: 0 };
    const demand = remainingDemand(t, spent);
    if (demand === null) {
      if (k.blocks > 0) continue;
      // 工作量未知：只安排一次有产出的起步块；做过之后要结合反馈才知道下一步，不无限续排
      if (hadStarter(t.id) || (spent.get(t.id) ?? 0) > 0) needs.push({ ...t, estimateMinutes: null });
      else {
        starters.add(t.id);
        needs.push({ ...t, estimateMinutes: STARTER_MINUTES, maxNewBlocks: 1 });
      }
      continue;
    }
    if (demand === 0) {
      // deliverable 投入已达估时仍未完成：不无依据再排满原估时，等用户报告剩余
      if (t.effortMode === "deliverable" || openBlocker(t.id)) unscheduled.push({ taskId: t.id, title: t.title, reason: "needs_remaining_estimate" });
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
    intakeId: opts.intakeId ?? null,
    itemId: null,
    policyVersion: COMMAND_POLICY_VERSION,
    instanceEpoch: 0,
    causedBy: opts.causedBy ?? null,
    conversationId: opts.conversationId ?? null,
  });
  for (const s of dropped) {
    supersedeSession(s.id);
    addChange(batchId, { entityKind: "plan_session", entityId: s.id, action: "update", before: { status: s.status }, after: { status: "superseded" }, beforeVersion: s.version, afterVersion: s.version + 1 });
  }
  for (const p of placed.placements) {
    const starter = starters.has(p.taskId);
    const id = insertSession({
      taskId: p.taskId,
      startUtc: new Date(p.start).toISOString(),
      endUtc: new Date(p.end).toISOString(),
      timezone: tz,
      batchId,
      kind: starter ? "starter" : "work",
      reason: placementReason(taskById.get(p.taskId)!, p, starter, tz, base),
    });
    addChange(batchId, { entityKind: "plan_session", entityId: id, action: "create", after: { taskId: p.taskId, start: p.start, end: p.end }, afterVersion: 1 });
  }
  return { ...result, batchId };
}

function localLabel(ms: number, tz: string): string {
  const d = localDateInTz(new Date(ms), tz);
  const t = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(ms));
  return `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))} ${t}`;
}

/** 安排依据：只写具体事实（截止、连续空档、预算、之前的日子为什么没排），不写空话 */
function placementReason(task: PlanTask, p: { start: number; end: number; skipped: Array<{ date: string; why: string }> }, starter: boolean, tz: string, base: Map<string, DayLedger>): string {
  const parts: string[] = [];
  const minutes = Math.round((p.end - p.start) / 60000);
  const blocker = openBlocker(task.id);
  if (blocker) parts.push(`上次卡在“${blocker.slice(0, 40)}”，先安排 ${minutes} 分钟处理这个卡点`);
  else if (starter) parts.push(`这件事的工作量还不清楚，先安排 ${minutes} 分钟梳理出下一步`);
  if (task.dueAtMs != null) parts.push(task.dueDateOnly && task.dueLocalDate ? `${Number(task.dueLocalDate.slice(5, 7))}/${Number(task.dueLocalDate.slice(8, 10))} 当天截止` : `${localLabel(task.dueAtMs, tz)} 截止`);
  const date = localDateInTz(new Date(p.start), tz);
  const ledger = base.get(date);
  if (ledger) {
    const window = ledger.w.find(([s, e]) => s <= p.start && e >= p.end);
    if (window) parts.push(`这段时间有 ${Math.round((window[1] - Math.max(window[0], p.start)) / 60000)} 分钟连续空档`);
  }
  const why: Record<string, string> = { budget: "当天学习预算不够一整段", no_slot: "没有够长的连续空档", busy_day: "课比较满" };
  const skipped = p.skipped.slice(-2).map((s) => `${Number(s.date.slice(5, 7))}/${Number(s.date.slice(8, 10))} ${why[s.why] ?? ""}`);
  if (skipped.length) parts.push(`没排在更早：${skipped.join("、")}`);
  return parts.join("；");
}

/** 这个任务是否已经排过起步块（被替换的不算） */
function hadStarter(taskId: string): boolean {
  return Boolean(getDb().prepare(`SELECT 1 FROM plan_sessions WHERE task_id = ? AND kind = 'starter' AND status != 'superseded'`).get(taskId));
}

/**
 * 已确认投入：任务关联的学习记录 + 没有对应实际记录的已完成块（同一任务同一天只取其一）。
 * since 给出时只算那之后的投入（主人报告过剩余需求）。
 */
function spentMinutes(taskId: string, since: string | null): number {
  const db = getDb();
  const tz = instanceTimezone();
  let total = 0;
  const daysWithActual = new Set<string>();
  const practice = db.prepare(`SELECT occurred_on, actual_minutes, created_at FROM practice_entries WHERE task_id = ? AND actual_minutes IS NOT NULL AND category = 'study'`).all(taskId) as Array<{ occurred_on: string; actual_minutes: number; created_at: string }>;
  for (const p of practice) {
    daysWithActual.add(p.occurred_on);
    if (!since || p.created_at >= since) total += p.actual_minutes;
  }
  const done = db.prepare(`SELECT start_utc, end_utc, updated_at FROM plan_sessions WHERE task_id = ? AND status = 'completed'`).all(taskId) as Array<{ start_utc: string; end_utc: string; updated_at: string }>;
  for (const s of done) {
    if (daysWithActual.has(localDateInTz(new Date(s.start_utc), tz))) continue;
    if (since && s.updated_at < since) continue;
    total += (Date.parse(s.end_utc) - Date.parse(s.start_utc)) / 60000;
  }
  return total;
}

/** 任务最近一次实践留下、还没被后续记录消除的卡点 */
export function openBlocker(taskId: string): string {
  return blockerState(taskId).text;
}

/** 卡点及其排障块是否已经做过一次（做过却没有新反馈：不再自动续排，等主人说结果） */
function blockerState(taskId: string): { text: string; handled: boolean } {
  const db = getDb();
  const r = db.prepare(`SELECT blocker, created_at FROM practice_entries WHERE task_id = ? ORDER BY occurred_on DESC, created_at DESC LIMIT 1`).get(taskId) as { blocker: string; created_at: string } | undefined;
  if (!r?.blocker) return { text: "", handled: false };
  const handled = Boolean(db.prepare(`SELECT 1 FROM plan_sessions WHERE task_id = ? AND status IN ('completed','skipped') AND updated_at > ?`).get(taskId, r.created_at));
  return { text: r.blocker, handled };
}

/**
 * 剩余需求：主人报告过剩余就从那里扣；否则估时 − 已确认投入；未知估时为 null。
 * 有未解决的卡点时只排一个最小的排障步骤——卡着的时候花了多久推不出进度，也不该照旧排满。
 */
function remainingDemand(task: PlanTask, spent: Map<string, number>): number | null {
  const blocker = blockerState(task.id);
  if (blocker.text) return blocker.handled ? 0 : STARTER_MINUTES;
  const used = Math.round(spent.get(task.id) ?? 0);
  if (task.remainingMinutes !== null) return Math.max(0, task.remainingMinutes - used);
  if (task.estimateMinutes === null) return null;
  return Math.max(0, task.estimateMinutes - used);
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

/** 当日占用：有效课程实例（含补课/调课）、普通固定活动、待核对预留。全部来自统一日历解释器 */
export function eventsForDay(date: string, tz: string): DayEvent[] {
  return eventsOf(calendarDay(date, tz));
}

function eventsOf(day: CalendarDay): DayEvent[] {
  const out: DayEvent[] = [];
  for (const c of day.courses) {
    out.push({ id: c.occurrenceId, title: c.title, interval: c.interval, kind: "course", isCourse: true, location: c.location, teacher: c.teacher, courseId: c.courseId, sourceDate: c.sourceDate, origin: c.origin });
  }
  for (const f of day.fixed) out.push({ id: f.id, title: f.title, interval: f.interval, kind: "fixed", isCourse: false });
  day.pending.forEach((interval, i) => out.push({ id: `pending:${day.date}:${i}`, title: "可能补课（学校安排待核对）", interval, kind: "pending", isCourse: false }));
  return out;
}

function listSchedulableTasks(tz: string, today: string): PlanTask[] {
  // 暂停中的任务不排；到期自动恢复（一次暂停不是撤销）
  const rows = getDb()
    .prepare(
      `SELECT id, title, task_kind, estimate_minutes, due_kind, due_local_date, due_timezone, due_at, priority, created_at, effort_mode, remaining_minutes, remaining_reported_at
       FROM tasks WHERE status IN ('todo','doing') AND archived_at IS NULL AND (paused_until IS NULL OR paused_until <= ?) ORDER BY created_at, id`,
    )
    .all(today) as Array<Record<string, unknown>>;
  return rows.filter((r) => admitsLearning({ title: r.title as string, taskKind: r.task_kind as string })).map((r) => {
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
      dueDateOnly: !instant && Boolean(dueDate),
      remainingMinutes: (r.remaining_minutes as number | null) ?? null,
      remainingReportedAt: (r.remaining_reported_at as string | null) ?? null,
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
  return (latestPlanReason().unscheduled ?? []).filter((u) => taskAdmitted(u.taskId));
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
