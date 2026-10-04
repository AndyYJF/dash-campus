import { z } from "zod";
import { taskKindSchema } from "@/domain/task-admission";

/** 目标 / 项目 / 任务的 Zod 契约，前后端共用（计划 v1.2 第 4.1 节） */

/** UTC 时刻：ISO 8601 且必须带时区偏移（Z 或 ±hh:mm），避免"明天"之类字符串进库后 new Date() 得 NaN */
export const isoInstant = z.iso.datetime({ offset: true });

type PatchShape<T extends z.ZodRawShape> = {
  [K in keyof T]: T[K] extends z.ZodDefault<infer I> ? z.ZodOptional<I> : z.ZodOptional<T[K]>;
};

/**
 * PATCH 用：去掉 .default() 再 optional。
 * Zod 4 的 .partial() 保留默认值，未传字段会被补成默认值并写回库（清空项目/截止等）。
 */
function patchShape<T extends z.ZodRawShape>(shape: T): PatchShape<T> {
  const out: Record<string, z.ZodType> = {};
  for (const [key, field] of Object.entries(shape)) {
    const inner = field instanceof z.ZodDefault ? (field.unwrap() as z.ZodType) : (field as z.ZodType);
    out[key] = inner.optional();
  }
  return out as PatchShape<T>;
}

export const goalSchema = z.object({
  title: z.string().trim().min(1).max(200),
  reason: z.string().max(2000).default(""),
  horizon: z.enum(["long_term", "semester"]),
});

export const goalPatchSchema = z.object(patchShape(goalSchema.shape)).extend({
  status: z.enum(["active", "paused", "completed"]).optional(),
});

export const projectSchema = z.object({
  title: z.string().trim().min(1).max(200),
  question: z.string().max(2000).default(""),
  expectedOutcome: z.string().max(2000).default(""),
  prerequisites: z.string().max(2000).default(""),
  reviewQuestions: z.string().max(2000).default(""),
  goalIds: z.array(z.string().uuid()).max(20).default([]),
});

export const projectPatchSchema = z.object(patchShape(projectSchema.shape)).extend({
  status: z.enum(["active", "paused", "completed"]).optional(),
  goalIds: z.array(z.string().uuid()).max(20).optional(),
});

export const dueSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none") }),
  z.object({
    kind: z.literal("date"),
    localDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    timezone: z.string().min(1),
  }),
  z.object({
    kind: z.literal("instant"),
    at: isoInstant,
    timezone: z.string().min(1),
  }),
]);

export const taskSchema = z.object({
  taskKind: taskKindSchema.optional(),
  title: z.string().trim().min(1).max(200),
  description: z.string().max(5000).default(""),
  projectId: z.string().uuid().nullable().default(null),
  goalId: z.string().uuid().nullable().default(null),
  status: z.enum(["todo", "doing", "blocked", "done", "cancelled"]).default("todo"),
  priority: z.enum(["normal", "high"]).default("normal"),
  estimateMinutes: z.number().int().min(0).nullable().default(null),
  plannedWeek: z
    .object({
      // 必须是周一：选成周三的任务不会被计入任何一周（4.3 周负担按 localMonday 归属）
      localMonday: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .refine((d) => new Date(`${d}T00:00:00Z`).getUTCDay() === 1, "localMonday 必须是周一"),
      timezone: z.string().min(1),
    })
    .nullable()
    .default(null),
  scheduledStart: isoInstant.nullable().default(null),
  scheduledEnd: isoInstant.nullable().default(null),
  due: dueSchema.default({ kind: "none" }),
  planningOverrideReason: z.string().trim().min(1).max(1000).nullable().optional(),
  reminderLeadMinutes: z.number().int().min(0).max(525600).nullable().optional(),
});

/** 创建任务：结束时间必须晚于开始、不能只有结束 */
export const taskCreateSchema = taskSchema.superRefine((t, ctx) => {
  if (t.scheduledEnd && !t.scheduledStart) ctx.addIssue({ code: "custom", path: ["scheduledEnd"], message: "只有结束时间没有开始时间" });
  if (t.scheduledStart && t.scheduledEnd && new Date(t.scheduledEnd) <= new Date(t.scheduledStart)) {
    ctx.addIssue({ code: "custom", path: ["scheduledEnd"], message: "结束时间必须晚于开始时间" });
  }
});

export const taskPatchSchema = z.object(patchShape(taskSchema.shape));

export const expectedVersionSchema = z.object({
  expectedVersion: z.number().int().min(1),
});

export type GoalInput = z.infer<typeof goalSchema>;
export type ProjectInput = z.infer<typeof projectSchema>;
export type TaskInput = z.infer<typeof taskSchema>;
export type Due = z.infer<typeof dueSchema>;
