import { getSetting, updateSetting } from "@/repositories/settings";
import {
  MAIL_SETTINGS_KEY,
  mailTemplateSettingsSchema,
  type MailTemplateSettings,
} from "@/contracts/mail";

/**
 * 邮件模板设置的读取与更新（供 worker 准入、preview/test 路由共用）。
 * 存库值是部分字段 + Zod 默认值合并；不接收任意 HTML/脚本。
 */

export function getMailTemplateSettings(): MailTemplateSettings {
  const { value } = getSetting(MAIL_SETTINGS_KEY);
  return mailTemplateSettingsSchema.parse(value ?? {});
}

export function saveMailTemplateSettings(
  value: MailTemplateSettings,
  expectedVersion: number,
): { version: number } | "conflict" {
  return updateSetting(MAIL_SETTINGS_KEY, mailTemplateSettingsSchema.parse(value), expectedVersion);
}
