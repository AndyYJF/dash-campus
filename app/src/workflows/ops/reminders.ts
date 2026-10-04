import { getDb } from "@/repositories/db";
import type { ChangeInput } from "@/repositories/journal";
import type { Command, CommandContext } from "@/contracts/commands";
import { getSetting } from "@/repositories/settings";
import { getTask, updateTask } from "@/repositories/planning";
import { DIGEST_SETTINGS_KEY, digestSettingsSchema } from "@/contracts/digests";
import { HttpError } from "@/workflows/http";
import { refreshAllReminders } from "@/workflows/reminders";
import { REMINDER_POLICY_KEY, reminderPolicy, type ReminderPolicy } from "@/workflows/reminder-policy";
import { getConfig } from "@/config";

/**
 * 提醒与摘要策略（AGENT-INTERFACE-CONTRACT §2/§7）：持久更新具体策略，并让既有提醒任务与新策略一致。
 * 只发给已配置的主人邮箱；已经发出的邮件不能撤回，撤销只影响以后。
 */

type Cmd<N extends Command["command"]> = Extract<Command, { command: N }>;
const now = () => new Date().toISOString();

function writeSetting(key: string, before: unknown, after: unknown, version: number, changes: ChangeInput[]): void {
  const db = getDb();
  if (version === 0) {
    db.prepare(`INSERT INTO settings (key, value_json, version, updated_at) VALUES (?, ?, 1, ?)`).run(key, JSON.stringify(after), now());
    changes.push({ entityKind: "setting", entityId: key, action: "create", after: after as Record<string, unknown>, afterVersion: 1 });
  } else {
    db.prepare(`UPDATE settings SET value_json = ?, version = version + 1, updated_at = ? WHERE key = ?`).run(JSON.stringify(after), now(), key);
    changes.push({ entityKind: "setting", entityId: key, action: "update", before: { valueJson: JSON.stringify(before) }, after: { valueJson: JSON.stringify(after) }, beforeVersion: version, afterVersion: version + 1 });
  }
}

function leadLabel(minutes: number): string {
  if (minutes % 1440 === 0) return `${minutes / 1440} 天`;
  if (minutes % 60 === 0) return `${minutes / 60} 小时`;
  return `${minutes} 分钟`;
}

export function applyReminderPolicy(cmd: Cmd<"update_reminder_policy">, ctx: CommandContext, changes: ChangeInput[]): string {
  const parts: string[] = [];
  const entry = getSetting(REMINDER_POLICY_KEY);
  const before = reminderPolicy();
  const after: ReminderPolicy = {
    deadlineReminders: cmd.deadlineReminders ?? before.deadlineReminders,
    defaultLeadMinutes: cmd.defaultLeadMinutes === undefined ? before.defaultLeadMinutes : cmd.defaultLeadMinutes,
    quietEnabled: cmd.quietEnabled ?? before.quietEnabled,
    quietStart: cmd.quietStart ?? before.quietStart,
    quietEnd: cmd.quietEnd ?? before.quietEnd,
  };
  const policyChanged = JSON.stringify(before) !== JSON.stringify(after);
  if (policyChanged) {
    writeSetting(REMINDER_POLICY_KEY, before, after, entry.version, changes);
    if (after.deadlineReminders !== before.deadlineReminders) parts.push(after.deadlineReminders ? "有截止的任务会在临近截止时提醒" : "不再发截止提醒（已排好的提醒一并取消；页面上仍能看到截止）");
    if (after.defaultLeadMinutes !== before.defaultLeadMinutes) parts.push(after.defaultLeadMinutes === null ? "提前量恢复默认" : `默认提前 ${leadLabel(after.defaultLeadMinutes)}提醒`);
    if (after.quietEnabled !== before.quietEnabled || after.quietStart !== before.quietStart || after.quietEnd !== before.quietEnd) {
      parts.push(after.quietEnabled ? `${after.quietStart}–${after.quietEnd} 不发邮件，落在这段的提醒顺延到 ${after.quietEnd}` : "不再设安静时段");
    }
  }
  if (cmd.taskId) {
    const task = getTask(cmd.taskId);
    if (!task || task.archivedAt) throw new HttpError(404, "NOT_FOUND", "要设置提醒的任务不存在");
    const lead = cmd.taskLeadMinutes ?? null;
    if ((task.reminderLeadMinutes ?? null) !== lead) {
      const updated = updateTask(cmd.taskId, { reminderLeadMinutes: lead }, task.version, { validateSchedule: false });
      if (updated === "conflict" || updated === "not_found") throw new HttpError(409, "CONFLICT", "任务刚被修改，请重试");
      changes.push({ entityKind: "task", entityId: cmd.taskId, action: "update", before: { reminderLeadMinutes: task.reminderLeadMinutes ?? null }, after: { reminderLeadMinutes: lead }, beforeVersion: task.version, afterVersion: updated.version });
      parts.push(task.due.kind === "none" ? `「${task.title}」还没有截止时间，等有了截止会按提前 ${lead === null ? "默认时间" : leadLabel(lead)}提醒` : `「${task.title}」${lead === null ? "按默认时间" : `提前 ${leadLabel(lead)}`}提醒`);
    }
  }
  if (!changes.length) return "提醒设置没有变化";
  // 既有提醒任务与新策略一致：重排一遍（旧版本的在途提醒在准入时会被拦下）
  if (policyChanged) {
    const n = refreshAllReminders(ctx.now?.toISOString() ?? now());
    if (n) parts.push(`${n} 个任务的提醒已按新规则重排`);
  }
  if (!getConfig().MAIL_TO) parts.push("注意：还没有配置收件邮箱，现在不会真的发出邮件");
  return parts.join("；");
}

export function applyDigestPolicy(cmd: Cmd<"update_digest_policy">, _ctx: CommandContext, changes: ChangeInput[]): string {
  const entry = getSetting(DIGEST_SETTINGS_KEY);
  const before = digestSettingsSchema.parse(entry.value ?? {});
  const after = digestSettingsSchema.parse({ ...before, ...Object.fromEntries(Object.entries(cmd).filter(([k, v]) => k !== "command" && v !== undefined)) });
  if (JSON.stringify(before) === JSON.stringify(after)) return "摘要设置没有变化";
  writeSetting(DIGEST_SETTINGS_KEY, before, after, entry.version, changes);
  const parts: string[] = [];
  const WEEKDAY = "一二三四五六日";
  if (after.dailyEnabled) parts.push(`${after.dailyWeekdaysOnly ? "工作日" : "每天"} ${after.dailyTime} 发今日摘要`);
  else if (before.dailyEnabled) parts.push("不再发每日摘要（已经发出的收不回，以后不发）");
  if (after.weeklyEnabled) parts.push(`每周${WEEKDAY[after.weeklyWeekday - 1]} ${after.weeklyTime} 发每周回顾`);
  else if (before.weeklyEnabled) parts.push("不再发每周回顾");
  parts.push(getConfig().MAIL_TO ? "只发到已配置的主人邮箱" : "注意：还没有配置收件邮箱，现在不会真的发出邮件");
  return parts.join("；");
}
