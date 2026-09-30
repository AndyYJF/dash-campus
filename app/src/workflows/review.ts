import crypto from "node:crypto";
import { getDb } from "@/repositories/db";
import { createJob, completeJob, failJob, leaseValid, renewLease } from "@/repositories/jobs";
import {
  finishAssistant,
  finishReview,
  getAssistantRequest,
  getReview,
  insertAssistantRequest,
  insertReview,
  latestReviewForWeek,
  setAssistantJob,
  setAssistantRunning,
  setReviewGenerating,
  setReviewJob,
  type ReviewRow,
} from "@/repositories/reviews";
import { listProposals } from "@/repositories/proposals";
import { getProject, getTask, listTasks } from "@/repositories/planning";
import { listLogs } from "@/repositories/logs";
import {
  ASSISTANT_JOB_TYPE,
  BLOCKER_LOOKBACK_DAYS,
  blockerOutputSchema,
  MAX_ASSISTANT_PROPOSALS,
  MAX_REVIEW_PROPOSALS,
  MODEL_WORKFLOW_BLOCKER,
  MODEL_WORKFLOW_REVIEW,
  REVIEW_JOB_TYPE,
  reviewOutputSchema,
} from "@/contracts/review";
import { JOB_EXTERNAL_TIMEOUT_MS, JOB_RENEW_INTERVAL_MS, type JobRow } from "@/contracts/jobs";
import { resolveModelProvider } from "@/integrations";
import { addDays, instanceTimezone, localDateInTz, mondayOf } from "@/domain/time";
import { nextWeeklyRun } from "@/domain/exploration";
import { budgetCheck, getAiBudget, meteredModel } from "@/workflows/ai-budget";
import { hasRecords, weekFacts, type WeekFacts } from "@/workflows/week-facts";
import { translateProposals } from "@/workflows/ai-proposals";
import { getSetting, updateSetting } from "@/repositories/settings";
import { isRestoredHold, RESTORED_HOLD_MESSAGE } from "@/repositories/instance";

/**
 * 周复盘与卡点辅助（计划 v1.2 第 6 节；产品计划第 6.5、12 节）。
 * - 事实部分由程序汇总（weekFacts），始终可用；模型只给推测与提案，三者分开存。
 * - 没有记录：状态 insufficient，不调用模型、不凭空写成长结论。
 * - 模型未配置或超预算：仍生成事实与手写复盘，AI 部分标明跳过原因。
 * - 模型调用不在任何数据库事务里；结果落库前检查租约（8.1）。
 */

// ===== 周复盘 =====

export type StartReviewResult = { ok: true; review: ReviewRow; jobId: string } | { ok: false; code: string; message: string };

/** "最近一个自然周"：实例时区上周一 */
export function lastWeekMonday(now = new Date()): string {
  return addDays(mondayOf(localDateInTz(now, instanceTimezone())), -7);
}

export function startReview(localMonday: string | null, trigger: "manual" | "scheduled" = "manual"): StartReviewResult {
  if (isRestoredHold()) return { ok: false, code: "RESTORED_HOLD", message: RESTORED_HOLD_MESSAGE };
  const tz = instanceTimezone();
  const monday = localMonday ?? lastWeekMonday();
  const db = getDb();
  return db.transaction((): StartReviewResult => {
    const existing = latestReviewForWeek(monday, tz);
    if (existing && (existing.status === "queued" || existing.status === "generating")) {
      return { ok: true, review: existing, jobId: existing.jobId ?? "" };
    }
    const review = insertReview({ localMonday: monday, timezone: tz, trigger });
    const job = createJob({
      type: REVIEW_JOB_TYPE,
      dedupeKey: `review:${review.id}`,
      runAt: new Date().toISOString(),
      payload: { reviewId: review.id },
    });
    setReviewJob(review.id, job.id);
    return { ok: true, review: getReview(review.id)!, jobId: job.id };
  })();
}

const REVIEW_INSTRUCTIONS = [
  "你帮一名学生做上周复盘。context.facts 是程序从真实记录汇总的事实。",
  "硬性规则：",
  "1. factNotes 只复述事实，每条的 evidenceIds 必须是 facts 里出现的 id（日志 log、任务 task、成果 artifact）。",
  "2. observations 是你的推测，写成'可能…'，不作人格判断，不给职业适配结论。",
  "3. proposals 最多 3 份，彼此独立；每份最多 5 个操作，只能用 create_task / set_task_status / reschedule_task。",
  "   set_task_status 与 reschedule_task 的 taskId 必须来自 facts.openTasks；create_task 的 projectId 必须来自 facts.projects 或为 null。",
  "   reschedule_task 的时间用带时区的 ISO 8601（如 2026-10-06T19:00:00+08:00）。不要改截止日期。",
  "   set_task_status 的 status 只能是 todo / doing / blocked / done / cancelled 之一（英文小写）。",
  "4. 记录很少时宁可不给建议，在 insufficientReason 说明，不编造进展或收获。",
  "5. 参考 facts.lastWeekProposals：被拒绝过的方向不要换个说法再提。",
  '输出 {"factNotes":[{text,evidenceIds}],"observations":[{text,evidenceIds}],"proposals":[{reason,evidenceIds,operations}],"insufficientReason":null}',
].join("\n");

function factsForModel(f: WeekFacts) {
  return {
    week: { localMonday: f.localMonday, timezone: f.timezone },
    focus: f.focus,
    logs: f.logs.map((l) => ({ id: l.id, date: l.occurredOn, progress: l.progress, blocker: l.blocker, taskId: l.taskId })),
    completedTasks: f.completedTasks.map((t) => ({ id: t.id, title: t.title, projectId: t.projectId })),
    openTasks: f.openTasks.map((t) => ({ id: t.id, title: t.title, status: t.status, projectId: t.projectId, estimateMinutes: t.estimateMinutes, plannedWeek: t.plannedWeek })),
    artifacts: f.artifacts.map((a) => ({ id: a.id, title: a.title, projectId: a.projectId })),
    projects: f.projects,
    workload: f.workload,
    lastWeekProposals: f.lastWeekProposals,
  };
}

type Lease = { job: JobRow; fenced: () => boolean; controller: AbortController; stop: () => void };

function holdLease(job: JobRow): Lease {
  let fenced = false;
  const controller = new AbortController();
  const timer = setInterval(() => {
    if (!renewLease(job.id, job.leaseToken!, job.generation, new Date().toISOString())) {
      fenced = true;
      controller.abort();
    }
  }, JOB_RENEW_INTERVAL_MS);
  return { job, fenced: () => fenced, controller, stop: () => clearInterval(timer) };
}

function stillHeld(l: Lease): boolean {
  return !l.fenced() && leaseValid(l.job.id, l.job.leaseToken!, l.job.generation, new Date().toISOString());
}

export async function runReviewJob(job: JobRow): Promise<{ kind: "done" | "failed" | "fenced" | "cancelled" }> {
  const { reviewId } = job.payload as { reviewId: string };
  const review = getReview(reviewId);
  const token = job.leaseToken!;
  const nowIso = () => new Date().toISOString();
  if (!review || !["queued", "generating"].includes(review.status)) {
    return completeJob(job.id, token, job.generation, { kind: "skipped", reason: "review_finished" }, nowIso())
      ? { kind: "done" }
      : { kind: "fenced" };
  }
  setReviewGenerating(review.id);
  const facts = weekFacts(review.localMonday, review.timezone);

  const finish = (args: Parameters<typeof finishReview>[1], ok: boolean, err?: string) => {
    return getDb().transaction(() => {
      if (!leaseValid(job.id, token, job.generation, nowIso())) return false;
      finishReview(review.id, args);
      return ok
        ? completeJob(job.id, token, job.generation, { kind: "skipped", reason: `review:${args.status}` }, nowIso())
        : failJob(job.id, token, job.generation, err ?? "failed", nowIso());
    }).immediate();
  };

  // 无新增记录：不调用模型（第 6 节）
  if (!hasRecords(facts)) {
    return finish({ status: "insufficient", facts, aiSkippedReason: "no_records", integrationMode: "none" }, true)
      ? { kind: "done" }
      : { kind: "fenced" };
  }

  const model = resolveModelProvider();
  if (!model) {
    return finish({ status: "ready", facts, aiSkippedReason: "not_configured", integrationMode: "none" }, true)
      ? { kind: "done" }
      : { kind: "fenced" };
  }
  const budget = budgetCheck({ model: 1 });
  if (!budget.ok) {
    return finish({ status: "ready", facts, aiSkippedReason: "budget", integrationMode: "none", errorMessage: budget.message }, true)
      ? { kind: "done" }
      : { kind: "fenced" };
  }

  const lease = holdLease(job);
  try {
    const provider = meteredModel(model.provider, { type: "review", id: review.id });
    const r = await provider.call({
      workflow: MODEL_WORKFLOW_REVIEW,
      context: { facts: factsForModel(facts) },
      outputSchemaVersion: 1,
      timeoutMs: JOB_EXTERNAL_TIMEOUT_MS,
      instructions: REVIEW_INSTRUCTIONS,
      schema: reviewOutputSchema,
      signal: lease.controller.signal,
    });
    if (!stillHeld(lease)) return { kind: "fenced" };
    if (!r.ok) {
      // AI 失败不影响事实部分：状态仍 ready，AI 部分显示失败原因
      return finish(
        { status: "ready", facts, aiSkippedReason: "error", integrationMode: model.mode, errorCode: r.error.code, errorMessage: r.error.message },
        true,
      )
        ? { kind: "done" }
        : { kind: "fenced" };
    }
    const out = r.validatedResult as import("zod").infer<typeof reviewOutputSchema>;
    const evidenceIds = new Set([...facts.logs.map((l) => l.id), ...facts.completedTasks.map((t) => t.id), ...facts.openTasks.map((t) => t.id), ...facts.artifacts.map((a) => a.id)]);
    const keepCited = <T extends { evidenceIds: string[] }>(xs: T[]) => xs.filter((x) => x.evidenceIds.every((id) => evidenceIds.has(id)));

    // 发布：租约仍有效才写提案与草案（同一事务）
    const outcome = getDb().transaction(() => {
      if (!leaseValid(job.id, token, job.generation, nowIso())) return "fenced" as const;
      const t = translateProposals(out.proposals.slice(0, MAX_REVIEW_PROPOSALS), {
        evidenceIds,
        taskIds: new Set(facts.openTasks.map((x) => x.id)),
        projectIds: new Set(facts.projects.map((p) => p.id)),
        projectId: null,
        sourceKind: "review",
        sourceId: review.id,
        groupId: crypto.randomUUID(),
        groupTitle: `${review.localMonday} 周复盘`,
      });
      finishReview(review.id, {
        status: "ready",
        facts,
        integrationMode: model.mode,
        aiDraft: {
          factNotes: keepCited(out.factNotes),
          observations: keepCited(out.observations),
          proposalIds: t.created.map((p) => p.id),
          dropped: [
            ...t.dropped,
            ...(out.factNotes.length - keepCited(out.factNotes).length > 0 ? ["部分事实复述引用了不存在的记录，已删除"] : []),
            ...(out.observations.length - keepCited(out.observations).length > 0 ? ["部分推测引用了不存在的记录，已删除"] : []),
          ],
          insufficientReason: out.insufficientReason,
        },
      });
      completeJob(job.id, token, job.generation, { kind: "skipped", reason: `review:proposals:${t.created.length}` }, nowIso());
      return "done" as const;
    }).immediate();
    return { kind: outcome };
  } finally {
    lease.stop();
  }
}

// ===== 定期周复盘 =====

const REVIEW_SCHEDULE_KEY = "weeklyReviewNextRun";

/** 启用了周复盘时：到点入队一次上周复盘；错过多个周期只生成一次 */
export function scheduleWeeklyReview(now = new Date()): boolean {
  const { budget } = getAiBudget();
  const cfg = budget.weeklyReview;
  const entry = getSetting(REVIEW_SCHEDULE_KEY);
  const tz = instanceTimezone();
  if (!cfg) {
    if (entry.value) updateSetting(REVIEW_SCHEDULE_KEY, null, entry.version);
    return false;
  }
  const state = entry.value as { nextRunAt: string; weekday: number; localTime: string } | null;
  const configChanged = !state || state.weekday !== cfg.weekday || state.localTime !== cfg.localTime;
  if (configChanged) {
    updateSetting(REVIEW_SCHEDULE_KEY, { nextRunAt: nextWeeklyRun(now, cfg.weekday, cfg.localTime, tz), ...cfg }, entry.version);
    return false;
  }
  if (state.nextRunAt > now.toISOString()) return false;
  const next = { ...state, nextRunAt: nextWeeklyRun(now, cfg.weekday, cfg.localTime, tz) };
  if (updateSetting(REVIEW_SCHEDULE_KEY, next, entry.version) === "conflict") return false;
  if (!budget.scheduledEnabled) return false;
  return startReview(null, "scheduled").ok;
}

// ===== 卡点辅助 =====

export type StartAssistantResult =
  | { ok: true; requestId: string; jobId: string; integrationMode: "real" | "fixture" }
  | { ok: false; status: number; code: string; message: string };

export function startAssistant(input: {
  scopeType: "project" | "week";
  scopeId: string | null;
  question: string;
  logId: string | null;
  rerun: boolean;
}): StartAssistantResult {
  if (isRestoredHold()) return { ok: false, status: 503, code: "RESTORED_HOLD", message: RESTORED_HOLD_MESSAGE };
  const model = resolveModelProvider();
  if (!model) return { ok: false, status: 503, code: "INTEGRATION_UNAVAILABLE", message: "模型未配置，暂时无法分析。记录已保存，可以手写下一步。" };
  const budget = budgetCheck({ model: 1 });
  if (!budget.ok) return { ok: false, status: 429, code: "BUDGET_EXCEEDED", message: budget.message };

  let scopeId = input.scopeId;
  if (input.scopeType === "project") {
    const p = scopeId ? getProject(scopeId) : null;
    if (!p || p.archivedAt) return { ok: false, status: 404, code: "NOT_FOUND", message: "项目不存在" };
  } else {
    scopeId = mondayOf(localDateInTz(new Date(), instanceTimezone()));
  }
  if (input.logId) {
    const log = getDb().prepare(`SELECT project_id FROM daily_logs WHERE id = ?`).get(input.logId) as { project_id: string | null } | undefined;
    if (!log) return { ok: false, status: 404, code: "NOT_FOUND", message: "记录不存在" };
    if (input.scopeType === "project" && log.project_id !== scopeId) {
      return { ok: false, status: 422, code: "VALIDATION", message: "记录不属于该项目" };
    }
  }
  return getDb().transaction((): StartAssistantResult => {
    const req = insertAssistantRequest({
      scopeType: input.scopeType,
      scopeId: scopeId!,
      question: input.question,
      logId: input.logId,
      rerun: input.rerun,
      integrationMode: model.mode,
    });
    const job = createJob({ type: ASSISTANT_JOB_TYPE, dedupeKey: `assistant:${req.id}`, runAt: new Date().toISOString(), payload: { requestId: req.id } });
    setAssistantJob(req.id, job.id);
    return { ok: true, requestId: req.id, jobId: job.id, integrationMode: model.mode };
  })();
}

const BLOCKER_INSTRUCTIONS = [
  "你帮一名学生分析一个卡点。context 里是主人选中的记录、关联任务和最近 7 天同项目的日志。",
  "硬性规则：",
  "1. explanations 是可能的原因，写成'可能…'，每条 evidenceIds 引用 context 里的日志或任务 id；不作人格判断。",
  "2. nextSteps 是可以验证的具体下一步（有明确的检查方式）。",
  "3. 信息不够时给 followUpQuestion 追问，或在 insufficientReason 说明，不要猜。",
  "4. proposal 最多 1 份（可以为 null），最多 5 个操作；taskId 只能来自 context.tasks，projectId 只能来自 context.project。",
  "   只能用 create_task / set_task_status / reschedule_task；不要改截止日期。",
  "   set_task_status 的 status 只能是 todo / doing / blocked / done / cancelled 之一（英文小写）。",
  '输出 {"explanations":[{text,evidenceIds}],"nextSteps":[],"followUpQuestion":null,"proposal":null,"insufficientReason":null}',
].join("\n");

export async function runAssistantJob(job: JobRow): Promise<{ kind: "done" | "failed" | "fenced" | "cancelled" }> {
  const { requestId } = job.payload as { requestId: string };
  const req = getAssistantRequest(requestId);
  const token = job.leaseToken!;
  const nowIso = () => new Date().toISOString();
  if (!req || !["queued", "running"].includes(req.status)) {
    return completeJob(job.id, token, job.generation, { kind: "skipped", reason: "request_finished" }, nowIso()) ? { kind: "done" } : { kind: "fenced" };
  }
  setAssistantRunning(req.id);

  // 读取范围：选中的记录 + 关联任务 + 最近 7 天同项目（或本周）的日志
  const tz = instanceTimezone();
  const since = addDays(localDateInTz(new Date(), tz), -BLOCKER_LOOKBACK_DAYS);
  const projectId = req.scopeType === "project" ? req.scopeId : null;
  const logs = (projectId ? listLogs({ projectId, limit: 50 }) : listLogs({ limit: 100 })).filter(
    (l) => l.occurredOn >= (req.scopeType === "week" ? req.scopeId : since),
  );
  const selected = req.logId ? listLogs({ limit: 500 }).find((l) => l.id === req.logId) ?? null : null;
  const allLogs = selected && !logs.some((l) => l.id === selected.id) ? [selected, ...logs] : logs;
  const taskIds = new Set<string>(allLogs.map((l) => l.taskId).filter((x): x is string => Boolean(x)));
  const tasks = projectId
    ? listTasks({ projectId }).filter((t) => ["todo", "doing", "blocked"].includes(t.status))
    : [...taskIds].map((id) => getTask(id)).filter((t): t is NonNullable<typeof t> => Boolean(t && !t.archivedAt && ["todo", "doing", "blocked"].includes(t.status)));
  for (const t of tasks) taskIds.add(t.id);

  const finish = (args: Parameters<typeof finishAssistant>[1], ok: boolean) =>
    getDb().transaction(() => {
      if (!leaseValid(job.id, token, job.generation, nowIso())) return false;
      finishAssistant(req.id, args);
      return ok
        ? completeJob(job.id, token, job.generation, { kind: "skipped", reason: `assistant:${args.status}` }, nowIso())
        : failJob(job.id, token, job.generation, args.errorMessage ?? "failed", nowIso());
    }).immediate();

  // 没有任何带内容的记录：资料不足，不调用模型
  if (allLogs.length === 0) {
    return finish({ status: "insufficient", result: { insufficientReason: "范围内没有记录，无法分析。可以先写一条进展或卡点。" } }, true)
      ? { kind: "done" }
      : { kind: "fenced" };
  }

  const model = resolveModelProvider();
  if (!model) {
    return finish({ status: "failed", errorCode: "INTEGRATION_UNAVAILABLE", errorMessage: "模型未配置" }, false) ? { kind: "failed" } : { kind: "fenced" };
  }
  const lease = holdLease(job);
  try {
    const provider = meteredModel(model.provider, { type: "assistant_request", id: req.id });
    const project = projectId ? getProject(projectId) : null;
    const r = await provider.call({
      workflow: MODEL_WORKFLOW_BLOCKER,
      context: {
        question: req.question,
        selectedLog: selected ? { id: selected.id, date: selected.occurredOn, progress: selected.progress, blocker: selected.blocker, taskId: selected.taskId } : null,
        logs: allLogs.map((l) => ({ id: l.id, date: l.occurredOn, progress: l.progress, blocker: l.blocker, taskId: l.taskId })),
        tasks: tasks.map((t) => ({ id: t.id, title: t.title, status: t.status, estimateMinutes: t.estimateMinutes, scheduledStart: t.scheduledStart })),
        project: project ? { id: project.id, title: project.title, question: project.question } : null,
        timezone: tz,
        now: nowIso(),
      },
      outputSchemaVersion: 1,
      timeoutMs: JOB_EXTERNAL_TIMEOUT_MS,
      instructions: BLOCKER_INSTRUCTIONS,
      schema: blockerOutputSchema,
      signal: lease.controller.signal,
    });
    if (!stillHeld(lease)) return { kind: "fenced" };
    if (!r.ok) {
      const code = r.error.message.startsWith("BUDGET_EXCEEDED") ? "BUDGET_EXCEEDED" : r.error.code;
      return finish({ status: "failed", errorCode: code, errorMessage: r.error.message }, false) ? { kind: "failed" } : { kind: "fenced" };
    }
    const out = r.validatedResult as import("zod").infer<typeof blockerOutputSchema>;
    const evidenceIds = new Set<string>([...allLogs.map((l) => l.id), ...taskIds]);
    const outcome = getDb().transaction(() => {
      if (!leaseValid(job.id, token, job.generation, nowIso())) return "fenced" as const;
      const t = out.proposal
        ? translateProposals([out.proposal].slice(0, MAX_ASSISTANT_PROPOSALS), {
            evidenceIds,
            taskIds,
            projectIds: new Set(projectId ? [projectId] : []),
            projectId,
            sourceKind: "assistant",
            sourceId: req.id,
            groupId: crypto.randomUUID(),
            groupTitle: "卡点分析",
            ignoreCooldown: req.rerun,
          })
        : { created: [], dropped: [] };
      const explanations = out.explanations.filter((x) => x.evidenceIds.every((id) => evidenceIds.has(id)));
      const hasContent = explanations.length + out.nextSteps.length + t.created.length > 0 || Boolean(out.followUpQuestion);
      finishAssistant(req.id, {
        status: hasContent ? "done" : "insufficient",
        result: {
          explanations,
          nextSteps: out.nextSteps,
          followUpQuestion: out.followUpQuestion,
          proposalIds: t.created.map((p) => p.id),
          dropped: [...t.dropped, ...(explanations.length < out.explanations.length ? ["部分解释引用了范围外的记录，已删除"] : [])],
          insufficientReason: out.insufficientReason ?? (hasContent ? null : "资料不足，没有形成可靠的分析"),
          readScope: { logIds: allLogs.map((l) => l.id), taskIds: [...taskIds], projectId },
        },
      });
      completeJob(job.id, token, job.generation, { kind: "skipped", reason: `assistant:proposals:${t.created.length}` }, nowIso());
      return "done" as const;
    }).immediate();
    return { kind: outcome };
  } finally {
    lease.stop();
  }
}

/** 某次复盘/助手产生的提案 */
export function proposalsFrom(sourceKind: "review" | "assistant", sourceId: string) {
  return listProposals({ sourceKind, sourceId });
}
