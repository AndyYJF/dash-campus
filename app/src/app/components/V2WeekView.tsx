"use client";

import { useCallback, useEffect, useState } from "react";
import { api, newIdempotencyKey } from "./api";
import styles from "./v2.module.css";

/** V2 本周页：7 天课程/容量/学习块、未排原因、偏好一句话确认。 */

type Day = { date: string; courseMinutes: number; cDay: number; bDay: number; sessions: Array<{ id: string; title: string; startUtc: string; minutes: number; status: string }> };
type Week = {
  monday: string;
  days: Day[];
  weekBudget: number;
  unscheduled: Array<{ taskId: string; title: string; reason: string }>;
  source: string;
};

const REASON_LABEL: Record<string, string> = {
  deadline_unfeasible: "截止前排不下",
  insufficient_capacity: "容量不足",
  unknown_requirement: "工作量未知",
  blocked_dependency: "有前置依赖",
};
const WEEKDAY = ["一", "二", "三", "四", "五", "六", "日"];

function hm(utc: string): string {
  return new Date(utc).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
}

export default function V2WeekView() {
  const [week, setWeek] = useState<Week | null>(null);
  const [error, setError] = useState("");

  const refresh = useCallback(() => {
    api<Week>("/api/v2/week").then(setWeek).catch((e) => setError(e instanceof Error ? e.message : "加载失败"));
  }, []);
  useEffect(refresh, [refresh]);

  const confirm = useCallback(() => {
    api("/api/v2/preferences/confirm", { method: "POST", body: {}, idempotencyKey: newIdempotencyKey() })
      .then(refresh)
      .catch((e) => setError(e instanceof Error ? e.message : "确认失败"));
  }, [refresh]);

  if (error) return <p className={styles.error}>{error}</p>;
  if (!week) return <p className={styles.muted}>加载中…</p>;

  return (
    <div className={styles.page}>
      <section className={styles.card}>
        <h2 className={styles.title}>本周（{week.monday} 起）</h2>
        <div className={styles.strip}>
          <span>本周学习预算 {week.weekBudget} 分钟{week.source === "tentative" && <em className={styles.badge}>暂定</em>}</span>
          {week.source === "tentative" && <button onClick={confirm}>作息就这样，确认</button>}
        </div>
      </section>

      <section className={styles.card}>
        {week.days.map((d, i) => (
          <div key={d.date} className={styles.dayRow}>
            <span className={styles.dayLabel}>周{WEEKDAY[i]} {d.date.slice(5)}</span>
            <span className={styles.muted}>课 {d.courseMinutes}′ · 容量 {d.cDay}′ · 已用 {d.bDay}′</span>
            <span className={styles.daySessions}>
              {d.sessions.filter((s) => ["planned", "in_progress"].includes(s.status)).map((s) => (
                <span key={s.id} className={styles.chip}>{hm(s.startUtc)} {s.title} {s.minutes}′</span>
              ))}
            </span>
          </div>
        ))}
      </section>

      {week.unscheduled.length > 0 && (
        <section className={styles.card}>
          <h2 className={styles.title}>排不下的</h2>
          {week.unscheduled.map((u) => (
            <p key={u.taskId} className={styles.question}>
              {u.title} — {REASON_LABEL[u.reason] ?? u.reason}
            </p>
          ))}
        </section>
      )}
    </div>
  );
}
