"use client";

import { useCallback, useEffect, useState } from "react";
import { api } from "./api";
import styles from "./dash.module.css";

/**
 * 收件箱列表（T4）：分区分组展示；folded 折叠但可找回；
 * revision_conflict 置顶提示待选择。
 */

type InboxItem = {
  id: string;
  sourceId: string;
  externalId: string;
  status: "active" | "revision_conflict";
  partition: string | null;
  applicability: string | null;
  noticeType: string | null;
  title: string;
  occurredAt: string | null;
  textPreview: string;
  updatedAt: string;
};

const PARTITION_LABEL: Record<string, string> = {
  action: "需要行动",
  review: "条件未知，待确认",
  opportunity: "自愿参加",
  info: "信息",
  folded: "已折叠（不符合）",
};

const ORDER = ["action", "review", "opportunity", "info", "folded"];

export default function InboxView() {
  const [items, setItems] = useState<InboxItem[] | null>(null);
  const [showFolded, setShowFolded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    api<{ items: InboxItem[] }>("/api/v1/inbox")
      .then((r) => {
        setItems(r.items);
        setError(null);
      })
      .catch((e) => setError(e instanceof Error ? e.message : "加载失败"));
  }, []);

  useEffect(refresh, [refresh]);

  if (error) return <p className={styles.error}>{error}</p>;
  if (!items) return <p className={styles.muted}>加载中…</p>;

  const conflicts = items.filter((i) => i.status === "revision_conflict");
  const normal = items.filter((i) => i.status === "active");
  const visible = normal.filter((i) => showFolded || i.partition !== "folded");

  return (
    <div>
      {conflicts.length > 0 && (
        <div className={styles.card}>
          <h2 className={styles.error}>有 {conflicts.length} 条通知的修订顺序无法确定，需要你选择当前版本。</h2>
          {conflicts.map((c) => (
            <div key={c.id} className={styles.taskRow}>
              <span className={styles.taskTitle}>{c.title}</span>
              <a href={`/inbox/${c.id}`}>去选择</a>
            </div>
          ))}
        </div>
      )}

      {visible.length === 0 && <p className={styles.muted}>收件箱为空。</p>}

      {ORDER.filter((p) => visible.some((i) => i.partition === p)).map((p) => (
        <div key={p} className={styles.card}>
          <h2 className={styles.sectionTitle}>{PARTITION_LABEL[p] ?? p}</h2>
          {visible
            .filter((i) => i.partition === p)
            .map((i) => (
              <div key={i.id} className={styles.taskRow}>
                <span className={styles.taskTitle}>
                  <strong>{i.title}</strong>
                  <span className={styles.taskMeta}>
                    {i.applicability ? ` · 判定 ${i.applicability}` : " · 未筛选"}
                    {i.noticeType ? ` · ${i.noticeType}` : ""}
                  </span>
                </span>
                <a href={`/inbox/${i.id}`}>查看</a>
              </div>
            ))}
        </div>
      ))}

      {normal.some((i) => i.partition === "folded") && (
        <p>
          <button className={styles.btn} onClick={() => setShowFolded((s) => !s)}>
            {showFolded ? "隐藏" : "显示"}已折叠的通知（可找回）
          </button>
        </p>
      )}
    </div>
  );
}