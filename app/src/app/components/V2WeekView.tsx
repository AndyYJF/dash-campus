"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { api, newIdempotencyKey } from "./api";
import { compose, emitChanged, useDashRefresh } from "./dashBus";
import DayTimeline, { dayExtent, minuteOfDay, type Picked, type TimelineEvent, type TimelineSession } from "./DayTimeline";
import ItemDetail from "./ItemDetail";
import styles from "./v2.module.css";

/**
 * V2 本周页（REPAIR-PLAN §3.1）：桌面七天时间网格，手机单日时间线 + 七天切换。
 * 课程、固定活动、学习安排、空档在同一坐标里，和预算用的是同一份事实；日期头标教学周、假期、补课、待核对。
 */

type Calendar = { windowStart: string; windowEnd: string; closed: Array<[string, string]>; civilType: string; civilName: string | null; civilKnown: boolean; teachingWeek: number | null; phase: string; teachingStatus: string; teachingNote: string; schoolEvents: Array<{ kind: string; title: string }>; policyNotes: string[]; noStudy: boolean };
type Budget = { cDay: number; bDay: number; actualMinutes: number; committedFutureMinutes: number; futureCapacity: number; dailyLimit: number; source: string };
type Day = { date: string; courseMinutes: number; fixedMinutes: number; cDay: number; bDay: number; budget: Budget; calendar: Calendar; events: TimelineEvent[]; sessions: TimelineSession[] };
type Policy = {
  status: string;
  workdayStart: string;
  workdayEnd: string;
  weekendStart: string;
  weekendEnd: string;
  meals: Array<[string, string]>;
  commuteMinutes: number;
  dailyLimitMinutes: number;
  bufferPercent: number;
  rules: Array<{ id: string; kind: string; scope: string; text: string }>;
};
type Week = {
  timezone: string;
  asOf: string;
  monday: string;
  today: string;
  teachingWeek: number | null;
  days: Day[];
  weekBudget: number;
  plannedMinutes: number;
  actualMinutes: number;
  courseMinutes: number;
  policy: Policy;
  unscheduled: Array<{ taskId: string; title: string; reason: string; missingMinutes?: number }>;
  conflicts: Array<{ sessionId: string; taskId: string; reason: string }>;
};

const REASON_LABEL: Record<string, string> = {
  deadline_unfeasible: "截止前排不下",
  insufficient_capacity: "这周的学习预算不够",
  unknown_requirement: "工作量还不清楚",
  blocked_dependency: "有前置依赖",
  no_contiguous_slot: "预算够，但缺连续空档",
  needs_remaining_estimate: "投入已达估时仍未完成，需要你说一下还剩多少",
};
const CONFLICT_LABEL: Record<string, string> = { overlaps_fixed: "和课程/固定活动撞了", outside_policy: "落在你说不安排学习的时段", over_budget: "超出了当天的学习预算" };
const WEEKDAY = ["一", "二", "三", "四", "五", "六", "日"];
const toMin = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));

function addDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function useWide(): boolean {
  const [wide, setWide] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(min-width: 900px)");
    const sync = () => setWide(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);
  return wide;
}

/** 日期头的标签：教学安排与公历日类型分开写，待核对的不写成已确定 */
function dayBadges(c: Calendar): Array<{ text: string; tone: "plain" | "warn" | "ok" }> {
  const out: Array<{ text: string; tone: "plain" | "warn" | "ok" }> = [];
  if (c.civilType === "holiday") out.push({ text: c.civilName ?? "节假日", tone: "ok" });
  if (c.civilType === "adjusted_workday") out.push({ text: "调休上班", tone: "plain" });
  if (c.teachingStatus === "cancelled") out.push({ text: "停课", tone: "ok" });
  if (c.teachingStatus === "makeup") out.push({ text: "补课", tone: "plain" });
  if (c.teachingStatus === "pending") out.push({ text: "待核对", tone: "warn" });
  if (c.phase === "exam") out.push({ text: "考试周", tone: "plain" });
  if (c.noStudy) out.push({ text: "不安排", tone: "plain" });
  return out;
}

export default function V2WeekView() {
  const [week, setWeek] = useState<Week | null>(null);
  const [monday, setMonday] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [picked, setPicked] = useState<{ p: Picked; key: string; date: string } | null>(null);
  const [activeDay, setActiveDay] = useState<string | null>(null);
  const wide = useWide();

  const refresh = useCallback(() => {
    api<Week>(`/api/v2/week${monday ? `?monday=${monday}` : ""}`)
      .then((w) => {
        setWeek(w);
        setError("");
        setActiveDay((cur) => (cur && w.days.some((d) => d.date === cur) ? cur : w.days.some((d) => d.date === w.today) ? w.today : w.days[0]!.date));
      })
      .catch((e) => setError(e instanceof Error ? e.message : "加载失败"));
  }, [monday]);
  useEffect(refresh, [refresh]);
  useDashRefresh(refresh);

  const range = useMemo(() => {
    if (!week) return [8 * 60, 22 * 60] as [number, number];
    let start = Math.min(toMin(week.policy.workdayStart), toMin(week.policy.weekendStart));
    let end = Math.max(toMin(week.policy.workdayEnd), toMin(week.policy.weekendEnd));
    for (const d of week.days) {
      const ext = dayExtent(d.date, week.timezone, d.events, d.sessions);
      if (ext) {
        start = Math.min(start, ext[0]);
        end = Math.max(end, ext[1]);
      }
    }
    return [Math.floor(start / 60) * 60, Math.ceil(end / 60) * 60] as [number, number];
  }, [week]);

  const act = useCallback(
    (operation: string, args: Record<string, unknown>) =>
      api("/api/v2/actions", { method: "POST", body: { operation, args }, idempotencyKey: newIdempotencyKey() })
        .then(() => {
          emitChanged();
        })
        .catch((e) => setError(e instanceof Error ? e.message : "操作没有成功")),
    [],
  );

  if (error && !week) return <p className={styles.error}>{error}</p>;
  if (!week) return <p className={styles.muted}>加载中…</p>;

  const nowMinute = minuteOfDay(week.asOf, week.today, week.timezone);
  const isThisWeek = week.days.some((d) => d.date === week.today);
  const titleFor = (d: Day, i: number) => `周${WEEKDAY[i]} ${Number(d.date.slice(5, 7))}/${Number(d.date.slice(8, 10))}`;
  const timeline = (d: Day, i: number, opts: { hideHours?: boolean; ppm?: number }) => (
    <DayTimeline
      date={d.date}
      timezone={week.timezone}
      events={d.events}
      sessions={d.sessions}
      rangeStart={range[0]}
      rangeEnd={range[1]}
      pxPerMinute={opts.ppm}
      nowMinute={d.date === week.today ? nowMinute : null}
      past={d.date < week.today}
      windowStart={d.calendar.noStudy ? 1440 : toMin(d.calendar.windowStart)}
      windowEnd={d.calendar.noStudy ? 1440 : toMin(d.calendar.windowEnd)}
      closed={d.calendar.closed.map(([s, e]) => [toMin(s), e >= "24:00" ? 1440 : toMin(e)] as [number, number])}
      selectedKey={picked?.date === d.date ? picked.key : null}
      onPick={(p, key) => setPicked({ p, key, date: d.date })}
      label={`${titleFor(d, i)} 的时间线`}
      hideHours={opts.hideHours}
      budgetLeft={d.budget.futureCapacity}
    />
  );
  const header = (d: Day, i: number) => (
    <div className={`${styles.dayHead}${d.date === week.today ? ` ${styles.dayHeadToday}` : ""}`}>
      <span className={styles.dayName}>{titleFor(d, i)}</span>
      <span className={styles.dayBadges}>
        {dayBadges(d.calendar).map((b) => (
          <em key={b.text} className={styles.tagBadge} data-tone={b.tone}>
            {b.text}
          </em>
        ))}
      </span>
      <span className={styles.dayMeta}>
        课 {d.courseMinutes}′ · 可学 {d.cDay}′
      </span>
    </div>
  );
  const current = week.days.find((d) => d.date === activeDay) ?? week.days[0]!;
  const currentIndex = week.days.indexOf(current);
  const pickedDay = picked ? week.days.find((d) => d.date === picked.date) : undefined;
  const p = week.policy;

  return (
    <div className={styles.pageWide}>
      <section className={styles.card}>
        <div className={styles.weekBar}>
          <h2 className={styles.title}>
            {isThisWeek ? "本周" : "这一周"}
            {week.teachingWeek ? ` · 第 ${week.teachingWeek} 教学周` : ""}
            <span className={styles.titleSub}>
              {Number(week.monday.slice(5, 7))}/{Number(week.monday.slice(8, 10))}–{Number(week.days[6]!.date.slice(5, 7))}/{Number(week.days[6]!.date.slice(8, 10))}
            </span>
          </h2>
          <div className={styles.weekNav}>
            <button type="button" className={styles.btn} onClick={() => setMonday(addDays(week.monday, -7))} aria-label="上一周">
              ‹ 上一周
            </button>
            {!isThisWeek && (
              <button type="button" className={styles.btn} onClick={() => setMonday(null)}>
                回到本周
              </button>
            )}
            <button type="button" className={styles.btn} onClick={() => setMonday(addDays(week.monday, 7))} aria-label="下一周">
              下一周 ›
            </button>
          </div>
        </div>
        <div className={styles.stats}>
          <div className={styles.stat}>
            <div className={styles.statNum}>{week.courseMinutes}′</div>
            <div className={styles.statLabel}>课程占用</div>
          </div>
          <div className={styles.stat}>
            <div className={styles.statNum}>
              {week.weekBudget}′{p.status === "tentative" && <em className={styles.badge}>暂定</em>}
            </div>
            <div className={styles.statLabel}>学习预算</div>
          </div>
          <div className={styles.stat}>
            <div className={styles.statNum}>{week.plannedMinutes}′</div>
            <div className={styles.statLabel}>已排学习</div>
          </div>
          <div className={styles.stat}>
            <div className={styles.statNum}>{week.actualMinutes}′</div>
            <div className={styles.statLabel}>已记录的实际学习</div>
          </div>
        </div>
        {error && <p className={styles.error}>{error}</p>}
      </section>

      {(p.status === "tentative" || p.rules.length > 0) && (
        <section className={styles.card}>
          <h2 className={styles.title}>
            作息与规则{p.status === "tentative" && <em className={styles.badge}>暂定</em>}
          </h2>
          <p className={styles.muted}>
            工作日 {p.workdayStart}–{p.workdayEnd}、周末 {p.weekendStart}–{p.weekendEnd} 可以安排；三餐（{p.meals.map(([s, e]) => `${s}–${e}`).join("、")}）和课前后 {p.commuteMinutes} 分钟留出来；每天最多 {p.dailyLimitMinutes} 分钟，再留 {p.bufferPercent}% 机动。
          </p>
          {p.rules.length > 0 && (
            <ul className={styles.ruleList}>
              {p.rules.map((r) => (
                <li key={r.id}>
                  <span>
                    {r.text}
                    {r.scope === "temporary" && <em className={styles.tagBadge}>临时</em>}
                  </span>
                  <button type="button" className={styles.btnGhost} onClick={() => act("update_planning_policy", { revokeRuleIds: [r.id] })}>
                    撤回
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div className={styles.detailActions}>
            {p.status === "tentative" && (
              <button type="button" className={styles.btnPrimary} onClick={() => act("update_planning_policy", { confirm: true })}>
                就按这个安排
              </button>
            )}
            <button type="button" className={styles.btn} onClick={() => compose({ label: "作息与规则", text: "晚上十点后不排，工作日最多两小时" })}>
              一句话改…
            </button>
          </div>
        </section>
      )}

      {picked && pickedDay && <ItemDetail picked={picked.p} date={picked.date} timezone={week.timezone} onClose={() => setPicked(null)} teachingNote={pickedDay.calendar.teachingNote} budgetLeft={pickedDay.budget.futureCapacity} />}

      <section className={styles.card}>
        {wide ? (
          <div className={styles.grid} style={{ gridTemplateColumns: `repeat(7, minmax(0, 1fr))` }}>
            {week.days.map((d, i) => (
              <div key={d.date} className={styles.gridCol}>
                {header(d, i)}
                {d.calendar.teachingNote && <p className={styles.dayNote}>{d.calendar.teachingNote}</p>}
                {timeline(d, i, { hideHours: i > 0 })}
              </div>
            ))}
          </div>
        ) : (
          <>
            <div className={styles.dayTabs} role="tablist" aria-label="选择日期">
              {week.days.map((d, i) => (
                <button key={d.date} type="button" role="tab" aria-selected={d.date === current.date} className={`${styles.dayTab}${d.date === current.date ? ` ${styles.dayTabActive}` : ""}${d.date === week.today ? ` ${styles.dayTabToday}` : ""}`} onClick={() => setActiveDay(d.date)}>
                  <span>{WEEKDAY[i]}</span>
                  <span className={styles.dayTabDate}>{Number(d.date.slice(8, 10))}</span>
                  {(d.events.length > 0 || d.sessions.length > 0) && <span className={styles.dayTabDot} aria-hidden />}
                </button>
              ))}
            </div>
            {header(current, currentIndex)}
            {current.calendar.teachingNote && <p className={styles.dayNote}>{current.calendar.teachingNote}</p>}
            {current.calendar.policyNotes.length > 0 && <p className={styles.dayNote}>{current.calendar.policyNotes.join("；")}</p>}
            {timeline(current, currentIndex, { ppm: 1.05 })}
          </>
        )}
      </section>

      {week.conflicts.length > 0 && (
        <section className={styles.card}>
          <h2 className={styles.title}>近期安排有冲突（没有擅自改动）</h2>
          {week.conflicts.map((c) => {
            const s = week.days.flatMap((d) => d.sessions).find((x) => x.id === c.sessionId);
            return (
              <p key={c.sessionId} className={styles.question}>
                {s ? `「${s.title}」` : "一段学习安排"}
                {CONFLICT_LABEL[c.reason] ?? c.reason}。可以在上面的时间线点它挪动，或回答输入框上方的问题。
              </p>
            );
          })}
        </section>
      )}

      {week.unscheduled.length > 0 && (
        <section className={styles.card}>
          <h2 className={styles.title}>排不下的</h2>
          {week.unscheduled.map((u) => (
            <p key={u.taskId} className={styles.question}>
              {u.title} — {REASON_LABEL[u.reason] ?? u.reason}
              {u.missingMinutes ? `（缺 ${u.missingMinutes} 分钟）` : ""}
            </p>
          ))}
        </section>
      )}
    </div>
  );
}
