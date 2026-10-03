import { z } from "zod";

export const LEGACY_MAX_BYTES = 10 * 1024 * 1024;
export const legacyTaskSchema = z.object({
  id: z.number().int().positive(), title: z.string().min(1).max(10000).refine((s) => s.trim().length > 0, "标题不能为空"),
  note: z.string().max(50000).default(""), start_at: z.string().nullable().default(null),
  due_at: z.string().nullable().default(null), done: z.union([z.literal(0), z.literal(1)]),
  done_at: z.string().nullable().default(null), priority: z.enum(["low", "normal", "high"]),
  project: z.string().max(10000).refine((s) => s === "" || s.trim().length > 0, "项目名称不能只有空格").default(""), quick: z.union([z.literal(0), z.literal(1)]).default(0),
  pinned: z.union([z.literal(0), z.literal(1)]).default(0),
  created_at: z.string(), updated_at: z.string(),
  external_id: z.string().max(200).nullable().default(null),
  external_rev: z.number().int().nullable().default(null),
});
export const legacySnapshotSchema = z.object({
  format: z.literal("todo-web.sqlite.v1"),
  sourceId: z.string().regex(/^[a-zA-Z0-9._-]{1,80}$/),
  // 旧库没有时区，必须由主人明确选择，不能用服务器 TZ 猜。
  timezone: z.string().refine((s) => { try { new Intl.DateTimeFormat("en", { timeZone: s }); return true; } catch { return false; } }, "无效时区"),
  exportedAt: z.iso.datetime({ offset: true }), tasks: z.array(legacyTaskSchema).max(5000),
}).superRefine((s, ctx) => {
  if (new Set(s.tasks.map((t) => t.id)).size !== s.tasks.length) ctx.addIssue({ code: "custom", path: ["tasks"], message: "旧任务 ID 重复" });
});
export const legacyPreviewRequestSchema = z.object({
  snapshot: legacySnapshotSchema,
  campusSourceId: z.string().min(1).max(100).nullable().default(null),
  enableFutureReminders: z.boolean().default(false),
});
export const legacyApplyRequestSchema = legacyPreviewRequestSchema.extend({
  previewHash: z.string().regex(/^[a-f0-9]{64}$/), confirm: z.literal(true),
});
export type LegacyTask = z.infer<typeof legacyTaskSchema>;
export type LegacySnapshot = z.infer<typeof legacySnapshotSchema>;
export type LegacyRequest = z.infer<typeof legacyPreviewRequestSchema>;
export type LegacyApplyRequest = z.infer<typeof legacyApplyRequestSchema>;
export type LegacyItem = {
  kind: "project" | "task"; sourceId: string; title: string; targetId: string | null;
  action: "create" | "skip" | "conflict"; reason: string;
  mapped?: { status: string; priority: string; project: string; due: string | null; completedAt: string | null };
  current?: { title: string; status: string; due: string | null; archived: boolean };
  warnings: string[];
};
export type LegacyPreview = {
  previewHash: string; sourceId: string; timezone: string; campusSourceId: string | null;
  enableFutureReminders: boolean; items: LegacyItem[];
  counts: { projects: number; tasks: number; create: number; skip: number; conflict: number; warnings: number };
};
export type LegacyReceipt = {
  id: string; sourceId: string; createdAt: string; preview: LegacyPreview;
  created: Array<{ kind: "project" | "task"; sourceId: string; targetId: string }>;
};
