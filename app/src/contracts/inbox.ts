import { z } from "zod";
import { dueSchema } from "@/contracts/planning";

/**
 * 收件箱契约（计划 v1.2 第 5 节）。
 * 三值筛选：TRUE/FALSE/UNKNOWN；叶子只能是允许的身份字段与 eq/in 比较，附原文引用。
 * 未配置模型时可手填条件或仅存原文，不假装语义筛选已运行（structured 可省略）。
 */

/** 允许的身份字段（叶子字段白名单；新增字段属后续任务） */
export const PROFILE_FIELDS = ["education_level", "program", "campus", "grade_year"] as const;
export type ProfileField = (typeof PROFILE_FIELDS)[number];

export const PARTITIONS = ["action", "info", "opportunity", "review", "folded"] as const;
export type Partition = (typeof PARTITIONS)[number];

export type Tri = "TRUE" | "FALSE" | "UNKNOWN";

export const conditionLeafSchema = z.object({
  kind: z.literal("leaf"),
  field: z.string().min(1).max(50),
  op: z.enum(["eq", "in"]),
  value: z.union([z.string().min(1).max(200), z.array(z.string().min(1).max(200)).min(1)]),
  /** 原文引用：资格事实必须引用证据文本 */
  quote: z.string().min(1).max(1000),
});

export type ConditionNode = z.infer<typeof conditionLeafSchema> | {
  kind: "all" | "any";
  children: ConditionNode[];
};

export const conditionNodeSchema: z.ZodType<ConditionNode> = z.lazy(() =>
  z.union([
    conditionLeafSchema,
    z.object({
      kind: z.literal("all"),
      children: z.array(conditionNodeSchema).min(1).max(10),
    }),
    z.object({
      kind: z.literal("any"),
      children: z.array(conditionNodeSchema).min(1).max(10),
    }),
  ]),
);

export const noticeActionSchema = z.object({
  /** 第一次生成行动后固定 action_key，不由每次提取随机生成（5.1） */
  actionKey: z.string().min(1).max(100),
  title: z.string().trim().min(1).max(200),
  description: z.string().max(5000).default(""),
  due: dueSchema.optional(),
  /** 行动必需（TRUE→action）还是自愿参与（TRUE→opportunity） */
  required: z.boolean().default(false),
});

export const noticeStructuredSchema = z.object({
  noticeType: z.string().min(1).max(100),
  condition: conditionNodeSchema.optional(),
  action: noticeActionSchema.optional(),
});

/** NoticeImport 导入 envelope（计划 5.1）；structured 为 V1 手填/后续模型提取扩展 */
export const noticeImportSchema = z.object({
  schemaVersion: z.literal(1),
  source: z.string().min(1).max(100),
  externalId: z.string().min(1).max(200),
  revisionKey: z.string().min(1).max(200),
  revisionOrder: z.number().int().nullable().default(null),
  occurredAt: z.string().min(1),
  text: z.string().min(1).max(50000),
  sourceUrl: z.string().url().optional(),
  structured: noticeStructuredSchema.optional(),
});

export type NoticeImport = z.infer<typeof noticeImportSchema>;
export type NoticeStructured = z.infer<typeof noticeStructuredSchema>;
export type NoticeAction = z.infer<typeof noticeActionSchema>;

export const profileFactSchema = z.object({
  field: z.enum(PROFILE_FIELDS),
  value: z.string().trim().min(1).max(200),
  expectedVersion: z.number().int().min(0),
});

export const profileRuleSchema = z.object({
  source: z.string().min(1).max(100),
  noticeType: z.string().min(1).max(100),
  condition: conditionNodeSchema,
  outputPartition: z.enum(PARTITIONS),
  priority: z.number().int().min(1).max(100),
});
