import { occurrences } from './calendar-occurrences';
import crypto from "node:crypto";
import { getDb } from "@/repositories/db";
import {
  addDays,
  instanceTimezone,
  mondayOf,
  wallTimeToUtc,
} from "@/domain/time";
import type { TaskRow } from "@/repositories/planning";

/**
 * 周负担与容量（计划 v1.2 第 4.3 节，F6/F21 口径）：
 * - 整周承诺负担 = 归属该周且非 cancelled 的估时总和（含 done），未知估时单列
 * - 整周/未来可用 = 可用窗口并集 − 固定事件，× 0.8
 * - 剩余负担 = todo/doing/blocked 的全额估时（无实际计时，保守口径）
 * - 无时间数据时容量为 null，不显示"安排合理"
 */

export const BUFFER_PERCENT = 20;

export type AvailabilityRow = {
  version?: number;
  id: string;
  title: string;
  weekday: number;
  localStart: string;
  localEnd: string;
  timezone: string;
  validFrom: string | null;
  validUntil: string | null;
};

export type FixedEventRow = {
  version?: number;
  id: string;
  title: string;
  weekday: number;
  localStart: string;
  localEnd: string;
  timezone: string;
  eventDate: string | null;
  validFrom: string | null;
  validUntil: string | null;
};

export type Workload = {
  committedMinutes: number;
  committedUnknownCount: number;
  remainingKnownMinutes: number;
  remainingUnknownCount: number;
  weekCapacityMinutes: number | null;
  futureCapacityMinutes: number | null;
  bufferPercent: number;
  estimateMode: "full_estimate_for_unfinished";
  hasAnyTimeData: boolean;
};

export function computeWorkload(
  tasks: TaskRow[],
  localMonday: string,
  asOf: Date,
): Workload {
  const inWeek = tasks.filter(
    (t) => t.plannedWeek?.localMonday === localMonday && t.status !== "cancelled",
  );
  const committed = inWeek.filter((t) => t.estimateMinutes !== null);
  const committedUnknown = inWeek.filter((t) => t.estimateMinutes === null);
  const remaining = inWeek.filter(
    (t) => t.status === "todo" || t.status === "doing" || t.status === "blocked",
  );
  const remainingKnown = remaining.filter((t) => t.estimateMinutes !== null);
  const remainingUnknown = remaining.filter((t) => t.estimateMinutes === null);

  const sum = (rows: TaskRow[]) => rows.reduce((acc, t) => acc + (t.estimateMinutes ?? 0), 0);
  const blocks = listAvailabilityBlocks();
  const events = listFixedEvents();
  // 只看覆盖本周的窗口：别周的配置不算数
  const weekLast = addDays(localMonday, 6);
  const hasAnyTimeData = blocks.some((b) => overlapsRange(localMonday, weekLast, b.validFrom, b.validUntil));

  return {
    committedMinutes: sum(committed),
    committedUnknownCount: committedUnknown.length,
    remainingKnownMinutes: sum(remainingKnown),
    remainingUnknownCount: remainingUnknown.length,
    weekCapacityMinutes: hasAnyTimeData ? netAvailableMinutes(localMonday, asOf, false, blocks, events) : null,
    futureCapacityMinutes: hasAnyTimeData
      ? netAvailableMinutes(localMonday, asOf, true, blocks, events)
      : null,
    bufferPercent: bufferPercent(),
    estimateMode: "full_estimate_for_unfinished",
    hasAnyTimeData,
  };
}

/** 净可用分钟：可用窗口并集 − 固定事件，预留 bufferPercent%；futureOnly 只算当前时刻之后的部分 */
function netAvailableMinutes(
  localMonday: string, asOf: Date, futureOnly: boolean,
  blocks: AvailabilityRow[], events: FixedEventRow[],
): number {
  const tz = instanceTimezone();
  const first = wallTimeToUtc(localMonday, '00:00', tz).getTime();
  const last = wallTimeToUtc(addDays(localMonday, 7), '00:00', tz).getTime();
  const windows = mergeWindows(blocks.flatMap(b => occurrences(b, first, last)).sort((a,b) => a[0]-b[0]));
  const busy = mergeWindows(events.flatMap(e => occurrences(e, first, last)).sort((a,b) => a[0]-b[0]));
  let milliseconds = 0;
  for (const [s,e] of windows) {
    const start = Math.max(s,first,futureOnly ? asOf.getTime() : first), end = Math.min(e,last);
    if (end <= start) continue;
    let free = end-start;
    for (const [bs,be] of busy) free -= Math.max(0,Math.min(end,be)-Math.max(start,bs));
    milliseconds += Math.max(0,free);
  }
  return Math.floor(milliseconds/60000*(1-bufferPercent()/100));
}

/** 有效期 [from, until] 与 [first, last] 是否有交集（null 表示不限） */
function overlapsRange(first: string, last: string, from: string | null, until: string | null): boolean {
  if (from && from > last) return false;
  if (until && until < first) return false;
  return true;
}

function mergeWindows(windows: Array<[number, number]>): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const w of windows) {
    const s = w[0]!;
    const e = w[1]!;
    const last = out[out.length - 1];
    if (last && s <= last[1]) {
      last[1] = Math.max(last[1], e);
    } else {
      out.push([s, e]);
    }
  }
  return out;
}

// ===== availability / fixed events CRUD =====

export function listAvailabilityBlocks(): AvailabilityRow[] {
  const db = getDb();
  const rows = db.prepare(`SELECT * FROM availability_blocks`).all() as Array<Record<string, unknown>>;
  return rows.map(mapAvailability);
}

export function listFixedEvents(): FixedEventRow[] {
  const db = getDb();
  const rows = db.prepare(`SELECT * FROM fixed_events`).all() as Array<Record<string, unknown>>;
  return rows.map(mapFixedEvent);
}

function mapAvailability(r: Record<string, unknown>): AvailabilityRow {
  return {
    version: Number(r.version ?? 1),
    id: r.id as string,
    title: r.title as string,
    weekday: r.weekday as number,
    localStart: r.local_start as string,
    localEnd: r.local_end as string,
    timezone: r.timezone as string,
    validFrom: (r.valid_from as string | null) ?? null,
    validUntil: (r.valid_until as string | null) ?? null,
  };
}

function mapFixedEvent(r: Record<string, unknown>): FixedEventRow {
  return {
    version: Number(r.version ?? 1),
    id: r.id as string,
    title: r.title as string,
    weekday: r.weekday as number,
    localStart: r.local_start as string,
    localEnd: r.local_end as string,
    timezone: r.timezone as string,
    eventDate: (r.event_date as string | null) ?? null,
    validFrom: (r.valid_from as string | null) ?? null,
    validUntil: (r.valid_until as string | null) ?? null,
  };
}

export function weekRange(localMonday: string): { localMonday: string; endsAt: string } {
  return { localMonday, endsAt: addDays(localMonday, 7) };
}

export { mondayOf, wallTimeToUtc };
export const newId = () => crypto.randomUUID();
export function bufferPercent(): number { return (getDb().prepare('SELECT buffer_percent FROM planning_state WHERE id=1').get() as {buffer_percent:number}).buffer_percent; }
