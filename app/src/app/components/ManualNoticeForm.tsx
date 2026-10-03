"use client";
import { useRef, useState } from "react";
import { api, newIdempotencyKey } from "./api";
import { useDraft } from "./useDraft";
import styles from "./dash.module.css";
export default function ManualNoticeForm({ onCreated }: { onCreated: () => void }) {
  const { value: v, update, clear, persisted } = useDraft("manual-notice-v1", { text: "", sourceUrl: "", occurredAt: "" });
  const [busy, setBusy] = useState(false), [message, setMessage] = useState("");
  const [createdId, setCreatedId] = useState<string | null>(null);
  const request = useRef<{ content: string; body: unknown; key: string } | null>(null);
  async function save() {
    setBusy(true); setMessage("");
    const content = JSON.stringify(v);
    const saved = request.current?.content === content ? request.current : { content, body: { text: v.text, ...(v.sourceUrl.trim() ? { sourceUrl: v.sourceUrl.trim() } : {}), occurredAt: v.occurredAt ? new Date(v.occurredAt).toISOString() : new Date().toISOString() }, key: newIdempotencyKey() };
    request.current = saved;
    try {
      const result = await api<{ id: string }>("/api/v1/inbox/manual", { method: "POST", body: saved.body, idempotencyKey: saved.key });
      clear(); setCreatedId(result.id); setMessage("通知原文已保存，可在详情中查看提取进度与依据。"); onCreated();
    } catch (e) { setMessage(e instanceof Error ? e.message : "保存失败"); } finally { setBusy(false); }
  }
  return <section className={styles.card}><details><summary>粘贴一条通知</summary><form className={styles.subForm} onSubmit={(e) => { e.preventDefault(); void save(); }}>
    <label className={styles.label}>通知原文<textarea className={styles.field} rows={6} value={v.text} onChange={(e) => update({ text: e.target.value })} /></label>
    <div className={styles.formGrid}><label className={styles.label}>来源链接（可留空）<input className={styles.field} type="url" value={v.sourceUrl} onChange={(e) => update({ sourceUrl: e.target.value })} /></label><label className={styles.label}>通知时间（设备时区；留空为录入时间）<input className={styles.field} type="datetime-local" value={v.occurredAt} onChange={(e) => update({ occurredAt: e.target.value })} /></label></div>
    <p className={styles.muted}>保存后排队提取条件与行动。身份需在设置中由你填写；原文不会自动变成任务。草稿{persisted ? "已存本机" : "仅在当前页面中"}。</p>
    <button className={`${styles.btn} ${styles.btnPrimary}`} disabled={busy || !v.text.trim()}>保存通知</button>
  </form></details>{message && <p className={styles.notice} role="status">{message} {createdId && <a href={`/inbox/${createdId}`}>打开通知详情</a>}</p>}</section>;
}
