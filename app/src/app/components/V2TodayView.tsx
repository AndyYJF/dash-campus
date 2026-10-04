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
  focus: { id: string; note: string; startedAt: string; version: number } | null;
  recentChanges: Array<{ batchId: string; command: string; status: string; createdAt: string }>;
};

const COMMAND_LABEL: Record<string, string> = {
  upsert_course_set: "课表更新",
  record_practice: "实践记录",
  create_or_update_task: "任务创建",
  plan_sessions: "学习安排",
  import_fixed_events: "日程导入",
  apply_event_exception: "停课例外",
  archive_entity: "归档",
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
        <div className={styles.stats}>
          <div className={styles.stat}>
            <div className={styles.statNum}>{snap.today.courseMinutes}′</div>
            <div className={styles.statLabel}>课程占用</div>
          </div>
          <div className={styles.stat}>
            <div className={styles.statNum}>
              {b.cDay}′{b.source === "tentative" && <em className={styles.badge}>暂定</em>}
            </div>
            <div className={styles.statLabel}>今日容量</div>
          </div>
          <div className={styles.stat}>
            <div className={styles.statNum}>{b.bDay}′</div>
            <div className={styles.statLabel}>已用</div>
          </div>
          <div className={styles.stat}>
            <div className={styles.statNum}>{b.futureCapacity}′</div>
            <div className={styles.statLabel}>还可安排</div>
          </div>
        </div>
        {b.source === "tentative" && (
          <p className={styles.muted}>容量按默认作息模板估算。到「本周」页一句话确认后转为正式。</p>
        )}
      </section>

      <section className={styles.card}>
        <h2 className={styles.title}>计时</h2>
        {snap.focus ? (
          <div className={styles.session}>
            <span className={`${styles.sessionTitle} ${styles.live}`}>
              <span className={styles.liveDot} aria-hidden />
              计时中：{snap.focus.note || "未命名"}
            </span>
            <span className={styles.time}>开始于 {hm(snap.focus.startedAt)}</span>
            <button
              className={styles.btnPrimary}
              onClick={() =>
                api(`/api/v2/focus/${snap.focus!.id}/stop`, { method: "POST", body: { expectedVersion: snap.focus!.version }, idempotencyKey: newIdempotencyKey() })
                  .then(refresh)
                  .catch((e) => setError(e instanceof Error ? e.message : "停止失败"))
              }
            >
              停止并计入
            </button>
          </div>
        ) : (
          <button
            className={styles.btnPrimary}
            onClick={() => {
              const note = window.prompt("计时做什么？（如：学数学）") ?? "";
              api("/api/v2/focus", { method: "POST", body: { note }, idempotencyKey: newIdempotencyKey() })
                .then(refresh)
                .catch((e) => setError(e instanceof Error ? e.message : "启动失败"));
            }}
          >
            开始计时
          </button>
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
            {s.status === "planned" && <button className={styles.btnPrimary} onClick={() => act(s, "start")}>开始</button>}
            {s.status === "in_progress" && <button className={styles.btnPrimary} onClick={() => act(s, "complete")}>完成</button>}
            <button className={styles.btnGhost} onClick={() => act(s, "skip")}>跳过</button>
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
