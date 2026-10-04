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
};

export type Placement = { taskId: string; start: number; end: number };
export type UnscheduledReason = "unknown_requirement" | "deadline_unfeasible" | "insufficient_capacity" | "no_contiguous_slot" | "needs_remaining_estimate";
export type Unscheduled = { taskId: string; title: string; reason: UnscheduledReason; missingMinutes?: number };

const GAP_MS = 10 * 60000;
export const MAX_BLOCKS_PER_TASK = 3;

type DayState = { date: string; cDay: number; intervals: Interval[]; usedMinutes: number };
type Opts = { minBlock: number; maxBlock: number };

export function placeTasks(tasks: SchedTask[], days: SchedDay[], opts: Opts): { placements: Placement[]; unscheduled: Unscheduled[] } {
  const ordered = [...tasks].sort(compareTasks);
  const state: DayState[] = days.map((d) => ({ date: d.date, cDay: d.cDay, intervals: d.free.map((w) => [...w] as Interval), usedMinutes: 0 }));
  const placements: Placement[] = [];
  const unscheduled: Unscheduled[] = [];
  for (const t of ordered) {
    if (t.estimateMinutes === null) {
      unscheduled.push({ taskId: t.id, title: t.title, reason: "unknown_requirement" });
      continue;
    }
    const due = dueMs(t);
    const progress = { remaining: t.estimateMinutes, blocks: 0, maxBlocks: t.maxNewBlocks ?? MAX_BLOCKS_PER_TASK };
    // 有截止：最早可行优先，窗口不够整块时用截止前最大的可用片段；
    // 无截止：先找能放下整块的连续空档，全程找不到再退而用片段。
    if (due === null) placeOne(t, state, placements, opts, progress, false);
    placeOne(t, state, placements, opts, progress, true);
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

function placeOne(t: SchedTask, days: DayState[], placements: Placement[], opts: Opts, progress: { remaining: number; blocks: number; maxBlocks: number }, allowFragments: boolean): void {
  const due = dueMs(t) ?? Number.POSITIVE_INFINITY;
  for (const day of days) {
    if (progress.blocks >= progress.maxBlocks || progress.remaining <= 0) break;
    if (t.dueLocalDate && day.date > t.dueLocalDate) break;
    while (progress.blocks < progress.maxBlocks && progress.remaining > 0 && day.usedMinutes < day.cDay) {
      const remaining = progress.remaining;
      const want = remaining >= opts.minBlock ? Math.min(remaining, opts.maxBlock) : remaining; // 剩余不足最小块：作为有依据的收尾块
      let len = Math.min(want, day.cDay - day.usedMinutes);
      if (len < opts.minBlock && remaining > len) break; // 当天预算放不下有效块就换天；除非这就是收尾块
      let spot = findSpot(day.intervals, len, due);
      if (!spot && allowFragments) {
        const largest = Math.min(len, largestSpot(day.intervals, due));
        if (largest >= opts.minBlock) {
          len = largest;
          spot = findSpot(day.intervals, len, due);
        }
      }
      if (!spot) break;
      placements.push({ taskId: t.id, start: spot, end: spot + len * 60000 });
      day.usedMinutes += len;
      progress.remaining -= len;
      progress.blocks++;
    }
  }
}

/** 在区间列表里找截止前能放下 len 分钟的最早起点，原地消费该段（含块后间隔） */
function findSpot(intervals: Interval[], lenMin: number, due: number): number | null {
  const need = lenMin * 60000;
  for (const w of intervals) {
    if (Math.min(w[1], due) - w[0] >= need) {
      const start = w[0];
      w[0] = start + need + GAP_MS;
      return start;
    }
  }
  return null;
}

function largestSpot(intervals: Interval[], due: number): number {
  let best = 0;
  for (const w of intervals) best = Math.max(best, Math.floor((Math.min(w[1], due) - w[0]) / 60000));
  return best;
}
