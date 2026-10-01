"use client";

import { useEffect, useState, type KeyboardEvent } from "react";
import { api } from "./api";
import { useDraft } from "./useDraft";
import ErrorNote, { toErrorState } from "./ErrorNote";
import LogTimeline from "./LogTimeline";
import styles from "./dash.module.css";
import type { TaskRow } from "@/repositories/planning";

/**
 * QuickLogForm（F17/U7）：每条新记录一个独立 clientEntryId，与正文一起存为本机草稿；
 * 会话过期、刷新或重新登录后草稿仍在，用同一个 clientEntryId 重新提交不会重复创建。
 * 成功后清理草稿并生成新 clientEntryId。日期按实例时区取"今天"。
 */

type Draft = { clientEntryId: string; occurredOn: string; progress: string; blocker: string; taskId: string };

export default function QuickLogForm({
  recentLogs,
  tasks,
  localDate,
  onSaved,
}: {
  recentLogs: Array<{
    id: string;
    occurredOn: string;
    progress: string;
    blocker: string;
    taskId: string | null;
    projectId: string | null;
  }>;
  tasks: TaskRow[];
  /** 实例时区的今天（来自 /today 快照），不用浏览器 UTC 日期 */
  localDate: string;
  onSaved: () => void;
}) {
  const { value: d, update, clear, restored, loaded } = useDraft<Draft>("quick-log", {
    clientEntryId: "",
    occurredOn: "",
    progress: "",
    blocker: "",
    taskId: "",
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; status?: number } | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(null);

  // 草稿缺 ID 或日期时补齐（首次打开或上一条已保存）
  // 必须等本机草稿读完：否则会先生成新 ID，覆盖草稿里原来的 clientEntryId
  useEffect(() => {
    if (!loaded) return;
    if (!d.clientEntryId) update({ clientEntryId: crypto.randomUUID() });
    if (!d.occurredOn && localDate) update({ occurredOn: localDate });
  }, [loaded, d.clientEntryId, d.occurredOn, localDate, update]);

  async function save() {
    if (!d.progress.trim() && !d.blocker.trim()) {
      setError({ message: "进展与卡点至少填一项" });
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api("/api/v1/logs", {
        method: "POST",
        body: {
          clientEntryId: d.clientEntryId,
          occurredOn: d.occurredOn || localDate,
          progress: d.progress.trim(),
          blocker: d.blocker.trim(),
          taskId: d.taskId || null,
          projectId: tasks.find((t) => t.id === d.taskId)?.projectId ?? null,
        },
      });
      clear({ clientEntryId: crypto.randomUUID(), occurredOn: localDate });
      setSavedAt(new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }));
      onSaved();
    } catch (e) {
      setError(toErrorState(e, "保存失败，内容已保留在本机"));
    } finally {
      setBusy(false);
    }
  }

  const hasText = Boolean(d.progress.trim() || d.blocker.trim());
  // 四态分清（F17/U7）：本机草稿 / 提交中 / 已保存 / 失败
  const state = busy ? "submitting" : error ? "failed" : hasText ? "draft" : savedAt ? "saved" : "idle";
  const linked = tasks.find((t) => t.id === d.taskId);
  const submitOnCtrlEnter = (e: KeyboardEvent) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && !busy) {
      e.preventDefault();
      void save();
    }
  };

  return (
    <section className={styles.card} aria-labelledby="quick-log-title">
      <div className={styles.cardHeader}>
        <h2 id="quick-log-title">写记录</h2>
        <span
          className={`${styles.statusPill} ${state === "saved" ? styles.statusOk : state === "failed" ? styles.statusDanger : ""}`}
          role="status"
          aria-live="polite"
        >
          {state === "submitting" && "提交中…"}
          {state === "failed" && "未保存，内容在本机"}
          {state === "draft" && (restored ? "已恢复本机草稿" : "草稿已存本机")}
          {state === "saved" && `已保存 ${savedAt}`}
        </span>
      </div>
      {/* 两段正文 + 底部工具条（日期、关联、保存）合成一个输入框 */}
      <form
        className={styles.composer}
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <div className={styles.composerPart}>
          <label className={styles.composerLabel} htmlFor="log-progress">
            进展
          </label>
          <textarea id="log-progress" placeholder="今天推进了什么" rows={2} value={d.progress} onKeyDown={submitOnCtrlEnter} onChange={(e) => update({ progress: e.target.value })} />
        </div>
        <div className={styles.composerPart}>
          <label className={styles.composerLabel} htmlFor="log-blocker">
            卡点（可留空）
          </label>
          <textarea id="log-blocker" placeholder="卡在哪里" rows={2} value={d.blocker} onKeyDown={submitOnCtrlEnter} onChange={(e) => update({ blocker: e.target.value })} />
        </div>
        <div className={styles.composerBar}>
          <label className="visually-hidden" htmlFor="log-date">
            日期
          </label>
          <input id="log-date" type="date" value={d.occurredOn} onChange={(e) => update({ occurredOn: e.target.value })} />
          <label className="visually-hidden" htmlFor="log-task">
            关联
          </label>
          <select id="log-task" value={d.taskId} onChange={(e) => update({ taskId: e.target.value })}>
            <option value="">日常记录（不关联任务）</option>
            {tasks.map((t) => (
              <option key={t.id} value={t.id}>
                {t.title}
              </option>
            ))}
          </select>
          <button type="submit" className={`${styles.btn} ${styles.btnPrimary}`} disabled={busy}>
            {busy ? "保存中…" : "保存记录"}
          </button>
        </div>
      </form>
      <p className={styles.composerHint}>
        <span>{linked ? `记在任务「${linked.title}」${linked.projectId ? "及其项目" : ""}下` : "记为日常记录"}</span>
        <span>
          进展和卡点至少填一项；<span className={styles.kbd}>Ctrl</span> + <span className={styles.kbd}>Enter</span> 也可提交
        </span>
      </p>
      <ErrorNote error={error} />
      <h3 className={styles.sectionTitle}>最近记录</h3>
      {recentLogs.length === 0 && <p className={styles.empty}>还没有记录。写一条今天的进展或卡点吧。</p>}
      {recentLogs.length > 0 && (
        <LogTimeline logs={recentLogs} />
      )}
    </section>
  );
}
