import { z } from "zod";

/**
 * Agent-first V2 统一输入契约（MASTER-PLAN §3、§4.1、§8）。
 * P1 范围：文字/SDCT1；附件与来源适配器在 P4 进入同一 envelope。
 */

export const INTAKE_JOB_TYPE = "intake_process";

export const INTAKE_STATUSES = [
  "received",
  "processing",
  "waiting_input",
  "partially_applied",
  "completed",
  "failed",
  "cancelled",
] as const;
export type IntakeStatus = (typeof INTAKE_STATUSES)[number];

export const INTAKE_ITEM_STATES = [
  "extracted",
  "resolving",
  "awaiting_input",
  "ready",
  "applied",
  "ignored",
  "failed",
  "cancelled",
] as const;
export type IntakeItemState = (typeof INTAKE_ITEM_STATES)[number];

export const INTAKE_ITEM_KINDS = ["timetable", "notice", "practice", "task", "note"] as const;
export type IntakeItemKind = (typeof INTAKE_ITEM_KINDS)[number];

/** POST /api/v2/intakes 请求体；multipart 与附件在 P4 */
export const intakeCreateSchema = z.object({
  text: z.string().min(1, "内容不能为空").max(100_000, "文字最多 100k 字符"),
  /** 显式参照日期（默认取提交日）；旧截图/引用由前端提示确认 */
  referenceDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "参照日期格式 YYYY-MM-DD")
    .optional(),
});
export type IntakeCreateInput = z.infer<typeof intakeCreateSchema>;

/**
 * 模型分类输出（§4.2 严格 schema）：只拆事项与引用原文，不执行任何操作。
 * excerpt 必须逐字来自输入文本，由服务端二次校验。
 */
export const intakeClassificationSchema = z.object({
  items: z
    .array(
      z.object({
        itemKey: z
          .string()
          .min(1)
          .max(64)
          .regex(/^[a-z0-9-]+$/, "itemKey 只用小写字母数字连字符"),
        kind: z.enum(INTAKE_ITEM_KINDS),
        summary: z.string().min(1).max(200),
        excerpt: z.string().min(1).max(2000),
      }),
    )
    .min(1)
    .max(50),
});
export type IntakeClassification = z.infer<typeof intakeClassificationSchema>;

export const QUESTION_STATUSES = ["open", "answered", "deferred", "superseded"] as const;
export type QuestionStatus = (typeof QUESTION_STATUSES)[number];

/** 学期首周锚点：全局唯一 open（§2.3 同一缺口最多 1 个 open 问题） */
export const SEMESTER_FIRST_MONDAY_KEY = "semester.first_monday";

/** POST /api/v2/questions/:id/answers 请求体 */
export const answerSubmitSchema = z.object({
  text: z.string().min(1, "回答不能为空").max(2000),
  /** 防过时回答（§2.3）：回答时看到的问题版本 */
  expectedVersion: z.number().int().min(1),
});
export type AnswerSubmitInput = z.infer<typeof answerSubmitSchema>;

/** intake job payload */
export const intakeJobPayloadSchema = z.object({
  intakeId: z.string().uuid(),
  /** 触发原因：initial=首次处理；resume:<questionId>=回答后从 Resolve 恢复 */
  cause: z.string().min(1).max(80),
});
export type IntakeJobPayload = z.infer<typeof intakeJobPayloadSchema>;
