"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import BackLink from "./BackLink";
import Icon from "./Icon";
import { api, ApiError } from "./api";
import styles from "./dash.module.css";
import ex from "./explore.module.css";
import CandidateCard, { type Candidate, type EvidenceMeta } from "./CandidateCard";
import { MODE_LABEL, STATUS_LABEL } from "./ExploreView";

/**
 * 探索运行详情（T5）：实际阶段 + 取消、预算与诊断、证据取回状态、最多 3 个候选比较。
 */

type Run = {
  id: string;
  kind: "on_demand" | "scheduled";
  query: string;
  status: string;
  integrationMode: string;
  errorCode: string | null;
  errorMessage: string | null;
  budget: Record<string, number>;
  diagnostics: Array<{ at: string; stage: string; message: string }>;
  createdAt: string;
  finishedAt: string | null;
};

type Evidence = EvidenceMeta & { excerpt: string; length: number };

type Detail = { run: Run; evidence: Evidence[]; candidates: Candidate[] };

const STAGES = ["queued", "searching", "extracting", "generating", "done"];

export const EVIDENCE_LABEL: Record<string, string> = {
  retrieved: "已取回原文",
  snippet: "仅搜索摘要（待核实）",
  user_supplied: "用户提供",
};

export default function ExplorationRunView() {
  const { id } = useParams<{ id: string }>();
  const [detail, setDetail] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);

  const refresh = useCallback(() => {
    api<Detail>(`/api/v1/explorations/${id}`)
      .then((d) => {
        setDetail(d);
        setError(null);
      })
      .catch((e) => setError(e instanceof Error ? e.message : "加载失败"));
  }, [id]);
  useEffect(refresh, [refresh]);

  const running = detail && !["done", "failed", "cancelled"].includes(detail.run.status);
  useEffect(() => {
    if (!running) return;
    const t = setInterval(refresh, 2500);
    return () => clearInterval(t);
  }, [running, refresh]);

  async function cancel() {
    setCancelling(true);
    try {
      await api(`/api/v1/explorations/${id}/cancel`, { method: "POST" });
      refresh();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "取消失败");
    } finally {
      setCancelling(false);
    }
  }

  if (!detail) return <p className={error ? styles.error : styles.muted}>{error ?? "加载中…"}</p>;
  const { run, evidence, candidates } = detail;
  const evidenceById = new Map(evidence.map((e) => [e.id, e]));
  const stageIndex = STAGES.indexOf(run.status);

  return (
    <div>
      <BackLink href="/explore" label="探索" />
      <h1>{run.query}</h1>
      {run.integrationMode !== "real" && <p className={ex.banner}>{MODE_LABEL[run.integrationMode]}</p>}

      <div className={styles.card}>
        <div className={ex.row}>
          <strong style={{ flex: 1 }}>
            {run.kind === "scheduled" ? "定期探索" : "按需探索"} · {STATUS_LABEL[run.status] ?? run.status}
          </strong>
          {running && (
            <button className={styles.btn} onClick={cancel} disabled={cancelling}>
              {cancelling ? "取消中…" : "取消"}
            </button>
          )}
        </div>
        {run.status !== "failed" && run.status !== "cancelled" && (
          <ol className={ex.stages} aria-label="执行阶段">
            {STAGES.map((s, i) => (
              <li
                key={s}
                className={i < stageIndex ? ex.stageDone : i === stageIndex ? ex.stageActive : ex.stage}
                aria-current={i === stageIndex ? "step" : undefined}
              >
                {i < stageIndex && <Icon name="check" size={14} />}
                {STATUS_LABEL[s]}
              </li>
            ))}
          </ol>
        )}
        {run.errorMessage && (
          <p className={run.status === "failed" ? styles.error : styles.muted} role={run.status === "failed" ? "alert" : undefined}>
            {run.errorMessage}
          </p>
        )}
        {run.budget.elapsedMs !== undefined && (
          <p className={styles.muted}>
            用量：检索 {run.budget.queries ?? 0} 次 · 提取 {run.budget.extractPages ?? 0} 页 · 模型 {run.budget.modelCalls ?? 0} 次 · 重试{" "}
            {run.budget.retries ?? 0} 次 · 耗时 {Math.round((run.budget.elapsedMs ?? 0) / 1000)} 秒
          </p>
        )}
      </div>

      {run.status === "done" && candidates.length === 0 && (
        <div className={styles.card}>
          <p>资料不足，这次没有形成候选。</p>
          <p className={styles.muted}>可以换个问法、粘贴具体资料原文，或稍后再试。不会凭空编写候选。</p>
        </div>
      )}

      {candidates.length > 0 && (
        <>
          <h2 className={ex.heading}>候选实践（{candidates.length}）</h2>
          <p className={styles.muted}>
            候选只说明与问题的关联，不代表适合你。前置条件默认「未知」，只有你确认后才算具备。
          </p>
          <div className={ex.grid}>
            {candidates.map((c) => (
              <CandidateCard key={c.id} candidate={c} evidenceById={evidenceById} onChange={refresh} />
            ))}
          </div>
        </>
      )}

      {evidence.length > 0 && (
        <div className={styles.card} style={{ marginTop: 16 }}>
          <h2>来源（{evidence.length}）</h2>
          {evidence.map((e) => (
            <div key={e.id} className={styles.logItem}>
              <div className={ex.row}>
                <span className={`${ex.status} ${e.status === "snippet" ? ex.unknown : ex.met}`}>{EVIDENCE_LABEL[e.status]}</span>
                {e.url ? (
                  <a href={e.url} target="_blank" rel="noreferrer noopener">
                    {e.title || e.url}
                  </a>
                ) : (
                  <span>{e.title}</span>
                )}
              </div>
              <div className={styles.muted}>
                获取于 {new Date(e.retrievedAt).toLocaleString("zh-CN")}
                {e.publishedAt ? ` · 发布 ${e.publishedAt.slice(0, 10)}` : " · 发布时间未知"}
                {` · ${e.length} 字`}
              </div>
            </div>
          ))}
        </div>
      )}

      {run.diagnostics.length > 0 && (
        <details className={styles.card}>
          <summary>运行诊断（{run.diagnostics.length}）</summary>
          <ul className={ex.list}>
            {run.diagnostics.map((d, i) => (
              <li key={i}>
                <span className={styles.muted}>[{STATUS_LABEL[d.stage] ?? d.stage}]</span> {d.message}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
