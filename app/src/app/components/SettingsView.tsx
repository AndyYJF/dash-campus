"use client";

import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "./api";
import styles from "./dash.module.css";
import Icon from "./Icon";
import Link from "next/link";
import IntegrationStatus from "./IntegrationStatus";
import AiBudgetCard from "./AiBudgetCard";
import ModelCapabilitiesCard from "./ModelCapabilitiesCard";
import AgentTrialMetricsCard from "./AgentTrialMetricsCard";
import ThemeToggle from "./ThemeToggle";
import DigestSettingsCard from "./DigestSettingsCard";
import ProfileSourcesCard from "./ProfileSourcesCard";
import DataExportCard from "./DataExportCard";
import LegacyImportCard from "./LegacyImportCard";
import type { IntegrationStatusMap } from "@/contracts/integration-status";
import type { TaskRow } from "@/repositories/planning";
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
export default function SettingsView() {
  const [integrations, setIntegrations] = useState<IntegrationStatusMap | null>(null);
  const [settings, setSettings] = useState<MailTemplateSettings | null>(null);
  const [version, setVersion] = useState(0);
  const [preview, setPreview] = useState<PreviewResp | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [previewTasks, setPreviewTasks] = useState<TaskRow[]>([]);
  const [previewTaskId, setPreviewTaskId] = useState("");

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
    api<{ tasks: TaskRow[] }>("/api/v1/tasks")
      .then((r) =>
        setPreviewTasks(
          r.tasks.filter((t) => !t.archivedAt && t.status !== "done" && t.status !== "cancelled"),
        ),
      )
      .catch(() => setPreviewTasks([]));
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
      const r = await api<PreviewResp>("/api/v1/mail/preview", {
        method: "POST",
        body: previewTaskId ? { taskId: previewTaskId } : {},
      });
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
    <div className={styles.narrow}>
      <div className={styles.card}>
        <h2 className={styles.sectionTitle}>集成状态</h2>
        <IntegrationStatus integrations={integrations} />
        <p className={styles.muted}>
          密钥只在部署环境的 <code>.env</code> 里配置，这里不显示也不能填写。SMTP 未配置时提醒任务会标记失败并注明
          INTEGRATION_UNAVAILABLE，不冒充已发送。
        </p>
      </div>

      <div className={styles.card}>
        <div className={styles.cardHeader}>
          <h2>外观</h2>
          <div className={styles.themeSlot}>
            <ThemeToggle />
          </div>
        </div>
        <p className={styles.muted}>亮色、跟随系统或暗色。选择只保存在这台设备的浏览器里。</p>
      </div>

      <ProfileSourcesCard />
      <DigestSettingsCard />
      {integrations.model.state === "configured" && <ModelCapabilitiesCard />}
      <AiBudgetCard />
      <AgentTrialMetricsCard />
      <DataExportCard />
      <LegacyImportCard />

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
        </div>
        <hr className={styles.divider} />
        <h3 className={styles.sectionTitle}>预览与测试</h3>
        <label className={styles.label} htmlFor="mail-preview-task">
          预览用任务
        </label>
        <div className={styles.fieldRow}>
          <select
            id="mail-preview-task"
            className={styles.field}
            value={previewTaskId}
            onChange={(e) => setPreviewTaskId(e.target.value)}
          >
            <option value="">合成示例</option>
            {previewTasks.map((t) => (
              <option key={t.id} value={t.id}>
                {t.title}
              </option>
            ))}
          </select>
          <button className={styles.btn} disabled={busy} onClick={doPreview}>
            预览邮件（不发送）
          </button>
          <button className={styles.btn} disabled={busy} onClick={doTest}>
            <Icon name="mail" size={16} />
            发送测试邮件
          </button>
        </div>
        {preview && (
          <div style={{ marginTop: 12 }}>
            <div className={styles.muted}>
              {preview.sample ? "（合成示例）" : ""}主题：{preview.subject}
            </div>
            <pre className={styles.previewText}>{preview.text}</pre>
            <iframe title="邮件 HTML 预览" srcDoc={preview.html} className={styles.previewFrame} />
          </div>
        )}
      </div>

      <p><Link href="/notifications">查看提醒队列与投递记录</Link></p>

      {message && (
        <p className={styles.notice} role="status">
          {message}
        </p>
      )}
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
