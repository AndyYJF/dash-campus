"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { api, newIdempotencyKey } from "./api";
import ErrorNote, { toErrorState } from "./ErrorNote";
import ProposalCard from "./ProposalCard";
import styles from "./dash.module.css";
import ex from "./explore.module.css";
import type { ProposalRow } from "@/repositories/proposals";
import type { TaskRow } from "@/repositories/planning";

/**
 * 回顾页（T6）：生成周复盘、复盘列表、所有待处理建议（逐份整体处理）。
 * 没有记录时说明依据不足，允许手写复盘（在复盘详情里）。
 */

type ReviewSummary = {
  id: string;
  localMonday: string;
  trigger: "manual" | "scheduled";
  status: string;
  aiSkippedReason: string | null;
  integrationMode: string | null;
  hasOwnerEdit: boolean;
  createdAt: string;
};

export const REVIEW_STATUS: Record<string, string> = {
  queued: "排队中",
  generating: "生成中",
  ready: "已生成",
  insufficient: "记录不足",
  failed: "失败",
  cancelled: "已取消",
};

function lastMonday(): string {
  const now = new Date(Date.now() + 8 * 3600_000); // 实例时区 Asia/Shanghai
  const dow = (now.getUTCDay() + 6) % 7;
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - dow - 7));
  return d.toISOString().slice(0, 10);
}

export default function ReviewsView() {
  const router = useRouter();
  const [reviews, setReviews] = useState<ReviewSummary[]>([]);
  const [proposals, setProposals] = useState<ProposalRow[]>([]);
  const [tasks, setTasks] = useState<TaskRow[]>([]);
  const [error, setError] = useState<{ message: string; status?: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [monday, setMonday] = useState(lastMonday);
  const keyRef = useRef<{ monday: string; key: string } | null>(null);

  const refresh = useCallback(() => {
    api<{ reviews: ReviewSummary[] }>("/api/v1/reviews").then((r) => setReviews(r.reviews)).catch((e) => setError(toErrorState(e, "加载失败")));
    api<{ proposals: ProposalRow[] }>("/api/v1/proposals").then((r) => setProposals(r.proposals)).catch(() => {});
    api<{ tasks: TaskRow[] }>("/api/v1/tasks").then((r) => setTasks(r.tasks)).catch(() => {});
  }, []);
  useEffect(refresh, [refresh]);

  const running = reviews.some((r) => r.status === "queued" || r.status === "generating");
  useEffect(() => {
    if (!running) return;
    const t = setInterval(refresh, 3000);
    return () => clearInterval(t);
  }, [running, refresh]);

  const taskMap = useMemo(() => new Map(tasks.map((t) => [t.id, t])), [tasks]);
  const pending = proposals.filter((p) => p.status === "pending");
  const decided = proposals.filter((p) => p.status !== "pending").slice(0, 10);

  async function generate() {
    setBusy(true);
    setError(null);
    const key = keyRef.current?.monday === monday ? keyRef.current.key : newIdempotencyKey();
    keyRef.current = { monday, key };
    try {
      const r = await api<{ reviewId: string }>("/api/v1/reviews/generate", { method: "POST", body: { localMonday: monday }, idempotencyKey: key });
      keyRef.current = null;
      router.push(`/reviews/${r.reviewId}`);
    } catch (e) {
      setError(toErrorState(e, "生成失败"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={styles.columns}>
      <div>
        <h2 className={ex.heading}>待处理的建议（{pending.length}）</h2>
        <p className={styles.muted} style={{ marginBottom: 16 }}>
          每份建议独立处理，只能整体应用、拒绝或暂缓。
        </p>
        {pending.length === 0 && <p className={styles.empty}>没有待处理的建议。生成一次周复盘，或在记录旁点「分析这个卡点」，这里就会出现建议。</p>}
        {pending.map((p) => (
          <ProposalCard key={p.id} proposal={p} tasks={taskMap} onChanged={refresh} />
        ))}
        {decided.length > 0 && (
          <details className={styles.card}>
            <summary>最近处理过的建议（{decided.length}）</summary>
            {decided.map((p) => (
              <ProposalCard key={p.id} proposal={p} tasks={taskMap} onChanged={refresh} />
            ))}
          </details>
        )}
      </div>

      <div>
        <div className={styles.card}>
          <h2>周复盘</h2>
          <label className={ex.fieldLabel} htmlFor="rv-week">
            复盘哪一周（周一）
          </label>
          <div className={ex.row}>
            <input
              id="rv-week"
              type="date"
              className={styles.field}
              value={monday}
              onChange={(e) => setMonday(e.target.value)}
            />
            <button className={`${styles.btn} ${styles.btnPrimary}`} disabled={busy || !monday} onClick={generate}>
              {busy ? "提交中…" : "生成复盘"}
            </button>
          </div>
          <p className={styles.muted}>事实由记录直接汇总；配置了模型时另给推测与最多 3 份建议。没有记录时不会编写结论。</p>
          <ErrorNote error={error} />
        </div>
        <div className={styles.card}>
          <h2>复盘记录</h2>
          {reviews.length === 0 && <p className={styles.empty}>还没有复盘。</p>}
          {reviews.map((r) => (
            <div key={r.id} className={styles.taskRow}>
              <span className={styles.taskTitle}>
                <Link href={`/reviews/${r.id}`}>{r.localMonday} 起的一周</Link>
              </span>
              {r.trigger === "scheduled" && <span className={styles.badge}>定期</span>}
              {r.integrationMode === "fixture" && <span className={styles.badge}>示例数据</span>}
              {r.hasOwnerEdit && <span className={styles.badge}>有本人修订</span>}
              <span className={styles.taskMeta}>{REVIEW_STATUS[r.status] ?? r.status}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
