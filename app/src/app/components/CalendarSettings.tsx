"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, newIdempotencyKey } from "./api";
import styles from "./dash.module.css";
import type { AvailabilityRow, FixedEventRow } from "@/domain/workload";
import type { CalendarOccurrence } from "@/domain/calendar-occurrences";
import TimetableImport from "./TimetableImport";

type Exception = { event_id: string; local_date: string; cancelled: number; local_start: string | null; local_end: string | null; version: number };
type Calendar = { availabilityBlocks: AvailabilityRow[]; fixedEvents: FixedEventRow[]; exceptions: Exception[]; bufferPercent: number; planningRevision: number;occurrences:CalendarOccurrence[] };
type Kind = "availability" | "fixed-event";
const weekdays = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];

export default function CalendarSettings({ timezone, onChanged }: { timezone: string; onChanged: () => void }) {
  const [data, setData] = useState<Calendar | null>(null), [error, setError] = useState("");
  const [editing, setEditing] = useState<{ kind: Kind; row: AvailabilityRow | FixedEventRow | null } | null>(null);
  const [exception, setException] = useState<FixedEventRow | null>(null);
  const [buffer, setBuffer] = useState(20);
  const refresh = useCallback(() => { api<Calendar>("/api/v1/availability").then((d) => { setData(d); setBuffer(d.bufferPercent); }).catch((e) => setError(e.message)); }, []);
  useEffect(refresh, [refresh]);
  function changed() { refresh(); onChanged(); }
  async function remove(kind: Kind, row: AvailabilityRow) {
    setError(""); try { await api(`/api/v1/availability/${row.id}?kind=${kind}`, { method: "DELETE", body: { expectedVersion: row.version } }); changed(); } catch (e) { setError(e instanceof Error ? e.message : "删除失败"); }
  }
  async function saveBuffer() {
    if (!data) return;
    try { await api("/api/v1/planning/buffer", { method: "PUT", body: { bufferPercent: buffer, expectedRevision: data.planningRevision } }); changed(); } catch (e) { setError(e instanceof Error ? e.message : "保存失败"); }
  }
  return <section className={styles.card}><details><summary>可用时间、课程与缓冲</summary><p className={styles.muted}>可用时间填写能用于自主学习的完整窗口，固定活动会从中扣除。每条记录按自己的时区计算。</p>
    <TimetableImport timezone={timezone} onChanged={changed} />
    {data && <>{(["availability", "fixed-event"] as Kind[]).map((kind) => <div key={kind}><h3>{kind === "availability" ? "可用窗口" : "固定活动"}</h3>
      {(kind === "availability" ? data.availabilityBlocks : data.fixedEvents).map((r) => <div key={r.id} className={styles.taskRow}><div className={styles.taskBody}><strong>{r.title}</strong><p className={styles.muted}>{kind === "fixed-event" && (r as FixedEventRow).eventDate ? (r as FixedEventRow).eventDate : weekdays[r.weekday - 1]} · {r.localStart}–{r.localEnd} · {r.timezone}{r.validFrom || r.validUntil ? ` · ${r.validFrom ?? "不限"} 至 ${r.validUntil ?? "不限"}` : ""}</p></div><div className={styles.actionsRow}><button className={styles.btn} onClick={() => setEditing({ kind, row: r })}>编辑</button>{kind === "fixed-event" && <button className={styles.btn} onClick={() => setException(r as FixedEventRow)}>单日变更</button>}<button className={styles.btn} onClick={() => void remove(kind, r)}>删除</button></div></div>)}
      <button className={styles.btn} onClick={() => setEditing({ kind, row: null })}>添加{kind === "availability" ? "窗口" : "活动"}</button></div>)}
      <label className={styles.label}>预留缓冲（%）<input type="number" className={styles.field} min={0} max={80} value={buffer} onChange={(e) => setBuffer(Number(e.target.value))} /></label><button className={styles.btn} onClick={() => void saveBuffer()}>保存缓冲</button>
      <details><summary>本周实际时段与时区调整</summary>{data.occurrences.length===0 && <p className={styles.muted}>本周没有活动时段。</p>}{data.occurrences.map(o=><div key={o.key} className={styles.logItem}><strong>{o.title} · {o.localDate}</strong><p className={styles.muted}>{o.timezone} · {o.start} 至 {o.end} · UTC偏移 {o.startOffsetMinutes} / {o.endOffsetMinutes} 分钟</p>{(o.startAdjustment!=="none"||o.endAdjustment!=="none") && <p>夏令时调整：{o.startAdjustment==="gap_shifted"||o.endAdjustment==="gap_shifted"?"不存在的当地时刻已移到首个有效时刻。":"重复当地时刻采用较早的一次。"}{o.collapsed?"调整后无有效时长，不计入容量。":""}</p>}</div>)}</details>
    </>}
    {editing && <CalendarEditor key={`${editing.kind}:${editing.row?.id ?? "new"}:${editing.row?.version ?? 0}`} {...editing} timezone={timezone} onSaved={() => { setEditing(null); changed(); }} onClose={() => setEditing(null)} />}
    {exception && data && <ExceptionEditor key={exception.id} event={exception} exceptions={data.exceptions} onSaved={() => { setException(null); changed(); }} onClose={() => setException(null)} />}
    {error && <p className={styles.error} role="alert">{error}</p>}
  </details></section>;
}

function CalendarEditor({ kind, row, timezone, onSaved, onClose }: { kind: Kind; row: AvailabilityRow | FixedEventRow | null; timezone: string; onSaved: () => void; onClose: () => void }) {
  const [v, setV] = useState({ title: row?.title ?? "", weekday: row?.weekday ?? 1, localStart: row?.localStart ?? "19:00", localEnd: row?.localEnd ?? "21:00", timezone: row?.timezone ?? timezone, validFrom: row?.validFrom ?? "", validUntil: row?.validUntil ?? "", eventDate: row && "eventDate" in row ? row.eventDate ?? "" : "" });
  const [error, setError] = useState(""), [busy, setBusy] = useState(false);
  const request = useRef<{ body: string; key: string } | null>(null);
  async function save() {
    setBusy(true); setError("");
    const body = { ...v, validFrom: v.validFrom || null, validUntil: v.validUntil || null, eventDate: v.eventDate || null, ...(row ? { expectedVersion: row.version } : { kind }) };
    const serialized = JSON.stringify(body), key = request.current?.body === serialized ? request.current.key : newIdempotencyKey(); request.current = { body: serialized, key };
    try { await api(`/api/v1/availability${row ? `/${row.id}` : ""}?kind=${kind}`, { method: row ? "PATCH" : "POST", body, idempotencyKey: row ? undefined : key }); onSaved(); } catch (e) { setError(e instanceof Error ? e.message : "保存失败"); } finally { setBusy(false); }
  }
  const field = (key: Exclude<keyof typeof v, "weekday">, label: string, type = "text") => <label className={styles.label}>{label}<input className={styles.field} type={type} value={v[key]} onChange={(e) => setV({ ...v, [key]: e.target.value })} /></label>;
  return <form className={styles.subForm} onSubmit={(e) => { e.preventDefault(); void save(); }}><div className={styles.formGrid}>
    {field("title", "名称")}<label className={styles.label}>每周<select className={styles.field} value={v.weekday} onChange={(e) => setV({ ...v, weekday: Number(e.target.value) })}>{weekdays.map((d, i) => <option key={d} value={i + 1}>{d}</option>)}</select></label>
    {field("localStart", "开始", "time")}{field("localEnd", "结束", "time")}{field("timezone", "时区")}{field("validFrom", "有效期从（可留空）", "date")}{field("validUntil", "有效期至（可留空）", "date")}{kind === "fixed-event" && field("eventDate", "仅这一天（留空为每周重复）", "date")}
  </div><div className={styles.actionsRow}><button className={`${styles.btn} ${styles.btnPrimary}`} disabled={busy}>保存时间</button><button type="button" className={styles.btn} onClick={onClose}>关闭</button></div>{error && <p className={styles.error} role="alert">{error}</p>}</form>;
}

function ExceptionEditor({ event, exceptions, onSaved, onClose }: { event: FixedEventRow; exceptions: Exception[]; onSaved: () => void; onClose: () => void }) {
  const [date, setDate] = useState(""), [cancelled, setCancelled] = useState(true), [start, setStart] = useState(event.localStart), [end, setEnd] = useState(event.localEnd), [error, setError] = useState("");
  const old = exceptions.find((e) => e.event_id === event.id && e.local_date === date);
  async function save() {
    try { await api(`/api/v1/availability/${event.id}/exceptions`, { method: "PUT", body: { localDate: date, cancelled, localStart: cancelled ? null : start, localEnd: cancelled ? null : end, expectedVersion: old?.version ?? 0 } }); onSaved(); } catch (e) { setError(e instanceof Error ? e.message : "保存失败"); }
  }
  return <form className={styles.subForm} onSubmit={(e) => { e.preventDefault(); void save(); }}><h3>{event.title} · 单日变更</h3><label className={styles.label}>日期<input type="date" className={styles.field} value={date} onChange={(e) => { setDate(e.target.value); const prev = exceptions.find((x) => x.event_id === event.id && x.local_date === e.target.value); setCancelled(prev ? Boolean(prev.cancelled) : true); setStart(prev?.local_start ?? event.localStart); setEnd(prev?.local_end ?? event.localEnd); }} /></label><label className={styles.check}><input type="checkbox" checked={cancelled} onChange={(e) => setCancelled(e.target.checked)} />取消这一天的活动</label>
    {!cancelled && <div className={styles.formGrid}><label className={styles.label}>替换开始<input type="time" className={styles.field} value={start} onChange={(e) => setStart(e.target.value)} /></label><label className={styles.label}>替换结束<input type="time" className={styles.field} value={end} onChange={(e) => setEnd(e.target.value)} /></label></div>}
    <p className={styles.muted}>恢复原时段时取消勾选并填回原时间。仅改变指定日期，不改整周活动。</p><div className={styles.actionsRow}><button className={styles.btn}>保存单日变更</button><button type="button" className={styles.btn} onClick={onClose}>关闭</button></div>{error && <p className={styles.error} role="alert">{error}</p>}</form>;
}
