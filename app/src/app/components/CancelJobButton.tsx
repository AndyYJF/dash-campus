"use client";

import { useState } from "react";
import { api } from "./api";
import ErrorNote, { toErrorState } from "./ErrorNote";
import styles from "./dash.module.css";

export default function CancelJobButton({ jobId, onChanged }: { jobId: string; onChanged: () => void }) {
  const [busy, setBusy] = useState(false), [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<{ message: string; status?: number } | null>(null);
  async function cancel() {
    setBusy(true); setError(null);
    try {
      const result = await api<{ result: string }>(`/api/v1/jobs/${jobId}/cancel`, { method: "POST" });
      setMessage(result.result === "cancel_requested" ? "取消请求已记录；等待运行中的调用返回，不再发布分析结果。" : result.result === "finished" ? "作业已经结束，结果保留。" : "已取消。已发出的网络请求无法撤回。");
      onChanged();
    } catch (e) { setError(toErrorState(e, "取消失败，作业状态保持原样")); }
    finally { setBusy(false); }
  }
  return <div><button type="button" className={styles.btn} disabled={busy || Boolean(message)} onClick={() => void cancel()}>{busy ? "取消中…" : "取消生成"}</button>{message && <p className={styles.muted} role="status">{message}</p>}<ErrorNote error={error} /></div>;
}
