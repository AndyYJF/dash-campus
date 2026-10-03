import type { Due } from "@/contracts/planning";
import {
  DATE_DUE_REMINDER_LOCAL_TIME,
  INSTANT_DUE_LEAD_MINUTES,
} from "@/contracts/jobs";
import { wallTimeToUtc } from "@/domain/time";

/**
 * 提醒触发点计算（计划 v1.2 第 4.3、8.2 节）。
 * date 型：截止日当天 09:00（当地）；instant 型：截止时刻前默认 24 小时。
 * 触发点已过去的不再建 job，进入"今日待处理"（由 notifications 查询呈现）。
 */

export function reminderTriggerUtc(due: Due, leadMinutes?: number | null): string | null {
  if (due.kind === "none") return null;
  if (due.kind === "date") {
    return new Date(wallTimeToUtc(due.localDate, DATE_DUE_REMINDER_LOCAL_TIME, due.timezone).getTime() - (leadMinutes ?? 0) * 60_000).toISOString();
  }
  const at = new Date(due.at);
  if (Number.isNaN(at.getTime())) return null;
  return new Date(at.getTime() - (leadMinutes ?? INSTANT_DUE_LEAD_MINUTES) * 60_000).toISOString();
}

/** 任务当前是否还可能需要提醒：未归档且未进入终态 */
export function reminderActive(task: {
  status: string;
  archivedAt: string | null;
}): boolean {
  return !task.archivedAt && task.status !== "done" && task.status !== "cancelled";
}

/** 提醒是否已过期（发送无意义）：已越过 due 边界即视为过期 */
export function reminderOverdue(due: Due, nowIso: string): boolean {
  const boundary = dueBoundaryLocal(due);
  return boundary !== null && boundary <= nowIso;
}

function dueBoundaryLocal(due: Due): string | null {
  if (due.kind === "none") return null;
  if (due.kind === "instant") return due.at;
  // date 型：当地次日 00:00 为逾期边界
  const next = new Date(`${due.localDate}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return wallTimeToUtc(next.toISOString().slice(0, 10), "00:00", due.timezone).toISOString();
}
