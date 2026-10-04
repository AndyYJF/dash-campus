import { getSetting } from "@/repositories/settings";
import { addDays, instanceTimezone, localDateInTz, wallTimeToUtc } from "@/domain/time";

/**
 * 提醒策略（MASTER-PLAN §7，AGENT-INTERFACE-CONTRACT §7）：是否发截止提醒、默认提前量、安静时段。
 * worker 与页面读同一份设置；自然语言修改走 update_reminder_policy，改完既有提醒任务一并重排。
 * 安静时段内不发：推到安静时段结束；推迟会越过截止就提前到安静时段开始之前；两者都不行就不发邮件（留在页面待处理）。
 */

export const REMINDER_POLICY_KEY = "reminderPolicy";

export type ReminderPolicy = {
  /** 沿用旧行为：有截止的任务默认提醒；主人可以关掉 */
  deadlineReminders: boolean;
  /** 任务自己没设提前量时用这个；null = 日期型当天 09:00、时刻型提前 24 小时 */
  defaultLeadMinutes: number | null;
  quietEnabled: boolean;
  quietStart: string;
  quietEnd: string;
};

export const DEFAULT_REMINDER_POLICY: ReminderPolicy = { deadlineReminders: true, defaultLeadMinutes: null, quietEnabled: true, quietStart: "22:00", quietEnd: "08:00" };

export function reminderPolicy(): ReminderPolicy {
  return { ...DEFAULT_REMINDER_POLICY, ...((getSetting(REMINDER_POLICY_KEY).value as Partial<ReminderPolicy> | null) ?? {}) };
}

function hhmm(iso: string, tz: string): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(iso));
}

/** 触发点是否落在安静时段（跨午夜的 22:00–08:00 也算） */
export function inQuietHours(iso: string, policy: ReminderPolicy, tz: string): boolean {
  if (!policy.quietEnabled || policy.quietStart === policy.quietEnd) return false;
  const t = hhmm(iso, tz);
  return policy.quietStart < policy.quietEnd ? t >= policy.quietStart && t < policy.quietEnd : t >= policy.quietStart || t < policy.quietEnd;
}

/**
 * 按安静时段调整触发点。dueBoundaryIso 是提醒失去意义的时刻（截止）。
 * 返回 null 表示这次不发邮件：安静时段内的临近截止没有明确的例外政策，不擅自打扰。
 */
export function adjustForQuiet(triggerIso: string, dueBoundaryIso: string | null, nowIso: string, policy: ReminderPolicy = reminderPolicy(), tz: string = instanceTimezone()): string | null {
  if (!inQuietHours(triggerIso, policy, tz)) return triggerIso;
  const date = localDateInTz(new Date(triggerIso), tz);
  const t = hhmm(triggerIso, tz);
  // 安静时段结束：当晚开始的算次日早上，凌晨的算当天早上
  const overnight = policy.quietStart > policy.quietEnd;
  const endDate = overnight && t >= policy.quietStart ? addDays(date, 1) : date;
  const postponed = wallTimeToUtc(endDate, policy.quietEnd, tz).toISOString();
  if (!dueBoundaryIso || postponed < dueBoundaryIso) return postponed;
  const startDate = overnight && t < policy.quietEnd ? addDays(date, -1) : date;
  const earlier = new Date(wallTimeToUtc(startDate, policy.quietStart, tz).getTime() - 60_000).toISOString();
  return earlier > nowIso ? earlier : null;
}
