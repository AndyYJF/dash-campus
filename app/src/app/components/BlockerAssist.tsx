"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, newIdempotencyKey } from "./api";
import ErrorNote, { toErrorState } from "./ErrorNote";
import Icon from "./Icon";
import ProposalCard from "./ProposalCard";
import styles from "./dash.module.css";
import ex from "./explore.module.css";
import type { ProposalRow } from "@/repositories/proposals";
import type { TaskRow } from "@/repositories/planning";

/**
 * "分析这个卡点"（第 6 节：保存日志后显示入口，主人点击才分析，不发 AI 邮件）。
 * 默认范围：记录所属项目，否则当前周；展开后显示实际读取范围、可能原因、下一步和最多 1 份提案。
 */

type Result = {
  explanations: Array<{ text: string; evidenceIds: string[] }>;
  nextSteps: string[];
  followUpQuestion: string | null;
  proposalIds: string[];
  dropped: string[];
  insufficientReason: string | null;
  readScope: { logIds: string[]; taskIds: string[]; projectId: string | null };
};

type Req = { id: string; status: string; result: Result | null; errorMessage: string | null; integrationMode: string | null };

export default function BlockerAssist({ log }: { log: { id: string; projectId: string | null; blocker: string } }) {
  const [open, setOpen] = useState(false);
  const [req, setReq] = useState<Req | null>(null);
  const [proposals, setProposals] = useState<ProposalRow[]>([]);
  const [tasks, setTasks] = useState<TaskRow[]>([]);
  const [error, setError] = useState<{ message: string; status?: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const keyRef = useRef<string | null>(null);

  const load = useCallback(
    (requestId: string) => {
      api<{ request: Req; proposals: ProposalRow[] }>(`/api/v1/assistant/requests/${requestId}`)
        .then((r) => {
          setReq(r.request);
          setProposals(r.proposals);
        })
        .catch((e) => setError(toErrorState(e, "加载失败")));
    },
    [],
  );

  // 打开时读取这条记录最近一次分析
  useEffect(() => {
    if (!open || req) return;
    api<{ requests: Req[] }>(`/api/v1/assistant/requests?logId=${log.id}`)
      .then((r) => r.requests[0] && load(r.requests[0].id))
      .catch(() => {});
    api<{ tasks: TaskRow[] }>("/api/v1/tasks").then((r) => setTasks(r.tasks)).catch(() => {});
  }, [open, req, log.id, load]);

  const running = req && (req.status === "queued" || req.status === "running");
  useEffect(() => {
    if (!running || !req) return;
    const t = setInterval(() => load(req.id), 2500);
    return () => clearInterval(t);
  }, [running, req, load]);

  const taskMap = useMemo(() => new Map(tasks.map((t) => [t.id, t])), [tasks]);

  async function start(rerun: boolean) {
    setBusy(true);
    setError(null);
    const key = keyRef.current ?? newIdempotencyKey();
    keyRef.current = key;
    try {
      const r = await api<{ requestId: string }>("/api/v1/assistant/requests", {
        method: "POST",
        idempotencyKey: key,
        body: {
          scopeType: log.projectId ? "project" : "week",
          scopeId: log.projectId,
          question: "分析这个卡点：可能的原因和可以验证的下一步",
          logId: log.id,
          rerun,
        },
      });
      keyRef.current = null;
      load(r.requestId);
    } catch (e) {
      setError(toErrorState(e, "发起失败"));
    } finally {
      setBusy(false);
    }
  }

  if (!log.blocker.trim()) return null;
  const res = req?.result;

  return (
    <div style={{ marginTop: 6 }}>
      {!open ? (
        <button className={`${styles.btn} ${styles.btnGhost}`} onClick={() => setOpen(true)} aria-expanded={false}>
          <Icon name="sparkles" size={15} />
          分析这个卡点
        </button>
      ) : (
        <div className={ex.draft}>
          <div className={ex.row}>
            <strong style={{ flex: 1 }}>卡点分析</strong>
            <button className={`${styles.btn} ${styles.btnGhost}`} onClick={() => setOpen(false)} aria-label="收起卡点分析">
              收起
            </button>
          </div>
          <p className={styles.muted}>范围：{log.projectId ? "这条记录所属项目最近 7 天的记录与任务" : "本周的记录与关联任务"}</p>
          {!req && (
            <button className={`${styles.btn} ${styles.btnPrimary}`} disabled={busy} onClick={() => start(false)}>
              {busy ? "提交中…" : "开始分析"}
            </button>
          )}
          {running && <p className={styles.muted}>分析中…</p>}
          {req?.integrationMode === "fixture" && <p className={ex.banner}>示例数据（非真实模型）</p>}
          {req?.status === "failed" && <p className={styles.error}>{req.errorMessage ?? "分析失败"}</p>}
          {res && (
            <>
              <p className={styles.muted}>
                实际读取：{res.readScope.logIds.length} 条记录、{res.readScope.taskIds.length} 个任务
              </p>
              {res.insufficientReason && <p>{res.insufficientReason}</p>}
              {res.explanations.length > 0 && (
                <>
                  <span className={ex.fieldLabel}>可能的原因（推测）</span>
                  <ul className={ex.list}>
                    {res.explanations.map((x, i) => (
                      <li key={i}>{x.text}</li>
                    ))}
                  </ul>
                </>
              )}
              {res.nextSteps.length > 0 && (
                <>
                  <span className={ex.fieldLabel}>可以验证的下一步</span>
                  <ul className={ex.list}>
                    {res.nextSteps.map((x, i) => (
                      <li key={i}>{x}</li>
                    ))}
                  </ul>
                </>
              )}
              {res.followUpQuestion && <p>需要你补充：{res.followUpQuestion}</p>}
              {proposals.map((p) => (
                <ProposalCard key={p.id} proposal={p} tasks={taskMap} onChanged={() => load(req!.id)} />
              ))}
              {res.dropped.length > 0 && (
                <details>
                  <summary className={styles.muted}>未采用的模型输出（{res.dropped.length}）</summary>
                  <ul className={ex.list}>
                    {res.dropped.map((d, i) => (
                      <li key={i} className={styles.muted}>
                        {d}
                      </li>
                    ))}
                  </ul>
                </details>
              )}
              <button className={styles.btn} disabled={busy} onClick={() => start(true)}>
                重新分析
              </button>
            </>
          )}
          <ErrorNote error={error} />
        </div>
      )}
    </div>
  );
}
