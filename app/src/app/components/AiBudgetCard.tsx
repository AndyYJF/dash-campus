"use client";

import { useCallback, useEffect, useState } from "react";
import { api } from "./api";
import ErrorNote, { toErrorState } from "./ErrorNote";
import styles from "./dash.module.css";

/**
 * AI 预算与定期周复盘（产品计划 12）：次数上限，不估算金额；达到上限暂停非必要 AI 任务，截止提醒不受影响。
 */

type Budget = {
  dailyModelCalls: number;
  dailySearchCalls: number;
  scheduledEnabled: boolean;
  weeklyReview: { weekday: number; localTime: string } | null;
};
type Usage = { modelCalls: number; searchCalls: number; inputTokens: number; outputTokens: number; localDate: string };

const WEEKDAYS = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];

export default function AiBudgetCard() {
  const [budget, setBudget] = useState<Budget | null>(null);
  const [usage, setUsage] = useState<Usage | null>(null);
  const [version, setVersion] = useState(0);
  const [form, setForm] = useState<Budget | null>(null);
  const [error, setError] = useState<{ message: string; status?: number } | null>(null);
  const [saved, setSaved] = useState(false);

  const refresh = useCallback(() => {
    api<{ budget: Budget; version: number; usage: Usage }>("/api/v1/ai-budget")
      .then((r) => {
        setBudget(r.budget);
        setForm(r.budget);
        setVersion(r.version);
        setUsage(r.usage);
      })
      .catch((e) => setError(toErrorState(e, "加载失败")));
  }, []);
  useEffect(refresh, [refresh]);

  if (!form || !budget || !usage) return null;

  async function save() {
    setError(null);
    setSaved(false);
    try {
      const r = await api<{ budget: Budget; version: number; usage: Usage }>("/api/v1/ai-budget", {
        method: "PATCH",
        body: { expectedVersion: version, ...form },
      });
      setBudget(r.budget);
      setForm(r.budget);
      setVersion(r.version);
      setUsage(r.usage);
      setSaved(true);
    } catch (e) {
      setError(toErrorState(e));
      if ((e as { status?: number }).status === 409) refresh();
    }
  }

  const set = (patch: Partial<Budget>) => setForm({ ...form, ...patch });

  return (
    <div className={styles.card}>
      <h2 className={styles.sectionTitle}>AI 用量与预算</h2>
      <div className={styles.strip}>
        <UsageTile label="今日模型调用" used={usage.modelCalls} limit={budget.dailyModelCalls} />
        <UsageTile label="今日搜索调用" used={usage.searchCalls} limit={budget.dailySearchCalls} />
      </div>
      <p className={styles.muted}>
        统计日期 {usage.localDate}
        {usage.inputTokens + usage.outputTokens > 0 && ` · token 输入 ${usage.inputTokens} / 输出 ${usage.outputTokens}`}
        。只统计次数与 token，不估算费用。达到上限后暂停探索、复盘推测和卡点分析，截止提醒照常。
      </p>
      <div className={styles.formGrid}>
        <label className={styles.label}>
          每日模型调用上限
          <input
            className={styles.field}
            type="number"
            min={0}
            max={1000}
            value={form.dailyModelCalls}
            onChange={(e) => set({ dailyModelCalls: Number(e.target.value) })}
          />
        </label>
        <label className={styles.label}>
          每日搜索调用上限
          <input
            className={styles.field}
            type="number"
            min={0}
            max={1000}
            value={form.dailySearchCalls}
            onChange={(e) => set({ dailySearchCalls: Number(e.target.value) })}
          />
        </label>
      </div>
      <label className={styles.check}>
        <input type="checkbox" checked={form.scheduledEnabled} onChange={(e) => set({ scheduledEnabled: e.target.checked })} />
        允许定期任务（定期探索、定期周复盘）
      </label>
      <label className={styles.check}>
        <input
          type="checkbox"
          checked={form.weeklyReview !== null}
          onChange={(e) => set({ weeklyReview: e.target.checked ? { weekday: 7, localTime: "20:00" } : null })}
        />
        每周自动生成上周复盘
      </label>
      {form.weeklyReview && (
        <div className={styles.fieldRow}>
          <select
            aria-label="周复盘在周几"
            className={styles.field}
            value={form.weeklyReview.weekday}
            onChange={(e) => set({ weeklyReview: { ...form.weeklyReview!, weekday: Number(e.target.value) } })}
          >
            {WEEKDAYS.map((w, i) => (
              <option key={w} value={i + 1}>
                {w}
              </option>
            ))}
          </select>
          <input
            aria-label="周复盘本地时间"
            type="time"
            className={styles.field}
            value={form.weeklyReview.localTime}
            onChange={(e) => e.target.value && set({ weeklyReview: { ...form.weeklyReview!, localTime: e.target.value } })}
          />
        </div>
      )}
      <div className={styles.actionsRow}>
        <button className={`${styles.btn} ${styles.btnPrimary}`} onClick={save}>
          保存
        </button>
        {saved && (
          <span className={styles.muted} role="status">
            已保存
          </span>
        )}
      </div>
      <ErrorNote error={error} />
    </div>
  );
}

/** 用量小卡：已用 / 上限 + 进度条；上限为 0 表示已停用，不画进度条 */
function UsageTile({ label, used, limit }: { label: string; used: number; limit: number }) {
  const pct = limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0;
  const full = limit > 0 && used >= limit;
  return (
    <div className={styles.stripItem}>
      <span className={styles.stripLabel}>{label}</span>
      <span className={styles.stripValue}>
        {used}
        <span className={styles.stripUnit}> / {limit} 次</span>
      </span>
      {limit > 0 ? (
        <div className={styles.meter} role="img" aria-label={`${label}已用 ${pct}%`}>
          <div className={`${styles.meterFill} ${full ? styles.meterOver : ""}`} style={{ width: `${pct}%` }} />
        </div>
      ) : (
        <span className={styles.stripNote}>上限为 0，已停用</span>
      )}
    </div>
  );
}
