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

/** 当地墙钟时间 → UTC instant。不存在的 DST 时刻按调用方规则处理（T2 先取迭代逼近）。 */
export function wallTimeToUtc(date: string, time: string, tz: string): Date {
  // time 形如 "HH:MM"
  const guess = new Date(`${date}T${time}:00Z`);
  for (let i = 0; i < 3; i++) {
    const offset = tzOffsetMs(guess, tz);
    const next = new Date(`${date}T${time}:00Z`);
    next.setTime(next.getTime() - offset);
    if (Math.abs(next.getTime() - guess.getTime()) < 1000) break;
    guess.setTime(next.getTime());
  }
  return guess;
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
