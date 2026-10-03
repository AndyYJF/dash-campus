"use client";
import { useState } from "react";
import { api, ApiError } from "./api";
import TaskEditor, { TASK_STATUS } from "./TaskEditor";
import { TaskMeta } from "./TaskList";
import styles from "./dash.module.css";
import type { TaskRow } from "@/repositories/planning";

export default function ManagedTasks({ tasks, timezone, onChanged }: { tasks: TaskRow[]; timezone: string; onChanged: () => void }) {
  const [editing, setEditing] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  async function complete(task: TaskRow) {
    setBusy(task.id); setError("");
    try { await api(`/api/v1/tasks/${task.id}`, { method: "PATCH", body: { expectedVersion: task.version, status: task.status === "done" ? "todo" : "done" } }); onChanged(); }
    catch (e) {
      if (e instanceof ApiError && ["FIXED_EVENT_CONFLICT", "TASK_TIME_CONFLICT", "OUTSIDE_AVAILABILITY"].includes(e.code)) {
        setEditing(task.id);
        setError(`${e.message}。重开后需要重新核对排程；请在编辑表单中调整时段，或填写人工覆盖原因后保存。`);
      } else setError(e instanceof Error ? e.message : "更新失败");
    } finally { setBusy(null); }
  }
  return <div>
    {error && <p className={styles.error} role="alert">{error}</p>}
    {tasks.map((t) => <div key={t.id} className={`${styles.taskRow} ${styles.taskRowWrap}`}>
      <div className={styles.taskBody}><span className={styles.taskTitle}>{t.title} <span className={styles.badge}>{TASK_STATUS[t.status]}</span></span><TaskMeta task={t} />{t.planningOverrideReason && <p className={styles.muted}>人工覆盖：{t.planningOverrideReason}</p>}</div>
      <div className={styles.actionsRow}><button className={`${styles.btn} ${styles.btnGhost}`} onClick={() => setEditing(editing === t.id ? null : t.id)}>编辑 / 安排</button>{t.status !== "cancelled" && <button className={styles.btn} disabled={busy === t.id} onClick={() => void complete(t)}>{t.status === "done" ? "重新打开" : "完成"}</button>}</div>
      {editing === t.id && <TaskEditor key={`${t.id}:${t.version}`} task={t} timezone={timezone} onSaved={() => { setEditing(null); setError(""); onChanged(); }} onCancel={() => setEditing(null)} />}
    </div>)}
  </div>;
}
