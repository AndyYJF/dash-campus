import { z } from "zod";

/**
 * 导出契约（计划 v1.2 第 9、10.2 节；产品计划第 5.4、7 节阶段报告）。
 * - project_markdown：只含主人选中的项目字段、记录与成果；缺失内容留空，不编造。
 * - full_json：个人业务数据；不含密码摘要、session、integration token、secret、私有路径与后台投递队列。
 * 导出文件在实例私有目录保存 24 小时；下载 GET 不触发重新生成，到期 410。
 */

export const EXPORT_TTL_MS = 24 * 60 * 60 * 1000;

export const REPORT_FIELDS = ["goal", "actions", "artifacts", "difficulties", "nextSteps"] as const;
export type ReportField = (typeof REPORT_FIELDS)[number];

export const REPORT_FIELD_LABEL: Record<ReportField, string> = {
  goal: "目标与理由",
  actions: "采取的行动",
  artifacts: "成果链接",
  difficulties: "困难与反思",
  nextSteps: "下一步",
};

export const exportRequestSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("project_markdown"),
    projectId: z.string().uuid(),
    fields: z.array(z.enum(REPORT_FIELDS)).min(1).max(REPORT_FIELDS.length),
    /** 选中的记录与成果；空数组表示不含 */
    selectedLogIds: z.array(z.string().uuid()).max(500).default([]),
    selectedArtifactIds: z.array(z.string().uuid()).max(500).default([]),
    /** 主人在预览中编辑过的正文；省略则按选择生成 */
    editedMarkdown: z.string().max(200_000).nullable().default(null),
  }),
  z.object({ type: z.literal("full_json") }),
]);
export type ExportRequest = z.infer<typeof exportRequestSchema>;

export const reportPreviewSchema = z.object({
  projectId: z.string().uuid(),
  fields: z.array(z.enum(REPORT_FIELDS)).min(1).max(REPORT_FIELDS.length),
  selectedLogIds: z.array(z.string().uuid()).max(500).default([]),
  selectedArtifactIds: z.array(z.string().uuid()).max(500).default([]),
});

/** full_json 的数据表白名单：只导出业务表；列级再剔除内部字段 */
export const FULL_JSON_TABLES: Record<string, { omit?: string[] }> = {
  goals: {},
  projects: {},
  project_goals: {},
  tasks: {},
  legacy_instances: {},
  legacy_mappings: {},
  legacy_imports: {},
  daily_logs: {},
  daily_log_revisions: {},
  artifacts: {},
  artifact_revisions: {},
  resources: {},
  resource_revisions: {},
  evidence_resource_refs: {},
  weekly_focus: {},
  availability_blocks: {},
  fixed_events: {},
  fixed_event_exceptions: {},
  notice_extractions: { omit: ["job_id"] },
  proposal_groups: {},
  proposals: {},
  proposal_operations: {},
  profile_facts: {},
  profile_rules: {},
  // 导入 token 摘要不导出；保留 id/title 维持消息的来源关系
  inbox_sources: { omit: ["token_digest"] },
  inbox_messages: {},
  inbox_revisions: {},
  inbox_decisions: {},
  inbox_task_links: {},
  practice_templates: {},
  exploration_topics: {},
  exploration_runs: { omit: ["job_id"] },
  search_hits: {},
  evidence_documents: {},
  candidates: {},
  reviews: { omit: ["job_id"] },
  review_edits: {},
  assistant_requests: { omit: ["job_id"] },
  // Agent-first V2（迁移 0017）：统一输入与问答；原文与结构值是业务数据，全部导出
  intakes: {},
  extracted_documents: {},
  intake_items: {},
  clarification_questions: {},
  clarification_answers: {},
  // Agent-first V2（迁移 0018）：课程语义模型/实践记录/命令 journal 都是业务数据，全部导出
  semesters: {},
  course_sets: {},
  courses: {},
  course_meetings: {},
  course_meeting_projections: {},
  entity_source_links: {},
  agent_action_batches: {},
  agent_action_changes: {},
  practice_entries: {},
  // Agent-first V2（迁移 0019）：规划偏好与学习块排程
  planning_preferences: {},
  plan_sessions: {},
  // Agent-first V2（迁移 0020）：附件元数据导出；blob 二进制原件列入排除
  intake_attachments: {},
  // Agent-first V2（迁移 0022）：课程单日例外（停课/调课）
  course_event_exceptions: {},
  // Agent-first V2（迁移 0023）：focus 计时
  focus_sessions: {},
  // R0/R1（迁移 0025）：校历、国家节假日、教学日例外、来源刷新状态与撤销墓碑、时间政策规则
  academic_calendars: {},
  academic_calendar_events: {},
  holiday_datasets: {},
  holiday_days: {},
  teaching_day_overrides: {},
  calendar_sync_sources: {},
  source_tombstones: {},
  planning_policy_rules: {},
  // R2（迁移 0026）：服务端对话与轮次（主人原话、结果引用）
  conversations: {},
  conversation_turns: {},
  // R2/R5（迁移 0027）：资料与项目/任务的关联及事实类型
  resource_links: {},
  // Agent 增强 P4（迁移 0031）：目标与修订是业务流程状态，随业务导出与恢复
  agent_goals: {},
  agent_goal_revisions: {},
  // Agent 增强 P5（迁移 0032）：执行后的核验与修正记录属于目标流程状态
  agent_verifications: {},
    // 非敏感设置（邮件模板、预算）；调度内部状态不导出
  settings: {},
};

/** settings 里只属于调度内部的键 */
export const FULL_JSON_SETTINGS_OMIT_KEYS = ["weeklyReviewNextRun", "digestSchedule:daily", "digestSchedule:weekly", "digestSystemFingerprint", "modelCapabilities"];

/** 明确不导出（审计用）：凭证、会话、幂等记录、后台队列、导出记录本身、实例控制 */
export const FULL_JSON_EXCLUDED = [
  "owner",
  "sessions",
  "idempotency_keys",
  "jobs",
  "deliveries",
  "ai_usage",
  "exports",
  "instance_state",
  "planning_state",
  "schema_version",
  "intake_blobs",
  // Agent 增强 P0（迁移 0030）：请求额度账目与模型诊断/纠错不是用户事实
  "ai_request_ledger",
  "agent_traces",
  "agent_feedback",
] as const;
