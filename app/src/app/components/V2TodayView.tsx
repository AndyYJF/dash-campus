"use client";

import { useCallback, useEffect, useState } from "react";
import { api, ApiError, newIdempotencyKey } from "./api";
import { emitChanged, useDashRefresh } from "./dashBus";
import DayTimeline, { dayExtent, hm, minuteOfDay, useNarrow, type Picked, type TimelineEvent, type TimelineSession } from "./DayTimeline";
import ItemDetail from "./ItemDetail";
import PendingItems, { type PendingItem } from "./PendingItems";
import styles from "./v2.module.css";

/**
 * V2 今天页（REPAIR-PLAN §3.1）：首屏回答“今天有什么课、接下来做什么、为什么这样安排”。
 * 状态带（日期/教学周、下一节课、还能安排多少、本周重点）+ 今天的时间线 + 最多 3 个下一步 + 最近变化。
 */

type Action = TimelineSession & { date: string };
type Snapshot = {
  pendingItems: PendingItem[];
  timezone: string;
  asOf: string;
  date: string;
  today: {
    courseMinutes: number;
    fixedMinutes: number;
    events: TimelineEvent[];
    sessions: TimelineSession[];
    nextClass: TimelineEvent | null;
    calendar: { windowStart: string; windowEnd: string; closed: Array<[string, string]>; civilType: string; civilName: string | null; teachingWeek: number | null; teachingStatus: string; teachingNote: string; policyNotes: string[]; noStudy: boolean; phase: string };
    budget: { cDay: number; bDay: number; actualMinutes: number; estimatedMinutes: number; provisionalMinutes: number; committedFutureMinutes: number; futureCapacity: number; dailyLimit: number; source: string };
  };
  nextActions: Action[];
  mainGoal: string | null;
  policy: { workdayStart: string; workdayEnd: string; weekendStart: string; weekendEnd: string };
  focus: { id: string; note: string; startedAt: string; version: number } | null;
  recentChanges: Array<{ batchId: string; command: string; status: string; createdAt: string }>;
};

const COMMAND_LABEL: Record<string, string> = {
  upsert_course_set: "课表更新",
  record_practice: "实践记录",
  create_or_update_task: "任务",
  plan_sessions: "学习安排调整",
  import_fixed_events: "日程导入",
  apply_event_exception: "停课",
  apply_teaching_day_override: "调课/停课",
  archive_entity: "归档",
  complete_task: "完成任务",
  pause_task: "暂停任务",
  correct_practice: "纠正记录",
  reschedule_session: "挪动学习安排",
  set_session_state: "学习块状态",
  update_planning_policy: "作息规则",
  sync_holiday_calendar: "节假日安排",
  upsert_academic_calendar: "校历",
  update_calendar_sync_policy: "日历自动更新",
  update_reminder_policy: "提醒设置",
  update_digest_policy: "摘要设置",
  update_profile_fact: "身份信息",
  upsert_notice_rule: "通知筛选",
  apply_notice: "通知",
  resolve_notice: "通知归类",
  upsert_goal: "目标",
  select_candidate: "开始项目",
  update_project_state: "项目状态",
  link_resource: "资料",
  update_direction_profile: "阶段与去向",
  upsert_direction_track: "关注方向",
  update_roadmap_item: "阶段项",
  link_direction_project: "项目关联方向",
  record_direction_reflection: "实践感受",
};
const WEEKDAY = "日一二三四五六";
const toMin = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));

function dateTitle(date: string): string {
  const d = new Date(`${date}T12:00:00Z`);
  return `${d.getUTCMonth() + 1}月${d.getUTCDate()}日 周${WEEKDAY[d.getUTCDay()]}`;
}

export default function V2TodayView() {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [error, setError] = useState("");
  const [picked, setPicked] = useState<{ p: Picked; key: string; date: string } | null>(null);
  const [timerNote, setTimerNote] = useState("");
  const [confirm, setConfirm] = useState<{ minutes: number; reason: string } | null>(null);
  const [fixMinutes, setFixMinutes] = useState("");
  const [merged, setMerged] = useState<{ focusId: string; note: string } | null>(null);
  const narrow = useNarrow();

  const refresh = useCallback(() => {
    api<Snapshot>("/api/v2/dashboard")
      .then((s) => {
        setSnap(s);
        setError("");
      })
      .catch((e) => setError(e instanceof Error ? e.message : "加载失败"));
  }, []);
  useEffect(refresh, [refresh]);
  useDashRefresh(refresh);

  const post = useCallback(async (path: string, body: unknown) => {
    await api(path, { method: "POST", body, idempotencyKey: newIdempotencyKey() });
    emitChanged();
  }, []);

  async function stopTimer(extra: Record<string, unknown> = {}) {
    if (!snap?.focus) return;
    try {
      const r = await api<{ merged?: boolean; mergedNote?: string | null; focusId: string }>(`/api/v2/focus/${snap.focus.id}/stop`, { method: "POST", body: { expectedVersion: snap.focus.version, ...extra }, idempotencyKey: newIdempotencyKey() });
      setConfirm(null);
      setFixMinutes("");
      setMerged(r.merged && r.mergedNote ? { focusId: r.focusId, note: r.mergedNote } : null);
      emitChanged();
    } catch (e) {
      if (e instanceof ApiError && e.code === "NEEDS_CONFIRMATION") {
        const m = /共 (\d+) 分钟，(.+?)。/.exec(e.message);
        setConfirm({ minutes: m ? Number(m[1]) : 0, reason: m ? m[2]! : "时间很长" });
      } else setError(e instanceof Error ? e.message : "停止失败");
    }
  }

  if (error && !snap) return <p className={styles.error}>{error}</p>;
  if (!snap) return <p className={styles.muted}>加载中…</p>;
  const t = snap.today;
  const b = t.budget;
  const tz = snap.timezone;
  const nowMinute = minuteOfDay(snap.asOf, snap.date, tz);
  const win: [number, number] = [toMin(t.calendar.windowStart), toMin(t.calendar.windowEnd)];
  const ext = dayExtent(snap.date, tz, t.events, t.sessions);
  const range: [number, number] = [Math.floor(Math.min(win[0], ext?.[0] ?? win[0]) / 60) * 60, Math.ceil(Math.max(win[1], ext?.[1] ?? win[1]) / 60) * 60];
  const next = t.nextClass;
  const label = (iso: string, date: string) => hm(minuteOfDay(iso, date, tz));
  const badges = [t.calendar.civilType === "holiday" ? (t.calendar.civilName ?? "节假日") : "", t.calendar.civilType === "adjusted_workday" ? "调休上班" : "", t.calendar.teachingStatus === "cancelled" ? "停课" : "", t.calendar.teachingStatus === "makeup" ? "补课" : "", t.calendar.teachingStatus === "pending" ? "教学安排待核对" : "", t.calendar.phase === "exam" ? "考试周" : ""].filter(Boolean);

  return (
    <div className={styles.pageWide} data-page="today">
      <header className={styles.mast}>
        <p className={styles.kicker}>
          {t.calendar.teachingWeek ? <span>第 {t.calendar.teachingWeek} 教学周</span> : <span>今天</span>}
          {badges.map((x) => (
            <em key={x} className={styles.tagBadge} data-tone={x.includes("待核对") ? "warn" : "plain"}>
              {x}
            </em>
          ))}
        </p>
        <h1 className={styles.mastTitle}>{dateTitle(snap.date)}</h1>
        <p className={styles.lede}>
          {next
            ? `下一节课：${next.title.split(" · ")[0]}，${label(next.startUtc, snap.date)}–${label(next.endUtc, snap.date)}${next.location ? `，${next.location}` : ""}。`
            : t.courseMinutes > 0
              ? "今天的课上完了。"
              : "今天没有课。"}
        </p>
        <dl className={styles.stats}>
          <div className={styles.stat} data-lead="true">
            <dd className={styles.statNum}>
              {b.futureCapacity}
              <span className={styles.unit}>分钟</span>
              {b.source === "tentative" && <em className={styles.badge}>暂定</em>}
            </dd>
            <dt className={styles.statLabel}>今天还能新排的学习（上限 {b.dailyLimit}）</dt>
          </div>
          <div className={styles.stat}>
            <dd className={styles.statNum}>
              {b.actualMinutes}
              <span className={styles.unit}>分钟</span>
            </dd>
            <dt className={styles.statLabel}>
              已记录的实际学习
              {b.estimatedMinutes + b.provisionalMinutes > 0 ? `，另有 ${b.estimatedMinutes + b.provisionalMinutes} 按计划暂扣` : ""}
            </dt>
          </div>
          <div className={styles.stat}>
            <dd className={styles.statNum}>
              {t.courseMinutes}
              <span className={styles.unit}>分钟</span>
            </dd>
            <dt className={styles.statLabel}>今天的课程{t.fixedMinutes > 0 ? `，另有固定活动 ${t.fixedMinutes}` : ""}</dt>
          </div>
          <div className={styles.stat}>
            <dd className={styles.statText}>{snap.mainGoal ?? "还没定"}</dd>
            <dt className={styles.statLabel}>当前主要方向</dt>
          </div>
        </dl>
        {[t.calendar.teachingNote, ...t.calendar.policyNotes].filter(Boolean).map((n) => (
          <p key={n} className={styles.note}>
            {n}
          </p>
        ))}
        {b.source === "tentative" && <p className={styles.note}>上面的容量按暂定作息估算；到「本周」页看具体内容，确认或一句话修改。</p>}
        {error && <p className={styles.error}>{error}</p>}
      </header>

      {picked && <ItemDetail picked={picked.p} date={picked.date} timezone={tz} onClose={() => setPicked(null)} teachingNote={t.calendar.teachingNote} budgetLeft={picked.date === snap.date ? b.futureCapacity : undefined} />}

      <div className={styles.columns}>
        <section className={`${styles.card} ${styles.colMain}`}>
          <h2 className={styles.title}>时间线</h2>
          <DayTimeline
            date={snap.date}
            timezone={tz}
            events={t.events}
            sessions={t.sessions}
            rangeStart={range[0]}
            rangeEnd={range[1]}
            pxPerMinute={narrow ? 1.35 : 0.95}
            nowMinute={nowMinute}
            windowStart={t.calendar.noStudy ? 1440 : win[0]}
            windowEnd={t.calendar.noStudy ? 1440 : win[1]}
            closed={t.calendar.closed.map(([s, e]) => [toMin(s), e >= "24:00" ? 1440 : toMin(e)] as [number, number])}
            selectedKey={picked?.key ?? null}
            onPick={(p, key) => setPicked({ p, key, date: snap.date })}
            budgetLeft={b.futureCapacity}
            label="今天的时间线"
          />
        </section>

        <div className={styles.side}>
          <section className={`${styles.card} ${styles.steps}`}>
            <h2 className={styles.title}>下一步</h2>
            {snap.nextActions.length === 0 && <p className={styles.muted}>今天无需额外安排。想做点什么，在底部说一句。</p>}
            {snap.nextActions.map((a) => (
              <div key={a.id} className={styles.action}>
                <div className={styles.actionHead}>
                  <span className={styles.time}>
                    {a.date === snap.date ? "" : `${Number(a.date.slice(5, 7))}/${Number(a.date.slice(8, 10))} `}
                    {label(a.startUtc, a.date)}–{label(a.endUtc, a.date)}
                  </span>
                  <span className={styles.sessionTitle}>{a.title}</span>
                </div>
                {a.reason && <p className={styles.why}>{a.reason}</p>}
                <div className={styles.detailActions}>
                  {a.status === "in_progress" ? (
                    <button type="button" className={styles.btnPrimary} onClick={() => post(`/api/v2/sessions/${a.id}/complete`, { expectedVersion: a.version }).catch((e) => setError(e instanceof Error ? e.message : "操作失败"))}>
                      这一段完成
                    </button>
                  ) : (
                    <button type="button" className={styles.btnPrimary} onClick={() => post("/api/v2/focus", { sessionId: a.id }).catch(() => post(`/api/v2/sessions/${a.id}/start`, { expectedVersion: a.version }).catch((e) => setError(e instanceof Error ? e.message : "操作失败")))}>
                      开始
                    </button>
                  )}
                  <button type="button" className={styles.btn} onClick={() => post(`/api/v2/sessions/${a.id}/skip`, { expectedVersion: a.version }).catch((e) => setError(e instanceof Error ? e.message : "操作失败"))}>
                    稍后再排
                  </button>
                  <button type="button" className={styles.btnGhost} onClick={() => setPicked({ p: { type: "session", session: a }, key: `s:${a.id}`, date: a.date })}>
                    更多
                  </button>
                </div>
              </div>
            ))}
          </section>

          <PendingItems items={snap.pendingItems} timezone={snap.timezone} />

          <section className={styles.card}>
            <h2 className={styles.title}>计时</h2>
            {snap.focus ? (
              <>
                <div className={styles.session}>
                  <span className={`${styles.sessionTitle} ${styles.live}`}>
                    <span className={styles.liveDot} aria-hidden />
                    计时中：{snap.focus.note || "未命名"}
                  </span>
                  <span className={styles.time}>开始于 {label(snap.focus.startedAt, snap.date)}</span>
                </div>
                {confirm ? (
                  <div className={styles.confirmBox}>
                    <p className={styles.muted}>
                      这次计时共 {confirm.minutes} 分钟，{confirm.reason}。按多少计入？
                    </p>
                    <div className={styles.detailActions}>
                      <button type="button" className={styles.btn} onClick={() => stopTimer({ confirm: true })}>
                        就按 {confirm.minutes} 分钟
                      </button>
                      <label className={styles.inlineField}>
                        改成
                        <input inputMode="numeric" value={fixMinutes} onChange={(e) => setFixMinutes(e.target.value.replace(/\D/g, "").slice(0, 4))} aria-label="实际分钟" />
                        分钟
                      </label>
                      <button type="button" className={styles.btn} disabled={!fixMinutes} onClick={() => stopTimer({ minutes: Number(fixMinutes) })}>
                        按这个计入
                      </button>
                      <button type="button" className={styles.btnGhost} onClick={() => stopTimer({ discard: true })}>
                        放弃这次计时
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className={styles.detailActions}>
                    <button type="button" className={styles.btnPrimary} onClick={() => stopTimer()}>
                      停止并计入
                    </button>
                  </div>
                )}
              </>
            ) : (
              <form
                className={styles.timerForm}
                onSubmit={(e) => {
                  e.preventDefault();
                  // 没填做什么就不启动：取消输入不会误开计时
                  if (!timerNote.trim()) return;
                  post("/api/v2/focus", { note: timerNote.trim() })
                    .then(() => setTimerNote(""))
                    .catch((err) => setError(err instanceof Error ? err.message : "启动失败"));
                }}
              >
                <input value={timerNote} onChange={(e) => setTimerNote(e.target.value)} placeholder="计时做什么？（如：学数学）" maxLength={200} aria-label="计时做什么" />
                <button type="submit" className={styles.btn} disabled={!timerNote.trim()}>
                  开始计时
                </button>
              </form>
            )}
            {merged && (
              <p className={styles.muted}>
                已和今天手动记的「{merged.note}」算作同一次。
                <button type="button" className={styles.linkBtn} onClick={() => post(`/api/v2/focus/${merged.focusId}/split`, { expectedVersion: 1 }).then(() => setMerged(null)).catch((e) => setError(e instanceof Error ? e.message : "操作失败"))}>
                  不是同一次，分开记
                </button>
              </p>
            )}
          </section>

          {snap.recentChanges.length > 0 && (
            <section className={styles.card}>
              <h2 className={styles.title}>最近变化</h2>
              {snap.recentChanges.map((c) => (
                <div key={c.batchId} className={styles.changeRow}>
                  <span>
                    {COMMAND_LABEL[c.command] ?? c.command} · {c.status === "undone" ? "已撤销" : "已生效"}
                  </span>
                  {c.status === "applied" && c.command !== "plan_sessions" && (
                    <button type="button" className={styles.linkBtn} onClick={() => post(`/api/v2/actions/${c.batchId}/undo`, { expectedVersion: 1 }).catch((e) => setError(e instanceof Error ? e.message : "撤销失败"))}>
                      撤销
                    </button>
                  )}
                </div>
              ))}
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
