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
});

export const createOrUpdateTaskSchema = z.object({
  command: z.literal("create_or_update_task"),
  taskId: z.string().uuid().nullable().default(null),
  title: z.string().min(1).max(200),
  estimateMinutes: z.number().int().min(1).max(100_000).nullable().default(null),
  dueLocalDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().default(null),
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
]);

export type Command = z.infer<typeof commandSchema>;

export const COMMAND_WHITELIST = ["upsert_course_set", "record_practice", "create_or_update_task", "import_fixed_events", "apply_event_exception", "archive_entity"] as const;

/** 命令执行上下文：来源引用进 journal，目标对象由服务端解析 */
export type CommandContext = {
  intakeId: string | null;
  itemId: string | null;
  itemKey: string;
  instanceEpoch: number;
  evidence: string;
};
