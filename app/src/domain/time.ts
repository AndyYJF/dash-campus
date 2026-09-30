import { getConfig } from "@/config";
import type { Due } from "@/contracts/planning";

/**
 * 时区与日期工具。用 Node 内置 Intl（维护中的时区库），不引入额外依赖。
 * 周一律按实例时区计算 localMonday。
 */

export function instanceTimezone(): string {
  return getConfig().APP_TIMEZONE;
}

export function localDateInTz(instant: Date, tz: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(instant);
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** ISO 周：返回当地日期所在周的周一（当地日期字符串；输入须已是当地日期） */
export function mondayOf(localDate: string): string {
  const d = new Date(`${localDate}T00:00:00Z`);
  // 用 UTC  weekday 推算即可：localDate 本身已是当地日期，周一按日历差计算
  const dow = (d.getUTCDay() + 6) % 7; // 周一=0
  d.setUTCDate(d.getUTCDate() - dow);
  return d.toISOString().slice(0, 10);
}

export type WallTimeAdjustment = "none" | "gap_shifted" | "overlap_earlier";

/**
 * 当地墙钟时间 → UTC instant（开发计划"日期与时区"，F19）：
 * - 不存在的时刻（夏令时开始跳过的区间）向后移到第一个有效时刻，标 gap_shifted；
 * - 重复的时刻（夏令时结束回拨）取较早的那一次（较早偏移），标 overlap_earlier。
 * 以当天前后 24 小时的偏移为两个候选：转换不会在一天内发生两次。
 */
export function resolveWallTime(
  date: string,
  time: string,
  tz: string,
): { instant: Date; adjustment: WallTimeAdjustment } {
  // time 形如 "HH:MM"
  const naive = Date.parse(`${date}T${time}:00Z`);
  const DAY = 86_400_000;
  const before = tzOffsetMs(new Date(naive - DAY), tz);
  const after = tzOffsetMs(new Date(naive + DAY), tz);
  const valid = [...new Set([before, after])]
    .map((o) => naive - o)
    .filter((t) => tzOffsetMs(new Date(t), tz) === naive - t)
    .sort((x, y) => x - y);

  if (valid.length === 1) return { instant: new Date(valid[0]!), adjustment: "none" };
  if (valid.length > 1) return { instant: new Date(valid[0]!), adjustment: "overlap_earlier" };

  // 落在跳过的区间：二分找转换点（第一个使用新偏移的时刻），精确到秒
  let lo = Math.min(naive - before, naive - after);
  let hi = Math.max(naive - before, naive - after);
  while (hi - lo > 1000) {
    const mid = lo + Math.floor((hi - lo) / 2);
    if (tzOffsetMs(new Date(mid), tz) === after) hi = mid;
    else lo = mid;
  }
  return { instant: new Date(hi), adjustment: "gap_shifted" };
}

/** 当地墙钟时间 → UTC instant；DST 规则见 resolveWallTime */
export function wallTimeToUtc(date: string, time: string, tz: string): Date {
  return resolveWallTime(date, time, tz).instant;
}

/** tz 相对 UTC 的偏移毫秒（正 = 本地超前 UTC） */
export function tzOffsetMs(instant: Date, tz: string): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const parts = dtf.formatToParts(instant);
  const get = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  const asUTC = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour") % 24, get("minute"), get("second"));
  return asUTC - instant.getTime();
}

/** due 的逾期判断边界：date 型取当地次日 00:00（UTC instant）；instant 型取 at 本身 */
export function dueBoundaryUtc(due: Due): string | null {
  if (due.kind === "none") return null;
  if (due.kind === "instant") return due.at;
  const nextDay = new Date(`${due.localDate}T00:00:00Z`);
  nextDay.setUTCDate(nextDay.getUTCDate() + 1);
  return wallTimeToUtc(nextDay.toISOString().slice(0, 10), "00:00", due.timezone).toISOString();
}

export function addDays(localDate: string, days: number): string {
  const d = new Date(`${localDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
