import { z } from "zod";

/**
 * 方向探索契约（计划 v1.2 第 7 节）。
 * 模型只能引用提供的证据 ID；requirements 的 met 只能由主人确认，模型输出一律按 unknown/unmet 落库。
 */

/** 7.2 默认预算：每次最多 3 query、合计 6 个提取页、3 个候选、180 秒；可重试失败最多重试 1 次 */
export const EXPLORATION_BUDGET = {
  maxQueries: 3,
  maxExtractPages: 6,
  maxCandidates: 3,
  totalMs: 180_000,
  maxRetries: 1,
  resultsPerQuery: 5,
} as const;

export const EXPLORATION_JOB_TYPE = "exploration";

export const RUN_STATUSES = ["queued", "searching", "extracting", "generating", "done", "failed", "cancelled"] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export const EVIDENCE_STATUSES = ["snippet", "retrieved", "user_supplied"] as const;
export type EvidenceStatus = (typeof EVIDENCE_STATUSES)[number];

export const CANDIDATE_FEEDBACK = ["not_interested", "lacking_basics", "no_time", "low_quality"] as const;

const shortText = (max: number) => z.string().trim().min(1).max(max);

// ===== 请求 =====

/** 用户粘贴资料（无搜索服务时的 user_supplied 证据） */
export const materialSchema = z.object({
  title: z.string().trim().max(200).default(""),
  url: z.string().url().refine((u) => /^https?:\/\//.test(u), "仅限 http/https").nullable().default(null),
  text: shortText(20_000),
});

export const explorationRequestSchema = z.object({
  query: shortText(500),
  topicId: z.string().uuid().nullable().default(null),
  projectId: z.string().uuid().nullable().default(null),
  /** 当前基础、可用时间等背景（主人自填，可空） */
  background: z.string().max(2000).default(""),
  materials: z.array(materialSchema).max(6).default([]),
  resourceIds: z.array(z.string().uuid()).max(6).optional(),
});
export type ExplorationRequest = z.infer<typeof explorationRequestSchema>;

export const explorationJobPayloadSchema = z.object({
  runId: z.string().uuid(),
  topicId: z.string().uuid().nullable(),
  topicVersion: z.number().int().nullable(),
});

// ===== 模型输出 =====

/** 规划检索：最多 3 个 query */
export const queryPlanSchema = z.object({
  queries: z.array(shortText(200)).min(1).max(EXPLORATION_BUDGET.maxQueries),
});

export const modelRequirementSchema = z.object({
  label: shortText(200),
  // 模型不能判定 met：met 需要主人确认（7.1）。模型给 met 会被降为 unknown
  status: z.enum(["met", "unmet", "unknown"]),
  basis: z.string().max(500).default(""),
});

export const modelTaskSchema = z.object({
  title: shortText(200),
  input: z.string().max(500).default(""),
  output: z.string().max(500).default(""),
  estimateMinutes: z.number().int().min(5).max(24 * 60).nullable().default(null),
});

export const modelCandidateSchema = z.object({
  title: shortText(200),
  question: shortText(500),
  activities: z.array(shortText(300)).min(1).max(6),
  deliverable: shortText(500),
  firstTask: modelTaskSchema,
  initialTasks: z.array(modelTaskSchema).max(5).default([]),
  estimatedMinutesRange: z
    .object({ min: z.number().int().min(0), max: z.number().int().min(0) })
    .refine((r) => r.min <= r.max, "min 不能大于 max")
    .nullable()
    .default(null),
  requirements: z.array(modelRequirementSchema).max(10).default([]),
  unknowns: z.array(z.string().max(300)).max(10).default([]),
  fitReason: z.string().max(800).default(""),
  /** 必须引用证据文本里真实存在的片段 */
  sourceRefs: z
    .array(z.object({ evidenceId: z.string().min(1), quote: shortText(400) }))
    .min(1)
    .max(6),
});
export type ModelCandidate = z.infer<typeof modelCandidateSchema>;

export const candidatesOutputSchema = z.object({
  candidates: z.array(modelCandidateSchema).max(EXPLORATION_BUDGET.maxCandidates),
  /** 资料不足时说明，不编造 */
  insufficientReason: z.string().max(500).nullable().default(null),
});

export const MODEL_WORKFLOW_PLAN = "exploration.plan_queries";
export const MODEL_WORKFLOW_CANDIDATES = "exploration.candidates";

// ===== topic =====

export const topicCreateSchema = z.object({
  title: shortText(200),
  purpose: z.string().max(1000).default(""),
  sourcePreference: z.string().max(500).default(""),
  enabled: z.boolean().default(false),
  weekday: z.number().int().min(1).max(7).default(1),
  localTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).default("09:00"),
});

export const topicPatchSchema = z.object({
  expectedVersion: z.number().int().min(1),
  title: shortText(200).optional(),
  purpose: z.string().max(1000).optional(),
  sourcePreference: z.string().max(500).optional(),
  enabled: z.boolean().optional(),
  weekday: z.number().int().min(1).max(7).optional(),
  localTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional(),
});

// ===== candidate → project =====

export const createProjectFromCandidateSchema = z.object({
  expectedVersion: z.number().int().min(1),
  title: shortText(200),
  question: z.string().max(2000),
  expectedOutcome: z.string().max(2000),
  prerequisites: z.string().max(2000).default(""),
  reviewQuestions: z.string().max(2000).default(""),
  goalIds: z.array(z.string().uuid()).max(20).default([]),
  startInclination: z.enum(["unknown", "interested", "unsure"]),
  /** 仍有未知/未满足条件时必须显式确认"带这些未知条件开始"（7.1） */
  acceptUnknowns: z.boolean().default(false),
  /** 主人确认已具备的条件（按 requirements 下标） */
  confirmedRequirementIndexes: z.array(z.number().int().min(0)).max(10).default([]),
  tasks: z
    .array(
      z.object({
        title: shortText(200),
        description: z.string().max(2000).default(""),
        estimateMinutes: z.number().int().min(0).nullable().default(null),
      }),
    )
    .min(1)
    .max(5),
});

export const candidateActionSchema = z.object({
  expectedVersion: z.number().int().min(1),
  action: z.enum(["save_idea", "dismiss"]),
  feedback: z.enum(CANDIDATE_FEEDBACK).nullable().default(null),
});

export const projectConclusionSchema = z.object({
  expectedVersion: z.number().int().min(1),
  experiencedActivities: z.string().max(2000).default(""),
  conclusion: z.enum(["continue", "change", "undecided"]),
  reason: z.string().max(2000).default(""),
  artifactIds: z.array(z.string().uuid()).max(20).default([]),
});
