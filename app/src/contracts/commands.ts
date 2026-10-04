import { z } from "zod";

/**
 * P2 白名单命令契约（MASTER-PLAN §4.2/§7）：
 * 领域写入只允许经这里的 schema 校验后由命令执行器落库；模型输出永远不能绕过。
 * P2 实现 3 个首版命令，其余（plan_sessions 等）在 P3 加入同一白名单。
 */

export const COMMAND_POLICY_VERSION = "v2-p2";

export const upsertCourseSetSchema = z.object({
  command: z.literal("upsert_course_set"),
  sdctText: z.string().min(1).max(100_000),
  firstMonday: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  timezone: z.string().min(1).max(64),
});

export const recordPracticeSchema = z.object({
  command: z.literal("record_practice"),
  occurredOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  actualMinutes: z.number().int().min(1).max(24 * 60).nullable(),
  note: z.string().max(500).default(""),
  qualitative: z.enum(["shorter", "as_expected", "longer"]).nullable().default(null),
  /** 关联任务：同一任务当天的计划块不再另扣预算 */
  taskId: z.string().uuid().nullable().default(null),
  /** other = 运动/事务等非学习活动，占时间但不消耗学习预算 */
  category: z.enum(["study", "other"]).default("study"),
});

/**
 * 带 taskId = 修改原任务（只改给出的字段，不新建副本）；不带 = 新建（title 必填，由执行器校验）。
 * dueLocalDate 为 null 表示清除截止；dueLocalTime 给出时保存为具体截止时刻。
 */
export const createOrUpdateTaskSchema = z.object({
  command: z.literal("create_or_update_task"),
  taskId: z.string().uuid().nullable().default(null),
  title: z.string().min(1).max(200).optional(),
  estimateMinutes: z.number().int().min(1).max(100_000).nullable().optional(),
  dueLocalDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  dueLocalTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).nullable().optional(),
  effortMode: z.enum(["deliverable", "time_budget"]).optional(),
});

/** 完成原任务：取消其未执行的学习块与提醒；可顺带记下这次的实际投入 */
export const completeTaskSchema = z.object({
  command: z.literal("complete_task"),
  taskId: z.string().uuid(),
  occurredOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().default(null),
  actualMinutes: z.number().int().min(1).max(24 * 60).nullable().default(null),
  note: z.string().max(500).default(""),
});

export const importFixedEventsSchema = z.object({
  command: z.literal("import_fixed_events"),
  events: z
    .array(
      z.object({
        title: z.string().min(1).max(200),
        eventDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        localStart: z.string().regex(/^\d{2}:\d{2}$/),
        localEnd: z.string().regex(/^\d{2}:\d{2}$/),
      }),
    )
    .min(1)
    .max(200),
  timezone: z.string().min(1).max(64),
});

export const applyEventExceptionSchema = z.object({
  command: z.literal("apply_event_exception"),
  courseName: z.string().min(1).max(100),
  eventDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  action: z.literal("cancel").default("cancel"),
  note: z.string().max(200).default(""),
});

export const archiveEntitySchema = z.object({
  command: z.literal("archive_entity"),
  entityKind: z.enum(["task", "course_set", "goal"]),
  entityId: z.string().min(1).max(64),
});

export const commandSchema = z.discriminatedUnion("command", [
  upsertCourseSetSchema,
  recordPracticeSchema,
  createOrUpdateTaskSchema,
  importFixedEventsSchema,
  applyEventExceptionSchema,
  archiveEntitySchema,
  completeTaskSchema,
]);

export type Command = z.infer<typeof commandSchema>;

export const COMMAND_WHITELIST = ["upsert_course_set", "record_practice", "create_or_update_task", "import_fixed_events", "apply_event_exception", "archive_entity", "complete_task"] as const;

/** 命令执行上下文：来源引用进 journal，目标对象由服务端解析 */
export type CommandContext = {
  intakeId: string | null;
  itemId: string | null;
  itemKey: string;
  instanceEpoch: number;
  evidence: string;
};
