"use client";

import styles from "./timeline.module.css";

/**
 * 一天的时间线（REPAIR-PLAN §3）：课程、固定活动、待核对预留、学习安排、可用空档画在同一坐标里，
 * 与预算、排程用的是同一批区间。类型靠文字标签和形状区分（不只靠颜色）；每一块都是可聚焦的按钮。
 */

export type TimelineEvent = {
  id: string;
  title: string;
  startUtc: string;
  endUtc: string;
  kind: "course" | "fixed" | "pending";
  location: string;
  teacher: string;
  courseId: string | null;
  sourceDate: string | null;
  origin: string | null;
};
export type TimelineSession = { id: string; taskId: string; title: string; startUtc: string; endUtc: string; minutes: number; status: string; locked: boolean; version: number; reason: string; kind: string; origin: string };
export type TimelineSlot = { date: string; start: string; end: string; minutes: number };
export type Picked = { type: "event"; event: TimelineEvent } | { type: "session"; session: TimelineSession } | { type: "slot"; slot: TimelineSlot };

type Box = { key: string; start: number; end: number; col: number; cols: number; pick: Picked };

const KIND_TAG: Record<string, string> = { course: "课", fixed: "固定", pending: "待核对" };
const STATUS_TAG: Record<string, string> = { planned: "学习", tentative: "暂定", in_progress: "进行中", completed: "已完成", skipped: "已跳过" };

/** 实例时区里的“当天第几分钟”；跨到前后一天的部分裁到 0–1440 */
export function minuteOfDay(iso: string, date: string, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(new Date(iso));
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  const day = `${get("year")}-${get("month")}-${get("day")}`;
  const minutes = (Number(get("hour")) % 24) * 60 + Number(get("minute"));
  return day < date ? 0 : day > date ? 1440 : minutes;
}

export function hm(minutes: number): string {
  const m = Math.max(0, Math.min(1440, Math.round(minutes)));
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

/** 一天里所有块的最早/最晚时刻，用来决定时间轴范围——不拿固定的 08–22 裁掉真实课程 */
export function dayExtent(date: string, tz: string, events: TimelineEvent[], sessions: TimelineSession[]): [number, number] | null {
  const all = [...events, ...sessions].map((x) => [minuteOfDay(x.startUtc, date, tz), minuteOfDay(x.endUtc, date, tz)] as const).filter(([s, e]) => e > s);
  return all.length ? [Math.min(...all.map((x) => x[0])), Math.max(...all.map((x) => x[1]))] : null;
}

/** 重叠的块并排显示：不挤成一张卡，也不悄悄去重 */
function layout(items: Array<Omit<Box, "col" | "cols">>): Box[] {
  const sorted = [...items].sort((a, b) => a.start - b.start || b.end - a.end);
  const out: Box[] = [];
  let cluster: Box[] = [];
  let clusterEnd = -1;
  const flush = () => {
    const cols = Math.max(1, ...cluster.map((b) => b.col + 1));
    for (const b of cluster) b.cols = cols;
    out.push(...cluster);
    cluster = [];
  };
  for (const item of sorted) {
    if (cluster.length && item.start >= clusterEnd) flush();
    const used = new Set(cluster.filter((b) => b.end > item.start).map((b) => b.col));
    let col = 0;
    while (used.has(col)) col++;
    cluster.push({ ...item, col, cols: 1 });
    clusterEnd = Math.max(clusterEnd, item.end);
  }
  if (cluster.length) flush();
  return out;
}

export default function DayTimeline(props: {
  date: string;
  timezone: string;
  events: TimelineEvent[];
  sessions: TimelineSession[];
  /** 时间轴范围（分钟）；一周共用同一范围 */
  rangeStart: number;
  rangeEnd: number;
  /** 每分钟像素；手机单日视图可以更高 */
  pxPerMinute?: number;
  /** 当前时刻（只在当天画线、只在之后算空档） */
  nowMinute?: number | null;
  /** 这一天整体已经过去：不再给空档 */
  past?: boolean;
  /** 可安排窗口（当天作息），空档只在这里面给 */
  windowStart: number;
  windowEnd: number;
  /** 当天明确不安排学习的时段（分钟），空档不落在里面 */
  closed?: Array<[number, number]>;
  minSlot?: number;
  selectedKey?: string | null;
  onPick: (p: Picked, key: string) => void;
  label: string;
  /** 一周并排时只有第一列显示钟点，其余列不留钟点栏 */
  hideHours?: boolean;
  /** 当天还能新排的学习分钟：为 0 时空档只是物理空闲，照实标出，不让人以为还能排 */
  budgetLeft?: number;
}) {
  const { date, timezone: tz, rangeStart, rangeEnd } = props;
  const ppm = props.pxPerMinute ?? 0.85;
  const visibleSessions = props.sessions.filter((s) => s.status !== "skipped");
  const occupied: Array<Omit<Box, "col" | "cols">> = [
    ...props.events.map((e) => ({ key: `e:${e.id}:${e.startUtc}`, start: minuteOfDay(e.startUtc, date, tz), end: minuteOfDay(e.endUtc, date, tz), pick: { type: "event", event: e } as Picked })),
    ...visibleSessions.map((s) => ({ key: `s:${s.id}`, start: minuteOfDay(s.startUtc, date, tz), end: minuteOfDay(s.endUtc, date, tz), pick: { type: "session", session: s } as Picked })),
  ].filter((b) => b.end > b.start);

  // 空档：作息窗口内、现在之后、没有被任何块占用、够放下一段学习的连续时间
  const slots: Array<Omit<Box, "col" | "cols">> = [];
  if (!props.past) {
    const from = Math.max(props.windowStart, props.nowMinute ?? 0);
    let cursor = from;
    const busy = [...occupied.map((b) => [b.start, b.end] as const), ...(props.closed ?? [])].sort((a, b) => a[0] - b[0]);
    const push = (s: number, e: number) => {
      if (e - s >= (props.minSlot ?? 25)) slots.push({ key: `f:${date}:${s}`, start: s, end: e, pick: { type: "slot", slot: { date, start: hm(s), end: hm(e), minutes: e - s } } });
    };
    for (const [s, e] of busy) {
      if (s > cursor) push(cursor, Math.min(s, props.windowEnd));
      cursor = Math.max(cursor, e);
    }
    if (cursor < props.windowEnd) push(cursor, props.windowEnd);
  }

  const boxes = layout(occupied);
  const hours: number[] = [];
  for (let h = Math.ceil(rangeStart / 60); h * 60 <= rangeEnd; h++) hours.push(h);
  const top = (m: number) => (Math.max(rangeStart, Math.min(rangeEnd, m)) - rangeStart) * ppm;

  return (
    <div className={`${styles.day}${props.hideHours ? ` ${styles.noHours}` : ""}`} style={{ height: (rangeEnd - rangeStart) * ppm }} role="group" aria-label={props.label}>
      {hours.map((h) => (
        <div key={h} className={styles.hour} style={{ top: (h * 60 - rangeStart) * ppm }} aria-hidden>
          {!props.hideHours && <span className={styles.hourLabel}>{String(h).padStart(2, "0")}</span>}
        </div>
      ))}
      {slots.map((b) => (
        <button
          key={b.key}
          type="button"
          className={`${styles.block} ${styles.slot}${props.selectedKey === b.key ? ` ${styles.selected}` : ""}`}
          style={{ top: top(b.start), height: Math.max(18, (b.end - b.start) * ppm - 2) }}
          onClick={() => props.onPick(b.pick, b.key)}
          aria-label={`空档 ${hm(b.start)} 到 ${hm(b.end)}，${b.end - b.start} 分钟${props.budgetLeft === 0 ? "，但今天的学习预算已满" : "，点这里安排"}`}
        >
          <span className={styles.slotText}>
            空档 {b.end - b.start}′{props.budgetLeft === 0 ? " · 预算已满" : ""}
          </span>
        </button>
      ))}
      {boxes.map((b) => {
        const height = Math.max(22, (b.end - b.start) * ppm - 2);
        const width = `calc((100% - var(--tl-gutter)) / ${b.cols} - 2px)`;
        const left = `calc(var(--tl-gutter) + (100% - var(--tl-gutter)) * ${b.col} / ${b.cols})`;
        if (b.pick.type === "event") {
          const e = b.pick.event;
          const tag = e.origin === "makeup" ? "补课" : e.origin === "moved" ? "调课" : KIND_TAG[e.kind];
          return (
            <button
              key={b.key}
              type="button"
              className={`${styles.block} ${styles[e.kind]}${height < 58 ? ` ${styles.compact}` : ""}${props.selectedKey === b.key ? ` ${styles.selected}` : ""}`}
              style={{ top: top(b.start), height, width, left }}
              onClick={() => props.onPick(b.pick, b.key)}
              aria-label={`${tag}：${e.title}，${hm(b.start)} 到 ${hm(b.end)}${e.location ? `，${e.location}` : ""}`}
            >
              {height >= 34 && <span className={styles.tag}>{tag}</span>}
              <span className={styles.name}>{e.kind === "course" ? e.title.split(" · ")[0] : e.title}</span>
              {height >= 44 && (
                <span className={styles.meta}>
                  {hm(b.start)}–{hm(b.end)}
                  {e.location ? ` · ${e.location}` : ""}
                </span>
              )}
            </button>
          );
        }
        if (b.pick.type !== "session") return null;
        const s = b.pick.session;
        return (
          <button
            key={b.key}
            type="button"
            className={`${styles.block} ${styles.session}${height < 58 ? ` ${styles.compact}` : ""}${s.status === "completed" ? ` ${styles.done}` : ""}${s.status === "in_progress" ? ` ${styles.live}` : ""}${props.selectedKey === b.key ? ` ${styles.selected}` : ""}`}
            style={{ top: top(b.start), height, width, left }}
            onClick={() => props.onPick(b.pick, b.key)}
            aria-label={`${STATUS_TAG[s.status] ?? "学习"}：${s.title}，${hm(b.start)} 到 ${hm(b.end)}${s.locked ? "，已锁定" : ""}`}
          >
            {height >= 34 && (
              <span className={styles.tag}>
                {STATUS_TAG[s.status] ?? "学习"}
                {s.locked ? " · 锁" : ""}
              </span>
            )}
            <span className={styles.name}>{s.title}</span>
            {height >= 44 && (
              <span className={styles.meta}>
                {hm(b.start)}–{hm(b.end)}
              </span>
            )}
          </button>
        );
      })}
      {props.nowMinute != null && props.nowMinute >= rangeStart && props.nowMinute <= rangeEnd && <div className={styles.now} style={{ top: top(props.nowMinute) }} aria-label={`现在 ${hm(props.nowMinute)}`} />}
    </div>
  );
}
