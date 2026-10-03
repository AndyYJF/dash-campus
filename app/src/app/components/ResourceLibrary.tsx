"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, newIdempotencyKey } from "./api";
import styles from "./dash.module.css";
import type { ResourceRow } from "@/repositories/resources";

type Draft = Pick<ResourceRow,"kind"|"title"|"body"|"url"|"sourceYear"|"sourceKind">;
type Revision = {version:number;createdAt:string;contentHash:string;snapshot:Draft & {archivedAt:string|null}};
const empty: Draft = {kind:"text",title:"",body:"",url:null,sourceYear:null,sourceKind:"user_supplied"};

export default function ResourceLibrary({selected,onSelectionChange}:{selected:string[];onSelectionChange:(ids:string[])=>void}) {
  const [items,setItems]=useState<ResourceRow[]>([]),[draft,setDraft]=useState<Draft>(empty);
  const [editing,setEditing]=useState<ResourceRow|null>(null),[history,setHistory]=useState<Revision[]>([]);
  const [busy,setBusy]=useState(false),[error,setError]=useState<string|null>(null),[message,setMessage]=useState<string|null>(null);
  const [showArchived,setShowArchived]=useState(false),[archiveId,setArchiveId]=useState<string|null>(null);
  const key=useRef<{body:string;key:string}|null>(null);
  const refresh=useCallback(()=>api<{resources:ResourceRow[]}>("/api/v1/resources?includeArchived=true").then(r=>setItems(r.resources)).catch(e=>setError(e instanceof Error?e.message:"资料加载失败")),[]);
  useEffect(()=>{void refresh();},[refresh]);
  async function edit(item:ResourceRow) {
    setError(null);setBusy(true);
    try {const r=await api<{resource:ResourceRow;revisions:Revision[]}>(`/api/v1/resources/${item.id}`);setEditing(r.resource);setDraft(r.resource);setHistory(r.revisions);setArchiveId(null);setMessage(null);}
    catch(e){setError(e instanceof Error?e.message:"加载失败");}finally{setBusy(false);}
  }
  async function save(e:React.FormEvent) {
    e.preventDefault();setBusy(true);setError(null);setMessage(null);
    const body={...draft,title:draft.title.trim(),url:draft.url?.trim()||null};
    const serialized=JSON.stringify(body);if(key.current?.body!==serialized)key.current={body:serialized,key:newIdempotencyKey()};
    try {
      if(editing)await api(`/api/v1/resources/${editing.id}`,{method:"PATCH",body:{...body,expectedVersion:editing.version}});
      else await api("/api/v1/resources",{method:"POST",body,idempotencyKey:key.current!.key});
      setDraft(empty);setEditing(null);setHistory([]);key.current=null;setMessage("资料已保存，旧版本仍可用于查看历史引用。");await refresh();
    }catch(e){setError(e instanceof Error?e.message:"保存失败，输入已保留");}finally{setBusy(false);}
  }
  async function archive(item:ResourceRow) {
    setBusy(true);setError(null);
    try{await api(`/api/v1/resources/${item.id}`,{method:"DELETE",body:{expectedVersion:item.version}});onSelectionChange(selected.filter(id=>id!==item.id));setArchiveId(null);if(editing?.id===item.id){setEditing(null);setDraft(empty);setHistory([]);}await refresh();setMessage("已归档；探索中的历史引用保留原文与版本。");}
    catch(e){setError(e instanceof Error?e.message:"归档失败");}finally{setBusy(false);}
  }
  return <section className={styles.card}>
    <h2>资料库</h2><p className={styles.muted}>保存文本或链接。勾选有正文的资料供本次探索使用；链接不会自动抓取，请补充原文。每次探索保留当时的版本。</p>
    <label className={styles.check}><input type="checkbox" checked={showArchived} onChange={e=>setShowArchived(e.target.checked)}/>显示已归档资料</label>
    {items.filter(r=>showArchived||!r.archivedAt).map(r=><div key={r.id} className={styles.logItem}>
      <label className={styles.check}><input type="checkbox" checked={selected.includes(r.id)} disabled={busy||Boolean(r.archivedAt)||!r.body.trim()||(!selected.includes(r.id)&&selected.length>=6)} onChange={e=>onSelectionChange(e.target.checked?[...selected,r.id]:selected.filter(id=>id!==r.id))}/>{r.title}</label>
      <span className={styles.muted}>版本 {r.version}{r.archivedAt?" · 已归档":!r.body.trim()?" · 待补正文":""}{r.sourceYear?` · ${r.sourceYear} 年资料`:""}</span>
      <button className={styles.btn} disabled={busy} onClick={()=>void edit(r)}>{r.archivedAt?"查看历史":"编辑 / 历史"}</button>
      {!r.archivedAt && <button className={styles.btn} disabled={busy} onClick={()=>setArchiveId(r.id)}>归档…</button>}
      {archiveId===r.id && <div className={styles.actionsRow}><span>归档后不再用于新探索，保留历史引用。</span><button className={styles.btn} disabled={busy} onClick={()=>void archive(r)}>确认归档</button><button className={styles.btn} onClick={()=>setArchiveId(null)}>取消</button></div>}
    </div>)}
    <details open={Boolean(editing)}><summary>{editing?`资料：${editing.title}`:"新增资料"}</summary>
      <form onSubmit={save} aria-label="资料编辑">
        <label className={styles.label}>类型<select className={styles.field} disabled={Boolean(editing?.archivedAt)} value={draft.kind} onChange={e=>setDraft({...draft,kind:e.target.value as Draft["kind"]})}><option value="text">文本</option><option value="url">链接</option></select></label>
        <label className={styles.label}>资料标题<input className={styles.field} required maxLength={200} value={draft.title} onChange={e=>setDraft({...draft,title:e.target.value})}/></label>
        <label className={styles.label}>资料链接<input className={styles.field} type="url" required={draft.kind==="url"} value={draft.url??""} onChange={e=>setDraft({...draft,url:e.target.value||null})}/></label>
        <label className={styles.label}>资料正文<textarea className={styles.field} rows={5} required={draft.kind==="text"} maxLength={20000} value={draft.body} onChange={e=>setDraft({...draft,body:e.target.value})}/></label>
        <label className={styles.label}>资料年份（可选）<input className={styles.field} type="number" min={1900} max={2200} value={draft.sourceYear??""} onChange={e=>setDraft({...draft,sourceYear:e.target.value?Number(e.target.value):null})}/></label>
        <label className={styles.label}>来源标注<select className={styles.field} value={draft.sourceKind} onChange={e=>setDraft({...draft,sourceKind:e.target.value as Draft["sourceKind"]})}><option value="user_supplied">用户提供</option><option value="official">用户标注为官方</option><option value="other">其他</option></select></label>
        <p className={styles.muted}>来源标注是你的记录，系统不会据此宣称已联网核实。</p>
        <button className={styles.btn} disabled={busy||Boolean(editing?.archivedAt)} type="submit">保存资料</button>
        {editing && <button className={styles.btn} type="button" disabled={busy} onClick={()=>{setEditing(null);setDraft(empty);setHistory([]);}}>关闭编辑</button>}
      </form>
      {history.length>0 && <details><summary>版本历史（{history.length}）</summary>{history.map(r=><div className={styles.logItem} key={r.version}><strong>版本 {r.version} · {r.snapshot.title}</strong><p className={styles.muted}>{r.createdAt}{r.snapshot.archivedAt?" · 归档版本":""}</p><p style={{whiteSpace:"pre-wrap",overflowWrap:"anywhere"}}>{r.snapshot.body}</p>{r.snapshot.url && <a href={r.snapshot.url} target="_blank" rel="noreferrer">原始链接</a>}</div>)}</details>}
    </details>
    {error && <p className={styles.error} role="alert">{error}</p>}{message && <p className={styles.notice} role="status">{message}</p>}
  </section>;
}
