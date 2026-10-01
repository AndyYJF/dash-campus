"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { api } from "./api";
import ErrorNote, { toErrorState } from "./ErrorNote";
import ProposalCard from "./ProposalCard";
import { useDraft } from "./useDraft";
import { REVIEW_STATUS } from "./ReviewsView";
import BackLink from "./BackLink";
import styles from "./dash.module.css";
import ex from "./explore.module.css";
import type { ProposalRow } from "@/repositories/proposals";
import type { TaskRow } from "@/repositories/planning";
import type { WeekFacts } from "@/workflows/week-facts";

/**
 * 复盘详情（产品计划 5 回顾页）：事实记录、成果、主人判断与模型推测分开；
 * 建议逐份展示理由、依据、前后值；没有记录时说明依据不足，允许手写复盘。
 */

type Review = {
  id: string;
  localMonday: string;
  status: string;
  facts: WeekFacts | null;
  aiDraft: {
    factNotes: Array<{ text: string; evidenceIds: string[] }>;
    observations: Array<{ text: string; evidenceIds: string[] }>;
    proposalIds: string[];
    dropped: string[];
    insufficientReason: string | null;
  } | null;
  aiSkippedReason: string | null;
  integrationMode: string | null;
  errorMessage: string | null;
  ownerSummary: string;
  ownerNextWeek: string;
  version: number;
  generatedAt: string | null;
};

const SKIP: Record<string, string> = {
  not_configured: "模型未配置，只汇总了事实。",
  budget: "今日 AI 额度已用完，只汇总了事实。",
  no_records: "这一周没有记录，依据不足，没有生成推测或建议。",
  error: "AI 部分生成失败，事实部分不受影响。",
};

export default function ReviewDetailView() {
  const { id } = useParams<{ id: string }>();
  const [review, setReview] = useState<Review | null>(null);
  const [proposals, setProposals] = useState<ProposalRow[]>([]);
  const [tasks, setTasks] = useState<TaskRow[]>([]);
  const [edits, setEdits] = useState<Array<{ field: string; createdAt: string }>>([]);
  const [error, setError] = useState<{ message: string; status?: number } | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const draft = useDraft<{ summary: string; next: string; baseVersion: number }>(`review:${id}`, { summary: "", next: "", baseVersion: 0 });

  const refresh = useCallback(() => {
    api<{ review: Review; proposals: ProposalRow[]; edits: Array<{ field: string; createdAt: string }> }>(`/api/v1/reviews/${id}`)
      .then((r) => {
        setReview(r.review);
        setProposals(r.proposals);
        setEdits(r.edits);
      })
      .catch((e) => setError(toErrorState(e, "加载失败")));
    api<{ tasks: TaskRow[] }>("/api/v1/tasks").then((r) => setTasks(r.tasks)).catch(() => {});
  }, [id]);
  useEffect(refresh, [refresh]);

  // 没有本机草稿时用服务端的本人修订填充
  const { update } = draft;
  useEffect(() => {
    if (review && draft.value.baseVersion === 0) {
      update({ summary: review.ownerSummary, next: review.ownerNextWeek, baseVersion: review.version });
    }
  }, [review, draft.value.baseVersion, update]);

  const running = review && (review.status === "queued" || review.status === "generating");
  useEffect(() => {
    if (!running) return;
    const t = setInterval(refresh, 2500);
    return () => clearInterval(t);
  }, [running, refresh]);

  const labels = useMemo(() => {
    const m = new Map<string, string>();
    const f = review?.facts;
    if (!f) return m;
    for (const l of f.logs) m.set(l.id, `${l.occurredOn} 的记录`);
    for (const t of f.completedTasks) m.set(t.id, `任务「${t.title}」`);
    for (const t of f.openTasks) m.set(t.id, `任务「${t.title}」`);
    for (const a of f.artifacts) m.set(a.id, `成果「${a.title}」`);
    return m;
  }, [review]);
  const taskMap = useMemo(() => new Map(tasks.map((t) => [t.id, t])), [tasks]);

  if (!review) return error ? <ErrorNote error={error} /> : <p className={styles.muted}>加载中…</p>;
  const f = review.facts;
  const refs = (ids: string[]) => ids.map((x) => labels.get(x) ?? x.slice(0, 6)).join("、");

  async function saveOwner() {
    setBusy(true);
    setError(null);
    setSaved(null);
    try {
      const r = await api<{ review: Review }>(`/api/v1/reviews/${id}`, {
        method: "PATCH",
        body: { expectedVersion: review!.version, ownerSummary: draft.value.summary, ownerNextWeek: draft.value.next },
      });
      draft.clear({ summary: r.review.ownerSummary, next: r.review.ownerNextWeek, baseVersion: r.review.version });
      setSaved("已保存");
      refresh();
    } catch (e) {
      setError(toErrorState(e, "保存失败，内容已保留在本机"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <BackLink href="/reviews" label="回顾" />
      <h1>{review.localMonday} 起的一周</h1>
      <p className={styles.muted}>
        {REVIEW_STATUS[review.status] ?? review.status}
        {review.generatedAt && ` · 生成于 ${new Date(review.generatedAt).toLocaleString("zh-CN")}`}
      </p>
      {review.integrationMode === "fixture" && <p className={ex.banner}>AI 部分是示例数据（非真实模型）。</p>}

      <div className={styles.columns}>
        <div>
          <section className={styles.card} aria-labelledby="facts-h">
            <h2 id="facts-h">事实（来自你的记录）</h2>
            {!f && <p className={styles.muted}>{running ? "正在汇总…" : "没有事实数据。"}</p>}
            {f && (
              <>
                <p className={styles.muted}>
                  记录 {f.counts.logs} 条（含卡点 {f.counts.blockers}）· 完成任务 {f.counts.completed} · 新成果 {f.counts.artifacts}
                  {f.focus && ` · 本周重点：${f.focus.title}`}
                </p>
                {f.completedTasks.length > 0 && (
                  <>
                    <h3 className={styles.sectionTitle}>完成的任务</h3>
                    <ul className={ex.list}>
                      {f.completedTasks.map((t) => (
                        <li key={t.id}>{t.title}</li>
                      ))}
                    </ul>
                  </>
                )}
                {f.logs.length > 0 && (
                  <>
                    <h3 className={styles.sectionTitle}>记录</h3>
                    {f.logs.map((l) => (
                      <div key={l.id} className={styles.logItem}>
                        <div className={styles.taskMeta}>{l.occurredOn}</div>
                        {l.progress && <div>{l.progress}</div>}
                        {l.blocker && <div className={styles.muted}>卡点：{l.blocker}</div>}
                      </div>
                    ))}
                  </>
                )}
                {f.artifacts.length > 0 && (
                  <>
                    <h3 className={styles.sectionTitle}>成果</h3>
                    <ul className={ex.list}>
                      {f.artifacts.map((a) => (
                        <li key={a.id}>
                          <Link href={`/projects/${a.projectId}`}>{a.title}</Link>
                        </li>
                      ))}
                    </ul>
                  </>
                )}
                <p className={styles.muted}>
                  负担：已承诺 {f.workload.committedMinutes} 分钟
                  {f.workload.committedUnknownCount > 0 && `（另有 ${f.workload.committedUnknownCount} 项未估时）`}
                  {f.workload.weekCapacityMinutes === null ? " · 未配置可用时间" : ` · 可用 ${f.workload.weekCapacityMinutes} 分钟`}
                </p>
              </>
            )}
          </section>

          <section className={styles.card} aria-labelledby="ai-h">
            <h2 id="ai-h">模型推测</h2>
            {review.aiSkippedReason && <p className={styles.muted}>{SKIP[review.aiSkippedReason] ?? review.aiSkippedReason}</p>}
            {review.errorMessage && <p className={styles.muted}>{review.errorMessage}</p>}
            {review.aiDraft && (
              <>
                {review.aiDraft.observations.length === 0 && review.aiDraft.factNotes.length === 0 && (
                  <p className={styles.muted}>{review.aiDraft.insufficientReason ?? "没有形成推测。"}</p>
                )}
                {review.aiDraft.observations.map((o, i) => (
                  <div key={i} className={styles.logItem}>
                    {o.text}
                    <div className={styles.muted}>依据：{refs(o.evidenceIds)}</div>
                  </div>
                ))}
                {review.aiDraft.dropped.length > 0 && (
                  <details>
                    <summary className={styles.muted}>未采用的模型输出（{review.aiDraft.dropped.length}）</summary>
                    <ul className={ex.list}>
                      {review.aiDraft.dropped.map((d, i) => (
                        <li key={i} className={styles.muted}>
                          {d}
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
              </>
            )}
          </section>

          {proposals.length > 0 && <h2 style={{ fontSize: 16 }}>建议（{proposals.length}）</h2>}
          {proposals.map((p) => (
            <ProposalCard key={p.id} proposal={p} tasks={taskMap} evidenceLabels={labels} onChanged={refresh} />
          ))}
        </div>

        <div>
          <section className={styles.card} aria-labelledby="own-h">
            <h2 id="own-h">我的复盘</h2>
            <p className={styles.muted}>你自己的判断，和上面的事实、模型推测分开保存。</p>
            <label className={ex.fieldLabel}>
              这周怎么样
              <textarea className={styles.field} rows={5} value={draft.value.summary} onChange={(e) => draft.update({ summary: e.target.value })} />
            </label>
            <label className={ex.fieldLabel}>
              下周打算
              <textarea className={styles.field} rows={4} value={draft.value.next} onChange={(e) => draft.update({ next: e.target.value })} />
            </label>
            <button className={`${styles.btn} ${styles.btnPrimary}`} disabled={busy} onClick={saveOwner}>
              {busy ? "保存中…" : "保存"}
            </button>
            {saved && <span className={styles.muted} role="status"> {saved}</span>}
            <ErrorNote error={error} />
            {edits.length > 0 && <p className={styles.muted}>已修订 {edits.length} 次，最近 {new Date(edits[edits.length - 1].createdAt).toLocaleString("zh-CN")}</p>}
          </section>
        </div>
      </div>
    </div>
  );
}
