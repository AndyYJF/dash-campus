"use client";

import { useCallback, useEffect, useState } from "react";
import { api } from "./api";
import ErrorNote, { toErrorState } from "./ErrorNote";
import styles from "./dash.module.css";
import ex from "./explore.module.css";

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
      <p>
        今天（{usage.localDate}）：模型 {usage.modelCalls}/{budget.dailyModelCalls} 次 · 搜索 {usage.searchCalls}/{budget.dailySearchCalls} 次
        {usage.inputTokens + usage.outputTokens > 0 && ` · token 输入 ${usage.inputTokens} / 输出 ${usage.outputTokens}`}
      </p>
      <p className={styles.muted}>只统计次数与 token，不估算费用。达到上限后暂停探索、复盘推测和卡点分析，截止提醒照常。</p>
      <div className={ex.row}>
        <label className={ex.fieldLabel}>
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
        <label className={ex.fieldLabel}>
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
      <label className={ex.inlineLabel}>
        <input type="checkbox" checked={form.scheduledEnabled} onChange={(e) => set({ scheduledEnabled: e.target.checked })} />
        允许定期任务（定期探索、定期周复盘）
      </label>
      <label className={ex.inlineLabel}>
        <input
          type="checkbox"
          checked={form.weeklyReview !== null}
          onChange={(e) => set({ weeklyReview: e.target.checked ? { weekday: 7, localTime: "20:00" } : null })}
        />
        每周自动生成上周复盘
      </label>
      {form.weeklyReview && (
        <div className={ex.row}>
          <select
            aria-label="周复盘在周几"
            className={styles.field}
            style={{ width: "auto" }}
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
            style={{ width: "auto" }}
            value={form.weeklyReview.localTime}
            onChange={(e) => e.target.value && set({ weeklyReview: { ...form.weeklyReview!, localTime: e.target.value } })}
          />
        </div>
      )}
      <button className={`${styles.btn} ${styles.btnPrimary}`} onClick={save}>
        保存
      </button>
      {saved && <span className={styles.muted} role="status"> 已保存</span>}
      <ErrorNote error={error} />
    </div>
  );
}
