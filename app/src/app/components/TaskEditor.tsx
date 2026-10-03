"use client";

import { useEffect, useRef, useState } from "react";
import { api, newIdempotencyKey } from "./api";
import { useDraft } from "./useDraft";
import styles from "./dash.module.css";
import type { TaskRow, GoalRow, ProjectRow } from "@/repositories/planning";
import type { Due } from "@/contracts/planning";

export function localInput(instant: string | null, timezone: string) {
  if (!instant) return "";
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).formatToParts(new Date(instant));
  const p = (key: string) => parts.find((part) => part.type === key)?.value;
  return `${p("year")}-${p("month")}-${p("day")}T${p("hour")}:${p("minute")}`;
}

export function monday(date: string) {
  if (!date) return "";
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - (d.getUTCDay() + 6) % 7);
  return d.toISOString().slice(0, 10);
}

export default function TaskEditor({ task, timezone, projectId = null, plannedMonday = "", onSaved, onCancel }: {
  task?: TaskRow; timezone: string; projectId?: string | null; plannedMonday?: string;
  onSaved: () => void; onCancel?: () => void;
}) {
  const { value: v, update, clear, restored, persisted } = useDraft(`task-v2:${task ? `${task.id}:${task.version}` : `${projectId ?? "general"}:${plannedMonday}`}`, {
    title: task?.title ?? "", description: task?.description ?? "", projectId: task?.projectId ?? projectId ?? "",
    goalId: task?.goalId ?? "", status: task?.status ?? "todo", priority: task?.priority ?? "normal",
    estimate: task?.estimateMinutes?.toString() ?? "", week: task?.plannedWeek?.localMonday ?? plannedMonday,
    start: localInput(task?.scheduledStart ?? null, timezone), end: localInput(task?.scheduledEnd ?? null, timezone),
    dueKind: task?.due.kind ?? "none", dueDate: task?.due.kind === "date" ? task.due.localDate : "",
    dueInstant: localInput(task?.due.kind === "instant" ? task.due.at : null, timezone),
    lead: task?.reminderLeadMinutes?.toString() ?? "", override: "",
  });
  const [goals, setGoals] = useState<GoalRow[]>([]);
  const [projects, setProjects] = useState<ProjectRow[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const request = useRef<{ body: string; key: string } | null>(null);
  useEffect(() => {
    Promise.all([api<{ goals: GoalRow[] }>("/api/v1/goals"), api<{ projects: ProjectRow[] }>("/api/v1/projects")])
      .then(([g, p]) => { setGoals(g.goals); setProjects(p.projects); }).catch((e) => setError(e.message));
  }, []);
  async function instant(input: string) {
    if (!input) return null;
    const [date, time] = input.split("T");
    return (await api<{ instant: string }>(`/api/v1/planning/resolve-time?date=${date}&time=${time}&timezone=${encodeURIComponent(timezone)}`)).instant;
  }
  async function save() {
    setBusy(true); setError("");
    try {
      const [scheduledStart, scheduledEnd, dueAt] = await Promise.all([instant(v.start), instant(v.end), v.dueKind === "instant" ? instant(v.dueInstant) : Promise.resolve(null)]);
      let due: Due = { kind: "none" };
      if (v.dueKind === "date") due = { kind: "date", localDate: v.dueDate, timezone };
      if (v.dueKind === "instant") {
        if (!dueAt) throw new Error("请填写截止时刻");
        due = { kind: "instant", at: dueAt, timezone };
      }
      const body = { title: v.title, description: v.description, projectId: v.projectId || null, goalId: v.goalId || null,
        status: v.status, priority: v.priority, estimateMinutes: v.estimate === "" ? null : Number(v.estimate),
        plannedWeek: v.week ? { localMonday: monday(v.week), timezone } : scheduledStart ? { localMonday: monday(v.start.slice(0, 10)), timezone } : null,
        scheduledStart, scheduledEnd, due, reminderLeadMinutes: v.lead === "" ? null : Number(v.lead), planningOverrideReason: v.override.trim() || null,
        ...(task ? { expectedVersion: task.version } : {}) };
      const serialized = JSON.stringify(body);
      const key = request.current?.body === serialized ? request.current.key : newIdempotencyKey();
      request.current = { body: serialized, key };
      await api(`/api/v1/tasks${task ? `/${task.id}` : ""}`, { method: task ? "PATCH" : "POST", body, idempotencyKey: task ? undefined : key });
      clear(); onSaved();
    } catch (e) { setError(e instanceof Error ? e.message : "保存失败"); } finally { setBusy(false); }
  }
  const id = task?.id ?? `new-${projectId ?? "task"}-${plannedMonday}`;
  const field = (label: string, key: "title" | "estimate" | "week" | "start" | "end" | "dueDate" | "dueInstant" | "lead", type = "text") => <div>
    <label className={styles.label} htmlFor={`${id}-${key}`}>{label}</label>
    <input id={`${id}-${key}`} className={styles.field} type={type} min={type === "number" ? 0 : undefined} value={v[key]} onChange={(e) => update({ [key]: e.target.value })} />
  </div>;
  return <form className={styles.subForm} onSubmit={(e) => { e.preventDefault(); void save(); }}>
    {restored && <p className={styles.muted}>已恢复本机草稿；保存时仍需核对任务版本。</p>}
    <div className={styles.formGrid}>
      {field("任务标题", "title")}{field("估时（分钟；留空为未知）", "estimate", "number")}
      <div><label className={styles.label} htmlFor={`${id}-project`}>所属项目</label><select id={`${id}-project`} className={styles.field} value={v.projectId} onChange={(e) => update({ projectId: e.target.value })}><option value="">不关联</option>{projects.map((p) => <option key={p.id} value={p.id}>{p.title}</option>)}</select></div>
      <div><label className={styles.label} htmlFor={`${id}-goal`}>关联目标</label><select id={`${id}-goal`} className={styles.field} value={v.goalId} onChange={(e) => update({ goalId: e.target.value })}><option value="">不关联</option>{goals.map((g) => <option key={g.id} value={g.id}>{g.title}</option>)}</select></div>
      <div><label className={styles.label} htmlFor={`${id}-status`}>状态</label><select id={`${id}-status`} className={styles.field} value={v.status} onChange={(e) => update({ status: e.target.value as typeof v.status })}>{Object.entries(TASK_STATUS).map(([key, name]) => <option key={key} value={key}>{name}</option>)}</select></div>
      <div><label className={styles.label} htmlFor={`${id}-priority`}>优先级</label><select id={`${id}-priority`} className={styles.field} value={v.priority} onChange={(e) => update({ priority: e.target.value as typeof v.priority })}><option value="normal">普通</option><option value="high">高</option></select></div>
      {field("计划周（选任意日期，归入该周；留空待安排）", "week", "date")}
      {field(`开始（${timezone}）`, "start", "datetime-local")}{field("结束（可留空）", "end", "datetime-local")}
      <div><label className={styles.label} htmlFor={`${id}-due`}>截止精度</label><select id={`${id}-due`} className={styles.field} value={v.dueKind} onChange={(e) => update({ dueKind: e.target.value as typeof v.dueKind })}><option value="none">无截止</option><option value="date">仅日期</option><option value="instant">精确时刻</option></select></div>
      {v.dueKind === "date" && field("截止日期", "dueDate", "date")}{v.dueKind === "instant" && field("截止时刻", "dueInstant", "datetime-local")}
      {v.dueKind !== "none" && field("提前提醒（分钟；留空用默认值）", "lead", "number")}
    </div>
    <label className={styles.label} htmlFor={`${id}-description`}>说明 / 完成标准</label><textarea id={`${id}-description`} className={styles.field} value={v.description} onChange={(e) => update({ description: e.target.value })} />
    <details><summary>覆盖排程冲突</summary><label className={styles.label} htmlFor={`${id}-override`}>仍要这样安排的原因（仅本次保存有效）</label><input id={`${id}-override`} className={styles.field} value={v.override} onChange={(e) => update({ override: e.target.value })} /><p className={styles.muted}>任务重叠、固定活动、可用窗口外的安排默认会拒绝；填写原因后保留人工覆盖记录。</p></details>
    <p className={styles.muted}>日期型以当天 09:00 为基准，提前量留空则当天 09:00；时刻型以截止为基准，留空提前 24 小时。草稿{persisted ? "已存本机" : "仅在当前页面中，尚未确认保存到本机"}。</p>
    <div className={styles.actionsRow}><button className={`${styles.btn} ${styles.btnPrimary}`} disabled={busy}>{busy ? "保存中…" : task ? "保存任务" : "创建任务"}</button>{onCancel && <button type="button" className={styles.btn} onClick={onCancel}>关闭编辑</button>}</div>
    {error && <p className={styles.error} role="alert">{error}。输入已保留；版本冲突时关闭编辑并重新加载后再核对。</p>}
  </form>;
}

export const TASK_STATUS = { todo: "待办", doing: "进行中", blocked: "受阻", done: "已完成", cancelled: "已取消" };
