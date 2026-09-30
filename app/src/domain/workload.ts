import crypto from "node:crypto";
import { getDb } from "@/repositories/db";
import {
  addDays,
  instanceTimezone,
  localDateInTz,
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
    bufferPercent: BUFFER_PERCENT,
    estimateMode: "full_estimate_for_unfinished",
    hasAnyTimeData,
  };
}

/** 净可用分钟：可用窗口并集 − 固定事件，预留 bufferPercent%；futureOnly 只算当前时刻之后的部分 */
function netAvailableMinutes(
  localMonday: string,
  asOf: Date,
  futureOnly: boolean,
  blocks: AvailabilityRow[],
  events: FixedEventRow[],
): number | null {
  const tz = instanceTimezone();
  const todayLocal = localDateInTz(asOf, tz);
  let total = 0;

  for (let i = 0; i < 7; i++) {
    const date = addDays(localMonday, i);
    const dow = ((new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7) + 1; // 周一=1

    // 当日可用窗口（合并并集）
    const dayWindows: Array<[number, number]> = blocks
      .filter((b) => b.weekday === dow && inValidRange(date, b.validFrom, b.validUntil))
      .map((b) => [toMinutes(b.localStart), toMinutes(b.localEnd)] as [number, number])
      .sort((a, b) => a[0] - b[0]);
    const merged = mergeWindows(dayWindows);

    // 当日固定事件占用（合并并集，重叠事件只扣一次）
    const busy = mergeWindows(
      events
        .filter(
          (e) =>
            e.weekday === dow &&
            inValidRange(date, e.validFrom, e.validUntil) &&
            (e.eventDate === null || e.eventDate === date),
        )
        .map((e) => [toMinutes(e.localStart), toMinutes(e.localEnd)] as [number, number])
        .sort((a, b) => a[0] - b[0]),
    );

    for (const [s, e] of merged) {
      let start = s;
      const end = e;
      if (futureOnly) {
        if (date < todayLocal) continue; // 过去的空闲不再利用
        if (date === todayLocal) {
          const nowMin = minutesOfInstantInTz(asOf, tz);
          start = Math.max(start, nowMin);
          if (start >= end) continue;
        }
      }
      let minutes = end - start;
      for (const [bs, be] of busy) {
        const overlap = Math.max(0, Math.min(end, be) - Math.max(start, bs));
        minutes -= overlap;
      }
      total += Math.max(0, minutes);
    }
  }

  return Math.floor(total * (1 - BUFFER_PERCENT / 100));
}

function minutesOfInstantInTz(instant: Date, tz: string): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = dtf.formatToParts(instant);
  const h = Number(parts.find((p) => p.type === "hour")!.value) % 24;
  const m = Number(parts.find((p) => p.type === "minute")!.value);
  return h * 60 + m;
}

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

function inValidRange(date: string, from: string | null, until: string | null): boolean {
  if (from && date < from) return false;
  if (until && date > until) return false;
  return true;
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
