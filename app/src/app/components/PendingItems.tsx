"use client";

import { useState } from "react";
import { compose } from "./dashBus";
import { TASK_KIND_LABEL, type ResolvedTaskKind } from "@/domain/task-admission";
import styles from "./v2.module.css";

export type PendingItem = { taskId: string; title: string; kind: ResolvedTaskKind; reason: string; dueLocalDate: string | null; dueAt: string | null };

export default function PendingItems({ items, timezone }: { items: PendingItem[]; timezone: string }) {
  const [expanded, setExpanded] = useState(false);
  if (!items.length) return null;
  const visible = expanded ? items : items.slice(0, 5);
  return (
    <section className={styles.card}>
      <h2 className={styles.title}>待处理 <span className={styles.muted}>({items.length})</span></h2>
      <p className={styles.muted}>通知、决策与日常待办保留在这里，不自动占用学习时间。</p>
      {visible.map((item) => (
        <div key={item.taskId} className={styles.action}>
          <p className={styles.sessionTitle}>{item.title}</p>
          <p className={styles.why}>{TASK_KIND_LABEL[item.kind]} · {item.reason}</p>
          {(item.dueAt || item.dueLocalDate) && <p className={styles.muted}>截止：{item.dueAt ? new Intl.DateTimeFormat("zh-CN", { timeZone: timezone, month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(item.dueAt)) : item.dueLocalDate}</p>}
          <div className={styles.detailActions}>
            <button type="button" className={styles.btn} onClick={() => compose({ label: item.title, selectedEntityRef: { kind: "task", id: item.taskId }, command: "study", text: "" })}>作为学习任务</button>
            <button type="button" className={styles.btnGhost} onClick={() => compose({ label: item.title, selectedEntityRef: { kind: "task", id: item.taskId }, command: "process", text: "" })}>告诉 Agent 怎么处理</button>
          </div>
        </div>
      ))}
      {items.length > 5 && <button type="button" className={styles.btnGhost} onClick={() => setExpanded(!expanded)}>{expanded ? "收起" : `查看全部 ${items.length} 项`}</button>}
    </section>
  );
}
