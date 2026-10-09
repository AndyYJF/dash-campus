import { z } from "zod";
import { taskKindSchema } from "@/domain/task-admission";
import { PATH_KEYS, STAGE_KEYS } from "@/content/direction/stages";

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
  /** 卡点原话（没跑通、报错……）：之后先安排最小的排障步骤 */
  blocker: z.string().max(500).default(""),
  projectId: z.string().uuid().nullable().default(null),
});

/**
 * 带 taskId = 修改原任务（只改给出的字段，不新建副本）；不带 = 新建（title 必填，由执行器校验）。
 * dueLocalDate 为 null 表示清除截止；dueLocalTime 给出时保存为具体截止时刻。
 */
export const createOrUpdateTaskSchema = z.object({
  command: z.literal("create_or_update_task"),
  taskKind: taskKindSchema.optional(),
  taskId: z.string().uuid().nullable().default(null),
  title: z.string().min(1).max(200).optional(),
  estimateMinutes: z.number().int().min(1).max(100_000).nullable().optional(),
  dueLocalDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  dueLocalTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).nullable().optional(),
  effortMode: z.enum(["deliverable", "time_budget"]).optional(),
  /** 主人报告的剩余需求（“还差一个小时”）；之后的投入从这里扣 */
  remainingMinutes: z.number().int().min(0).max(100_000).nullable().optional(),
  priority: z.enum(["normal", "high"]).optional(),
  /** 归入的项目；null 表示移出项目 */
  projectId: z.string().uuid().nullable().optional(),
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

/** 在指定时段安排一段学习（从时间轴空档发起）：给已有任务排，或带 title 新建任务再排 */
export const scheduleSessionSchema = z.object({
  command: z.literal("schedule_session"),
  taskId: z.string().uuid().nullable().default(null),
  title: z.string().trim().min(1).max(200).optional(),
  date: dateStr,
  startLocalTime: timeStr,
  durationMinutes: z.number().int().min(5).max(240),
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

/** 提醒策略：全局开关/提前量/安静时段；带 taskId 时设置这个任务自己的提前量 */
export const updateReminderPolicySchema = z.object({
  command: z.literal("update_reminder_policy"),
  deadlineReminders: z.boolean().optional(),
  defaultLeadMinutes: z.number().int().min(0).max(525_600).nullable().optional(),
  quietEnabled: z.boolean().optional(),
  quietStart: timeStr.optional(),
  quietEnd: timeStr.optional(),
  taskId: z.string().uuid().optional(),
  taskLeadMinutes: z.number().int().min(0).max(525_600).nullable().optional(),
});

/** 摘要邮件策略（默认都不发）：只接受时间、频率这些有限字段，不接受任意模板 */
export const updateDigestPolicySchema = z.object({
  command: z.literal("update_digest_policy"),
  dailyEnabled: z.boolean().optional(),
  dailyTime: timeStr.optional(),
  dailyWeekdaysOnly: z.boolean().optional(),
  weeklyEnabled: z.boolean().optional(),
  weeklyWeekday: z.number().int().min(1).max(7).optional(),
  weeklyTime: timeStr.optional(),
});

/** 主人陈述的身份事实（学历层次/专业/校区/入学年份/年级）；不由兴趣或模型推断 */
export const updateProfileFactSchema = z.object({
  command: z.literal("update_profile_fact"),
  facts: z.array(z.object({ field: z.enum(["education_level", "program", "campus", "grade_year", "study_year"]), value: z.string().trim().min(1).max(200) })).min(1).max(5),
});

/** 有范围的通知筛选规则：明确只面向某类人群的通知不进行动；remove=true 撤回 */
export const upsertNoticeRuleSchema = z.object({
  command: z.literal("upsert_notice_rule"),
  field: z.enum(["education_level", "program", "campus", "grade_year", "study_year"]),
  value: z.string().trim().min(1).max(200),
  remove: z.boolean().default(false),
});

/** 通知落地：按身份与规则判断后，明确适用的义务建任务，其余只保留事实 */
export const applyNoticeSchema = z.object({ command: z.literal("apply_notice"), messageId: z.string().uuid() });

/** 主人纠正某条通知的归类（只这一条，不改身份和规则） */
export const resolveNoticeSchema = z.object({
  command: z.literal("resolve_notice"),
  messageId: z.string().uuid(),
  partition: z.enum(["action", "info", "opportunity", "review", "folded"]),
});

/** 生成一份业务数据导出（24 小时内可下载；不含密钥、会话、后台队列） */
export const requestExportSchema = z.object({ command: z.literal("request_export"), type: z.literal("full_json").default("full_json") });

/** 目标：不带 goalId 新建；primary=true 设为唯一的主要方向 */
export const upsertGoalSchema = z.object({
  command: z.literal("upsert_goal"),
  goalId: z.string().uuid().nullable().default(null),
  title: z.string().trim().min(1).max(200).optional(),
  reason: z.string().max(2000).optional(),
  horizon: z.enum(["long_term", "semester"]).optional(),
  status: z.enum(["active", "paused", "completed"]).optional(),
  primary: z.boolean().optional(),
});

/** 选一个候选开始：trial 试做（默认两周，只建第一步）；commit 正式投入 */
export const selectCandidateSchema = z.object({
  command: z.literal("select_candidate"),
  candidateId: z.string().uuid(),
  mode: z.enum(["trial", "commit"]).default("trial"),
  trialWeeks: z.number().int().min(1).max(12).default(2),
  goalId: z.string().uuid().nullable().default(null),
  /** 从方向卡/阶段项发起时的关联：同一事务里写方向关联，重复选择返回已有项目 */
  trackId: z.string().uuid().nullable().default(null),
  roadmapItemId: z.string().uuid().nullable().default(null),
});

export const updateProjectStateSchema = z.object({
  command: z.literal("update_project_state"),
  projectId: z.string().uuid(),
  status: z.enum(["active", "paused", "completed"]).optional(),
  engagement: z.enum(["trial", "committed"]).optional(),
});

/** 找候选项目（检索有来源的资料，最多 3 个候选） */
export const cancelAiNewsSchema = z.object({ command:z.literal("cancel_ai_news") });
export const requestAiNewsSchema = z.object({ command: z.literal("request_ai_news"), days: z.number().int().min(1).max(30).default(7) });
export const updateAiNewsPolicySchema = z.object({ command: z.literal("update_ai_news_policy"), expectedVersion: z.number().int().min(0).nullable().default(null), enabled: z.boolean().optional(), localTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional(), days: z.number().int().min(1).max(30).optional() });

export const requestExplorationSchema = z.object({
  command: z.literal("request_exploration"),
  query: z.string().trim().min(1).max(500),
  background: z.string().max(2000).default(""),
});

/** 资料入库/关联/纠正事实类型：reference 参考 / requirement 别人的要求 / achievement 自己的成果 */
export const linkResourceSchema = z.object({
  command: z.literal("link_resource"),
  resourceId: z.string().uuid().nullable().default(null),
  title: z.string().max(200).optional(),
  body: z.string().max(20_000).optional(),
  url: z.string().url().optional(),
  projectId: z.string().uuid().nullable().default(null),
  role: z.enum(["reference", "requirement", "achievement"]).optional(),
  origin: z.enum(["user", "assumed"]).default("assumed"),
  /** 主人线索的方向/阶段上下文与类型；只是存档，不建任务、不代表要联系或申请 */
  trackId: z.string().uuid().nullable().optional(),
  stageKey: z.enum(STAGE_KEYS).nullable().optional(),
  noteKind: z.enum(["advice", "policy", "opportunity", "industry", "question", "other"]).nullable().optional(),
});

/** 主人明确说的当前阶段与去向偏好；阶段不从任务数推算，去向可多选，未选不代表排除 */
export const updateDirectionProfileSchema = z.object({
  command: z.literal("update_direction_profile"),
  /** 尚无记录时快照为 0，首次提交允许 0；已有记录必须等于当前版本 */
  expectedVersion: z.number().int().min(0).nullable().default(null),
  confirmedStage: z.enum(STAGE_KEYS).nullable().optional(),
  entryYear: z.number().int().min(2000).max(2100).nullable().optional(),
  pathPreferences: z.array(z.enum(PATH_KEYS)).max(PATH_KEYS.length).optional(),
});

/** 关注方向：不带 trackId 新建（同一工作样本只建一个）；带 trackId 修改状态或备注 */
export const upsertDirectionTrackSchema = z.object({
  command: z.literal("upsert_direction_track"),
  trackId: z.string().uuid().nullable().default(null),
  expectedVersion: z.number().int().min(1).nullable().default(null),
  templateKey: z.string().trim().min(1).max(60).nullable().optional(),
  title: z.string().trim().min(1).max(200).optional(),
  status: z.enum(["exploring", "following", "paused"]).optional(),
  ownerNotes: z.string().max(2000).optional(),
});

/** 阶段项：不带 roadmapItemId 是主人采用一条；带 ID 修订；completed 只在主人明确确认时用 */
export const updateRoadmapItemSchema = z.object({
  command: z.literal("update_roadmap_item"),
  roadmapItemId: z.string().uuid().nullable().default(null),
  expectedVersion: z.number().int().min(1).nullable().default(null),
  stageKey: z.enum(STAGE_KEYS).optional(),
  title: z.string().trim().min(1).max(200).optional(),
  purpose: z.string().max(1000).optional(),
  goalId: z.string().uuid().nullable().optional(),
  trackId: z.string().uuid().nullable().optional(),
  status: z.enum(["adopted", "completed", "paused"]).optional(),
});

/** 把已有项目关联到关注方向（可附阶段项）；同一项目 + 方向只有一条；remove 解除关联，项目本身不动 */
export const linkDirectionProjectSchema = z.object({
  command: z.literal("link_direction_project"),
  projectId: z.string().uuid(),
  trackId: z.string().uuid(),
  roadmapItemId: z.string().uuid().nullable().optional(),
  remove: z.boolean().default(false),
});

/** 主人的实践感受：原话必留；关联到项目/方向/实践记录至少一个；不另记分钟数 */
export const recordDirectionReflectionSchema = z.object({
  command: z.literal("record_direction_reflection"),
  text: z.string().trim().min(1).max(4000),
  occurredOn: dateStr.optional(),
  projectId: z.string().uuid().nullable().default(null),
  trackId: z.string().uuid().nullable().default(null),
  practiceEntryId: z.string().uuid().nullable().default(null),
});

/** 主动程度与调用预算：每日模型/搜索次数上限、是否运行定期探索与定期复盘 */
export const updateAgentPolicySchema = z.object({
  command: z.literal("update_agent_policy"),
  dailyModelCalls: z.number().int().min(0).max(1000).optional(),
  dailySearchCalls: z.number().int().min(0).max(1000).optional(),
  scheduledEnabled: z.boolean().optional(),
  /** 定期周复盘的时间；null = 不定期做 */
  weeklyReview: z.object({ weekday: z.number().int().min(1).max(7), localTime: timeStr }).nullable().optional(),
});

/** 按需复盘：上周（默认）、本周或指定那一周 */
export const requestReviewSchema = z.object({
  command: z.literal("request_review"),
  week: z.enum(["last", "this"]).default("last"),
  localMonday: dateStr.optional(),
});

/** 定期探索的关注方向：不带 topicId 是新建；archive 停用 */
export const configureExplorationSchema = z.object({
  command: z.literal("configure_exploration"),
  topicId: z.string().uuid().nullable().default(null),
  title: z.string().trim().min(1).max(200).optional(),
  purpose: z.string().max(1000).optional(),
  enabled: z.boolean().optional(),
  weekday: z.number().int().min(1).max(7).optional(),
  localTime: timeStr.optional(),
  archive: z.boolean().default(false),
});

/** 现在给主人发一份摘要（只发主人邮箱） */
export const requestOwnerDigestSchema = z.object({
  command: z.literal("request_owner_digest"),
  kind: z.enum(["daily", "weekly"]).default("daily"),
});

/** 停止处理一份还没完成的投递 */
export const cancelOperationSchema = z.object({
  command: z.literal("cancel_operation"),
  intakeId: z.string().uuid(),
});

/** 非课程固定活动的修改或移除 */
export const updateFixedEventSchema = z.object({
  command: z.literal("update_fixed_event"),
  eventId: z.string().uuid(),
  expectedVersion: z.number().int().min(1).nullable().default(null),
  title: z.string().trim().min(1).max(200).optional(),
  weekday: z.number().int().min(1).max(7).optional(),
  eventDate: dateStr.nullable().optional(),
  localStart: timeStr.optional(),
  localEnd: timeStr.optional(),
  remove: z.boolean().default(false),
  /** 只是这一天不去：规则不变 */
  skipDate: dateStr.optional(),
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
  scheduleSessionSchema,
  undoBatchSchema,
  updateReminderPolicySchema,
  updateDigestPolicySchema,
  updateProfileFactSchema,
  upsertNoticeRuleSchema,
  applyNoticeSchema,
  resolveNoticeSchema,
  requestExportSchema,
  upsertGoalSchema,
  selectCandidateSchema,
  updateProjectStateSchema,
  requestExplorationSchema,
  requestAiNewsSchema,
  cancelAiNewsSchema,
  updateAiNewsPolicySchema,
  linkResourceSchema,
  updateDirectionProfileSchema,
  upsertDirectionTrackSchema,
  updateRoadmapItemSchema,
  linkDirectionProjectSchema,
  recordDirectionReflectionSchema,
  updateAgentPolicySchema,
  requestReviewSchema,
  configureExplorationSchema,
  requestOwnerDigestSchema,
  cancelOperationSchema,
  updateFixedEventSchema,
]);

export type Command = z.infer<typeof commandSchema>;

export type OperationAffect = "plan" | "reminders" | "calendar" | "notices" | "direction";

/**
 * 授权级别（Agent 增强 v1.1 §5.3）：
 * - auto：信息明确且可逆，来自资料正文也可以执行；
 * - explicit：必须来自主人本人的明确表达或按钮；Agent 推断时需确认（个别参数组合例外，见 domain/authorization）；
 * - confirm：即使主人提出也要先确认一次；
 * - never：不开放给 Agent。
 */
export type OperationAuthorization = "auto" | "explicit" | "confirm" | "never";

/** 提交后会引起的后续动作 */
export type OperationSideEffect = "replan" | "reminders" | "mail" | "job";

/** 有界只读工具（P2 实现）；元数据里声明执行这个操作之前通常要读什么 */
export const READ_TOOL_NAMES = ["get_context", "find_entities", "get_entity_detail", "get_calendar_budget", "get_open_questions", "get_conversation", "get_operation_status", "get_evidence", "get_reviews", "get_ai_news"] as const;
export type ReadToolName = (typeof READ_TOOL_NAMES)[number];

/** 执行后的确定性核验（P5 Verify 阶段使用） */
export const VERIFICATION_KINDS = ["policy_saved", "entity_state_matches", "session_in_scope", "plan_consistent", "practice_not_duplicated", "dependent_steps_completed", "side_effect_status"] as const;
export type VerificationKind = (typeof VERIFICATION_KINDS)[number];

export type OperationMeta = {
  /** 用户可见的名称 */
  title: string;
  /** 给 Agent 的工具说明：何时用、关键参数 */
  description: string;
  group: "course" | "calendar" | "task" | "plan" | "practice" | "goal" | "profile" | "reminder" | "agent" | "recovery";
  authorization: OperationAuthorization;
  /** journal：可按批次撤销；none：外部副作用或不可逆，结果里如实说明 */
  undo: "journal" | "none";
  /** 提交后需要更新的派生状态 */
  affects: OperationAffect[];
  sideEffects: OperationSideEffect[];
  /** 绑定参数前通常需要读取的事实 */
  reads: ReadToolName[];
  /** 执行后用哪些确定性检查确认结果 */
  verify: VerificationKind[];
  /**
   * 确认快照的读取集合：确认绑定“命令 + 这些事实的当前值”，执行事务内再核对一次；集合外的变化不让确认失效。
   * 缺省只读命令里点名对象的版本。
   */
  facts?: FactSet[];
};

/** entity：命令里点名对象的版本；preferences：命令要改的作息字段当前值；rules：同类或日期重叠的生效规则 */
export type FactSet = "entity" | "preferences" | "rules" | "direction_profile" | "agent_policy" | "ai_news_policy";

export const OPERATIONS: { [N in Command["command"]]: OperationMeta } = {
  upsert_course_set: { title: "课表更新", description: "用确定性课表文本（SDCT1）和学期首周一建立/替换本学期课程。", group: "course", authorization: "auto", undo: "journal", affects: ["plan", "calendar"], sideEffects: ["replan"], reads: ["get_context"], verify: ["entity_state_matches", "plan_consistent"] },
  record_practice: { title: "实践记录", description: "记录一次已发生的学习/实践投入（日期可以是过去）；可关联任务或项目，非学习活动标 other。", group: "practice", authorization: "auto", undo: "journal", affects: ["plan", "direction"], sideEffects: ["replan"], reads: ["find_entities"], verify: ["practice_not_duplicated", "plan_consistent"] },
  create_or_update_task: { title: "任务", description: "新建事项，或带 taskId 修改原事项（只改给出的字段）；taskKind 区分学习、日常待办、决策、活动、通知和待确认；projectId 归入项目。只有学习事项自动排学习时间。", group: "task", authorization: "auto", undo: "journal", affects: ["plan", "reminders"], sideEffects: ["replan", "reminders"], reads: ["find_entities", "get_entity_detail"], verify: ["entity_state_matches", "plan_consistent"] },
  import_fixed_events: { title: "日程导入", description: "导入有具体日期和起止时间的一次性固定活动。", group: "course", authorization: "auto", undo: "journal", affects: ["plan", "calendar"], sideEffects: ["replan"], reads: ["get_calendar_budget"], verify: ["entity_state_matches", "plan_consistent"] },
  apply_event_exception: { title: "停课例外", description: "某门课某一天停课。", group: "course", authorization: "auto", undo: "journal", affects: ["plan", "calendar"], sideEffects: ["replan"], reads: ["get_calendar_budget"], verify: ["entity_state_matches", "plan_consistent"] },
  archive_entity: { title: "归档", description: "归档任务、目标或整套课表（可撤销）。", group: "recovery", authorization: "explicit", undo: "journal", affects: ["plan"], sideEffects: ["replan", "reminders"], reads: ["find_entities", "get_entity_detail"], verify: ["entity_state_matches", "plan_consistent"] },
  sync_holiday_calendar: { title: "节假日安排", description: "把官方年度节假日/调休日期入库（只标注公历日，不决定学校补课）。", group: "calendar", authorization: "auto", undo: "journal", affects: ["plan", "calendar"], sideEffects: ["replan"], reads: ["get_calendar_budget"], verify: ["entity_state_matches", "plan_consistent"] },
  upsert_academic_calendar: { title: "校历", description: "一个学期的校历：首周、周数、停课区间、学校明确的补课映射。", group: "calendar", authorization: "auto", undo: "journal", affects: ["plan", "calendar"], sideEffects: ["replan"], reads: ["get_calendar_budget"], verify: ["entity_state_matches", "plan_consistent"] },
  apply_teaching_day_override: { title: "调课/停课", description: "单次例外：某门课取消或移到别的时间；或整天停课、按另一天的课表上课。周次条件按原教学日期判断。", group: "calendar", authorization: "auto", undo: "journal", affects: ["plan", "calendar"], sideEffects: ["replan"], reads: ["get_calendar_budget"], verify: ["entity_state_matches", "plan_consistent"] },
  update_calendar_sync_policy: { title: "日历自动更新设置", description: "开启/关闭校历与节假日的有限自动核对，设置学校、人群、间隔与官方入口。", group: "calendar", authorization: "explicit", undo: "journal", affects: [], sideEffects: ["job"], reads: ["get_context"], verify: ["policy_saved"] },
  update_planning_policy: { title: "时间安排规则", description: "修改作息模板字段、按星期/工作日的上限、某段时间不学、假期策略、集中时段偏好，或授权重新安排某天。", group: "plan", authorization: "explicit", undo: "journal", affects: ["plan"], sideEffects: ["replan"], reads: ["get_context", "get_calendar_budget"], verify: ["policy_saved", "plan_consistent"], facts: ["preferences", "rules"] },
  pause_task: { title: "暂停任务", description: "把任务先放一放（到某天或先不定），让出未执行的学习块；resume 恢复。", group: "task", authorization: "explicit", undo: "journal", affects: ["plan", "reminders"], sideEffects: ["replan", "reminders"], reads: ["find_entities", "get_entity_detail"], verify: ["entity_state_matches", "plan_consistent"] },
  correct_practice: { title: "纠正实践记录", description: "修改一条已有实践记录的分钟、日期、说明或关联任务。", group: "practice", authorization: "explicit", undo: "journal", affects: ["plan", "direction"], sideEffects: ["replan"], reads: ["find_entities", "get_entity_detail"], verify: ["entity_state_matches", "practice_not_duplicated"] },
  reschedule_session: { title: "调整学习安排", description: "把一个具体学习块挪到别的日期/时段/钟点，或只改这一段的长度。", group: "plan", authorization: "explicit", undo: "journal", affects: ["plan"], sideEffects: ["replan"], reads: ["find_entities", "get_calendar_budget"], verify: ["session_in_scope", "plan_consistent"] },
  schedule_session: { title: "安排学习", description: "在指定日期和钟点给某个任务安排一段学习（可新建任务）。", group: "plan", authorization: "explicit", undo: "journal", affects: ["plan"], sideEffects: ["replan"], reads: ["find_entities", "get_calendar_budget"], verify: ["session_in_scope", "plan_consistent"] },
  set_session_state: { title: "学习块状态", description: "开始、完成、跳过、锁定或解锁一个学习块。", group: "plan", authorization: "explicit", undo: "journal", affects: ["plan"], sideEffects: ["replan"], reads: ["find_entities", "get_entity_detail"], verify: ["entity_state_matches"] },
  undo_batch: { title: "撤销", description: "撤销最近一次（或指定的）变更。", group: "recovery", authorization: "explicit", undo: "none", affects: ["plan", "calendar"], sideEffects: ["replan", "reminders"], reads: ["get_conversation", "get_operation_status"], verify: ["entity_state_matches"] },
  update_reminder_policy: { title: "提醒设置", description: "开关截止提醒、默认提前量、安静时段；或设置某个任务提前多久提醒。", group: "reminder", authorization: "explicit", undo: "journal", affects: ["reminders"], sideEffects: ["reminders"], reads: ["get_context"], verify: ["policy_saved", "side_effect_status"] },
  update_digest_policy: { title: "摘要邮件设置", description: "每日/每周摘要的开关、时间、是否只在工作日。", group: "reminder", authorization: "explicit", undo: "journal", affects: ["reminders"], sideEffects: ["job"], reads: ["get_context"], verify: ["policy_saved"] },
  update_profile_fact: { title: "身份信息", description: "记录主人陈述的学历层次、专业、校区、入学年份、年级。", group: "profile", authorization: "explicit", undo: "journal", affects: ["notices"], sideEffects: [], reads: ["get_context"], verify: ["entity_state_matches"] },
  upsert_notice_rule: { title: "通知筛选规则", description: "某类人群专属的通知不进行动（原文保留）；remove 撤回。", group: "profile", authorization: "explicit", undo: "journal", affects: ["notices"], sideEffects: [], reads: ["get_context"], verify: ["policy_saved"] },
  apply_notice: { title: "通知", description: "按身份与规则判断一条通知：明确适用的义务建任务，其余只保留事实。", group: "profile", authorization: "auto", undo: "journal", affects: ["plan", "reminders", "notices"], sideEffects: ["replan", "reminders"], reads: ["get_evidence"], verify: ["entity_state_matches"] },
  resolve_notice: { title: "通知归类", description: "主人纠正某条通知是否与自己有关、要不要做。", group: "profile", authorization: "explicit", undo: "journal", affects: ["plan", "notices"], sideEffects: ["replan"], reads: ["find_entities", "get_evidence"], verify: ["entity_state_matches"] },
  request_export: { title: "导出数据", description: "生成一份业务数据导出文件供下载。", group: "recovery", authorization: "explicit", undo: "none", affects: [], sideEffects: ["job"], reads: [], verify: ["side_effect_status"] },
  upsert_goal: { title: "目标", description: "新建或修改目标；primary=true 设为当前唯一的主要方向。", group: "goal", authorization: "explicit", undo: "journal", affects: ["direction"], sideEffects: [], reads: ["find_entities"], verify: ["entity_state_matches"] },
  select_candidate: { title: "开始项目", description: "选一个候选开始试做（默认两周、只建第一步）或正式投入。不代表对外报名。", group: "goal", authorization: "explicit", undo: "journal", affects: ["plan", "direction"], sideEffects: ["replan"], reads: ["find_entities", "get_entity_detail"], verify: ["entity_state_matches", "plan_consistent"] },
  update_project_state: { title: "项目状态", description: "暂停/恢复/结束项目，或把试做转为正式投入。", group: "goal", authorization: "explicit", undo: "journal", affects: ["plan", "direction"], sideEffects: ["replan"], reads: ["find_entities", "get_entity_detail"], verify: ["entity_state_matches", "plan_consistent"] },
  cancel_ai_news: { title:"停止本次资讯更新", description:"停止当前尚未完成的AI资讯更新，保留已有盘点，不改变自动更新开关。",group:"agent",authorization:"explicit",undo:"none",affects:[],sideEffects:["job"],reads:["get_ai_news"],verify:["side_effect_status"] },
  request_ai_news: { title: "更新AI资讯", description: "获取并总结最近1–30天AI新闻；查看已保存资讯用get_ai_news，不启动更新。", group: "agent", authorization: "explicit", undo: "none", affects: [], sideEffects: ["job"], reads: ["get_ai_news"], verify: ["side_effect_status"] },
  update_ai_news_policy: { title: "AI资讯自动更新设置", description: "设置每天资讯更新时间、近期范围或开关，不改变定期AI总开关和调用预算。", group: "agent", authorization: "explicit", undo: "journal", affects: [], sideEffects: [], reads: ["get_ai_news"], verify: ["policy_saved"], facts: ["ai_news_policy"] },
  request_exploration: { title: "找候选项目", description: "按主人给的问题检索有来源的资料并生成最多 3 个候选。", group: "goal", authorization: "explicit", undo: "none", affects: ["direction"], sideEffects: ["job"], reads: ["get_context"], verify: ["side_effect_status"] },
  link_resource: { title: "资料", description: "把资料存下来、关联到项目，或纠正它是参考资料/别人的要求/自己的成果；主人线索可带关注方向 trackId、阶段 stageKey 与类型 noteKind（只存档，不建任务）。", group: "goal", authorization: "auto", undo: "journal", affects: ["direction"], sideEffects: [], reads: ["find_entities"], verify: ["entity_state_matches"] },
  update_direction_profile: { title: "阶段与去向", description: "记录主人明确说的当前阶段（year1–year4）、入学年与去向偏好（research/further_study/employment/undecided，可多选）。不从任务数推算阶段，不生成目标或任务。", group: "goal", authorization: "explicit", undo: "journal", affects: ["direction"], sideEffects: [], reads: ["get_context"], verify: ["entity_state_matches"], facts: ["direction_profile"] },
  upsert_direction_track: { title: "关注方向", description: "添加一个关注方向（可来自工作样本 templateKey），或改它的状态 exploring/following/paused 与主人备注。“先不看了”只改状态，不动关联项目。", group: "goal", authorization: "explicit", undo: "journal", affects: ["direction"], sideEffects: [], reads: ["get_context", "find_entities"], verify: ["entity_state_matches"] },
  update_roadmap_item: { title: "阶段项", description: "主人采用或修订一条阶段项（stageKey + 标题/目的，可引用已有目标或关注方向）；completed 只在主人明确确认时用。不生成任务。", group: "goal", authorization: "explicit", undo: "journal", affects: ["direction"], sideEffects: [], reads: ["get_context", "find_entities"], verify: ["entity_state_matches"] },
  link_direction_project: { title: "项目关联方向", description: "把已有项目关联到关注方向（可附阶段项），或 remove 解除；项目本身和它的安排不变。", group: "goal", authorization: "explicit", undo: "journal", affects: ["direction"], sideEffects: [], reads: ["find_entities"], verify: ["entity_state_matches"] },
  record_direction_reflection: { title: "实践感受", description: "保存主人对实践的原话感受，关联项目/关注方向/实践记录至少一个。只记主人说的，不记分钟数（实际用时走实践记录）。", group: "practice", authorization: "explicit", undo: "journal", affects: ["direction"], sideEffects: [], reads: ["find_entities"], verify: ["entity_state_matches"] },
  update_agent_policy: { title: "主动程度与预算", description: "每日模型/搜索调用上限；是否运行定期探索和定期复盘。", group: "agent", authorization: "explicit", undo: "journal", affects: [], sideEffects: [], reads: ["get_context"], verify: ["policy_saved"], facts: ["agent_policy"] },
  request_review: { title: "复盘", description: "按一周已记录的事实生成复盘与建议；建议不自动执行。", group: "agent", authorization: "explicit", undo: "none", affects: [], sideEffects: ["job"], reads: ["get_context"], verify: ["side_effect_status"] },
  configure_exploration: { title: "定期探索", description: "新建、调整或停用一个关注方向及其每周探索时间。", group: "agent", authorization: "explicit", undo: "journal", affects: ["direction"], sideEffects: ["job"], reads: ["find_entities"], verify: ["policy_saved"] },
  request_owner_digest: { title: "发送摘要", description: "现在给主人本人发一份今日或本周摘要；已发出的邮件不能撤回。", group: "reminder", authorization: "explicit", undo: "none", affects: [], sideEffects: ["mail", "job"], reads: ["get_context"], verify: ["side_effect_status"] },
  cancel_operation: { title: "停止处理", description: "停止一份还没处理完的投递；已生效的变化保留，用撤销回退。", group: "agent", authorization: "explicit", undo: "none", affects: [], sideEffects: [], reads: ["get_operation_status"], verify: ["side_effect_status"] },
  update_fixed_event: { title: "固定活动", description: "修改或移除一个非课程的固定活动（名称、星期/日期、钟点）。", group: "course", authorization: "explicit", undo: "journal", affects: ["plan"], sideEffects: ["replan"], reads: ["find_entities", "get_calendar_budget"], verify: ["entity_state_matches", "plan_consistent"] },
  complete_task: { title: "完成任务", description: "把指定任务标记完成，取消其未执行学习块与提醒。", group: "task", authorization: "explicit", undo: "journal", affects: ["plan", "reminders"], sideEffects: ["replan", "reminders"], reads: ["find_entities", "get_entity_detail"], verify: ["entity_state_matches", "plan_consistent"] },
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
  /** Agent 推断出的修改（决策/目标运行），不是主人逐字说出的；按参数级授权判断是否要确认 */
  inferred?: boolean;
  /** 主人已经确认过这份绑定后的方案（确认与方案指纹一致） */
  confirmed?: boolean;
  /** 服务端标记：主人输入中形成的策略提案；仅可请求确认，不能让模型自行增大预算 */
  ownerPolicyProposal?: boolean;
  /** 规划时刻；缺省取当前时间（测试用固定时钟） */
  now?: Date;
  conversationId?: string | null;
  /** 确认时的事实快照指纹：执行事务内重算，不一致就不写（确认期间相关事实变了） */
  expectedFacts?: string | null;
};
