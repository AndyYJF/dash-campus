"use client";
import { useState } from "react";
import { api } from "./api";
import styles from "./dash.module.css";
import type { DailyLogRow } from "@/repositories/logs";
type Revision={version:number;snapshot:{occurredOn:string;progress:string;blocker:string};createdAt:string};
export default function LogEdit({id,onChanged}:{id:string;onChanged:()=>void}) {
 const [log,setLog]=useState<DailyLogRow|null>(null),[revisions,setRevisions]=useState<Revision[]>([]),[busy,setBusy]=useState(false),[error,setError]=useState<string|null>(null),[archive,setArchive]=useState(false);
 async function open(){setBusy(true);setError(null);try{const r=await api<{log:DailyLogRow;revisions:Revision[]}>(`/api/v1/logs/${id}`);setLog(r.log);setRevisions(r.revisions);}catch(e){setError(e instanceof Error?e.message:"读取失败");}finally{setBusy(false);}}
 async function save(remove=false){if(!log)return;setBusy(true);setError(null);try{await api(`/api/v1/logs/${id}`,{method:remove?"DELETE":"PATCH",body:remove?{expectedVersion:log.version}:{expectedVersion:log.version,occurredOn:log.occurredOn,progress:log.progress,blocker:log.blocker}});setLog(null);setArchive(false);onChanged();}catch(e){setError(e instanceof Error?e.message:"保存失败，修改内容保留");}finally{setBusy(false);}}
 return <div>
  {!log&&<button className={`${styles.btn} ${styles.btnGhost}`} disabled={busy} onClick={()=>void open()}>编辑 / 查看历史</button>}
  {log&&<form onSubmit={e=>{e.preventDefault();void save();}} aria-label="编辑记录" className={styles.logItem}>
   <label className={styles.label}>记录日期<input className={styles.field} type="date" required value={log.occurredOn} onChange={e=>setLog({...log,occurredOn:e.target.value})}/></label>
   <label className={styles.label}>记录进展<textarea className={styles.field} rows={3} maxLength={5000} value={log.progress} onChange={e=>setLog({...log,progress:e.target.value})}/></label>
   <label className={styles.label}>记录卡点<textarea className={styles.field} rows={2} maxLength={5000} value={log.blocker} onChange={e=>setLog({...log,blocker:e.target.value})}/></label>
   <p className={styles.muted}>在线修订，原有任务和项目关联保留；历史正文仍可追溯。</p>
   <div className={styles.actionsRow}><button className={styles.btn} disabled={busy||Boolean(log.archivedAt)}>保存修订</button><button className={styles.btn} type="button" disabled={busy} onClick={()=>setLog(null)}>取消编辑</button><button className={styles.btn} type="button" disabled={busy||Boolean(log.archivedAt)} onClick={()=>setArchive(!archive)}>归档记录…</button></div>
   {archive&&<div className={styles.notice}>归档后不再用于新的复盘，已有历史依据仍保留。<button className={styles.btn} type="button" disabled={busy} onClick={()=>void save(true)}>确认归档记录</button></div>}
   <details><summary>历史修订（{revisions.length}）</summary>{revisions.map(r=><div className={styles.logItem} key={r.version}><strong>版本 {r.version} · {r.snapshot.occurredOn}</strong><p>{r.snapshot.progress}</p><p>{r.snapshot.blocker}</p></div>)}</details>
  </form>}
  {error&&<p className={styles.error} role="alert">{error}</p>}
 </div>;
}
