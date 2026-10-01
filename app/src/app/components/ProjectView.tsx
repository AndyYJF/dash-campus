"use client";

import { useCallback, useEffect, useState } from "react";
import { api, ApiError, newIdempotencyKey } from "./api";
import TaskForm from "./TaskForm";
import ExplorationConclusion from "./ExplorationConclusion";
import StageReport from "./StageReport";
import BackLink from "./BackLink";
import LogTimeline from "./LogTimeline";
import { TaskMeta } from "./TaskList";
import styles from "./dash.module.css";
import type { TaskRow, ProjectRow } from "@/repositories/planning";
import type { DailyLogRow, ArtifactRow } from "@/repositories/logs";

/** 项目详情：信息 + 任务 + 记录 + 成果（成果只支持文本与链接，URL 限 http/https） */
export default function ProjectView({ projectId }: { projectId: string }) {
  const [project, setProject] = useState<ProjectRow | null>(null);
  const [tasks, setTasks] = useState<TaskRow[]>([]);
  const [logs, setLogs] = useState<DailyLogRow[]>([]);
  const [artifacts, setArtifacts] = useState<ArtifactRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [artTitle, setArtTitle] = useState("");
  const [artUrl, setArtUrl] = useState("");
  const [artBody, setArtBody] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  // 同一份成果内容重试复用同一个幂等键
  const [artKey, setArtKey] = useState<{ body: string; key: string } | null>(null);

  const refresh = useCallback(() => {
    Promise.all([
      api<{ project: ProjectRow }>(`/api/v1/projects/${projectId}`),
      api<{ tasks: TaskRow[] }>(`/api/v1/tasks?projectId=${projectId}`),
      api<{ logs: DailyLogRow[] }>(`/api/v1/logs?projectId=${projectId}`),
      api<{ artifacts: ArtifactRow[] }>(`/api/v1/artifacts?projectId=${projectId}`),
    ])
      .then(([p, t, l, a]) => {
        setProject(p.project);
        setTasks(t.tasks);
        setLogs(l.logs);
        setArtifacts(a.artifacts);
        setError(null);
      })
      .catch((e) => setError(e instanceof Error ? e.message : "加载失败"));
  }, [projectId]);

  useEffect(refresh, [refresh]);

  if (error) return <p className={styles.error} role="alert">{error}</p>;
  if (!project) return <p className={styles.muted}>加载中…</p>;

  async function addArtifact() {
    setMessage(null);
    if (!artTitle.trim()) {
      setMessage("成果标题不能为空");
      return;
    }
    const body = {
      projectId,
      logId: null,
      kind: artUrl.trim() ? "link" : "text",
      title: artTitle.trim(),
      body: artBody.trim(),
      url: artUrl.trim() || null,
    };
    const serialized = JSON.stringify(body);
    const key = artKey && artKey.body === serialized ? artKey.key : newIdempotencyKey();
    setArtKey({ body: serialized, key });
    try {
      await api("/api/v1/artifacts", {
        method: "POST",
        idempotencyKey: key,
        body,
      });
      setArtTitle("");
      setArtUrl("");
      setArtBody("");
      setArtKey(null);
      refresh();
    } catch (e) {
      setMessage(e instanceof ApiError ? `${e.code}: ${e.message}` : "保存成果失败");
    }
  }

  return (
    <div>
      <div className={styles.pageHeader}>
        <div>
          <BackLink href="/plan" label="计划" />
          <h1>
            {project.title}{" "}
            <span className={`${styles.badge} ${project.status === "active" ? styles.badgeAccent : ""}`}>
              {PROJECT_STATUS[project.status]}
            </span>
          </h1>
        </div>
      </div>

      <div className={styles.columns}>
        <div>
          <section className={styles.card}>
            <h2>目的</h2>
            <dl className={styles.facts}>
              <dt>想验证的问题</dt>
              <dd>{project.question || <span className={styles.muted}>未填写</span>}</dd>
              <dt>预期产出</dt>
              <dd>{project.expectedOutcome || <span className={styles.muted}>未填写</span>}</dd>
              {project.prerequisites && (
                <>
                  <dt>前置条件</dt>
                  <dd>{project.prerequisites}</dd>
                </>
              )}
            </dl>
          </section>

          <section className={styles.card}>
            <h2>任务</h2>
            {tasks.length === 0 && <p className={styles.empty}>还没有任务。</p>}
            {tasks.map((t) => (
              <div key={t.id} className={styles.taskRow}>
                <div className={styles.taskBody}>
                  <span className={styles.taskTitle}>
                    {t.title}{" "}
                    <span className={`${styles.badge} ${t.status === "done" ? styles.badgeOk : t.status === "blocked" ? styles.badgeHigh : t.status === "doing" ? styles.badgeAccent : ""}`}>
                      {TASK_STATUS[t.status]}
                    </span>
                  </span>
                  <TaskMeta task={t} />
                </div>
              </div>
            ))}
            <details className={styles.addTask}>
              <summary>添加任务</summary>
              <TaskForm projectId={projectId} onCreated={refresh} />
            </details>
          </section>

          <section className={styles.card}>
            <h2>相关记录</h2>
            {logs.length === 0 && <p className={styles.empty}>还没有记录。可以在今天页写一条并关联到这个项目的任务。</p>}
            {logs.length > 0 && <LogTimeline logs={logs} />}
          </section>
        </div>

        <div>
          <section className={styles.card}>
            <h2>成果</h2>
            {artifacts.length === 0 && <p className={styles.empty}>还没有成果。</p>}
            {artifacts.map((a) => (
              <div key={a.id} className={styles.logItem}>
                <span className={styles.badge}>{a.kind === "link" ? "链接" : "文本"}</span> <strong>{a.title}</strong>
                {a.url && (
                  <div>
                    <a href={a.url} target="_blank" rel="noreferrer">
                      {a.url}
                    </a>
                  </div>
                )}
                {a.body && <div className={styles.muted}>{a.body}</div>}
              </div>
            ))}
            <details className={styles.addTask}>
              <summary>添加成果</summary>
              <label className={styles.label} htmlFor="art-title">
                标题
              </label>
              <input
                id="art-title"
                className={styles.field}
                placeholder="如：实验记录、作品链接"
                value={artTitle}
                onChange={(e) => setArtTitle(e.target.value)}
              />
              <label className={styles.label} htmlFor="art-url">
                链接（可留空，表示文本成果）
              </label>
              <input
                id="art-url"
                className={styles.field}
                type="url"
                inputMode="url"
                placeholder="https://"
                value={artUrl}
                onChange={(e) => setArtUrl(e.target.value)}
              />
              <label className={styles.label} htmlFor="art-body">
                说明
              </label>
              <textarea id="art-body" className={styles.field} rows={3} value={artBody} onChange={(e) => setArtBody(e.target.value)} />
              <button className={`${styles.btn} ${styles.btnPrimary}`} onClick={addArtifact}>
                添加成果
              </button>
              {message && (
                <p className={styles.error} role="alert">
                  {message}
                </p>
              )}
            </details>
          </section>

          <ExplorationConclusion
            projectId={projectId}
            projectVersion={project.version}
            projectStatus={project.status}
            artifacts={artifacts.map((a) => ({ id: a.id, title: a.title }))}
            onSaved={refresh}
          />

          <StageReport projectId={projectId} logs={logs} artifacts={artifacts} />
        </div>
      </div>
    </div>
  );
}

const PROJECT_STATUS: Record<ProjectRow["status"], string> = { active: "进行中", paused: "已暂停", completed: "已结束" };
const TASK_STATUS: Record<TaskRow["status"], string> = { todo: "待办", doing: "进行中", blocked: "受阻", done: "已完成", cancelled: "已取消" };
