import {
  type MailColumnKey,
  type MailTemplateSettings,
} from "@/contracts/mail";
import type { Due } from "@/contracts/planning";

/**
 * 固定布局的邮件模板（计划 v1.2 第 8.2 节）。
 * 模板代码随应用发布；正文与变量全部 HTML 转义；同时生成纯文本版。
 * 邮件中的业务链接只读打开页面；正文标明内容生成时间。
 */

export type ReminderEmailInput = {
  taskTitle: string;
  due: Due;
  projectName: string | null;
  description: string;
  taskUrl: string;
  nowIso: string;
};

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** 截断到摘要长度上限，附加省略标记 */
export function summarize(s: string, maxLength: number): string {
  if (s.length <= maxLength) return s;
  return `${s.slice(0, maxLength)}…`;
}

export function dueLabel(due: Due): string {
  if (due.kind === "none") return "无截止";
  if (due.kind === "date") return `${due.localDate} 截止（具体时间未知）`;
  const at = new Date(due.at);
  const local = new Intl.DateTimeFormat("zh-CN", {
    timeZone: due.timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(at);
  return `${local}（${due.timezone}）截止`;
}

type ColumnRow = { label: string; html: string; text: string };

function buildColumn(
  key: MailColumnKey,
  input: ReminderEmailInput,
  settings: MailTemplateSettings,
): ColumnRow | null {
  const esc = escapeHtml;
  const hidden = "（隐私模式已隐藏）";
  switch (key) {
    case "title":
      return {
        label: "任务",
        html: `<strong>${esc(settings.privacyMode ? "任务提醒（隐私模式已隐藏标题）" : input.taskTitle)}</strong>`,
        text: settings.privacyMode ? "任务提醒（隐私模式已隐藏标题）" : input.taskTitle,
      };
    case "due":
      return { label: "截止", html: esc(dueLabel(input.due)), text: dueLabel(input.due) };
    case "project":
      if (!input.projectName) return null;
      return {
        label: "所属项目",
        html: esc(settings.privacyMode ? hidden : input.projectName),
        text: settings.privacyMode ? hidden : input.projectName,
      };
    case "description": {
      if (!input.description) return null;
      const summary = summarize(input.description, settings.summaryMaxLength);
      return {
        label: "说明",
        html: esc(settings.privacyMode ? hidden : summary),
        text: settings.privacyMode ? hidden : summary,
      };
    }
    case "link":
      return {
        label: "打开任务",
        html: `<a href="${esc(input.taskUrl)}">${esc(input.taskUrl)}</a>`,
        text: input.taskUrl,
      };
  }
}

/** 渲染提醒邮件；返回 {subject, html, text}。text 为纯文本版，html 为固定布局。 */
export function renderReminderEmail(
  input: ReminderEmailInput,
  settings: MailTemplateSettings,
): { subject: string; html: string; text: string } {
  const rows: ColumnRow[] = [];
  for (const key of settings.columns) {
    const row = buildColumn(key, input, settings);
    if (row) rows.push(row);
  }
  const generatedLabel = `内容生成时间：${input.nowIso}`;
  const subject = `${settings.subjectPrefix} 截止提醒：${
    settings.privacyMode ? "你有任务即将截止" : input.taskTitle
  }`;

  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f4f5f7;font-family:sans-serif;color:#222;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;margin:24px auto;background:#ffffff;border-radius:8px;overflow:hidden;">
    <tr><td style="background:${escapeHtml(settings.themeColor)};padding:16px 24px;color:#ffffff;font-size:16px;">
      ${escapeHtml(settings.subjectPrefix)} 截止提醒
    </td></tr>
    <tr><td style="padding:16px 24px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
        ${rows
          .map(
            (r) =>
              `<tr><td style="padding:6px 0;color:#777;font-size:13px;">${escapeHtml(r.label)}</td></tr>` +
              `<tr><td style="padding:0 0 12px;font-size:15px;line-height:1.5;">${r.html}</td></tr>`,
          )
          .join("")}
      </table>
      <p style="margin:12px 0 0;color:#999;font-size:12px;">${escapeHtml(generatedLabel)}</p>
    </td></tr>
  </table>
</body>
</html>`;

  const text = [
    `${settings.subjectPrefix} 截止提醒`,
    "",
    ...rows.map((r) => `${r.label}：${r.text}`),
    "",
    generatedLabel,
  ].join("\n");

  return { subject, html, text };
}
