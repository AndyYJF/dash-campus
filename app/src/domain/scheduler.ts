import type { Interval } from "./budget";

/**
 * 确定性排程（MASTER-PLAN §6.2）：纯函数，不做分钟算术以外的判断。
 * 顺序：明确截止优先 → 高优先级 → 创建时间；块 25–90 分钟、间隔 10 分钟、每项最多 3 个未来块；
 * 不可放入课程/生活保留/已排块，不超日预算；放不下给原因，不改截止。
 */

export type SchedTask = {
  id: string;
  title: string;
  estimateMinutes: number | null;
  dueLocalDate: string | null;
  priority: "normal" | "high";
  createdAt: string;
};

export type SchedDay = {
  date: string; // YYYY-MM-DD（本地）
  free: Interval[]; // W 区间（已扣课程/生活/已排）
  cDay: number;
};

export type Placement = { taskId: string; start: number; end: number };
export type Unscheduled = { taskId: string; title: string; reason: string };

const GAP_MS = 10 * 60000;
const MAX_BLOCKS_PER_TASK = 3;

export function placeTasks(tasks: SchedTask[], days: SchedDay[], opts: { minBlock: number; maxBlock: number }): { placements: Placement[]; unscheduled: Unscheduled[] } {
  const ordered = [...tasks].sort(compareTasks);
  const free = days.map((d) => ({ date: d.date, cDay: d.cDay, intervals: d.free.map((w) => [...w] as Interval), usedMinutes: 0 }));
  const placements: Placement[] = [];
  const unscheduled: Unscheduled[] = [];
  for (const t of ordered) {
    if (t.estimateMinutes === null) {
      unscheduled.push({ taskId: t.id, title: t.title, reason: "unknown_requirement" });
      continue;
    }
    const placed = placeOne(t, free, placements, opts);
    if (placed.remaining > 0) {
      unscheduled.push({ taskId: t.id, title: t.title, reason: t.dueLocalDate ? "deadline_unfeasible" : "insufficient_capacity" });
    }
  }
  return { placements, unscheduled };
}

function compareTasks(a: SchedTask, b: SchedTask): number {
  if (a.dueLocalDate && b.dueLocalDate && a.dueLocalDate !== b.dueLocalDate) return a.dueLocalDate < b.dueLocalDate ? -1 : 1;
  if (a.dueLocalDate && !b.dueLocalDate) return -1;
  if (!a.dueLocalDate && b.dueLocalDate) return 1;
  if (a.priority !== b.priority) return a.priority === "high" ? -1 : 1;
  return a.createdAt < b.createdAt ? -1 : 1;
}

function placeOne(t: SchedTask, days: Array<{ date: string; cDay: number; intervals: Interval[]; usedMinutes: number }>, placements: Placement[], opts: { minBlock: number; maxBlock: number }): { remaining: number } {
  let remaining = t.estimateMinutes!;
  let blocks = 0;
  for (const day of days) {
    if (blocks >= MAX_BLOCKS_PER_TASK || remaining <= 0) break;
    if (t.dueLocalDate && day.date > t.dueLocalDate) break;
    while (blocks < MAX_BLOCKS_PER_TASK && remaining > 0 && day.usedMinutes < day.cDay) {
      const want = remaining >= opts.minBlock ? Math.min(remaining, opts.maxBlock) : remaining; // 剩余不足最小块：作为有依据的收尾块
      const len = Math.min(want, day.cDay - day.usedMinutes);
      if (len < opts.minBlock && remaining > len) break; // 当天放不下有效块就换天；除非这就是收尾块
      const spot = findSpot(day.intervals, len, GAP_MS);
      if (!spot) break;
      placements.push({ taskId: t.id, start: spot[0], end: spot[0] + len * 60000 });
      day.usedMinutes += len;
      remaining -= len;
      blocks++;
    }
  }
  return { remaining };
}

/** 在区间列表里找能放下 len 分钟（含块后间隔）的起点，原地消费该段 */
function findSpot(intervals: Interval[], lenMin: number, gapMs: number): Interval | null {
  const need = lenMin * 60000;
  for (const w of intervals) {
    if (w[1] - w[0] >= need) {
      const start = w[0];
      w[0] = start + need + gapMs;
      return [start, w[1]];
    }
  }
  return null;
}
