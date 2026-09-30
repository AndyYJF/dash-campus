"use client";

import { useState } from "react";
import { api, ApiError } from "./api";
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
    { key: "today", label: "今天截止" },
    { key: "upcoming", label: "临近截止" },
    { key: "this_week", label: "本周安排" },
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
            <h3 className={styles.sectionTitle}>
              {section.label}（{rows.length}）
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
                    {section.key === "overdue" && <span className={`${styles.badge} ${styles.badgeOverdue}`}>逾期</span>}{" "}
                    {task.priority === "high" && <span className={`${styles.badge} ${styles.badgeHigh}`}>高优先</span>}{" "}
                    {task.title}
                    {pendingId === task.id && <span className={styles.muted}>（提交中…）</span>}
                  </span>
                  <span className={styles.taskMeta}>
                    {task.estimateMinutes !== null ? `${task.estimateMinutes} 分钟` : "估时未知"}
                    {dueLabel(task)}
                    {task.scheduledStart && ` · 安排在 ${new Date(task.scheduledStart).toLocaleString([], { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}`}
                    {task.projectId && (
                      <>
                        {" · "}
                        <a href={`/projects/${task.projectId}`}>所属项目</a>
                      </>
                    )}
                  </span>
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

function dueLabel(task: TaskRow): string {
  if (task.due.kind === "date") return ` · ${task.due.localDate} 截止`;
  if (task.due.kind === "instant") return ` · ${new Date(task.due.at).toLocaleString()} 截止`;
  return "";
}
