"use client";

import { useState } from "react";
import { api, newIdempotencyKey } from "./api";
import ErrorNote, { toErrorState } from "./ErrorNote";
import styles from "./dash.module.css";
import { REPORT_FIELDS, REPORT_FIELD_LABEL, type ReportField } from "@/contracts/exports";
import type { ArtifactRow, DailyLogRow } from "@/repositories/logs";

type ExportRow = { id: string; status: string; fileName: string; expiresAt: string; error: string | null };

/**
 * 阶段报告（产品计划 5.4、7）：先选择字段和记录 → 预览 Markdown → 可编辑 → 导出。
 * 只含选中的内容；缺失字段在预览中标"未填写"，不编造。导出文件 24 小时后过期。
 */
export default function StageReport({
  projectId,
  logs,
  artifacts,
}: {
  projectId: string;
  logs: DailyLogRow[];
  artifacts: ArtifactRow[];
}) {
  const [open, setOpen] = useState(false);
  const [fields, setFields] = useState<ReportField[]>([...REPORT_FIELDS]);
  const [logIds, setLogIds] = useState<string[]>([]);
  const [artIds, setArtIds] = useState<string[]>([]);
  const [markdown, setMarkdown] = useState<string | null>(null);
  const [missing, setMissing] = useState<ReportField[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; status?: number } | null>(null);
  const [done, setDone] = useState<ExportRow | null>(null);
  const [key, setKey] = useState<string | null>(null);

  const toggle = <T,>(xs: T[], x: T) => (xs.includes(x) ? xs.filter((y) => y !== x) : [...xs, x]);

  async function preview() {
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      const r = await api<{ markdown: string; missing: ReportField[] }>("/api/v1/exports/report-preview", {
        method: "POST",
        body: { projectId, fields, selectedLogIds: logIds, selectedArtifactIds: artIds },
      });
      setMarkdown(r.markdown);
      setMissing(r.missing);
      setKey(null);
    } catch (e) {
      setError(toErrorState(e, "预览失败"));
    } finally {
      setBusy(false);
    }
  }

  async function exportIt() {
    if (markdown === null) return;
    const k = key ?? newIdempotencyKey();
    setKey(k);
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ export: ExportRow }>("/api/v1/exports", {
        method: "POST",
        idempotencyKey: k,
        body: {
          type: "project_markdown",
          projectId,
          fields,
          selectedLogIds: logIds,
          selectedArtifactIds: artIds,
          editedMarkdown: markdown,
        },
      });
      setDone(r.export);
    } catch (e) {
      setError(toErrorState(e, "导出失败，内容已保留"));
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <section className={styles.card}>
        <div className={styles.cardHeader}>
          <h2>阶段报告</h2>
          <button className={styles.btn} onClick={() => setOpen(true)}>
            生成阶段报告
          </button>
        </div>
        <p className={styles.muted}>从选中的记录和成果生成一份可编辑的 Markdown。缺少的内容会留空，不会自动补写。</p>
      </section>
    );
  }

  return (
    <section className={styles.card} aria-labelledby="report-title">
      <div className={styles.cardHeader}>
        <h2 id="report-title">阶段报告</h2>
        <button className={styles.btn} onClick={() => setOpen(false)}>
          收起
        </button>
      </div>

      <fieldset className={styles.fieldset}>
        <legend className={styles.label}>1. 选择内容</legend>
        <div className={styles.checkGrid}>
          {REPORT_FIELDS.map((f) => (
            <label key={f} className={styles.check}>
              <input type="checkbox" checked={fields.includes(f)} onChange={() => setFields(toggle(fields, f))} />
              {REPORT_FIELD_LABEL[f]}
            </label>
          ))}
        </div>
      </fieldset>

      <fieldset className={styles.fieldset}>
        <legend className={styles.label}>2. 选择记录（{logIds.length}/{logs.length}）</legend>
        {logs.length === 0 && <p className={styles.muted}>这个项目还没有记录。</p>}
        {logs.length > 0 && (
          <div className={styles.actionsRow} style={{ marginTop: 0 }}>
            <button type="button" className={styles.btn} onClick={() => setLogIds(logs.map((l) => l.id))}>
              全选
            </button>
            <button type="button" className={styles.btn} onClick={() => setLogIds([])}>
              清空
            </button>
          </div>
        )}
        {logs.map((l) => (
          <label key={l.id} className={styles.checkRow}>
            <input type="checkbox" checked={logIds.includes(l.id)} onChange={() => setLogIds(toggle(logIds, l.id))} />
            <span>
              <span className={styles.taskMeta}>{l.occurredOn}</span> {l.progress || <span className={styles.muted}>卡点：{l.blocker}</span>}
            </span>
          </label>
        ))}
      </fieldset>

      <fieldset className={styles.fieldset}>
        <legend className={styles.label}>3. 选择成果（{artIds.length}/{artifacts.length}）</legend>
        {artifacts.length === 0 && <p className={styles.muted}>这个项目还没有成果。</p>}
        {artifacts.map((a) => (
          <label key={a.id} className={styles.checkRow}>
            <input type="checkbox" checked={artIds.includes(a.id)} onChange={() => setArtIds(toggle(artIds, a.id))} />
            <span>
              {a.title}
              {a.url && <span className={styles.muted}> · {a.url}</span>}
            </span>
          </label>
        ))}
      </fieldset>

      <div className={styles.actionsRow}>
        <button className={`${styles.btn} ${styles.btnPrimary}`} onClick={preview} disabled={busy || fields.length === 0}>
          {markdown === null ? "预览" : "按选择重新生成预览"}
        </button>
        {fields.length === 0 && <span className={styles.muted}>至少选一项内容</span>}
      </div>

      {markdown !== null && (
        <div style={{ marginTop: 16 }}>
          <label className={styles.label} htmlFor="report-md">
            4. 预览与编辑（Markdown）
          </label>
          {missing.length > 0 && (
            <p className={`${styles.notice} ${styles.noticeWarn}`}>
              以下部分没有可用材料，已留空：{missing.map((f) => REPORT_FIELD_LABEL[f]).join("、")}。可以在下面手写补充。
            </p>
          )}
          <textarea
            id="report-md"
            className={`${styles.field} ${styles.mono}`}
            rows={14}
            value={markdown}
            onChange={(e) => {
              setMarkdown(e.target.value);
              setKey(null);
            }}
          />
          <div className={styles.actionsRow}>
            <button className={`${styles.btn} ${styles.btnPrimary}`} onClick={exportIt} disabled={busy}>
              {busy ? "导出中…" : "导出 Markdown"}
            </button>
            <span className={styles.muted}>只包含上面选中的内容；导出文件保存 24 小时</span>
          </div>
        </div>
      )}
      <ErrorNote error={error} />
      {done && done.status === "ready" && (
        <p className={`${styles.notice} ${styles.noticeOk}`} role="status">
          已生成 {done.fileName}。<a href={`/api/v1/exports/${done.id}/download`}>下载</a>（
          {new Date(done.expiresAt).toLocaleString()} 前有效）
        </p>
      )}
      {done && done.status === "failed" && (
        <p className={`${styles.notice} ${styles.noticeError}`} role="alert">
          导出失败：{done.error}
        </p>
      )}
    </section>
  );
}
