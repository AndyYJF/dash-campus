"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { api } from "./api";
import TodayHeader from "./TodayHeader";
import WeekStatusStrip from "./WeekStatusStrip";
import TaskList from "./TaskList";
import QuickLogForm from "./QuickLogForm";
import DecisionList from "./DecisionList";
import TaskForm, { mondaysFrom } from "./TaskForm";
import styles from "./dash.module.css";
import type { TodaySummary } from "@/contracts/today";
import type { TaskRow } from "@/repositories/planning";

/** 今日页：页头 + 主体。单快照渲染，刷新拉取新的 /api/v1/today */
export default function TodayView() {
  const [summary, setSummary] = useState<TodaySummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [asOfText, setAsOfText] = useState("");
  // 记录可关联所有未结束任务（首页行动只展示前 6 项）
  const [allTasks, setAllTasks] = useState<TaskRow[] | null>(null);

  const refresh = useCallback(() => {
    api<TodaySummary>("/api/v1/today")
      .then((s) => {
        setSummary(s);
        setAsOfText(new Date(s.asOf).toLocaleString());
        setError(null);
      })
      .catch((e) => setError(e instanceof Error ? e.message : "加载失败"));
    api<{ tasks: TaskRow[] }>("/api/v1/tasks")
      .then((r) => setAllTasks(r.tasks.filter((t) => t.status !== "done" && t.status !== "cancelled")))
      .catch(() => setAllTasks(null));
  }, []);

  useEffect(refresh, [refresh]);

  if (error) {
    return (
      <>
        <TodayHeader />
        <p className={styles.error} role="alert">
          {error}
        </p>
      </>
    );
  }
  if (!summary) {
    return (
      <>
        <TodayHeader />
        <p className={styles.muted}>加载中…</p>
      </>
    );
  }
  const logTasks = allTasks ?? summary.actions.map((a) => a.task);

  return (
    <div>
      <TodayHeader localDate={summary.localDate} localMonday={summary.week.localMonday} />
      <WeekStatusStrip summary={summary} />
      {/* 桌面：行动 + 最近记录（约 2/3）｜需要你决定（约 1/3）；手机：行动 → 待决定 → 记录 */}
      <div className={styles.todayGrid}>
        <div className={styles.areaActions}>
          <div className={styles.card}>
            <h2>近期行动</h2>
            {summary.actions.length === 0 ? (
              <p className={styles.empty}>{summary.unplannedTaskCount > 0 ? "近期没有已安排的行动；已有任务仍在待安排区。" : "近期暂无行动。可以在下面添加第一条任务。"}</p>
            ) : (
              <TaskList actions={summary.actions} onChanged={refresh} />
            )}
            {summary.unplannedTaskCount > 0 && <p className={styles.muted}>还有 {summary.unplannedTaskCount} 条任务未分配计划周，<Link href="/plan#unplanned-tasks">去待安排区选择下一步</Link>。</p>}
            {summary.moreActionCount > 0 && (
              <p className={styles.muted}>
                还有 {summary.moreActionCount} 项未显示，<Link href="/plan">去计划页查看全部</Link>。
              </p>
            )}
            <details className={styles.addTask}>
              <summary>添加任务</summary>
              <TaskForm
                defaultPlannedMonday={summary.week.localMonday}
                weekOptions={mondaysFrom(summary.week.localMonday)}
                timezone={summary.timezone}
                onCreated={refresh}
              />
            </details>
          </div>
        </div>
        <div className={styles.areaDecisions}>
          <DecisionList summary={summary} />
        </div>
        <div className={styles.areaLog} id="quick-log">
          <QuickLogForm recentLogs={summary.recentLogs} tasks={logTasks} localDate={summary.localDate} onSaved={refresh} />
          <p className={styles.muted}>数据更新时间：{asOfText}</p>
        </div>
      </div>
    </div>
  );
}
