"use client";

import { useState } from "react";
import { api, ApiError } from "./api";
import { toErrorState } from "./ErrorNote";
import ErrorNote from "./ErrorNote";
import styles from "./dash.module.css";
import ex from "./explore.module.css";
import type { ProposalRow } from "@/repositories/proposals";
import type { TaskRow } from "@/repositories/planning";

/**
 * ProposalDiff（13.1 / U6）：每份提案的完整差异（修改前后值）、理由与依据、版本冲突反馈。
 * 只有整体应用/拒绝/暂缓，没有内部半选。过时（409）时显示原因，提案保持可查看。
 */

const STATUS: Record<string, string> = { todo: "待办", doing: "进行中", blocked: "受阻", done: "已完成", cancelled: "已取消" };
const REJECT: Array<[string, string]> = [
  ["not_useful", "没用"],
  ["wrong_basis", "依据不对"],
  ["no_time", "暂时没时间"],
  ["other", "其他"],
];
const SOURCE: Record<string, string> = { manual: "手动发起", assistant: "卡点分析", review: "周复盘" };

function fmt(iso: string | null): string {
  if (!iso) return "（无）";
  return new Date(iso).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

/** 次日 09:00（实例时区 Asia/Shanghai = +08:00） */
function tomorrowNine(): string {
  const now = new Date(Date.now() + 8 * 3600_000);
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 1, 0));
  return d.toISOString();
}

export default function ProposalCard({
  proposal: p,
  tasks,
  evidenceLabels,
  onChanged,
}: {
  proposal: ProposalRow;
  /** 当前任务（用于显示修改前的值）；缺失时只显示新值 */
  tasks: Map<string, TaskRow>;
  /** 依据 ID → 可读标签 */
  evidenceLabels?: Map<string, string>;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; status?: number } | null>(null);
  const [stale, setStale] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState(false);

  async function act(path: string, body: unknown) {
    setBusy(true);
    setError(null);
    try {
      await api(`/api/v1/proposals/${p.id}/${path}`, { method: "POST", body });
      onChanged();
    } catch (e) {
      if (e instanceof ApiError && e.status === 409 && path === "apply") {
        setStale(e.message);
      } else {
        setError(toErrorState(e));
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <article className={styles.card} id={p.id} aria-labelledby={`p-${p.id}`}>
      <div className={ex.row}>
        <strong id={`p-${p.id}`} style={{ flex: 1 }}>
          {p.reason || "（无标题提案）"}
        </strong>
        <span className={styles.badge}>{SOURCE[p.sourceKind] ?? p.sourceKind}</span>
        <span className={`${styles.badge} ${p.status === "pending" ? styles.badgeAccent : p.status === "applied" ? styles.badgeOk : ""}`}>
          {p.status === "pending" ? (p.snoozeUntil && new Date(p.snoozeUntil) > new Date() ? `暂缓至 ${fmt(p.snoozeUntil)}` : "待处理") : ({ applied: "已应用", rejected: "已拒绝", snoozed: "已暂缓" } as Record<string, string>)[p.status]}
        </span>
      </div>

      {p.contextRefs.length > 0 && (
        <p className={styles.muted} style={{ margin: "6px 0" }}>
          依据：{p.contextRefs.map((id) => evidenceLabels?.get(id) ?? `记录 ${id.slice(0, 6)}`).join("；")}
        </p>
      )}

      <div className={ex.fieldLabel}>将要执行（{p.operations.length} 项，整体应用）</div>
      <ul className={ex.list}>
        {p.operations.map((op, i) => {
          if (op.kind === "create_task") {
            return (
              <li key={i}>
                新建任务「{op.input.title}」
                {op.input.estimateMinutes !== null && ` · ${op.input.estimateMinutes} 分钟`}
                {op.input.plannedWeek && ` · 归入 ${op.input.plannedWeek.localMonday} 起的一周`}
              </li>
            );
          }
          const t = tasks.get(op.taskId);
          const name = t ? `「${t.title}」` : `任务 ${op.taskId.slice(0, 8)}`;
          if (op.kind === "set_task_status") {
            return (
              <li key={i}>
                {name} 状态：{t ? STATUS[t.status] : "?"} → <strong>{STATUS[op.status]}</strong>
              </li>
            );
          }
          return (
            <li key={i}>
              {name} 时段：{t ? `${fmt(t.scheduledStart)}–${fmt(t.scheduledEnd)}` : "?"} →{" "}
              <strong>
                {fmt(op.scheduledStart)}–{fmt(op.scheduledEnd)}
              </strong>
            </li>
          );
        })}
      </ul>

      {stale && (
        <p className={ex.banner} role="alert">
          这份提案已过时：{stale}。内容保留可查看，不会部分应用；需要时请重新分析或重新发起。
        </p>
      )}
      <ErrorNote error={error} />

      {p.status === "pending" && !stale && (
        <div className={ex.actions}>
          <button className={`${styles.btn} ${styles.btnPrimary}`} disabled={busy} onClick={() => act("apply", {})}>
            应用
          </button>
          <button className={styles.btn} disabled={busy} onClick={() => setRejecting((r) => !r)}>
            拒绝…
          </button>
          <button className={styles.btn} disabled={busy} onClick={() => act("snooze", { snoozeUntil: tomorrowNine(), expectedVersion: p.version })}>
            暂缓到明早
          </button>
        </div>
      )}
      {rejecting && p.status === "pending" && (
        <div className={ex.row} style={{ marginTop: 6 }}>
          {REJECT.map(([k, label]) => (
            <button key={k} className={styles.btn} disabled={busy} onClick={() => act("reject", { reason: k, expectedVersion: p.version })}>
              {label}
            </button>
          ))}
          <span className={styles.muted}>拒绝后 14 天内不会自动重复同样依据的建议</span>
        </div>
      )}
      {p.status === "applied" && p.resultRefs?.taskIds && p.resultRefs.taskIds.length > 0 && (
        <p className={styles.muted}>已新建 {p.resultRefs.taskIds.length} 个任务。</p>
      )}
    </article>
  );
}
