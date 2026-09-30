"use client";

import { useCallback, useEffect, useState } from "react";
import { api, newIdempotencyKey } from "./api";
import ErrorNote, { toErrorState } from "./ErrorNote";
import styles from "./dash.module.css";

type ExportRow = {
  id: string;
  type: "project_markdown" | "full_json";
  status: "ready" | "failed" | "expired" | "deleted";
  fileName: string;
  byteSize: number | null;
  expiresAt: string;
  error: string | null;
  createdAt: string;
};

const STATUS: Record<ExportRow["status"], string> = {
  ready: "可下载",
  failed: "失败",
  expired: "已过期",
  deleted: "已删除",
};

/**
 * 设置 → 数据导出（计划 9 节）：full_json 个人业务数据；阶段报告在项目页生成。
 * 备份与恢复不提供 Web 按钮，只链接操作说明（产品计划 5.2）。
 */
export default function DataExportCard() {
  const [rows, setRows] = useState<ExportRow[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; status?: number } | null>(null);

  const load = useCallback(() => {
    api<{ exports: ExportRow[] }>("/api/v1/exports")
      .then((r) => setRows(r.exports))
      .catch((e) => setError(toErrorState(e, "加载导出记录失败")));
  }, []);
  useEffect(load, [load]);

  async function exportJson() {
    setBusy(true);
    setError(null);
    try {
      await api("/api/v1/exports", { method: "POST", idempotencyKey: newIdempotencyKey(), body: { type: "full_json" } });
      load();
    } catch (e) {
      setError(toErrorState(e, "导出失败"));
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    setError(null);
    try {
      await api(`/api/v1/exports/${id}`, { method: "DELETE" });
      load();
    } catch (e) {
      setError(toErrorState(e, "删除失败"));
    }
  }

  return (
    <section className={styles.card} aria-labelledby="export-title">
      <div className={styles.cardHeader}>
        <h2 id="export-title">数据导出</h2>
        <button className={`${styles.btn} ${styles.btnPrimary}`} onClick={exportJson} disabled={busy}>
          {busy ? "生成中…" : "导出全部数据（JSON）"}
        </button>
      </div>
      <p className={styles.muted}>
        全量 JSON 是你的个人业务数据（任务、记录、成果、复盘等，保留关联 ID），不含密码、会话和集成凭证，不适合公开。
        项目阶段报告请在项目页生成。导出文件保存 24 小时。
      </p>
      <p className={styles.muted}>备份与恢复需要在服务器上停机执行，见部署目录里的 docs/deploy.md。</p>
      <ErrorNote error={error} />
      {rows && rows.length === 0 && <p className={styles.empty}>还没有导出记录。</p>}
      {rows && rows.length > 0 && (
        <table className={styles.table}>
          <thead>
            <tr>
              <th>文件</th>
              <th>状态</th>
              <th>有效期至</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td data-label="文件">
                  {r.fileName}
                  <span className={styles.muted}> · {r.type === "full_json" ? "全量 JSON" : "阶段报告"}</span>
                </td>
                <td data-label="状态">
                  <span className={`${styles.badge} ${r.status === "ready" ? styles.badgeOk : r.status === "failed" ? styles.badgeOverdue : ""}`}>
                    {STATUS[r.status]}
                  </span>
                  {r.error && <span className={styles.muted}> {r.error}</span>}
                </td>
                <td data-label="有效期至">{new Date(r.expiresAt).toLocaleString()}</td>
                <td data-label="操作">
                  <span className={styles.actionsRow} style={{ marginTop: 0 }}>
                    {r.status === "ready" && (
                      <a className={styles.btn} href={`/api/v1/exports/${r.id}/download`}>
                        下载
                      </a>
                    )}
                    <button className={`${styles.btn} ${styles.btnDanger}`} onClick={() => remove(r.id)}>
                      删除
                    </button>
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
