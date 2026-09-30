"use client";

import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "./api";
import styles from "./dash.module.css";
import IntegrationStatus from "./IntegrationStatus";
import AiBudgetCard from "./AiBudgetCard";
import DataExportCard from "./DataExportCard";
import type { IntegrationStatusMap } from "@/contracts/integration-status";
import {
  MAIL_COLUMN_KEYS,
  type MailColumnKey,
  type MailTemplateSettings,
} from "@/contracts/mail";

/**
 * 设置页（T3 阶段落点）：集成状态、邮件模板预览（不发送）、发送测试邮件（仅 MAIL_TO）、
 * 模板配置、提醒待处理与投递记录（accepted/unknown 文案准确区分）。
 */

type PreviewResp = { sample: boolean; subject: string; html: string; text: string };
type NotificationsResp = {
  pendingReminders: Array<{ taskId: string; title: string; triggerAt: string }>;
  upcomingReminders: Array<{ jobId: string; taskId: string; title: string; runAt: string }>;
  recentDeliveries: Array<{
    id: string;
    taskId: string | null;
    subject: string;
    status: string;
    error: string | null;
    createdAt: string;
  }>;
};

const DELIVERY_STATUS_LABEL: Record<string, string> = {
  queued: "排队中（未准入）",
  submitting: "发送中",
  accepted: "已被发送服务接受（不代表已读）",
  failed: "失败",
  unknown: "结果不确定（不自动重发）",
  cancelled: "已取消",
};

export default function SettingsView() {
  const [integrations, setIntegrations] = useState<IntegrationStatusMap | null>(null);
  const [settings, setSettings] = useState<MailTemplateSettings | null>(null);
  const [version, setVersion] = useState(0);
  const [preview, setPreview] = useState<PreviewResp | null>(null);
  const [notifs, setNotifs] = useState<NotificationsResp | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(() => {
    api<{ integrations: IntegrationStatusMap }>("/api/v1/integrations")
      .then((r) => setIntegrations(r.integrations))
      .catch(() => setIntegrations(null));
    api<{ settings: MailTemplateSettings; version: number }>("/api/v1/settings")
      .then((r) => {
        setSettings(r.settings);
        setVersion(r.version);
      })
      .catch(() => setSettings(null));
    api<NotificationsResp>("/api/v1/notifications")
      .then((r) => setNotifs(r))
      .catch(() => setNotifs(null));
  }, []);

  useEffect(refresh, [refresh]);

  async function saveSettings() {
    if (!settings) return;
    setBusy(true);
    setMessage(null);
    try {
      const r = await api<{ settings: MailTemplateSettings; version: number }>("/api/v1/settings", {
        method: "PATCH",
        body: { ...settings, expectedVersion: version },
      });
      setSettings(r.settings);
      setVersion(r.version);
      setMessage("模板设置已保存");
    } catch (e) {
      setMessage(e instanceof ApiError ? `${e.code}: ${e.message}` : "保存失败");
    } finally {
      setBusy(false);
    }
  }

  async function doPreview() {
    setBusy(true);
    setMessage(null);
    try {
      const r = await api<PreviewResp>("/api/v1/mail/preview", { method: "POST", body: {} });
      setPreview(r);
    } catch (e) {
      setMessage(e instanceof ApiError ? `${e.code}: ${e.message}` : "预览失败");
    } finally {
      setBusy(false);
    }
  }

  async function doTest() {
    setBusy(true);
    setMessage(null);
    try {
      const r = await api<{ recipient: string; delivery: { status: string } }>("/api/v1/mail/test", {
        method: "POST",
        body: {},
      });
      setMessage(
        r.delivery.status === "accepted"
          ? `发送服务已接受测试邮件（收件人 ${r.recipient}，不代表已读）`
          : `测试邮件状态：${r.delivery.status}`,
      );
    } catch (e) {
      setMessage(e instanceof ApiError ? `${e.code}: ${e.message}` : "发送失败");
    } finally {
      setBusy(false);
      refresh();
    }
  }

  function toggleColumn(key: MailColumnKey) {
    setSettings((s) => {
      if (!s) return s;
      const has = s.columns.includes(key);
      const columns = has
        ? s.columns.filter((c) => c !== key)
        : MAIL_COLUMN_KEYS.filter((c) => s.columns.includes(c) || c === key);
      return { ...s, columns };
    });
  }

  if (!integrations || !settings) {
    return <p className={styles.muted}>加载中…（未登录会跳转登录页）</p>;
  }

  return (
    <div>
      <div className={styles.card}>
        <h2 className={styles.sectionTitle}>集成状态</h2>
        <IntegrationStatus integrations={integrations} />
        <p className={styles.muted}>
          SMTP 未配置时提醒任务会标记失败并注明 INTEGRATION_UNAVAILABLE，不冒充已发送。
        </p>
      </div>

      <AiBudgetCard />
      <DataExportCard />

      <div className={styles.card}>
        <h2 className={styles.sectionTitle}>邮件模板</h2>
        <div className={styles.formGrid}>
          <div>
            <label className={styles.label} htmlFor="mail-prefix">
              标题前缀
            </label>
            <input
              id="mail-prefix"
              className={styles.field}
              value={settings.subjectPrefix}
              onChange={(e) => setSettings({ ...settings, subjectPrefix: e.target.value })}
            />
          </div>
          <div>
            <label className={styles.label} htmlFor="mail-summary">
              摘要长度上限
            </label>
            <input
              id="mail-summary"
              className={styles.field}
              type="number"
              min={50}
              max={2000}
              value={settings.summaryMaxLength}
              onChange={(e) => setSettings({ ...settings, summaryMaxLength: Number(e.target.value) })}
            />
          </div>
          <div>
            <label className={styles.label} htmlFor="mail-color">
              主题色
            </label>
            <input
              id="mail-color"
              className={styles.field}
              type="color"
              value={settings.themeColor}
              onChange={(e) => setSettings({ ...settings, themeColor: e.target.value })}
            />
          </div>
        </div>
        <fieldset className={styles.fieldset}>
          <legend className={styles.label}>栏目</legend>
          <div className={styles.checkGrid}>
            {MAIL_COLUMN_KEYS.map((key) => (
              <label key={key} className={styles.check}>
                <input type="checkbox" checked={settings.columns.includes(key)} onChange={() => toggleColumn(key)} />
                {COLUMN_LABEL[key]}
              </label>
            ))}
          </div>
        </fieldset>
        <label className={styles.check}>
          <input
            type="checkbox"
            checked={settings.privacyMode}
            onChange={(e) => setSettings({ ...settings, privacyMode: e.target.checked })}
          />
          隐私模式（隐藏任务标题与说明）
        </label>
        <div className={styles.actionsRow}>
          <button className={`${styles.btn} ${styles.btnPrimary}`} disabled={busy} onClick={saveSettings}>
            保存设置
          </button>
          <button className={styles.btn} disabled={busy} onClick={doPreview}>
            预览邮件（不发送）
          </button>
          <button className={styles.btn} disabled={busy} onClick={doTest}>
            发送测试邮件
          </button>
        </div>
        {preview && (
          <div style={{ marginTop: 12 }}>
            <div className={styles.muted}>
              {preview.sample ? "（合成示例）" : ""}主题：{preview.subject}
            </div>
            <pre style={{ whiteSpace: "pre-wrap", margin: "8px 0", fontSize: 13 }}>{preview.text}</pre>
            <iframe
              title="邮件 HTML 预览"
              srcDoc={preview.html}
              style={{ width: "100%", height: 320, border: "1px solid #ccc", borderRadius: 8 }}
            />
          </div>
        )}
      </div>

      <div className={styles.card}>
        <h2 className={styles.sectionTitle}>提醒与投递</h2>
        <h3 className={styles.muted}>待处理提醒（触发点已到）</h3>
        {notifs && notifs.pendingReminders.length === 0 && <p className={styles.muted}>无</p>}
        {notifs?.pendingReminders.map((r) => (
          <div key={r.taskId} className={styles.logItem}>
            {r.title}（触发 {r.triggerAt}）
          </div>
        ))}
        <h3 className={styles.muted}>未来提醒</h3>
        {notifs && notifs.upcomingReminders.length === 0 && <p className={styles.muted}>无</p>}
        {notifs?.upcomingReminders.map((r) => (
          <div key={r.jobId} className={styles.logItem}>
            {r.title}（{r.runAt} 发送）
          </div>
        ))}
        <h3 className={styles.muted}>投递记录</h3>
        {notifs && notifs.recentDeliveries.length === 0 && <p className={styles.muted}>无</p>}
        {notifs?.recentDeliveries.map((d) => (
          <div key={d.id} className={styles.logItem}>
            <span className={styles.taskMeta}>{DELIVERY_STATUS_LABEL[d.status] ?? d.status}</span>{" "}
            {d.subject}
            {d.error && <span className={styles.muted}>（{d.error}）</span>}
          </div>
        ))}
      </div>

      {message && <p className={styles.muted}>{message}</p>}
    </div>
  );
}

const COLUMN_LABEL: Record<MailColumnKey, string> = {
  title: "任务标题",
  due: "截止时间",
  project: "所属项目",
  description: "说明",
  link: "打开链接",
};