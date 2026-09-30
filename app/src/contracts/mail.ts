import { z } from "zod";

/**
 * 邮件模板契约（计划 v1.2 第 8.2 节）。
 * 模板 V1 只提供标题前缀、栏目开关/顺序、摘要长度、主题色、隐私模式和时间；
 * 模板代码随应用发布，不允许界面提交任意 HTML/脚本。
 */

/** 提醒邮件的栏目 key（顺序即渲染顺序） */
export const MAIL_COLUMN_KEYS = ["title", "due", "project", "description", "link"] as const;
export type MailColumnKey = (typeof MAIL_COLUMN_KEYS)[number];

export const mailTemplateSettingsSchema = z.object({
  subjectPrefix: z.string().max(30).default("[Dash-campus]"),
  columns: z
    .array(z.enum(MAIL_COLUMN_KEYS))
    .max(MAIL_COLUMN_KEYS.length)
    .default([...MAIL_COLUMN_KEYS]),
  summaryMaxLength: z.number().int().min(50).max(2000).default(500),
  themeColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).default("#3a6df0"),
  privacyMode: z.boolean().default(false),
});

export type MailTemplateSettings = z.infer<typeof mailTemplateSettingsSchema>;

export const DEFAULT_MAIL_TEMPLATE_SETTINGS: MailTemplateSettings =
  mailTemplateSettingsSchema.parse({});

export const MAIL_SETTINGS_KEY = "mailTemplate";
