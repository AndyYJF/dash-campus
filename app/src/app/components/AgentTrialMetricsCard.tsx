"use client";

import { useEffect, useState } from "react";
import { api } from "./api";
import ErrorNote, { toErrorState } from "./ErrorNote";
import styles from "./dash.module.css";
import type { TrialMetrics } from "@/workflows/agent-metrics";

/** 七天试用指标：只读聚合，打开设置页时计算，不调模型、不写库 */

const PURPOSE: Record<string, string> = { confirm: "确认", agent_clarification: "追问", tradeoff: "取舍", locate: "指哪一个", conflict: "冲突" };
const VERDICT: Record<string, string> = { wrong_intent: "意思理解错", wrong_object: "对象/时间找错", should_ask: "应该先问", should_not_ask: "不该问", other: "其他" };
const pct = (n: number | null) => (n === null ? "—" : `${Math.round(n * 100)}%`);
const sec = (ms: number | null) => (ms === null ? "—" : `${(ms / 1000).toFixed(1)}s`);

export default function AgentTrialMetricsCard() {
  const [m, setM] = useState<TrialMetrics | null>(null);
  const [error, setError] = useState<{ message: string; status?: number } | null>(null);

  useEffect(() => {
    api<{ metrics: TrialMetrics }>("/api/v2/agent-metrics?days=7")
      .then((r) => setM(r.metrics))
      .catch((e) => setError(toErrorState(e, "加载失败")));
  }, []);

  if (!m) return error ? <div className={styles.card}><ErrorNote error={error} /></div> : null;
  const o = m.outcomes;
  const strip: Array<{ label: string; value: string; note: string }> = [
    { label: "投递", value: String(m.intakes), note: `${m.window.from} 至 ${m.window.to}` },
    { label: "模型理解", value: String(m.routing.model), note: `规则兜底 ${m.routing.rules} · 快速通道 ${m.routing.fast} · 未路由 ${m.routing.other}` },
    { label: "问过你", value: pct(m.asking.rate), note: `${m.asking.intakesAsked} 条投递` },
    { label: "核验通过", value: String(o.verified), note: `部分 ${o.partial} · 待决定 ${o.needs_action} · 受阻 ${o.blocked}` },
    { label: "自动修正", value: String(m.repairs.total), note: `${m.repairs.intakes} 条投递 · 上限停下 ${m.repairs.stoppedByLimit}` },
    { label: "理解错了", value: String(m.feedback.total), note: m.feedback.byVerdict.map((v) => `${VERDICT[v.verdict] ?? v.verdict} ${v.n}`).join(" · ") || "没有反馈" },
  ];

  return (
    <div className={styles.card}>
      <h2 className={styles.sectionTitle}>试用指标（近 {m.window.days} 天）</h2>
      <div className={styles.strip}>
        {strip.map((s) => (
          <div key={s.label} className={styles.stripItem}>
            <span className={styles.stripLabel}>{s.label}</span>
            <span className={styles.stripValue}>{s.value}</span>
            <span className={styles.stripNote}>{s.note}</span>
          </div>
        ))}
      </div>
      <p className={styles.muted}>
        没办成 {o.failed} · 已取消 {o.cancelled} · 等回答 {o.pending} · 无核验 {o.unverified}
        {m.asking.byPurpose.length > 0 && ` · 问题类型：${m.asking.byPurpose.map((p) => `${PURPOSE[p.purpose] ?? p.purpose} ${p.n}`).join("、")}`}
        {m.routing.fallbackReasons.length > 0 && ` · 兜底原因：${m.routing.fallbackReasons.map((r) => `${r.reason}（${r.n}）`).join("、")}`}
      </p>
      <table className={styles.table}>
        <thead>
          <tr>
            <th>日期</th>
            <th>模型请求</th>
            <th>出错</th>
            <th>理解/决策</th>
            <th>延迟 p50 / p95</th>
          </tr>
        </thead>
        <tbody>
          {m.daily.map((d) => (
            <tr key={d.date}>
              <td data-label="日期">{d.date.slice(5)}</td>
              <td data-label="模型请求">{d.requests}</td>
              <td data-label="出错">{d.errors}</td>
              <td data-label="理解/决策">{d.decisions}</td>
              <td data-label="延迟">{sec(d.p50Ms)} / {sec(d.p95Ms)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {m.notes.map((n) => (
        <p key={n} className={styles.muted}>{n}</p>
      ))}
    </div>
  );
}
