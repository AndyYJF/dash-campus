"use client";

import { useCallback, useEffect, useState } from "react";
import { api, newIdempotencyKey } from "./api";
import styles from "./v2.module.css";

/** V2 今天页（MASTER-PLAN §1/§8）：课程占用、预算账本、今日学习块、待答问题、最近变化。 */

type Session = { id: string; title: string; startUtc: string; endUtc: string; minutes: number; status: string; locked: boolean; version: number };
type Snapshot = {
  date: string;
  today: {
    courseMinutes: number;
    sessions: Session[];
    budget: { cDay: number; bDay: number; futureBudget: number; futureCapacity: number; source: string };
  };
  questions: Array<{ id: string; prompt: string }>;
  recentChanges: Array<{ batchId: string; command: string; status: string; createdAt: string }>;
};

const COMMAND_LABEL: Record<string, string> = {
  upsert_course_set: "课表更新",
  record_practice: "实践记录",
  create_or_update_task: "任务创建",
  plan_sessions: "学习安排",
};

function hm(utc: string): string {
  return new Date(utc).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
}

export default function V2TodayView() {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [error, setError] = useState("");

  const refresh = useCallback(() => {
    api<Snapshot>("/api/v2/dashboard").then(setSnap).catch((e) => setError(e instanceof Error ? e.message : "加载失败"));
  }, []);
  useEffect(refresh, [refresh]);

  const act = useCallback(
    (s: Session, action: string) => {
      api(`/api/v2/sessions/${s.id}/${action}`, { method: "POST", body: { expectedVersion: s.version }, idempotencyKey: newIdempotencyKey() })
        .then(refresh)
        .catch((e) => setError(e instanceof Error ? e.message : "操作失败"));
    },
    [refresh],
  );

  if (error) return <p className={styles.error}>{error}</p>;
  if (!snap) return <p className={styles.muted}>加载中…</p>;
  const b = snap.today.budget;
  const actionable = snap.today.sessions.filter((s) => ["planned", "in_progress"].includes(s.status));

  return (
    <div className={styles.page}>
      <section className={styles.card}>
        <h2 className={styles.title}>今天 {snap.date}</h2>
        <div className={styles.strip}>
          <span>课程占用 {snap.today.courseMinutes} 分钟</span>
          <span>今日容量 {b.cDay} 分钟{b.source === "tentative" && <em className={styles.badge}>暂定</em>}</span>
          <span>已用 {b.bDay} 分钟</span>
          <span>还可安排 {b.futureCapacity} 分钟</span>
        </div>
        {b.source === "tentative" && (
          <p className={styles.muted}>容量按默认作息模板估算。到「本周」页一句话确认后转为正式。</p>
        )}
      </section>

      <section className={styles.card}>
        <h2 className={styles.title}>学习块</h2>
        {actionable.length === 0 && <p className={styles.muted}>今天还没有安排学习块。投一条任务或等每日计划维护。</p>}
        {actionable.map((s) => (
          <div key={s.id} className={styles.session}>
            <span className={styles.time}>{hm(s.startUtc)}–{hm(s.endUtc)}</span>
            <span className={styles.sessionTitle}>{s.title}</span>
            <span className={styles.muted}>{s.minutes} 分钟</span>
            {s.status === "planned" && <button onClick={() => act(s, "start")}>开始</button>}
            {s.status === "in_progress" && <button onClick={() => act(s, "complete")}>完成</button>}
            <button className={styles.ghost} onClick={() => act(s, "skip")}>跳过</button>
          </div>
        ))}
      </section>

      {snap.questions.length > 0 && (
        <section className={styles.card}>
          <h2 className={styles.title}>需要你回答</h2>
          {snap.questions.map((q) => (
            <p key={q.id} className={styles.question}>{q.prompt}</p>
          ))}
        </section>
      )}

      {snap.recentChanges.length > 0 && (
        <section className={styles.card}>
          <h2 className={styles.title}>最近变化</h2>
          {snap.recentChanges.map((c) => (
            <p key={c.batchId} className={styles.muted}>
              {COMMAND_LABEL[c.command] ?? c.command} · {c.status === "undone" ? "已撤销" : "已生效"}
            </p>
          ))}
        </section>
      )}
    </div>
  );
}
