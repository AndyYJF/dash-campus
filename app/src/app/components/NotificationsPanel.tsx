"use client";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { api, ApiError } from "./api";
import styles from "./dash.module.css";
import Icon from "./Icon";
type NotificationsResp = {
  pendingReminders: Array<{ taskId: string; title: string; triggerAt: string }>;
  upcomingReminders: Array<{ jobId: string; taskId: string; title: string; runAt: string }>;
  inFlightOldReminders: Array<{
    deliveryId: string;
    taskId: string;
    title: string;
    status: string;
    reminderRevision: number;
    currentRevision: number;
  }>;
  recentDeliveries: Array<{
    id: string;
    taskId: string | null;
    subject: string;
    status: string;
    attempt: number;
    resentFrom: string | null;
    error: string | null;
    createdAt: string;
  }>;
};

const RESENDABLE = new Set(["unknown", "failed"]);

function formatTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

const DELIVERY_STATUS_LABEL: Record<string, string> = {
  queued: "排队中（未准入）",
  submitting: "发送中",
  accepted: "已被发送服务接受（不代表已读）",
  failed: "失败",
  unknown: "结果未确定，可能已发送（不自动重发）",
  cancelled: "已取消",
};

export default function NotificationsPanel() {
  const [notifs,setNotifs] = useState<NotificationsResp|null>(null);
  const [message,setMessage] = useState<string|null>(null);
  const [busy,setBusy] = useState(false);
  const [confirmResendId,setConfirmResendId] = useState<string|null>(null);
  const [loadError,setLoadError] = useState<string|null>(null);
  const refresh = useCallback(() => {
    api<NotificationsResp>("/api/v1/notifications").then(r=>{setNotifs(r);setLoadError(null);}).catch(e=>setLoadError(e instanceof Error?e.message:"加载失败"));
  },[]);
  useEffect(refresh,[refresh]);
  async function doResend(deliveryId: string) {
    setBusy(true);
    setMessage(null);
    try {
      const r = await api<{ delivery: { status: string; attempt: number } }>(
        `/api/v1/deliveries/${deliveryId}/resend`,
        { method: "POST", body: { confirmDuplicateRisk: true } },
      );
      setMessage(
        r.delivery.status === "accepted"
          ? `第 ${r.delivery.attempt} 次尝试已被发送服务接受（不代表已读）`
          : `重发状态：${DELIVERY_STATUS_LABEL[r.delivery.status] ?? r.delivery.status}`,
      );
    } catch (e) {
      setMessage(e instanceof ApiError ? `${e.code}: ${e.message}` : "重发失败");
    } finally {
      setConfirmResendId(null);
      setBusy(false);
      refresh();
    }
  }

  return <div className={styles.narrow}>
    <p><Link href="/settings">邮件模板与配置</Link> · <button className={styles.btn} onClick={refresh}>刷新记录</button></p>
    {loadError && <p className={styles.error} role="alert">{loadError}</p>}
    {!notifs && !loadError && <p className={styles.muted}>加载中…</p>}
      <div className={styles.card}>
        <h2 className={styles.sectionTitle}>提醒与投递</h2>
        <h3 className={styles.sectionTitle}>待处理提醒（触发点已到）</h3>
        {notifs && notifs.pendingReminders.length === 0 && <p className={styles.muted}>无</p>}
        {notifs?.pendingReminders.map((r) => (
          <div key={r.taskId} className={styles.logItem}>
            <div>{r.title}</div>
            <span className={styles.metaRow}>
              <span className={styles.metaItem}>
                <Icon name="clock" size={14} />
                触发于 {formatTime(r.triggerAt)}
              </span>
            </span>
          </div>
        ))}
        <h3 className={styles.sectionTitle}>未来提醒</h3>
        {notifs && notifs.upcomingReminders.length === 0 && <p className={styles.muted}>无</p>}
        {notifs?.upcomingReminders.map((r) => (
          <div key={r.jobId} className={styles.logItem}>
            <div>{r.title}</div>
            <span className={styles.metaRow}>
              <span className={styles.metaItem}>
                <Icon name="mail" size={14} />
                {formatTime(r.runAt)} 发送
              </span>
            </span>
          </div>
        ))}
        {notifs && notifs.inFlightOldReminders.length > 0 && (
          <>
            <h3 className={styles.sectionTitle}>存在发送中的旧提醒</h3>
            <p className={styles.muted}>
              这些任务改期前的提醒已经交给发送服务，可能仍会到达，按新时间的提醒另行发送。
            </p>
            {notifs.inFlightOldReminders.map((r) => (
              <div key={r.deliveryId} className={styles.logItem}>
                <span className={styles.taskMeta}>{DELIVERY_STATUS_LABEL[r.status] ?? r.status}</span>{" "}
                {r.title}（旧版本 {r.reminderRevision}，当前 {r.currentRevision}）
              </div>
            ))}
          </>
        )}
        <h3 className={styles.sectionTitle}>投递记录</h3>
        {notifs && notifs.recentDeliveries.length === 0 && <p className={styles.muted}>无</p>}
        {notifs?.recentDeliveries.map((d) => {
          const resent = notifs.recentDeliveries.some((x) => x.resentFrom === d.id);
          return (
            <div key={d.id} className={styles.logItem}>
              <span className={styles.taskMeta}>{DELIVERY_STATUS_LABEL[d.status] ?? d.status}</span>{" "}
              {d.subject}
              <span className={styles.muted}>
                {" "}
                · {formatTime(d.createdAt)}
                {d.attempt > 1 ? ` · 第 ${d.attempt} 次尝试` : ""}
              </span>
              {d.error && <span className={styles.muted}>（{d.error}）</span>}
              {RESENDABLE.has(d.status) && !resent && confirmResendId !== d.id && (
                <button className={`${styles.btn} ${styles.btnGhost}`} disabled={busy} onClick={() => setConfirmResendId(d.id)}>
                  重发…
                </button>
              )}
              {resent && <span className={styles.muted}> · 已重发</span>}
              {confirmResendId === d.id && (
                <div className={styles.actionsRow} role="group" aria-label="确认重发">
                  <span className={styles.muted}>
                    {d.status === "unknown"
                      ? "这封邮件可能已经发出，重发可能让你收到两封。"
                      : "上次发送失败，重发会再尝试一次。"}
                  </span>
                  <button className={`${styles.btn} ${styles.btnPrimary}`} disabled={busy} onClick={() => doResend(d.id)}>
                    确认重发
                  </button>
                  <button className={styles.btn} disabled={busy} onClick={() => setConfirmResendId(null)}>
                    取消
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>
    {message && <p className={styles.notice} role="status">{message}</p>}
  </div>;
}
