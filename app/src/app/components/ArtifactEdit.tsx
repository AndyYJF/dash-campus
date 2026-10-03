"use client";
import {useState} from "react";
import {api} from "./api";
import styles from "./dash.module.css";
import type {ArtifactRow} from "@/repositories/logs";
type Revision={version:number;snapshot:{title:string;body:string;url:string|null}};
export default function ArtifactEdit({artifact,onChanged}:{artifact:ArtifactRow;onChanged:()=>void}) {
 const [draft,setDraft]=useState<ArtifactRow|null>(null),[history,setHistory]=useState<Revision[]>([]),[busy,setBusy]=useState(false),[error,setError]=useState<string|null>(null),[archive,setArchive]=useState(false);
 async function open(){setBusy(true);setError(null);try{const r=await api<{artifact:ArtifactRow;revisions:Revision[]}>(`/api/v1/artifacts/${artifact.id}`);setDraft(r.artifact);setHistory(r.revisions);}catch(e){setError(e instanceof Error?e.message:"读取失败");}finally{setBusy(false);}}
 async function save(remove=false){if(!draft)return;setBusy(true);setError(null);try{await api(`/api/v1/artifacts/${draft.id}`,{method:remove?"DELETE":"PATCH",body:remove?{expectedVersion:draft.version}:{expectedVersion:draft.version,title:draft.title,body:draft.body,url:draft.url?.trim()||null,kind:draft.url?.trim()?"link":"text"}});setDraft(null);setArchive(false);onChanged();}catch(e){setError(e instanceof Error?e.message:"保存失败，修改内容保留");}finally{setBusy(false);}}
 return <div>{!draft&&<button className={`${styles.btn} ${styles.btnGhost}`} disabled={busy} onClick={()=>void open()}>编辑成果 / 查看历史</button>}
 {draft&&<form onSubmit={e=>{e.preventDefault();void save();}} aria-label="编辑成果">
  <label className={styles.label}>成果标题<input className={styles.field} required maxLength={200} value={draft.title} onChange={e=>setDraft({...draft,title:e.target.value})}/></label>
  <label className={styles.label}>成果正文<textarea className={styles.field} rows={3} maxLength={10000} value={draft.body} onChange={e=>setDraft({...draft,body:e.target.value})}/></label>
  <label className={styles.label}>成果链接<input className={styles.field} type="url" value={draft.url??""} onChange={e=>setDraft({...draft,url:e.target.value})}/></label>
  <div className={styles.actionsRow}><button className={styles.btn} disabled={busy}>保存成果修订</button><button className={styles.btn} type="button" disabled={busy} onClick={()=>setDraft(null)}>取消编辑</button><button className={styles.btn} type="button" disabled={busy} onClick={()=>setArchive(!archive)}>归档成果…</button></div>
  {archive&&<p className={styles.notice}>历史引用保留，新的报告默认不再选择它。<button className={styles.btn} type="button" disabled={busy} onClick={()=>void save(true)}>确认归档成果</button></p>}
  <details><summary>成果历史（{history.length}）</summary>{history.map(r=><div key={r.version}><strong>版本 {r.version} · {r.snapshot.title}</strong><p>{r.snapshot.body}</p>{r.snapshot.url&&<a href={r.snapshot.url} target="_blank" rel="noreferrer">原链接</a>}</div>)}</details>
 </form>}{error&&<p className={styles.error} role="alert">{error}</p>}</div>;
}
