"use client";

import { useCallback, useEffect, useState } from "react";
import { api } from "./api";
import ErrorNote, { toErrorState } from "./ErrorNote";
import styles from "./dash.module.css";
import type { CapabilityState, ModelCapabilities, ModelCapabilitiesView } from "@/contracts/model-capabilities";

/** 模型端点能力：实测结论，unknown 表示没测出结论，不是“不支持”。重探会发出约 5 次请求并计入今日额度 */

const ROWS: Array<{ key: "text" | "jsonSchema" | "tools" | "vision"; label: string; use: string }> = [
  { key: "text", label: "文本", use: "基础连通" },
  { key: "jsonSchema", label: "结构化输出", use: "按 schema 约束输出" },
  { key: "tools", label: "工具调用", use: "先查事实再决定" },
  { key: "vision", label: "图片输入", use: "课表/校历截图" },
];

function Badge({ state }: { state: CapabilityState }) {
  if (state === "supported") return <span className={`${styles.badge} ${styles.badgeOk}`}>支持</span>;
  if (state === "unsupported") return <span className={`${styles.badge} ${styles.badgeOverdue}`}>不支持</span>;
  return <span className={`${styles.badge} ${styles.badgeOutline}`}>未知</span>;
}

export default function ModelCapabilitiesCard() {
  const [view, setView] = useState<ModelCapabilitiesView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; status?: number } | null>(null);

  const refresh = useCallback(() => {
    api<{ view: ModelCapabilitiesView }>("/api/v1/integrations/model-capabilities")
      .then((r) => setView(r.view))
      .catch((e) => setError(toErrorState(e, "加载失败")));
  }, []);
  useEffect(refresh, [refresh]);

  async function probe() {
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ view: ModelCapabilitiesView }>("/api/v1/integrations/model-capabilities", { method: "POST", body: {} });
      setView(r.view);
    } catch (e) {
      setError(toErrorState(e));
    } finally {
      setBusy(false);
    }
  }

  if (!view) return null;
  const caps: ModelCapabilities | null = view.state === "current" ? view.capabilities : view.state === "stale" ? view.previous : null;

  return (
    <div className={styles.card}>
      <h2 className={styles.sectionTitle}>模型端点能力</h2>
      {view.state === "not_probed" && <p className={styles.muted}>还没有实测过。未实测时按兼容方式调用模型（只要求 JSON 输出，不使用工具调用）。</p>}
      {view.state === "stale" && <p className={styles.muted}>模型配置已变化，下面是旧端点的结论，当前不使用；请重新探测。</p>}
      {caps && (
        <>
          <div className={styles.strip}>
            {ROWS.map(({ key, label, use }) => (
              <div key={key} className={styles.stripItem}>
                <span className={styles.stripLabel}>{label}</span>
                <span className={styles.stripValueText}>
                  <Badge state={caps[key]} />
                </span>
                <span className={styles.stripNote}>{caps.details[key] ?? use}</span>
              </div>
            ))}
          </div>
          <p className={styles.muted}>
            模型 {caps.model} · 探测于 {new Date(caps.probedAt).toLocaleString()}
            {caps.details.note ? ` · ${caps.details.note}` : ""}
          </p>
        </>
      )}
      <div className={styles.actionsRow}>
        <button className={styles.btn} disabled={busy} onClick={probe}>
          {busy ? "探测中…" : "重新探测"}
        </button>
        <span className={styles.muted}>会发出约 5 次真实请求，计入今日模型额度。</span>
      </div>
      <ErrorNote error={error} />
    </div>
  );
}
