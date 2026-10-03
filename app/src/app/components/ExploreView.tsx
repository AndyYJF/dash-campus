"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { api, ApiError, newIdempotencyKey } from "./api";
import styles from "./dash.module.css";
import ex from "./explore.module.css";
import TopicList from "./TopicList";
import ResourceLibrary from "./ResourceLibrary";
import type { IntegrationStatusMap } from "@/contracts/integration-status";

/**
 * 探索页（T5）：按需探索输入 + 最近运行 + 关注方向（定期订阅）+ 实践模板。
 * 按需搜索与关注方向分开；无搜索服务时只能粘贴资料，并明说不是联网检索。
 */

type RunSummary = {
  id: string;
  kind: "on_demand" | "scheduled";
  query: string;
  status: string;
  integrationMode: "real" | "fixture" | "materials_only";
  errorMessage: string | null;
  createdAt: string;
};

type Template = {
  version: number;
  sourceLinks: Array<{title: string; url: string; license: string}>;
  deliverables: string[];
  initialTasks: Array<{title: string; estimateMinutes: number | null}>;
  id: string;
  status: "draft" | "ready";
  direction: string;
  question: string;
  estimatedMinutesRange: { min: number; max: number } | null;
  firstStep: string;
};

type Project = { id: string; title: string; archivedAt: string | null };

export const STATUS_LABEL: Record<string, string> = {
  queued: "排队中",
  searching: "检索中",
  extracting: "取回原文中",
  generating: "整理候选中",
  done: "已完成",
  failed: "失败",
  cancelled: "已取消",
};

export const MODE_LABEL: Record<string, string> = {
  real: "真实检索",
  fixture: "示例数据（非真实联网）",
  materials_only: "仅用粘贴资料（未联网）",
};

export default function ExploreView() {
  const router = useRouter();
  const [integrations, setIntegrations] = useState<IntegrationStatusMap | null>(null);
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [query, setQuery] = useState("");
  const [background, setBackground] = useState("");
  const [projectId, setProjectId] = useState("");
  const [materialText, setMaterialText] = useState("");
  const [materialUrl, setMaterialUrl] = useState("");
  const [resourceIds, setResourceIds] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // 同一次输入重试复用同一个幂等键；内容变化才换新键
  const keyRef = useRef<{ body: string; key: string } | null>(null);

  const refresh = useCallback(() => {
    api<{ runs: RunSummary[] }>("/api/v1/explorations").then((r) => setRuns(r.runs)).catch(() => {});
  }, []);

  useEffect(() => {
    api<{ integrations: IntegrationStatusMap }>("/api/v1/integrations").then((r) => setIntegrations(r.integrations)).catch(() => {});
    api<{ templates: Template[] }>("/api/v1/practice-templates").then((r) => setTemplates(r.templates)).catch(() => {});
    api<{ projects: Project[] }>("/api/v1/projects").then((r) => setProjects(r.projects)).catch(() => {});
    refresh();
  }, [refresh]);

  // 有运行中的探索时轮询状态（真实阶段，不显示虚构百分比）
  useEffect(() => {
    if (!runs.some((r) => !["done", "failed", "cancelled"].includes(r.status))) return;
    const t = setInterval(refresh, 3000);
    return () => clearInterval(t);
  }, [runs, refresh]);

  const searchReady = integrations?.search.state === "configured";
  const modelReady = integrations?.model.state === "configured";

  async function startFromTemplate(t: Template) {
    setBusy(true); setError(null);
    const body = {expectedVersion: t.version, plannedWeek: null}, serialized = `template:${t.id}:${JSON.stringify(body)}`;
    const key = keyRef.current?.body === serialized ? keyRef.current.key : newIdempotencyKey(); keyRef.current = {body: serialized, key};
    try { const p = await api<{id: string}>(`/api/v1/practice-templates/${t.id}/start`, {method: "POST", body, idempotencyKey: key}); router.push(`/projects/${p.id}`); }
    catch (e) { setError(e instanceof Error ? e.message : "创建失败"); } finally { setBusy(false); }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const materials = materialText.trim()
      ? [{ title: "", url: materialUrl.trim() || null, text: materialText.trim() }]
      : [];
    const body = { query: query.trim(), background, projectId: projectId || null, topicId: null, materials, resourceIds };
    const serialized = JSON.stringify(body);
    if (!keyRef.current || keyRef.current.body !== serialized) keyRef.current = { body: serialized, key: newIdempotencyKey() };
    setBusy(true);
    try {
      const r = await api<{ runId: string }>("/api/v1/explorations", {
        method: "POST",
        body,
        idempotencyKey: keyRef.current.key,
      });
      keyRef.current = null;
      router.push(`/explore/${r.runId}`);
    } catch (err) {
      // 失败保留输入（13.3）
      setError(err instanceof ApiError ? err.message : "提交失败，输入已保留，可重试");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div className={styles.columns}>
        <div>
          <form className={styles.card} onSubmit={submit}>
            <h2>按需探索</h2>
            {integrations && !modelReady && (
              <p className={ex.banner}>
                模型未配置，暂时无法生成候选。<Link href="/settings">查看配置状态</Link>
              </p>
            )}
            {integrations && modelReady && !searchReady && (
              <p className={ex.banner}>搜索服务未配置：只能根据你粘贴的资料整理候选，不会联网检索。</p>
            )}
            <label className={ex.fieldLabel} htmlFor="q">
              想了解的问题
            </label>
            <textarea
              id="q"
              className={styles.field}
              rows={2}
              required
              maxLength={500}
              placeholder="例如：我对信息检索感兴趣，有什么一两周能做完的小实践？"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <label className={ex.fieldLabel} htmlFor="bg">
              当前基础与可用时间（可选，只用于本次）
            </label>
            <textarea
              id="bg"
              className={styles.field}
              rows={2}
              maxLength={2000}
              value={background}
              onChange={(e) => setBackground(e.target.value)}
            />
            <label className={ex.fieldLabel} htmlFor="proj">
              关联项目（可选）
            </label>
            <select id="proj" className={styles.field} value={projectId} onChange={(e) => setProjectId(e.target.value)}>
              <option value="">不关联</option>
              {projects
                .filter((p) => !p.archivedAt)
                .map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.title}
                  </option>
                ))}
            </select>
            <details open={!searchReady}>
              <summary className={styles.muted}>粘贴资料原文{searchReady ? "（可选）" : "（未配置搜索时必填）"}</summary>
              <input
                className={styles.field}
                type="url"
                placeholder="资料链接（可选，仅 http/https）"
                value={materialUrl}
                onChange={(e) => setMaterialUrl(e.target.value)}
              />
              <textarea
                className={styles.field}
                rows={5}
                maxLength={20000}
                placeholder="粘贴课程页、项目说明等原文。保存为「用户提供」来源，候选只能引用其中的原句。"
                value={materialText}
                onChange={(e) => setMaterialText(e.target.value)}
              />
            </details>
            {error && <p className={styles.error} role="alert">{error}</p>}
            <button
              className={`${styles.btn} ${styles.btnPrimary}`}
              type="submit"
              disabled={busy || !query.trim() || !modelReady || (!searchReady && !materialText.trim() && resourceIds.length === 0)}
            >
              {busy ? "提交中…" : "开始探索"}
            </button>
            <p className={styles.muted}>单次最多 3 个检索词、6 个原文页、3 个候选、3 分钟。</p>
          </form>

          <div className={styles.card}>
            <h2>最近的探索</h2>
            {runs.length === 0 && <p className={styles.empty}>还没有探索记录。提一个问题开始第一次探索。</p>}
            {runs.map((r) => (
              <div key={r.id} className={styles.taskRow}>
                <span className={styles.taskTitle}>
                  <Link href={`/explore/${r.id}`}>{r.query}</Link>
                </span>
                <span className={styles.badge}>{r.kind === "scheduled" ? "定期" : "按需"}</span>
                {r.integrationMode !== "real" && <span className={styles.badge}>{MODE_LABEL[r.integrationMode]}</span>}
                <span className={styles.taskMeta}>{STATUS_LABEL[r.status] ?? r.status}</span>
              </div>
            ))}
          </div>
        </div>

        <div>
          <ResourceLibrary selected={resourceIds} onSelectionChange={setResourceIds} />
          <TopicList searchReady={Boolean(searchReady && modelReady)} onRun={refresh} />
          <div className={styles.card}>
            <h2>实践模板</h2>
            <p className={styles.muted}>
              可用模板包含具体步骤、完成标准和官方参考资料，无需模型即可开始。修改过的旧草稿会保留原内容。创建后在项目中选择计划周或时段。
            </p>
            {templates.map((t) => (
              <div key={t.id} className={styles.logItem}>
                <div className={ex.row}>
                  <strong>{t.direction}</strong>
                  <span className={styles.badge}>{t.status === "ready" ? "已核实来源" : "草稿"}</span>
                </div>
                <div>{t.question}</div>
                <div className={styles.muted}>
                  第一步：{t.firstStep}
                  {t.estimatedMinutesRange &&
                    ` · 约 ${Math.round(t.estimatedMinutesRange.min / 60)}–${Math.round(t.estimatedMinutesRange.max / 60)} 小时`}
                </div>
                <details><summary>产出、任务与资料</summary><ul>{t.deliverables.map((d) => <li key={d}>{d}</li>)}</ul><ul>{t.initialTasks.map((task) => <li key={task.title}>{task.title} · {task.estimateMinutes ?? "未知"} 分钟</li>)}</ul>{t.sourceLinks.map((link) => <p key={link.url}><a href={link.url} target="_blank" rel="noreferrer">{link.title}</a><br /><span className={styles.muted}>{link.license}</span></p>)}</details>
                {t.status === "ready" && <button className={styles.btn} disabled={busy} onClick={() => void startFromTemplate(t)}>用此模板创建项目</button>}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
