"use client";
import { useCallback, useEffect, useState } from "react";
import { api } from "./api";
import styles from "./dash.module.css";
import type { ProfileFactRow } from "@/repositories/profile";
import type { InboxSourceRow } from "@/repositories/inbox";
const fields = { education_level: "学历层次（如 本科 / 研究生）", program: "专业（如 人工智能）", campus: "校区（如 江安）", grade_year: "入学年份（如 2026）", study_year: "当前年级（如 一年级）" };
export default function ProfileSourcesCard() {
  const [facts, setFacts] = useState<ProfileFactRow[]>([]), [values, setValues] = useState<Record<string, string>>({}), [sources, setSources] = useState<InboxSourceRow[]>([]);
  const [message, setMessage] = useState(""), [token, setToken] = useState(""), [sourceId, setSourceId] = useState(""), [sourceTitle, setSourceTitle] = useState("");
  const refresh = useCallback(() => { Promise.all([api<{ facts: ProfileFactRow[] }>("/api/v1/profile"), api<{ sources: InboxSourceRow[] }>("/api/v1/inbox/sources")]).then(([f, s]) => { setFacts(f.facts); setValues(Object.fromEntries(f.facts.map((r) => [r.field, r.value]))); setSources(s.sources); }).catch((e) => setMessage(e.message)); }, []);
  useEffect(refresh, [refresh]);
  async function saveFacts() {
    const changes = Object.keys(fields).filter((field) => values[field]?.trim() && values[field] !== facts.find((f) => f.field === field)?.value).map((field) => ({ field, value: values[field].trim(), expectedVersion: facts.find((f) => f.field === field)?.version ?? 0 }));
    if (!changes.length) { setMessage("没有需要保存的身份变化。空白字段保持未知。"); return; }
    try { await api("/api/v1/profile", { method: "PATCH", body: { facts: changes } }); setMessage("身份已保存，通知判断已重新计算；已确认任务保持原内容。"); refresh(); } catch (e) { setMessage(e instanceof Error ? e.message : "保存失败"); }
  }
  async function create() {
    try { const r = await api<{ token: string }>("/api/v1/inbox/sources", { method: "POST", body: { id: sourceId, title: sourceTitle } }); setToken(r.token); setSourceId(""); setSourceTitle(""); refresh(); } catch (e) { setMessage(e instanceof Error ? e.message : "创建失败"); }
  }
  async function toggle(s: InboxSourceRow) {
    try { await api(`/api/v1/inbox/sources/${s.id}`, { method: "PATCH", body: { title: s.title || s.id, enabled: !s.enabled, expectedVersion: s.version } }); refresh(); } catch (e) { setMessage(e instanceof Error ? e.message : "更新失败"); }
  }
  return <><section className={styles.card}><h2>我的身份</h2><p className={styles.muted}>只使用你明确填写的身份筛选通知。入学年份与当前年级分别填写，升年级后请更新；不会根据年份自动推算。未知资格保留待确认，不由模型推测。</p>
    <div className={styles.formGrid}>{Object.entries(fields).map(([field, label]) => <label key={field} className={styles.label}>{label}<input className={styles.field} value={values[field] ?? ""} onChange={(e) => setValues({ ...values, [field]: e.target.value })} /></label>)}</div><button className={styles.btn} onClick={() => void saveFacts()}>保存身份并重评</button></section>
    <section className={styles.card}><h2>通知来源</h2>{sources.map((s) => <div key={s.id} className={styles.taskRow}><div className={styles.taskBody}><strong>{s.title || s.id}</strong><p className={styles.muted}>{s.id} · {s.enabled ? "允许导入" : "已停用；历史通知保留"}</p></div>{s.id !== "manual" && <button className={styles.btn} onClick={() => void toggle(s)}>{s.enabled ? "停用" : "启用"}</button>}</div>)}
      <details><summary>添加插件来源</summary><form className={styles.subForm} onSubmit={(e) => { e.preventDefault(); void create(); }}><div className={styles.formGrid}><label className={styles.label}>稳定标识（小写字母、数字、下划线）<input className={styles.field} value={sourceId} onChange={(e) => setSourceId(e.target.value)} /></label><label className={styles.label}>名称<input className={styles.field} value={sourceTitle} onChange={(e) => setSourceTitle(e.target.value)} /></label></div><button className={styles.btn}>创建来源</button></form></details>
      {token && <div className={styles.notice}><p>导入 token 只显示这一次，复制到你自己的插件配置中：</p><code style={{ overflowWrap: "anywhere" }}>{token}</code><p><button className={styles.btn} onClick={() => setToken("")}>已保存，隐藏 token</button></p></div>}
    </section>{message && <p className={styles.notice} role="status">{message}</p>}</>;
}
