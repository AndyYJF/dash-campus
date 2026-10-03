import { addDays, wallTimeToUtc } from "./time";

/**
 * 确定性时间预算（MASTER-PLAN §6.1）：纯函数，不碰 DB。
 * W = A − (F ∪ L)；C_day = min(W分钟 × (1−buffer), 日上限)。区间一律合并/扣除，不重复扣重叠。
 */

export type Interval = [number, number]; // epoch ms [start, end)

export type Prefs = {
  workdayStart: string;
  workdayEnd: string;
  weekendStart: string;
  weekendEnd: string;
  meals: Array<[string, string]>;
  commuteMinutes: number;
  dailyLimitMinutes: number;
  minBlockMinutes: number;
  bufferPercent: number;
  status: "tentative" | "confirmed";
  version: number;
};

export function mergeIntervals(ws: Interval[]): Interval[] {
  const sorted = [...ws].sort((a, b) => a[0] - b[0]);
  const out: Interval[] = [];
  for (const w of sorted) {
    const last = out[out.length - 1];
    if (last && w[0] <= last[1]) last[1] = Math.max(last[1], w[1]);
    else out.push([...w]);
  }
  return out;
}

export function subtractIntervals(base: Interval[], busy: Interval[]): Interval[] {
  let result = base;
  for (const [bs, be] of mergeIntervals(busy)) {
    const next: Interval[] = [];
    for (const [s, e] of result) {
      if (be <= s || bs >= e) next.push([s, e]);
      else {
        if (bs > s) next.push([s, bs]);
        if (be < e) next.push([be, e]);
      }
    }
    result = next;
  }
  return result;
}

export function minutesOf(ws: Interval[]): number {
  return Math.floor(ws.reduce((a, [s, e]) => a + (e - s), 0) / 60000);
}

/** 本地日期是否周末（周六/周日），dateLocal = YYYY-MM-DD，tz 内解释 */
function isWeekend(dateLocal: string, tz: string): boolean {
  const day = new Date(`${dateLocal}T12:00:00Z`).getUTCDay();
  void tz;
  return day === 0 || day === 6;
}

/** 基础可安排窗口 A（模板） */
export function baseWindows(dateLocal: string, prefs: Prefs, tz: string): Interval[] {
  const [start, end] = isWeekend(dateLocal, tz)
    ? [prefs.weekendStart, prefs.weekendEnd]
    : [prefs.workdayStart, prefs.workdayEnd];
  return [[wallTimeToUtc(dateLocal, start, tz).getTime(), wallTimeToUtc(dateLocal, end, tz).getTime()]];
}

/** 生活保留 L：餐饮时段与 A 的交集（只与 A 交集扣除） */
export function lifeReserves(dateLocal: string, prefs: Prefs, tz: string, a: Interval[]): Interval[] {
  const meals = prefs.meals.map(
    ([s, e]) => [wallTimeToUtc(dateLocal, s, tz).getTime(), wallTimeToUtc(dateLocal, e, tz).getTime()] as Interval,
  );
  const out: Interval[] = [];
  for (const m of meals) for (const w of a) {
    const s = Math.max(m[0], w[0]);
    const e = Math.min(m[1], w[1]);
    if (e > s) out.push([s, e]);
  }
  return out;
}

/** 日预算：输入当日课程/固定活动区间（course=true 的会加通勤），输出 W 区间与 C_day */
export function dayBudget(
  dateLocal: string,
  prefs: Prefs,
  tz: string,
  events: Array<{ interval: Interval; isCourse: boolean }>,
): { w: Interval[]; cDay: number; courseMinutes: number; eventMinutes: number } {
  const a = baseWindows(dateLocal, prefs, tz);
  const l = lifeReserves(dateLocal, prefs, tz, a);
  const commute = prefs.commuteMinutes * 60000;
  const f = events.map(({ interval: [s, e], isCourse }) =>
    isCourse ? ([s - commute, e + commute] as Interval) : ([s, e] as Interval),
  );
  const w = subtractIntervals(subtractIntervals(a, f), l);
  const cDay = Math.min(Math.floor(minutesOf(w) * (1 - prefs.bufferPercent / 100)), prefs.dailyLimitMinutes);
  const courseMinutes = minutesOf(mergeIntervals(events.filter((e) => e.isCourse).map((e) => e.interval)));
  const eventMinutes = minutesOf(mergeIntervals(events.map((e) => e.interval)));
  return { w, cDay, courseMinutes, eventMinutes };
}

/** 未来容量（§6.1）：futureBudget = min(max(0, C_day − B_day), floor(W_future × (1−buffer)))；futureCapacity = max(0, futureBudget − P_future) */
export function futureCapacity(input: { cDay: number; bDay: number; wFutureMinutes: number; pFutureMinutes: number; bufferPercent: number }): { futureBudget: number; futureCapacity: number } {
  const futureBudget = Math.min(
    Math.max(0, input.cDay - input.bDay),
    Math.floor(input.wFutureMinutes * (1 - input.bufferPercent / 100)),
  );
  return { futureBudget, futureCapacity: Math.max(0, futureBudget - input.pFutureMinutes) };
}

export function next7Days(fromLocal: string): string[] {
  return Array.from({ length: 7 }, (_, i) => addDays(fromLocal, i));
}
