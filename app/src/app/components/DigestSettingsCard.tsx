"use client";
import { useEffect, useState } from "react";
import { api } from "./api";
import styles from "./dash.module.css";
import type { DigestSettings, DigestKind } from "@/contracts/digests";
export default function DigestSettingsCard() {
  const [data, setData] = useState<{ settings: DigestSettings; version: number } | null>(null), [message, setMessage] = useState(""), [preview, setPreview] = useState<{ subject: string; text: string; html: string } | null>(null);
  useEffect(() => { api<{ settings: DigestSettings; version: number }>("/api/v1/digests").then(setData).catch((e) => setMessage(e.message)); }, []);
  if (!data) return <p className={styles.muted}>{message || "正在加载摘要配置…"}</p>;
  const cfg = data.settings;
  function update(patch: Partial<DigestSettings>) { setData({ settings: { ...cfg, ...patch }, version: data!.version }); }
  async function save() { try { setData(await api("/api/v1/digests", { method: "PUT", body: { ...cfg, expectedVersion: data!.version } })); setMessage("摘要通知设置已保存；由后台 worker 按实例时区运行。"); } catch (e) { setMessage(e instanceof Error ? e.message : "保存失败"); } }
  async function show(kind: DigestKind) { try { setPreview(await api("/api/v1/digests/preview", { method: "POST", body: { kind } })); } catch (e) { setMessage(e instanceof Error ? e.message : "预览失败"); } }
  return <section className={styles.card}><h2>主动摘要通知</h2><p className={styles.muted}>默认关闭。统一发送到部署配置的收件地址，继承邮件前缀、颜色、摘要长度和隐私模式；预览使用已保存的邮件模板。每天 / 每周合并探索结果，不逐条发送。</p>
    <div className={styles.formGrid}><label className={styles.check}><input type="checkbox" checked={cfg.dailyEnabled} onChange={(e) => update({ dailyEnabled: e.target.checked })} />每日状态与行动</label><label className={styles.label}>每日发送时间<input type="time" className={styles.field} value={cfg.dailyTime} onChange={(e) => update({ dailyTime: e.target.value })} /></label>
    <label className={styles.check}><input type="checkbox" checked={cfg.weeklyEnabled} onChange={(e) => update({ weeklyEnabled: e.target.checked })} />每周回顾摘要</label><label className={styles.label}>每周哪一天<select className={styles.field} value={cfg.weeklyWeekday} onChange={(e) => update({ weeklyWeekday: Number(e.target.value) })}>{["一", "二", "三", "四", "五", "六", "日"].map((d, i) => <option key={d} value={i + 1}>周{d}</option>)}</select></label><label className={styles.label}>每周发送时间<input type="time" className={styles.field} value={cfg.weeklyTime} onChange={(e) => update({ weeklyTime: e.target.value })} /></label>
    <label className={styles.check}><input type="checkbox" checked={cfg.systemEnabled} onChange={(e) => update({ systemEnabled: e.target.checked })} />有新后台失败或未知投递时通知</label></div>
    <div className={styles.actionsRow}><button className={`${styles.btn} ${styles.btnPrimary}`} onClick={() => void save()}>保存摘要设置</button>{(["daily", "weekly", "system"] as DigestKind[]).map((kind) => <button key={kind} className={styles.btn} onClick={() => void show(kind)}>预览{{ daily: "每日", weekly: "每周", system: "异常" }[kind]}</button>)}</div>
    {preview && <details open><summary>{preview.subject}</summary><pre className={styles.previewText}>{preview.text}</pre><iframe sandbox="" title="摘要邮件预览" srcDoc={preview.html} className={styles.previewFrame} /></details>}{message && <p className={styles.notice} role="status">{message}</p>}
  </section>;
}
