"use client";

import { useCallback, useEffect, useState } from "react";
import { api } from "./api";
import Icon from "./Icon";
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

/** 资格判定的可读说法与徽标颜色（与详情页一致，不直接显示内部代码） */
const APPLICABILITY: Record<string, { label: string; cls: string }> = {
  TRUE: { label: "符合条件", cls: styles.badgeOk },
  FALSE: { label: "不符合条件", cls: "" },
  UNKNOWN: { label: "条件未知", cls: styles.badgeHigh },
};

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
    <div className={styles.narrow}>
      {conflicts.length > 0 && (
        <div className={styles.card}>
          <h2 className={`${styles.sectionTitle} ${styles.sectionDanger}`}>有 {conflicts.length} 条通知的修订顺序无法确定，需要你选择当前版本。</h2>
          {conflicts.map((c) => (
            <div key={c.id} className={`${styles.taskRow} ${styles.taskRowCenter}`}>
              <span className={styles.taskTitle}>{c.title}</span>
              <a className={`${styles.btn} ${styles.btnGhost}`} href={`/inbox/${c.id}`}>
                去选择
                <Icon name="chevronRight" size={16} />
              </a>
            </div>
          ))}
        </div>
      )}

      {visible.length === 0 && <p className={styles.empty}>收件箱是空的。外部通知导入后会出现在这里。</p>}

      {ORDER.filter((p) => visible.some((i) => i.partition === p)).map((p) => (
        <div key={p} className={styles.card}>
          <h2 className={styles.sectionTitle}>{PARTITION_LABEL[p] ?? p}</h2>
          {visible
            .filter((i) => i.partition === p)
            .map((i) => (
              <div key={i.id} className={`${styles.taskRow} ${styles.taskRowCenter}`}>
                <div className={styles.taskBody}>
                  <span className={styles.taskTitle}>{i.title}</span>
                  {i.textPreview && <span className={styles.taskMeta}>{i.textPreview}</span>}
                  <span className={styles.metaRow}>
                    <span className={`${styles.badge} ${APPLICABILITY[i.applicability ?? ""]?.cls ?? ""}`}>
                      {APPLICABILITY[i.applicability ?? ""]?.label ?? "未筛选"}
                    </span>
                    {i.noticeType && <span className={styles.metaItem}>类型 {i.noticeType}</span>}
                    {i.occurredAt && (
                      <span className={styles.metaItem}>
                        <Icon name="clock" size={14} />
                        {new Date(i.occurredAt).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                      </span>
                    )}
                  </span>
                </div>
                <a className={`${styles.btn} ${styles.btnGhost}`} href={`/inbox/${i.id}`}>
                  查看
                  <Icon name="chevronRight" size={16} />
                </a>
              </div>
            ))}
        </div>
      ))}

      {normal.some((i) => i.partition === "folded") && (
        <p>
          <button className={`${styles.btn} ${styles.btnGhost}`} onClick={() => setShowFolded((s) => !s)}>
            {showFolded ? "隐藏" : "显示"}已折叠的通知（可找回）
          </button>
        </p>
      )}
    </div>
  );
}