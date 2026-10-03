"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, newIdempotencyKey } from "./api";
import styles from "./dash.module.css";
import type { GoalRow, ProjectRow } from "@/repositories/planning";

export default function PlanningEntities({ projectId, onChanged }: { projectId?: string; onChanged?: () => void }) {
  const [goals, setGoals] = useState<GoalRow[]>([]), [projects, setProjects] = useState<ProjectRow[]>([]);
  const [editing, setEditing] = useState<{ kind: "goals" | "projects"; row: GoalRow | ProjectRow | null } | null>(null);
  const [error, setError] = useState("");
  const refresh = useCallback(() => { Promise.all([api<{ goals: GoalRow[] }>("/api/v1/goals"), api<{ projects: ProjectRow[] }>("/api/v1/projects")]).then(([g, p]) => { setGoals(g.goals); setProjects(p.projects); }).catch((e) => setError(e.message)); }, []);
  useEffect(refresh, [refresh]);
  return <section className={styles.card}><details open={Boolean(projectId)}><summary>{projectId ? "编辑项目与关联目标" : "目标与项目"}</summary>
    {!projectId && <><h3>方向与学期目标</h3>{goals.map((g) => <div key={g.id} className={styles.taskRow}><div className={styles.taskBody}><strong>{g.title}</strong><p className={styles.muted}>{g.horizon === "semester" ? "学期目标" : "长期方向"} · {{active: "进行中", paused: "暂停", completed: "已完成"}[g.status]} · {g.reason || "尚未填写理由"}</p></div><button className={styles.btn} onClick={() => setEditing({ kind: "goals", row: g })}>编辑目标</button></div>)}<button className={styles.btn} onClick={() => setEditing({ kind: "goals", row: null })}>添加目标</button></>}
    <h3>{projectId ? "当前项目" : "实践项目"}</h3>{projects.filter((p) => !projectId || p.id === projectId).map((p) => <div key={p.id} className={styles.taskRow}><div className={styles.taskBody}><a href={`/projects/${p.id}`}>{p.title}</a><p className={styles.muted}>{{active: "进行中", paused: "暂停", completed: "已完成"}[p.status]} · {p.question || "待补充验证问题"} · 关联 {p.goalIds.length} 个目标</p></div><button className={styles.btn} onClick={() => setEditing({ kind: "projects", row: p })}>编辑项目</button></div>)}
    {!projectId && <button className={styles.btn} onClick={() => setEditing({ kind: "projects", row: null })}>创建项目</button>}
    {editing && <EntityEditor key={`${editing.kind}:${editing.row?.id ?? "new"}:${editing.row?.version ?? 0}`} {...editing} goals={goals} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); refresh(); onChanged?.(); }} />}
    {error && <p className={styles.error} role="alert">{error}</p>}
  </details></section>;
}

function EntityEditor({ kind, row, goals, onClose, onSaved }: { kind: "goals" | "projects"; row: GoalRow | ProjectRow | null; goals: GoalRow[]; onClose: () => void; onSaved: () => void }) {
  const project = row && "goalIds" in row ? row : null, goal = row && "horizon" in row ? row : null;
  const [v, setV] = useState({ title: row?.title ?? "", reason: goal?.reason ?? "", horizon: goal?.horizon ?? "semester", status: row?.status ?? "active", question: project?.question ?? "", expectedOutcome: project?.expectedOutcome ?? "", prerequisites: project?.prerequisites ?? "", reviewQuestions: project?.reviewQuestions ?? "", goalIds: project?.goalIds ?? [] });
  const [error, setError] = useState(""), [busy, setBusy] = useState(false);
  const request = useRef<{ body: string; key: string } | null>(null);
  async function save() {
    setBusy(true); setError("");
    const body = { ...(kind === "goals" ? { title: v.title, reason: v.reason, horizon: v.horizon } : { title: v.title, question: v.question, expectedOutcome: v.expectedOutcome, prerequisites: v.prerequisites, reviewQuestions: v.reviewQuestions, goalIds: v.goalIds }), ...(row ? { status: v.status, expectedVersion: row.version } : {}) };
    const serialized = JSON.stringify(body), key = request.current?.body === serialized ? request.current.key : newIdempotencyKey(); request.current = { body: serialized, key };
    try { await api(`/api/v1/${kind}${row ? `/${row.id}` : ""}`, { method: row ? "PATCH" : "POST", body, idempotencyKey: row ? undefined : key }); onSaved(); }
    catch (e) { setError(e instanceof Error ? e.message : "保存失败"); } finally { setBusy(false); }
  }
  const field = (key: "title" | "reason" | "question" | "expectedOutcome" | "prerequisites" | "reviewQuestions", label: string) => <label className={styles.label}>{label}<textarea className={styles.field} rows={key === "title" ? 1 : 2} value={v[key]} onChange={(e) => setV({ ...v, [key]: e.target.value })} /></label>;
  return <form className={styles.subForm} onSubmit={(e) => { e.preventDefault(); void save(); }}>
    {field("title", "标题")}{kind === "goals" ? <>{field("reason", "为什么值得投入")}
      <label className={styles.label}>尺度<select className={styles.field} value={v.horizon} onChange={(e) => setV({ ...v, horizon: e.target.value as typeof v.horizon })}><option value="semester">学期目标</option><option value="long_term">长期方向</option></select></label></> : <>
      {field("question", "要验证的问题")}{field("expectedOutcome", "预期产出 / 完成标准")}{field("prerequisites", "前置知识与条件")}{field("reviewQuestions", "阶段复盘问题")}
      <fieldset className={styles.fieldset}><legend>关联目标</legend>{goals.map((g) => <label key={g.id} className={styles.check}><input type="checkbox" checked={v.goalIds.includes(g.id)} onChange={(e) => setV({ ...v, goalIds: e.target.checked ? [...v.goalIds, g.id] : v.goalIds.filter((id) => id !== g.id) })} />{g.title}</label>)}</fieldset></>}
    {row && <label className={styles.label}>状态<select className={styles.field} value={v.status} onChange={(e) => setV({ ...v, status: e.target.value as typeof v.status })}><option value="active">进行中</option><option value="paused">暂停</option><option value="completed">已完成</option></select></label>}
    <div className={styles.actionsRow}><button className={`${styles.btn} ${styles.btnPrimary}`} disabled={busy}>保存</button><button type="button" className={styles.btn} onClick={onClose}>关闭</button></div>{error && <p className={styles.error} role="alert">{error}；输入仍保留。</p>}
  </form>;
}
