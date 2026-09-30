"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError, newIdempotencyKey } from "./api";
import Link from "next/link";
import TaskForm, { mondaysFrom } from "./TaskForm";
import { formatMinutes } from "./WeekStatusStrip";
import styles from "./dash.module.css";
import type { WeekPlan } from "@/contracts/today";
import type { TaskRow } from "@/repositories/planning";

/** 计划页：周视图 + 每周重点 + 改期提案发起 */
export default function PlanView() {
  const [plan, setPlan] = useState<WeekPlan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [focusTitle, setFocusTitle] = useState("");
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const focusKey = useRef<{ title: string; key: string } | null>(null);

  const refresh = useCallback(() => {
    api<WeekPlan>("/api/v1/planning/week")
      .then((p) => {
        setPlan(p);
        setFocusTitle(p.focus?.title ?? "");
        setError(null);
      })
      .catch((e) => setError(e instanceof Error ? e.message : "加载失败"));
  }, []);

  useEffect(refresh, [refresh]);

  if (error) return (
    <p className={styles.error} role="alert">
      {error}
    </p>
  );
  if (!plan) return <p className={styles.muted}>加载中…</p>;

  const w = plan.workload;
  const capacityText = w.weekCapacityMinutes === null ? "尚未设置可用时间" : formatMinutes(w.weekCapacityMinutes);
  const over = w.weekCapacityMinutes !== null && w.committedMinutes > w.weekCapacityMinutes;

  async function saveFocus() {
    if (!focusTitle.trim()) return;
    setMessage(null);
    // 首次创建：同一标题重试复用同一个键（超时后再点不会变成 409）
    let key: string | undefined;
    if (!plan?.focus) {
      key = focusKey.current && focusKey.current.title === focusTitle.trim() ? focusKey.current.key : newIdempotencyKey();
      focusKey.current = { title: focusTitle.trim(), key };
    }
    try {
      await api("/api/v1/planning/week/focus", {
        method: "PUT",
        idempotencyKey: key,
        body: {
          localMonday: plan!.week.localMonday,
          timezone: plan!.timezone,
          title: focusTitle.trim(),
          goalId: null,
          projectId: null,
          ...(plan!.focus ? { expectedVersion: plan!.focus.version } : {}),
        },
      });
      setMessage({ ok: true, text: "本周重点已保存" });
      refresh();
    } catch (e) {
      setMessage({ ok: false, text: e instanceof ApiError ? e.message : "保存失败" });
    }
  }

  async function proposeReschedule(task: TaskRow, start: string | null, end: string | null) {
    setMessage(null);
    try {
      await api("/api/v1/proposals", {
        method: "POST",
        idempotencyKey: newIdempotencyKey(),
        body: { type: "reschedule", taskId: task.id, scheduledStart: start, scheduledEnd: end, reason: "" },
      });
      setEditing(null);
      setMessage({ ok: true, text: "改期提案已创建。确认后才会修改计划，可在今天页「需要你决定」或回顾页处理。" });
    } catch (e) {
      setMessage({ ok: false, text: e instanceof ApiError ? e.message : "创建提案失败" });
    }
  }

  return (
    <div>
      <section className={styles.card} aria-labelledby="focus-title">
        <h2 id="focus-title">本周重点（{plan.week.localMonday} 起）</h2>
        <form
          className={styles.inlineForm}
          onSubmit={(e) => {
            e.preventDefault();
            void saveFocus();
          }}
        >
          <label className="visually-hidden" htmlFor="focus-input">
            本周重点
          </label>
          <input
            id="focus-input"
            className={styles.field}
            placeholder="本周最想推进的一件事"
            value={focusTitle}
            onChange={(e) => setFocusTitle(e.target.value)}
          />
          <button type="submit" className={`${styles.btn} ${styles.btnPrimary}`}>
            保存
          </button>
        </form>
        {plan.focus && <p className={styles.muted}>最近确认：{new Date(plan.focus.confirmedAt).toLocaleString()}</p>}
      </section>

      <section className={styles.card} aria-labelledby="load-title">
        <h2 id="load-title">周负担</h2>
        <div className={styles.strip} style={{ marginBottom: 8 }}>
          <div className={styles.stripItem}>
            <span className={styles.stripLabel}>整周承诺（含已完成）</span>
            <span className={styles.stripValue}>{formatMinutes(w.committedMinutes)}</span>
            {w.committedUnknownCount > 0 && <span className={styles.stripNote}>另有 {w.committedUnknownCount} 项估时未知</span>}
          </div>
          <div className={styles.stripItem}>
            <span className={styles.stripLabel}>剩余未完成</span>
            <span className={styles.stripValue}>{formatMinutes(w.remainingKnownMinutes)}</span>
            {w.remainingUnknownCount > 0 && <span className={styles.stripNote}>另有 {w.remainingUnknownCount} 项估时未知</span>}
          </div>
          <div className={styles.stripItem}>
            <span className={styles.stripLabel}>整周可用时间</span>
            <span className={w.weekCapacityMinutes === null ? styles.stripValueText : styles.stripValue}>{capacityText}</span>
            <span className={styles.stripNote}>已预留 {w.bufferPercent}% 缓冲</span>
          </div>
        </div>
        {over && (
          <p className={`${styles.notice} ${styles.noticeError}`} role="alert">
            已知估时至少超出整周可用时间 {formatMinutes(w.committedMinutes - w.weekCapacityMinutes!)}。
          </p>
        )}
        {w.weekCapacityMinutes === null && <p className={styles.muted}>尚未设置可用时间窗口，无法判断安排是否放得下。</p>}
      </section>

      <section className={styles.card} aria-labelledby="tasks-title">
        <h2 id="tasks-title">本周任务</h2>
        {plan.tasks.length === 0 && <p className={styles.empty}>本周还没有任务。</p>}
        {plan.tasks.map((t) => (
          <div key={t.id} className={styles.taskRow} style={{ flexWrap: "wrap" }}>
            <div className={styles.taskBody}>
              <span className={styles.taskTitle}>
                <span
                  className={`${styles.badge} ${t.status === "done" ? styles.badgeOk : t.status === "blocked" ? styles.badgeHigh : ""}`}
                >
                  {TASK_STATUS[t.status]}
                </span>{" "}
                {t.title}
              </span>
              <span className={styles.taskMeta}>
                {t.estimateMinutes !== null ? `${t.estimateMinutes} 分钟` : "估时未知"}
                {t.due.kind === "date" && ` · ${t.due.localDate} 截止`}
                {t.due.kind === "instant" && ` · ${new Date(t.due.at).toLocaleString()} 截止`}
                {t.scheduledStart && ` · 安排在 ${new Date(t.scheduledStart).toLocaleString()}`}
                {t.projectId && (
                  <>
                    {" · "}
                    <Link href={`/projects/${t.projectId}`}>所属项目</Link>
                  </>
                )}
              </span>
            </div>
            {t.status !== "done" && t.status !== "cancelled" && editing !== t.id && (
              <button className={styles.btn} onClick={() => setEditing(t.id)}>
                改期
              </button>
            )}
            {editing === t.id && (
              <RescheduleForm
                task={t}
                timezone={plan.timezone}
                onCancel={() => setEditing(null)}
                onSubmit={(start, end) => proposeReschedule(t, start, end)}
              />
            )}
          </div>
        ))}
        <details className={styles.addTask}>
          <summary>添加任务</summary>
          <TaskForm
            defaultPlannedMonday={plan.week.localMonday}
            weekOptions={mondaysFrom(plan.week.localMonday)}
            timezone={plan.timezone}
            onCreated={refresh}
          />
        </details>
      </section>
      {message && (
        <p
          className={`${styles.notice} ${message.ok ? styles.noticeOk : styles.noticeError}`}
          role={message.ok ? "status" : "alert"}
        >
          {message.text}
        </p>
      )}
    </div>
  );
}

const TASK_STATUS: Record<TaskRow["status"], string> = {
  todo: "待办",
  doing: "进行中",
  blocked: "受阻",
  done: "已完成",
  cancelled: "已取消",
};

/** 实例时区下的日期+时间 → UTC ISO（服务端再校验结束晚于开始、与固定活动冲突等） */
function toInstant(date: string, time: string, tz: string): string {
  const guess = new Date(`${date}T${time}:00Z`);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(guess);
  const get = (k: string) => Number(parts.find((p) => p.type === k)!.value);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"));
  return new Date(guess.getTime() - (asUtc - guess.getTime())).toISOString();
}

function RescheduleForm({
  task,
  timezone,
  onCancel,
  onSubmit,
}: {
  task: TaskRow;
  timezone: string;
  onCancel: () => void;
  onSubmit: (start: string | null, end: string | null) => void;
}) {
  const [date, setDate] = useState("");
  const [from, setFrom] = useState("19:00");
  const [minutes, setMinutes] = useState(String(task.estimateMinutes ?? 60));
  const [err, setErr] = useState<string | null>(null);
  const id = `rs-${task.id}`;
  return (
    <form
      className={styles.subForm}
      onSubmit={(e) => {
        e.preventDefault();
        if (!date) {
          onSubmit(null, null);
          return;
        }
        const m = Number(minutes);
        if (!Number.isFinite(m) || m <= 0) {
          setErr("时长需要是正数分钟");
          return;
        }
        const start = toInstant(date, from, timezone);
        onSubmit(start, new Date(new Date(start).getTime() + m * 60_000).toISOString());
      }}
    >
      <div className={styles.formGrid}>
        <div>
          <label className={styles.label} htmlFor={`${id}-d`}>
            日期（留空为取消安排）
          </label>
          <input id={`${id}-d`} type="date" className={styles.field} value={date} onChange={(e) => setDate(e.target.value)} />
        </div>
        <div>
          <label className={styles.label} htmlFor={`${id}-t`}>
            开始时间
          </label>
          <input id={`${id}-t`} type="time" className={styles.field} value={from} onChange={(e) => setFrom(e.target.value)} />
        </div>
        <div>
          <label className={styles.label} htmlFor={`${id}-m`}>
            时长（分钟）
          </label>
          <input
            id={`${id}-m`}
            type="number"
            min={5}
            className={styles.field}
            value={minutes}
            onChange={(e) => setMinutes(e.target.value)}
          />
        </div>
      </div>
      <p className={styles.muted} style={{ marginTop: 0 }}>
        按实例时区 {timezone} 解释。生成的是提案，确认后才修改计划。
      </p>
      <div className={styles.actionsRow}>
        <button type="submit" className={`${styles.btn} ${styles.btnPrimary}`}>
          生成改期提案
        </button>
        <button type="button" className={styles.btn} onClick={onCancel}>
          取消
        </button>
      </div>
      {err && (
        <p className={styles.error} role="alert">
          {err}
        </p>
      )}
    </form>
  );
}
