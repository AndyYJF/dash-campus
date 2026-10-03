import { z } from "zod";
import { noticeImportSchema } from "@/contracts/inbox";
import { redactLegacyText } from "@/domain/legacy";

/** 对照插件 todo_tasks 实际字段；原文仅500字/来源，不能假装完整。 */
export const campusTaskSchema = z.object({
  task_id: z.string().min(1).max(200), revision: z.number().int().min(0),
  title: z.string().min(1).max(10000), description: z.string().max(50000).default(""),
  action_text: z.string().max(10000).default(""), category: z.string().max(100).default(""),
  status: z.enum(["open", "completed", "cancelled"]),
  due_at: z.string().nullable().default(null), due_date: z.string().nullable().default(null),
  event_at: z.string().nullable().default(null), time_text: z.string().max(10000).default(""),
  updated_at: z.iso.datetime({ offset: true }), timezone: z.string().default("Asia/Shanghai"),
  uncertain_fields: z.array(z.string().max(200)).max(100).default([]),
  sources: z.array(z.object({ group_alias: z.string().max(200).default(""), text: z.string().max(50000).default(""),
    sent_at: z.string().optional(), media: z.array(z.string().max(2000)).max(100).default([]) })).max(100).default([]),
});
export const campusFeedSchema = z.object({ tasks: z.array(campusTaskSchema).max(5000) });
export type CampusTask = z.infer<typeof campusTaskSchema>;

export function campusEvidenceText(task: CampusTask): string {
  return [...new Set(task.sources.map((s) => redactLegacyText(s.text)).filter(Boolean))].sort().join("\n\n");
}

export function campusEvidenceOccurredAt(task: CampusTask): string | null {
  const evidence = task.sources.filter((s) => s.text.trim());
  if (!evidence.length || evidence.some((s) => !s.sent_at || !z.iso.datetime({ offset: true }).safeParse(s.sent_at).success)) return null;
  const dates = [...new Set(evidence.map((s) => new Date(s.sent_at!).toISOString()))];
  // 多条不同时间的节选无法统一锚定“明天”；不能借更新时间定位。
  return dates.length === 1 ? dates[0] : null;
}

export function campusEnvelope(task: CampusTask, source: string) {
  const evidence = [...new Set(task.sources.map((s) => redactLegacyText(s.text)).filter(Boolean))].sort();
  // 不写媒体 token，也不把插件的语义摘要当作资格原文。状态变化留在版本里供主人判断。
  const text = ["【旧校园插件桥接】原文由上游接口截取，每来源最多500字；摘要和行动由旧插件生成，资格待核对。",
    `旧事项ID：${task.task_id}`, `上游状态：${task.status}`, `上游标题：${redactLegacyText(task.title)}`,
    `旧插件摘要：${redactLegacyText(task.description)}`, `旧插件行动：${redactLegacyText(task.action_text)}`,
    `原文时间：${redactLegacyText(task.time_text)}`, `上游截止：${task.due_at ?? task.due_date ?? "未提供"}`,
    `上游事件时间：${task.event_at ?? "未提供"}`, `不确定字段：${task.uncertain_fields.slice().sort().join("、")}`,
    ...evidence.map((e) => `—— 群消息原文节选 ——\n${e}`),
  ].join("\n");
  return noticeImportSchema.parse({ schemaVersion: 1, source, externalId: task.task_id, revisionKey: `campus-r${task.revision}`,
    revisionOrder: task.revision, occurredAt: task.updated_at, text });
}
