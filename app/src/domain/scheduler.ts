import type { Interval } from "./budget";

/**
 * 确定性排程（MASTER-PLAN §6.2，REPAIR-PLAN §4.3–4.5）：纯函数，不做分钟算术以外的判断。
 * 顺序：截止时刻 → 高优先级 → 创建时间 → ID；块 25–90 分钟、间隔 10 分钟、每项最多 3 个未来块；
 * 只放进调用方给出的空闲区间和当日剩余预算，块结束不晚于截止；放不下给原因和缺口，不改截止。
 * 已保留的旧块由调用方先行扣除：这里的 estimateMinutes 是“还需新排的分钟”。
 */

export type SchedTask = {
  id: string;
  title: string;
  estimateMinutes: number | null;
  dueLocalDate: string | null;
  /** 截止时刻（epoch ms）；只有日期的截止由调用方折算为当地次日零点 */
  dueAtMs?: number | null;
  priority: "normal" | "high";
  createdAt: string;
  /** 本轮还能新增的块数（已保留的未来块占用名额）；缺省为每项上限 */
  maxNewBlocks?: number;
};

export type SchedDay = {
  date: string; // YYYY-MM-DD（本地）
  free: Interval[]; // W 区间（已扣课程/生活/已保留块，当天已裁到 asOf 之后）
  cDay: number; // 当日还可新增的学习分钟（共享账本的 futureCapacity）
  /** 课程密集日：没有截止的任务先放到更宽裕的日子 */
  busy?: boolean;
  /** 已确认的集中时段偏好落在当天的区间；同等条件下优先，不会因此错过截止 */
  preferred?: Interval[];
};

/** 之前的日子为什么没排：预算不够一整段，或没有够长的连续空档 */
export type SkipNote = { date: string; why: "budget" | "no_slot" | "busy_day" };
export type Placement = { taskId: string; start: number; end: number; skipped: SkipNote[] };
/** awaiting_feedback：之前的块已过去、没有反馈，这部分需求先挂着等主人说做没做 */
export type UnscheduledReason = "unknown_requirement" | "deadline_unfeasible" | "insufficient_capacity" | "no_contiguous_slot" | "needs_remaining_estimate" | "awaiting_feedback";
export type Unscheduled = { taskId: string; title: string; reason: UnscheduledReason; missingMinutes?: number };

const GAP_MS = 10 * 60000;
export const MAX_BLOCKS_PER_TASK = 3;

type DayState = { date: string; cDay: number; intervals: Interval[]; usedMinutes: number; busy: boolean; preferred: Interval[] };
type Opts = { minBlock: number; maxBlock: number };
type Progress = { remaining: number; blocks: number; maxBlocks: number; skipped: SkipNote[] };

export function placeTasks(tasks: SchedTask[], days: SchedDay[], opts: Opts): { placements: Placement[]; unscheduled: Unscheduled[] } {
  const ordered = [...tasks].sort(compareTasks);
  const state: DayState[] = days.map((d) => ({ date: d.date, cDay: d.cDay, intervals: d.free.map((w) => [...w] as Interval), usedMinutes: 0, busy: Boolean(d.busy), preferred: d.preferred ?? [] }));
  const placements: Placement[] = [];
  const unscheduled: Unscheduled[] = [];
  for (const t of ordered) {
    if (t.estimateMinutes === null) {
      unscheduled.push({ taskId: t.id, title: t.title, reason: "unknown_requirement" });
      continue;
    }
    const due = dueMs(t);
    const progress: Progress = { remaining: t.estimateMinutes, blocks: 0, maxBlocks: t.maxNewBlocks ?? MAX_BLOCKS_PER_TASK, skipped: [] };
    // 有截止：最早可行优先，窗口不够整块时用截止前最大的可用片段；
    // 无截止：先在不那么满的日子找整块连续空档，再放宽到课程密集日，全程找不到再退而用片段。
    if (due === null) {
      placeOne(t, state, placements, opts, progress, { fragments: false, skipBusy: true });
      placeOne(t, state, placements, opts, progress, { fragments: false, skipBusy: false });
    }
    placeOne(t, state, placements, opts, progress, { fragments: true, skipBusy: false });
    if (progress.remaining > 0) {
      unscheduled.push({ taskId: t.id, title: t.title, reason: reasonFor(due, progress.remaining, state), missingMinutes: progress.remaining });
    }
  }
  return { placements, unscheduled };
}

function dueMs(t: SchedTask): number | null {
  return t.dueAtMs ?? null;
}

function reasonFor(due: number | null, remaining: number, days: DayState[]): UnscheduledReason {
  if (due !== null) return "deadline_unfeasible";
  const budgetLeft = days.reduce((a, d) => a + Math.max(0, d.cDay - d.usedMinutes), 0);
  return budgetLeft >= remaining ? "no_contiguous_slot" : "insufficient_capacity";
}

function compareTasks(a: SchedTask, b: SchedTask): number {
  const da = dueMs(a);
  const db = dueMs(b);
  if (da !== null && db !== null && da !== db) return da - db;
  if (da !== null && db === null) return -1;
  if (da === null && db !== null) return 1;
  if (a.priority !== b.priority) return a.priority === "high" ? -1 : 1;
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function note(progress: Progress, date: string, why: SkipNote["why"]): void {
  if (!progress.skipped.some((s) => s.date === date)) progress.skipped.push({ date, why });
}

function placeOne(t: SchedTask, days: DayState[], placements: Placement[], opts: Opts, progress: Progress, mode: { fragments: boolean; skipBusy: boolean }): void {
  const due = dueMs(t) ?? Number.POSITIVE_INFINITY;
  for (const day of days) {
    if (progress.blocks >= progress.maxBlocks || progress.remaining <= 0) break;
    if (t.dueLocalDate && day.date > t.dueLocalDate) break;
    if (mode.skipBusy && day.busy) {
      note(progress, day.date, "busy_day");
      continue;
    }
    while (progress.blocks < progress.maxBlocks && progress.remaining > 0) {
      const remaining = progress.remaining;
      const want = remaining >= opts.minBlock ? Math.min(remaining, opts.maxBlock) : remaining; // 剩余不足最小块：作为有依据的收尾块
      let len = Math.min(want, day.cDay - day.usedMinutes);
      // 被预算截短的块取整到 5 分钟，不排出 29 分钟这种零碎长度（恰好是收尾的除外）
      if (len < want) len = neat(len, opts.minBlock);
      if (len <= 0 || (len < opts.minBlock && remaining > len)) {
        // 当天预算放不下有效块就换天；除非这就是收尾块
        if (day.intervals.length) note(progress, day.date, "budget");
        break;
      }
      let spot = findSpot(day, len, due);
      if (spot === null && mode.fragments) {
        const largest = Math.min(len, largestSpot(day.intervals, due));
        if (neat(largest, opts.minBlock) >= opts.minBlock) {
          len = neat(largest, opts.minBlock);
          spot = findSpot(day, len, due);
        }
      }
      if (spot === null) {
        note(progress, day.date, "no_slot");
        break;
      }
      placements.push({ taskId: t.id, start: spot, end: spot + len * 60000, skipped: progress.skipped.filter((s) => s.date < day.date) });
      day.usedMinutes += len;
      progress.remaining -= len;
      progress.blocks++;
    }
  }
}

/** 在当天空闲区间里找截止前能放下 len 分钟的起点（先看偏好时段，再取最早），原地消费该段（含块前后间隔） */
function findSpot(day: DayState, lenMin: number, due: number): number | null {
  const need = lenMin * 60000;
  for (const p of day.preferred) {
    for (let i = 0; i < day.intervals.length; i++) {
      const w = day.intervals[i]!;
      const start = Math.max(w[0], p[0]);
      const end = Math.min(w[1], p[1], due);
      if (end - start >= need) return consume(day.intervals, i, start, need);
    }
  }
  for (let i = 0; i < day.intervals.length; i++) {
    const w = day.intervals[i]!;
    if (Math.min(w[1], due) - w[0] >= need) return consume(day.intervals, i, w[0], need);
  }
  return null;
}

/** 从第 i 个区间里切走 [start, start+need) 及前后间隔；剩余两侧保留 */
function consume(intervals: Interval[], i: number, start: number, need: number): number {
  const w = intervals[i]!;
  const parts: Interval[] = [];
  if (start - GAP_MS > w[0]) parts.push([w[0], start - GAP_MS]);
  if (start + need + GAP_MS < w[1]) parts.push([start + need + GAP_MS, w[1]]);
  intervals.splice(i, 1, ...parts);
  return start;
}

function largestSpot(intervals: Interval[], due: number): number {
  let best = 0;
  for (const w of intervals) best = Math.max(best, Math.floor((Math.min(w[1], due) - w[0]) / 60000));
  return best;
}

/** 取整到 5 分钟；取整后不够最小块就保持原值（由调用方按原规则判断） */
function neat(minutes: number, minBlock: number): number {
  const rounded = Math.floor(minutes / 5) * 5;
  return rounded >= minBlock ? rounded : minutes;
}
