import { z } from "zod";

/**
 * 操作注册表契约（MASTER-PLAN §4.2/§7，AGENT-INTERFACE-CONTRACT §4）：
 * 领域写入只允许经这里的 schema 校验后由执行器落库；模型输出永远不能绕过。
 * schema、OPERATIONS 元数据、执行 handler（workflows/commands.ts）一一对应；
 * Agent 的工具说明与前端的可用操作都从 OPERATIONS 导出，未注册的不展示、不执行。
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
  /** 主人报告的剩余需求（“还差一个小时”）；之后的投入从这里扣 */
  remainingMinutes: z.number().int().min(0).max(100_000).nullable().optional(),
  priority: z.enum(["normal", "high"]).optional(),
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

const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const timeStr = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const audience = z.enum(["all", "undergraduate", "graduate"]);

/** 国家年度节假日安排（由通知原文确定性解析得到）；third_party 会被执行器拒绝 */
export const syncHolidayCalendarSchema = z.object({
  command: z.literal("sync_holiday_calendar"),
  year: z.number().int().min(2000).max(2100),
  days: z.array(z.object({ localDate: dateStr, name: z.string().min(1).max(40), kind: z.enum(["holiday", "adjusted_workday"]) })).min(1).max(120),
  sourceUrl: z.string().max(2048).default(""),
  sourceTitle: z.string().max(200).default(""),
  revisionHash: z.string().min(8).max(64),
  origin: z.enum(["official", "user_upload", "third_party"]),
  publishedAt: dateStr.nullable().default(null),
});

/** 一个学期的校历：报到日/授课日/首周周一分开；停课区间与补课映射都要有来源依据 */
export const upsertAcademicCalendarSchema = z.object({
  command: z.literal("upsert_academic_calendar"),
  school: z.string().max(80).default(""),
  audience: audience.default("all"),
  academicYear: z.string().max(20).default(""),
  termLabel: z.string().max(40).default(""),
  registrationDate: dateStr.nullable().default(null),
  teachingStart: dateStr.nullable().default(null),
  firstMonday: dateStr.nullable().default(null),
  totalWeeks: z.number().int().min(1).max(60).nullable().default(null),
  termEnd: dateStr.nullable().default(null),
  skippedWeeks: z.array(dateStr).max(10).default([]),
  events: z
    .array(
      z.object({
        kind: z.enum(["holiday", "exam", "registration", "teaching_start", "term_end", "training", "other"]),
        title: z.string().min(1).max(100),
        startDate: dateStr,
        endDate: dateStr,
        audience: audience.default("all"),
        cancelsClasses: z.boolean().default(false),
        evidence: z.string().max(500).default(""),
      }),
    )
    .max(60)
    .default([]),
  overrides: z
    .array(z.object({ targetDate: dateStr, sourceTeachingDate: dateStr, mode: z.enum(["replace", "add"]), cancelSource: z.boolean().default(false), evidence: z.string().max(500).default("") }))
    .max(40)
    .default([]),
  source: z.string().max(2048).default(""),
  sourceRevision: z.string().max(64).default(""),
  origin: z.enum(["source", "user"]).default("source"),
  /** 校历首周与现有课表不一致时，主人确认后才按校历修正课程日期 */
  confirmAnchorChange: z.boolean().default(false),
});

/** 单次教学日例外：整天停课/按另一天的课上（school），或某门课取消/移动（course） */
export const applyTeachingDayOverrideSchema = z.object({
  command: z.literal("apply_teaching_day_override"),
  scope: z.enum(["school", "course"]),
  courseId: z.string().uuid().nullable().default(null),
  courseName: z.string().max(100).nullable().default(null),
  mode: z.enum(["cancel", "replace", "add", "move"]),
  sourceTeachingDate: dateStr,
  targetDate: dateStr.nullable().default(null),
  targetStart: timeStr.nullable().default(null),
  targetEnd: timeStr.nullable().default(null),
  cancelSource: z.boolean().default(true),
  origin: z.enum(["source", "user"]).default("user"),
  note: z.string().max(200).default(""),
  evidence: z.string().max(500).default(""),
});

export const updateCalendarSyncPolicySchema = z.object({
  command: z.literal("update_calendar_sync_policy"),
  enabled: z.boolean().optional(),
  school: z.string().max(80).optional(),
  audience: audience.optional(),
  intervalDays: z.number().int().min(1).max(30).optional(),
  holidayYear: z.number().int().min(2000).max(2100).optional(),
  holidayUrl: z.string().url().max(2048).optional(),
  academicUrl: z.string().url().max(2048).optional(),
});

/** 时间政策：base 只改给出的模板字段；rules 是有范围的规则（持久或临时）；revokeRuleIds 撤回 */
export const updatePlanningPolicySchema = z.object({
  command: z.literal("update_planning_policy"),
  base: z
    .object({
      workdayStart: timeStr,
      workdayEnd: timeStr,
      weekendStart: timeStr,
      weekendEnd: timeStr,
      dailyLimitMinutes: z.number().int().min(0).max(960),
      minBlockMinutes: z.number().int().min(10).max(120),
      bufferPercent: z.number().int().min(0).max(80),
      commuteMinutes: z.number().int().min(0).max(120),
      meals: z.array(z.tuple([timeStr, timeStr])).max(6),
    })
    .partial()
    .optional(),
  rules: z
    .array(
      z.object({
        kind: z.enum(["weekday_limit", "group_limit", "date_limit", "no_study", "holiday_policy", "preferred_window", "auto_reschedule"]),
        weekday: z.number().int().min(1).max(7).nullable().optional(),
        dateFrom: dateStr.nullable().optional(),
        dateTo: dateStr.nullable().optional(),
        value: z.record(z.string(), z.unknown()).default({}),
        scope: z.enum(["persistent", "temporary"]).default("persistent"),
        origin: z.enum(["user", "assumed"]).default("user"),
      }),
    )
    .max(10)
    .default([]),
  revokeRuleIds: z.array(z.string().uuid()).max(20).default([]),
  confirm: z.boolean().default(false),
  evidence: z.string().max(500).default(""),
});

/** 暂停任务到某天（null = 先不定）；resume=true 恢复。暂停让出未执行的学习块，不是取消任务 */
export const pauseTaskSchema = z.object({
  command: z.literal("pause_task"),
  taskId: z.string().uuid(),
  until: dateStr.nullable().default(null),
  resume: z.boolean().default(false),
});

/** 纠正一条实践记录：只改给出的字段，旧值留在变更历史里 */
export const correctPracticeSchema = z.object({
  command: z.literal("correct_practice"),
  practiceId: z.string().uuid(),
  actualMinutes: z.number().int().min(1).max(24 * 60).nullable().optional(),
  occurredOn: dateStr.optional(),
  note: z.string().max(500).optional(),
  taskId: z.string().uuid().nullable().optional(),
  category: z.enum(["study", "other"]).optional(),
});

/** 把指定学习块挪到某天的某个时段或具体钟点；可只改这一段的长度（任务总需求不变） */
export const rescheduleSessionSchema = z.object({
  command: z.literal("reschedule_session"),
  sessionId: z.string().min(1).max(64),
  targetDate: dateStr.nullable().default(null),
  part: z.enum(["morning", "afternoon", "evening", "any"]).default("any"),
  startLocalTime: timeStr.nullable().default(null),
  durationMinutes: z.number().int().min(5).max(240).nullable().default(null),
  expectedVersion: z.number().int().min(1).nullable().default(null),
});

export const setSessionStateSchema = z.object({
  command: z.literal("set_session_state"),
  sessionId: z.string().min(1).max(64),
  action: z.enum(["start", "complete", "skip", "lock", "unlock"]),
  expectedVersion: z.number().int().min(1).nullable().default(null),
  actualMinutes: z.number().int().min(1).max(24 * 60).nullable().default(null),
  note: z.string().max(500).default(""),
});

/** 撤销一个变更批次（及它引起的重排）；后来又被改过的对象不会被覆盖 */
export const undoBatchSchema = z.object({
  command: z.literal("undo_batch"),
  batchId: z.string().uuid(),
});

export const commandSchema = z.discriminatedUnion("command", [
  upsertCourseSetSchema,
  recordPracticeSchema,
  createOrUpdateTaskSchema,
  importFixedEventsSchema,
  applyEventExceptionSchema,
  archiveEntitySchema,
  completeTaskSchema,
  syncHolidayCalendarSchema,
  upsertAcademicCalendarSchema,
  applyTeachingDayOverrideSchema,
  updateCalendarSyncPolicySchema,
  updatePlanningPolicySchema,
  pauseTaskSchema,
  correctPracticeSchema,
  rescheduleSessionSchema,
  setSessionStateSchema,
  undoBatchSchema,
]);

export type Command = z.infer<typeof commandSchema>;

export type OperationAffect = "plan" | "reminders" | "calendar" | "notices" | "direction";

export type OperationMeta = {
  /** 用户可见的名称 */
  title: string;
  /** 给 Agent 的工具说明：何时用、关键参数 */
  description: string;
  group: "course" | "calendar" | "task" | "plan" | "practice" | "goal" | "profile" | "reminder" | "agent" | "recovery";
  /** auto：信息明确且可逆，Agent 可直接执行；owner_explicit：必须来自主人本人的明确指令或按钮 */
  authorization: "auto" | "owner_explicit";
  /** journal：可按批次撤销；none：外部副作用或不可逆，结果里如实说明 */
  undo: "journal" | "none";
  /** 提交后需要更新的派生状态 */
  affects: OperationAffect[];
};

export const OPERATIONS: { [N in Command["command"]]: OperationMeta } = {
  upsert_course_set: { title: "课表更新", description: "用确定性课表文本（SDCT1）和学期首周一建立/替换本学期课程。", group: "course", authorization: "auto", undo: "journal", affects: ["plan", "calendar"] },
  record_practice: { title: "实践记录", description: "记录一次已发生的学习/实践投入；可关联任务，非学习活动标 other。", group: "practice", authorization: "auto", undo: "journal", affects: ["plan", "direction"] },
  create_or_update_task: { title: "任务", description: "新建任务，或带 taskId 修改原任务（只改给出的字段）。", group: "task", authorization: "auto", undo: "journal", affects: ["plan", "reminders"] },
  import_fixed_events: { title: "日程导入", description: "导入有具体日期和起止时间的一次性固定活动。", group: "course", authorization: "auto", undo: "journal", affects: ["plan", "calendar"] },
  apply_event_exception: { title: "停课例外", description: "某门课某一天停课。", group: "course", authorization: "auto", undo: "journal", affects: ["plan", "calendar"] },
  archive_entity: { title: "归档", description: "归档任务、目标或整套课表（可撤销）。", group: "recovery", authorization: "owner_explicit", undo: "journal", affects: ["plan"] },
  sync_holiday_calendar: { title: "节假日安排", description: "把官方年度节假日/调休日期入库（只标注公历日，不决定学校补课）。", group: "calendar", authorization: "auto", undo: "journal", affects: ["plan", "calendar"] },
  upsert_academic_calendar: { title: "校历", description: "一个学期的校历：首周、周数、停课区间、学校明确的补课映射。", group: "calendar", authorization: "auto", undo: "journal", affects: ["plan", "calendar"] },
  apply_teaching_day_override: { title: "调课/停课", description: "单次例外：某门课取消或移到别的时间；或整天停课、按另一天的课表上课。周次条件按原教学日期判断。", group: "calendar", authorization: "auto", undo: "journal", affects: ["plan", "calendar"] },
  update_calendar_sync_policy: { title: "日历自动更新设置", description: "开启/关闭校历与节假日的有限自动核对，设置学校、人群、间隔与官方入口。", group: "calendar", authorization: "owner_explicit", undo: "journal", affects: [] },
  update_planning_policy: { title: "时间安排规则", description: "修改作息模板字段、按星期/工作日的上限、某段时间不学、假期策略、集中时段偏好，或授权重新安排某天。", group: "plan", authorization: "owner_explicit", undo: "journal", affects: ["plan"] },
  pause_task: { title: "暂停任务", description: "把任务先放一放（到某天或先不定），让出未执行的学习块；resume 恢复。", group: "task", authorization: "owner_explicit", undo: "journal", affects: ["plan", "reminders"] },
  correct_practice: { title: "纠正实践记录", description: "修改一条已有实践记录的分钟、日期、说明或关联任务。", group: "practice", authorization: "owner_explicit", undo: "journal", affects: ["plan", "direction"] },
  reschedule_session: { title: "调整学习安排", description: "把一个具体学习块挪到别的日期/时段/钟点，或只改这一段的长度。", group: "plan", authorization: "owner_explicit", undo: "journal", affects: ["plan"] },
  set_session_state: { title: "学习块状态", description: "开始、完成、跳过、锁定或解锁一个学习块。", group: "plan", authorization: "owner_explicit", undo: "journal", affects: ["plan"] },
  undo_batch: { title: "撤销", description: "撤销最近一次（或指定的）变更。", group: "recovery", authorization: "owner_explicit", undo: "none", affects: ["plan", "calendar"] },
  complete_task: { title: "完成任务", description: "把指定任务标记完成，取消其未执行学习块与提醒。", group: "task", authorization: "owner_explicit", undo: "journal", affects: ["plan", "reminders"] },
};

export const COMMAND_WHITELIST = Object.keys(OPERATIONS) as Array<Command["command"]>;

/** 命令执行上下文：来源引用进 journal，目标对象由服务端解析；serverControl 字段不接受模型伪造 */
export type CommandContext = {
  intakeId: string | null;
  itemId: string | null;
  itemKey: string;
  instanceEpoch: number;
  evidence: string;
  /** 是否来自主人本人的明确指令（输入框原话/卡片按钮）。false = 来自资料正文或模型建议；缺省按 true（服务端内部调用） */
  explicit?: boolean;
  /** 规划时刻；缺省取当前时间（测试用固定时钟） */
  now?: Date;
  conversationId?: string | null;
};
