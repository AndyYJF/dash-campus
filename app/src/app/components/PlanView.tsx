"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError, newIdempotencyKey } from "./api";
import TaskEditor from "./TaskEditor";
import ManagedTasks from "./ManagedTasks";
import PlanningEntities from "./PlanningEntities";
import CalendarSettings from "./CalendarSettings";
import { useDashRefresh } from "./dashBus";
import Duration from "./Duration";
import { formatMinutes } from "./WeekStatusStrip";
import styles from "./dash.module.css";
import type { WeekPlan } from "@/contracts/today";
import type { TaskRow, GoalRow, ProjectRow } from "@/repositories/planning";

/** 计划页：周视图、每周重点与主人直接管理排程。 */
export default function PlanView() {
  const [plan, setPlan] = useState<WeekPlan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [focusTitle, setFocusTitle] = useState("");
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [date, setDate] = useState("");
  const [goals, setGoals] = useState<GoalRow[]>([]);
  const [projects, setProjects] = useState<ProjectRow[]>([]);
  const [focusGoalId, setFocusGoalId] = useState("");
  const [focusProjectId, setFocusProjectId] = useState("");
  const [backlog, setBacklog] = useState<TaskRow[]>([]);
  const focusKey = useRef<{ body: string; key: string } | null>(null);
  const initialAnchorScrolled = useRef(false);

  const refresh = useCallback(() => {
    Promise.all([
      api<WeekPlan>(`/api/v1/planning/week${date ? `?date=${date}` : ""}`),
      api<{tasks: TaskRow[]}>("/api/v1/tasks"),
      api<{goals: GoalRow[]}>("/api/v1/goals"),
      api<{projects: ProjectRow[]}>("/api/v1/projects"),
    ]).then(([p,t,g,projects]) => {
      setPlan(p); setFocusTitle(p.focus?.title ?? "");
      setFocusGoalId(p.focus?.goalId ?? ""); setFocusProjectId(p.focus?.projectId ?? "");
      setGoals(g.goals); setProjects(projects.projects);
      setBacklog(t.tasks.filter((task) => !task.plannedWeek && task.status !== "done" && task.status !== "cancelled"));
      setError(null);
    }).catch((e) => setError(e instanceof Error ? e.message : "加载失败"));
  }, [date]);

  useEffect(refresh, [refresh]);
  useDashRefresh(refresh);
  useEffect(() => {
    if (!plan || initialAnchorScrolled.current || window.location.hash !== "#unplanned-tasks") return;
    // The anchor is absent while async data loads, so the router's initial scroll can miss it.
    const frame = requestAnimationFrame(() => {
      document.getElementById("unplanned-tasks")?.scrollIntoView({ block: "start" });
      initialAnchorScrolled.current = true;
    });
    return () => cancelAnimationFrame(frame);
  }, [plan]);

  if (error) return (
    <p className={styles.error} role="alert">
      {error}
    </p>
  );
  if (!plan) return <p className={styles.muted}>加载中…</p>;

  const w = plan.workload;
  const over = w.weekCapacityMinutes !== null && w.committedMinutes > w.weekCapacityMinutes;

  async function saveFocus() {
    if (!focusTitle.trim()) return;
    setMessage(null);
    const body = {localMonday: plan!.week.localMonday, timezone: plan!.timezone, title: focusTitle.trim(), goalId: focusGoalId || null, projectId: focusProjectId || null, ...(plan!.focus ? {expectedVersion: plan!.focus.version} : {})};
    const serialized = JSON.stringify(body);
    let key: string | undefined;
    if (!plan?.focus) {
      key = focusKey.current?.body === serialized ? focusKey.current.key : newIdempotencyKey();
      focusKey.current = {body: serialized, key};
    }
    try {
      await api("/api/v1/planning/week/focus", {method: "PUT", idempotencyKey: key, body});
      setMessage({ ok: true, text: "本周重点已保存" });
      refresh();
    } catch (e) {
      setMessage({ ok: false, text: e instanceof ApiError ? e.message : "保存失败" });
    }
  }

  return (
    <div>
      <div className={styles.actionsRow}>
        <label className={styles.label} htmlFor="plan-week">查看哪一周</label><input id="plan-week" type="date" className={styles.field} value={date || plan.week.localMonday} onChange={(e) => setDate(e.target.value)} />
        <button className={styles.btn} onClick={() => setDate("")}>回到本周</button>
      </div>
      <section className={`${styles.card} ${styles.cardFeature}`} aria-labelledby="focus-title">
        <h2 id="focus-title">本周重点 · {plan.week.localMonday} 起的一周</h2>
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
        <label className={styles.label}>
          重点关联（选择一个目标或项目）
          <select
            className={styles.field}
            value={focusGoalId ? `goal:${focusGoalId}` : focusProjectId ? `project:${focusProjectId}` : ""}
            onChange={(e) => {
              const value = e.target.value;
              setFocusGoalId(value.startsWith("goal:") ? value.slice(5) : "");
              setFocusProjectId(value.startsWith("project:") ? value.slice(8) : "");
            }}
          >
            <option value="">不关联</option>
            <optgroup label="目标">{goals.map((g) => <option key={g.id} value={`goal:${g.id}`}>{g.title}</option>)}</optgroup>
            <optgroup label="项目">{projects.map((p) => <option key={p.id} value={`project:${p.id}`}>{p.title}</option>)}</optgroup>
          </select>
        </label>
        {plan.focus && <p className={styles.muted}>最近确认：{new Date(plan.focus.confirmedAt).toLocaleString()}</p>}
      </section>

      <section className={styles.card} aria-labelledby="load-title">
        <h2 id="load-title">周负担</h2>
        <div className={styles.strip}>
          <div className={styles.stripItem}>
            <span className={styles.stripLabel}>整周承诺（含已完成）</span>
            <span className={styles.stripValue}>
              <Duration minutes={w.committedMinutes} />
            </span>
            {w.committedUnknownCount > 0 && <span className={styles.stripNote}>另有 {w.committedUnknownCount} 项估时未知</span>}
          </div>
          <div className={styles.stripItem}>
            <span className={styles.stripLabel}>剩余未完成</span>
            <span className={styles.stripValue}>
              <Duration minutes={w.remainingKnownMinutes} />
            </span>
            {w.remainingUnknownCount > 0 && <span className={styles.stripNote}>另有 {w.remainingUnknownCount} 项估时未知</span>}
          </div>
          <div className={styles.stripItem}>
            <span className={styles.stripLabel}>整周可用时间</span>
            {w.weekCapacityMinutes === null ? (
              <span className={styles.stripValueText}>尚未设置可用时间</span>
            ) : (
              <span className={styles.stripValue}>
                <Duration minutes={w.weekCapacityMinutes} />
              </span>
            )}
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
        <ManagedTasks tasks={plan.tasks} timezone={plan.timezone} onChanged={refresh} />
        <details className={styles.addTask}>
          <summary>添加任务</summary>
          <TaskEditor key={plan.week.localMonday} plannedMonday={plan.week.localMonday} timezone={plan.timezone} onSaved={refresh} />
        </details>
      </section>
      <section className={styles.card} id="unplanned-tasks" style={{ scrollMarginTop: 80 }}><h2>待安排任务 · {backlog.length}</h2><p className={styles.muted}>候选项目的第一批任务会先出现在这里。编辑后选择计划周或具体时段即可进入行动列表。</p><ManagedTasks tasks={backlog} timezone={plan.timezone} onChanged={refresh} /></section>
      {plan.conflicts.length > 0 && <section className={styles.card}><h2>本周排程需核对</h2><p className={styles.muted}>修改课程或可用窗口后，既有任务不会自动改期。下列冲突需你核对；已填写的人工覆盖原因会保留。</p>{plan.conflicts.map((c) => <p key={`${c.taskId}:${c.code}`}><strong>{c.title}</strong>：{c.message}{c.overrideReason ? `；人工覆盖：${c.overrideReason}` : ""}</p>)}</section>}
      <PlanningEntities onChanged={refresh} />
      <CalendarSettings timezone={plan.timezone} onChanged={refresh} />
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
