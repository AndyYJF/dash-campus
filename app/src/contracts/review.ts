import { z } from "zod";

/**
 * 复盘、卡点辅助与 AI 预算契约（计划 v1.2 第 6 节；产品计划第 12 节）。
 * 模型只能引用提供的记录 ID；操作 ID 必须存在于上下文；输出一律 schema 校验。
 */

export const REVIEW_JOB_TYPE = "review";
export const ASSISTANT_JOB_TYPE = "assistant";

export const MODEL_WORKFLOW_REVIEW = "review.weekly";
export const MODEL_WORKFLOW_BLOCKER = "assistant.blocker";

/** 周复盘最多 3 份独立建议；卡点分析最多 1 份（第 6 节） */
export const MAX_REVIEW_PROPOSALS = 3;
export const MAX_ASSISTANT_PROPOSALS = 1;
/** 每份提案最多 5 个操作 */
export const MAX_OPERATIONS_PER_PROPOSAL = 5;
/** 默认拒绝后 14 天内同项目同操作类型同证据不自动重复 */
export const REJECTION_COOLDOWN_DAYS = 14;
/** 卡点分析读取的日志天数 */
export const BLOCKER_LOOKBACK_DAYS = 7;

// ===== 预算设置（非秘密，存 settings 表） =====

export const AI_BUDGET_SETTINGS_KEY = "aiBudget";
/** 模型优先路由后的默认日额度；已保存的旧设置不强制覆盖 */
export const DEFAULT_DAILY_MODEL_CALLS = 150;

export const aiBudgetSchema = z.object({
  /** 每日实际模型 HTTP 请求上限（含修复、重试、工具轮次）；达到后暂停非必要 AI 任务，截止提醒不受影响 */
  dailyModelCalls: z.number().int().min(0).max(1000).default(DEFAULT_DAILY_MODEL_CALLS),
  /** 单份投递累计模型 HTTP 请求上限（路由、决策、材料理解、修复与追问续答合计；恢复不重置） */
  perIntakeModelRequests: z.number().int().min(1).max(50).default(10),
  /** 每日搜索调用上限（search + extract 各算一次） */
  dailySearchCalls: z.number().int().min(0).max(1000).default(30),
  /** 定期任务（定期探索、定期周复盘）是否在额度内运行 */
  scheduledEnabled: z.boolean().default(true),
  /** 启用周复盘的定期生成：每周几（1=周一..7=周日）与本地时间；null 为不定期 */
  weeklyReview: z
    .object({ weekday: z.number().int().min(1).max(7), localTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/) })
    .nullable()
    .default(null),
});
export type AiBudget = z.infer<typeof aiBudgetSchema>;

// ===== 模型输出：提案操作（ID 由程序验证存在） =====

/** 模型常把状态写成别名或中文（真实联调中出现过）：先归一化再校验 */
const STATUS_ALIASES: Record<string, string> = {
  in_progress: "doing",
  "in-progress": "doing",
  inprogress: "doing",
  started: "doing",
  进行中: "doing",
  completed: "done",
  complete: "done",
  finished: "done",
  已完成: "done",
  完成: "done",
  pending: "todo",
  not_started: "todo",
  待办: "todo",
  未开始: "todo",
  受阻: "blocked",
  卡住: "blocked",
  canceled: "cancelled",
  已取消: "cancelled",
  取消: "cancelled",
};
const taskStatus = z.preprocess(
  (v) => (typeof v === "string" ? (STATUS_ALIASES[v.trim().toLowerCase()] ?? STATUS_ALIASES[v.trim()] ?? v.trim().toLowerCase()) : v),
  z.enum(["todo", "doing", "blocked", "done", "cancelled"]),
);

export const modelOperationSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("create_task"),
    title: z.string().trim().min(1).max(200),
    description: z.string().max(1000).default(""),
    estimateMinutes: z.number().int().min(5).max(24 * 60).nullable().default(null),
    /** 放入某个已有项目；null 为不属于项目 */
    projectId: z.string().nullable().default(null),
    /** 放入本周还是下周 */
    week: z.enum(["this", "next", "none"]).default("none"),
  }),
  z.object({
    kind: z.literal("set_task_status"),
    taskId: z.string().min(1),
    status: taskStatus,
  }),
  z.object({
    kind: z.literal("reschedule_task"),
    taskId: z.string().min(1),
    scheduledStart: z.string().nullable(),
    scheduledEnd: z.string().nullable(),
  }),
]);
export type ModelOperation = z.infer<typeof modelOperationSchema>;

export const modelProposalSchema = z.object({
  reason: z.string().trim().min(1).max(800),
  /** 依据：必须是上下文里给出的 log/task/artifact ID */
  evidenceIds: z.array(z.string().min(1)).min(1).max(10),
  operations: z.array(modelOperationSchema).min(1).max(MAX_OPERATIONS_PER_PROPOSAL),
});

/** 周复盘：事实总结、推测、提案操作三者分开 */
export const reviewOutputSchema = z.object({
  /** 对程序汇总事实的简短复述；每条必须引用记录 ID */
  factNotes: z.array(z.object({ text: z.string().trim().min(1).max(400), evidenceIds: z.array(z.string()).min(1).max(10) })).max(8).default([]),
  /** 推测：明确是模型观察，不作人格判断 */
  observations: z.array(z.object({ text: z.string().trim().min(1).max(400), evidenceIds: z.array(z.string()).min(1).max(10) })).max(5).default([]),
  proposals: z.array(modelProposalSchema).max(MAX_REVIEW_PROPOSALS).default([]),
  /** 资料不足时说明，不编造成长结论 */
  insufficientReason: z.string().max(400).nullable().default(null),
});

/** 卡点辅助：可能解释 + 可验证的下一步 + 最多 1 份提案 */
export const blockerOutputSchema = z.object({
  explanations: z.array(z.object({ text: z.string().trim().min(1).max(400), evidenceIds: z.array(z.string()).min(1).max(10) })).max(4).default([]),
  nextSteps: z.array(z.string().trim().min(1).max(300)).max(4).default([]),
  /** 需要更多信息时追问，而不是猜 */
  followUpQuestion: z.string().max(300).nullable().default(null),
  proposal: modelProposalSchema.nullable().default(null),
  insufficientReason: z.string().max(400).nullable().default(null),
});

// ===== 请求 =====

export const assistantRequestSchema = z.object({
  scopeType: z.enum(["project", "week"]),
  /** project：项目 id；week：可省略（当前周） */
  scopeId: z.string().min(1).nullable().default(null),
  question: z.string().trim().min(1).max(500).default("分析这个卡点：可能的原因和下一步"),
  logId: z.string().uuid().nullable().default(null),
  /** 主人主动重跑：不受拒绝冷却限制 */
  rerun: z.boolean().default(false),
});

export const reviewGenerateSchema = z.object({
  /** 复盘哪一周（周一，实例时区）；省略为"最近一个自然周"（上周） */
  localMonday: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .refine((d) => new Date(`${d}T00:00:00Z`).getUTCDay() === 1, "必须是周一")
    .nullable()
    .default(null),
});

export const reviewPatchSchema = z.object({
  expectedVersion: z.number().int().min(1),
  ownerSummary: z.string().max(5000).optional(),
  ownerNextWeek: z.string().max(5000).optional(),
});

export const REJECTION_REASONS = ["not_useful", "wrong_basis", "no_time", "other"] as const;
