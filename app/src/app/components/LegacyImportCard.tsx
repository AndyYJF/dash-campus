"use client";

import { useEffect, useState } from "react";
import { LEGACY_MAX_BYTES, legacySnapshotSchema, type LegacySnapshot, type LegacyPreview, type LegacyReceipt } from "@/contracts/legacy";
import { api, newIdempotencyKey } from "./api";
import styles from "./dash.module.css";

const ACTION = { create: "将新建", skip: "跳过", conflict: "冲突，保留现状" };
const STATE_LABEL: Record<string, string> = { todo: "待办", doing: "进行中", blocked: "卡住", done: "已完成", cancelled: "已取消", active: "进行中", paused: "已暂停", completed: "已完成" };
type Binding = { sourceId: string; timezone: string; campusSourceId: string | null };
type StateResponse = { receipts: LegacyReceipt[]; sources: Array<{ id: string; title: string }>; instances: Binding[] };
function download(value: unknown, file: string) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: "application/json" }));
  const a = document.createElement("a"); a.href = url; a.download = file; document.body.append(a); a.click(); a.remove();
  // 浏览器先开始读取 Blob；不能在 click 同一调用栈里撤销链接。
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export default function LegacyImportCard() {
  const [snapshot, setSnapshot] = useState<LegacySnapshot | null>(null);
  const [preview, setPreview] = useState<LegacyPreview | null>(null);
  const [receipts, setReceipts] = useState<LegacyReceipt[]>([]);
  const [sources, setSources] = useState<Array<{ id: string; title: string }>>([]);
  const [binding, setBinding] = useState<Binding | null>(null);
  const [campusSourceId, setCampusSourceId] = useState("");
  const [reminders, setReminders] = useState(false), [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false), [message, setMessage] = useState("");
  const [retryKey, setRetryKey] = useState<string | null>(null);
  const [filter, setFilter] = useState("all");
  useEffect(() => { api<StateResponse>("/api/v1/legacy").then((r) => { setReceipts(r.receipts); setSources(r.sources); }).catch((e) => setMessage(e.message)); }, []);
  async function acceptSnapshot(data: LegacySnapshot) {
    const state = await api<StateResponse>("/api/v1/legacy");
    setSources(state.sources); setReceipts(state.receipts);
    const prior = state.instances.find((i) => i.sourceId === data.sourceId) ?? null;
    setBinding(prior); setCampusSourceId(prior?.campusSourceId ?? "");
    setSnapshot({ ...data, timezone: prior?.timezone ?? data.timezone });
    if (prior) setMessage("已沿用首次确认的时区和校园来源绑定；不会重置原导入配置。");
  }
  function invalidate() { setPreview(null); setConfirm(false); setRetryKey(null); }
  async function loadServer() {
    setBusy(true); setMessage(""); invalidate(); setSnapshot(null);
    try { const r = await api<{ snapshot: LegacySnapshot }>("/api/v1/legacy?server=1"); await acceptSnapshot(r.snapshot); }
    catch (e) { setMessage(e instanceof Error ? e.message : "读取失败"); }
    finally { setBusy(false); }
  }
  async function loadFile(file: File | undefined) {
    invalidate(); setSnapshot(null); setMessage(""); if (!file) return;
    if (file.size > LEGACY_MAX_BYTES) { setMessage("文件超过10 MiB"); return; }
    setBusy(true);
    try { const data = legacySnapshotSchema.safeParse(JSON.parse(await file.text()));
      if (!data.success) { setMessage("文件格式不兼容，请用只读快照工具生成 JSON"); return; }
      await acceptSnapshot(data.data);
    } catch { setMessage("无法读取 JSON 文件"); } finally { setBusy(false); }
  }
  async function makePreview() {
    if (!snapshot) return; setBusy(true); setMessage(""); invalidate();
    try { const r = await api<{ preview: LegacyPreview }>("/api/v1/legacy/preview", { method: "POST", body: { snapshot, campusSourceId: campusSourceId || null, enableFutureReminders: reminders } });
      setPreview(r.preview); setRetryKey(newIdempotencyKey());
    } catch (e) { setMessage(e instanceof Error ? e.message : "预览失败"); } finally { setBusy(false); }
  }
  async function apply() {
    if (!snapshot || !preview || !confirm || !retryKey) return;
    setBusy(true); setMessage("");
    try { const r = await api<{ receipt: LegacyReceipt }>("/api/v1/legacy/apply", { method: "POST", idempotencyKey: retryKey,
      body: { snapshot, campusSourceId: campusSourceId || null, enableFutureReminders: reminders, previewHash: preview.previewHash, confirm: true } });
      setReceipts((prior) => [r.receipt, ...prior.filter((x) => x.id !== r.receipt.id)].slice(0, 10));
      setBinding({ sourceId: r.receipt.sourceId, timezone: r.receipt.preview.timezone, campusSourceId: r.receipt.preview.campusSourceId });
      setMessage(`导入完成：新建 ${r.receipt.created.length} 条记录；跳过 ${r.receipt.preview.counts.skip}，冲突 ${r.receipt.preview.counts.conflict}。`); invalidate();
    } catch (e) { setMessage(e instanceof Error ? e.message : "导入失败，保留预览，可重试"); } finally { setBusy(false); }
  }
  const visible = preview?.items.filter((i) => filter === "all" || i.action === filter) ?? [];
  return <section className={styles.card} aria-label="旧工具迁移" style={{ minWidth: 0, overflowWrap: "anywhere" }}>
    <h2 className={styles.sectionTitle}>旧 ToDo 迁移</h2>
    <p className={styles.muted}>读取快照后先预览，再确认导入。旧服务继续运行；同一来源 ID 重导会跳过已有记录，源变化保留为冲突，不覆盖你的修改。</p>
    <div className={styles.actionsRow}>
      <button className={styles.btn} disabled={busy} onClick={loadServer}>读取服务器快照</button>
      <label className={styles.label} style={{ minWidth: 0, maxWidth: "100%" }}>选择快照 JSON<input type="file" accept=".json,application/json" style={{ display: "block", maxWidth: "100%", width: "100%" }} disabled={busy} onChange={(e) => { void loadFile(e.target.files?.[0]); e.target.value = ""; }} /></label>
    </div>
    <p className={styles.muted}>服务器快照由管理员运行只读工具生成；这里不会直接打开旧数据库。快照仅用于这次操作，不存入浏览器草稿。</p>
    {snapshot && <>
      <p>来源 {snapshot.sourceId} · {snapshot.tasks.length} 条任务 · 快照 {new Date(snapshot.exportedAt).toLocaleString("zh-CN")}</p>
      <label className={styles.label} htmlFor="legacy-timezone">旧库时间所属时区</label>
      <input id="legacy-timezone" className={styles.field} disabled={busy || !!binding} value={snapshot.timezone} onChange={(e) => { setSnapshot({ ...snapshot, timezone: e.target.value }); invalidate(); }} />
      <label className={styles.label} htmlFor="legacy-campus-source">校园插件对应收件箱来源</label>
      <select id="legacy-campus-source" className={styles.field} disabled={busy || !!binding} value={campusSourceId} onChange={(e) => { setCampusSourceId(e.target.value); invalidate(); }}>
        <option value="">暂不绑定</option>{sources.map((s) => <option key={s.id} value={s.id}>{s.title || s.id}（{s.id}）</option>)}
      </select>
      <p className={styles.muted}>绑定后，插件后续修订会关联已迁移任务。时区和来源绑定在首次导入后固定，请先在“身份与来源”创建来源并保存 token。</p>
      <label className={styles.check}><input type="checkbox" disabled={busy} checked={reminders} onChange={(e) => { setReminders(e.target.checked); invalidate(); }} />为新导入任务建立未来截止提醒</label>
      <p className={styles.muted}>默认不创建邮件提醒；无论是否勾选，都不补发过去的提醒。之后改截止、提醒提前量或重开任务会按正常规则生成提醒。</p>
      <button className={styles.btn} disabled={busy} onClick={makePreview}>生成导入预览</button>
    </>}
    {preview && <div style={{ marginTop: 16 }}>
      <p>项目 {preview.counts.projects} · 任务 {preview.counts.tasks} · 将新建 {preview.counts.create} · 跳过 {preview.counts.skip} · 冲突 {preview.counts.conflict} · 有提示 {preview.counts.warnings}</p>
      <p className={styles.muted}>旧开始时间保留在来源记录，不当作执行时段。未完成任务进入待安排；旧完成时刻不明时留空。冲突记录不会被此次导入修改。</p>
      <label className={styles.label} htmlFor="legacy-filter">预览筛选</label>
      <select id="legacy-filter" className={styles.field} value={filter} onChange={(e) => setFilter(e.target.value)}>
        <option value="all">全部</option><option value="create">将新建</option><option value="skip">跳过</option><option value="conflict">冲突</option>
      </select>
      <div style={{ maxHeight: 360, overflowY: "auto", overflowWrap: "anywhere" }}>
        {visible.map((i) => <div key={`${i.kind}:${i.sourceId}`} className={styles.logItem}>
          <strong>{i.title}</strong><div className={styles.muted}>{i.kind === "task" ? "任务" : "项目"} · {ACTION[i.action]} · {i.reason}</div>
          {i.kind === "task" && <div className={styles.muted}>旧 ID {i.sourceId}{i.targetId ? ` → 新 ID ${i.targetId}` : ""}</div>}
          {i.current && <div className={styles.muted}>当前记录：{i.current.title} · 状态 {STATE_LABEL[i.current.status] ?? i.current.status}{i.current.archived ? " · 已归档" : ""}{i.current.due ? ` · 截止 ${i.current.due.length === 10 ? i.current.due : new Date(i.current.due).toLocaleString("zh-CN", { timeZone: preview.timezone })}` : ""}</div>}
          {i.mapped && <div className={styles.muted}>状态 {i.mapped.status === "done" ? "完成" : "待办"} · {i.mapped.priority === "high" ? "高优先" : "普通"} · 项目 {i.mapped.project || "无"} · 截止 {i.mapped.due ? new Date(i.mapped.due).toLocaleString("zh-CN", { timeZone: preview.timezone }) : "未设置"}</div>}
          {i.warnings.map((w) => <div key={w} className={styles.muted}>提示：{w}</div>)}
        </div>)}
      </div>
      <div className={styles.actionsRow}><button className={styles.btn} onClick={() => download(preview, "todo-import-preview.json")}>下载预览报告</button></div>
      <label className={styles.check}><input type="checkbox" disabled={busy} checked={confirm} onChange={(e) => setConfirm(e.target.checked)} />已核对映射、时间、提醒策略，确认仅新建预览中的记录</label>
      <button className={`${styles.btn} ${styles.btnPrimary}`} disabled={busy || !confirm || preview.counts.create === 0} onClick={apply}>确认导入 {preview.counts.create} 条记录</button>
    </div>}
    {message && <p className={styles.notice} role="status">{message}</p>}
    {receipts.length > 0 && <><h3 className={styles.sectionTitle}>最近导入结果</h3>{receipts.map((r) => <div key={r.id} className={styles.logItem}>
      <span>{r.sourceId} · {new Date(r.createdAt).toLocaleString("zh-CN")} · 新建 {r.created.length} · 冲突 {r.preview.counts.conflict}</span>{" "}
      <a className={`${styles.btn} ${styles.btnGhost}`} href={`/api/v1/legacy/imports/${r.id}/download`} download>下载结果与 ID 映射</a>
    </div>)}</>}
  </section>;
}
