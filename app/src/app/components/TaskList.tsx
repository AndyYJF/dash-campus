"use client";

import { useState } from "react";
import { api, ApiError } from "./api";
import Icon from "./Icon";
import styles from "./dash.module.css";
import type { TaskRow } from "@/repositories/planning";
import type { TodaySummary } from "@/contracts/today";

/** TaskList/TaskRow：分组展示 + 行内完成（pending→失败保留原状，成功后刷新） */

export default function TaskList({
  actions,
  onChanged,
}: {
  actions: TodaySummary["actions"];
  onChanged: () => void;
}) {
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const sections: Array<{ key: string; label: string }> = [
    { key: "overdue", label: "已逾期" },
    { key: "today", label: "今天" },
    { key: "upcoming", label: "未来七天" },
    { key: "this_week", label: "本周未定时" },
  ];

  async function complete(task: TaskRow) {
    setPendingId(task.id);
    setError(null);
    try {
      await api(`/api/v1/tasks/${task.id}`, {
        method: "PATCH",
        body: { expectedVersion: task.version, status: "done" },
      });
      onChanged();
    } catch (e) {
      setError(e instanceof ApiError ? `${e.code}: ${e.message}` : "提交失败，状态未变更");
    } finally {
      setPendingId(null);
    }
  }

  return (
    <div>
      {sections.map((section) => {
        const rows = actions.filter((a) => a.section === section.key);
        if (rows.length === 0) return null;
        return (
          <div key={section.key}>
            <h3 className={section.key === "overdue" ? `${styles.sectionTitle} ${styles.sectionDanger}` : styles.sectionTitle}>
              {section.label}
              <span className={styles.sectionCount}>{rows.length}</span>
            </h3>
            {rows.map(({ task }) => (
              <div key={task.id} className={styles.taskRow}>
                <input
                  type="checkbox"
                  id={`done-${task.id}`}
                  aria-label={`完成「${task.title}」`}
                  disabled={pendingId === task.id}
                  checked={false}
                  onChange={() => complete(task)}
                />
                <div className={styles.taskBody}>
                  <span className={styles.taskTitle}>
                    {task.title}{" "}
                    {section.key === "overdue" && <span className={`${styles.badge} ${styles.badgeOverdue}`}>逾期</span>}{" "}
                    {task.priority === "high" && <span className={`${styles.badge} ${styles.badgeHigh}`}>高优先</span>}
                    {pendingId === task.id && <span className={styles.muted}>（提交中…）</span>}
                  </span>
                  <TaskMeta task={task} overdue={section.key === "overdue"} />
                </div>
              </div>
            ))}
          </div>
        );
      })}
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

/** 任务元信息：估时、截止、安排时段、所属项目（今天页与计划页共用） */
export function TaskMeta({ task, overdue = false }: { task: TaskRow; overdue?: boolean }) {
  const due = dueLabel(task);
  return (
    <span className={styles.metaRow}>
      <span className={styles.metaItem}>
        <Icon name="hourglass" size={14} />
        {task.estimateMinutes !== null ? `${task.estimateMinutes} 分钟` : "估时未知"}
      </span>
      {due && (
        <span className={overdue ? `${styles.metaItem} ${styles.metaDanger}` : styles.metaItem}>
          <Icon name="flag" size={14} />
          {due}
        </span>
      )}
      {task.scheduledStart && (
        <span className={styles.metaItem}>
          <Icon name="calendar" size={14} />
          安排在 {new Date(task.scheduledStart).toLocaleString([], { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}
        </span>
      )}
      {task.projectId && (
        <span className={styles.metaItem}>
          <Icon name="folder" size={14} />
          <a href={`/projects/${task.projectId}`}>所属项目</a>
        </span>
      )}
    </span>
  );
}

function dueLabel(task: TaskRow): string {
  if (task.due.kind === "date") return `${task.due.localDate} 截止`;
  if (task.due.kind === "instant") {
    return `${new Date(task.due.at).toLocaleString([], { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })} 截止`;
  }
  return "";
}
