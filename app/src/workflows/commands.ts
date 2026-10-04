import { getDb } from "@/repositories/db";
import { addChange, createBatch, type ChangeInput } from "@/repositories/journal";
import { commandSchema, COMMAND_POLICY_VERSION, OPERATIONS, type Command, type CommandContext, type OperationAffect } from "@/contracts/commands";
import { getInstanceState } from "@/repositories/instance";
import { applyArchive, applyCourseSet, applyException, applyFixedEvents } from "@/workflows/ops/courses";
import { applyCompleteTask, applyCorrectPractice, applyPauseTask, applyPractice, applyTask } from "@/workflows/ops/tasks";
import { applyRescheduleSession, applySessionState } from "@/workflows/ops/sessions";
import { listCausedBatches } from "@/repositories/journal";
import { undoBatch, type UndoResult } from "@/workflows/undo";
import { HttpError } from "@/workflows/http";
import { nowDate } from "@/domain/clock";
import { applyAcademicCalendar, applyCalendarSyncPolicy, applyHolidayCalendar, applyTeachingOverride } from "@/workflows/ops/calendar";
import { applyPlanningPolicy } from "@/workflows/ops/policy";
import { applyDigestPolicy, applyReminderPolicy } from "@/workflows/ops/reminders";
import { applyNotice, applyNoticeRule, applyProfileFacts, applyResolveNotice } from "@/workflows/ops/notices";
import { reevaluateAllCurrent } from "@/workflows/inbox";
import { createExport } from "@/workflows/exports";
import { refreshAllReminders } from "@/workflows/reminders";
import { getBatch } from "@/repositories/journal";
import { rebuildPlan, type PlanConflict } from "@/workflows/plan";
import type { Unscheduled } from "@/domain/scheduler";

/**
 * 操作执行器（MASTER-PLAN §4.2/§5.3，AGENT-INTERFACE-CONTRACT §3/§4）：
 * 注册表里的操作才可执行 → schema 校验 → 授权/epoch 准入 → 单个 IMMEDIATE 事务内完成领域写入 + journal。
 * 聊天、卡片按钮、兼容 API 都走这里；模型/管线只给操作参数，不能直接写领域表。
 * 未注册操作显式拒绝，不兜底成别的操作；没有实际变化不写 journal。
 */

export type EntityRef = { kind: string; id: string };

export type CommandResult =
  | { ok: true; batchId: string; summary: string; noChange: false; affects: OperationAffect[]; refs: EntityRef[] }
  | { ok: true; batchId: null; summary: string; noChange: true; affects: OperationAffect[]; refs: EntityRef[] }
  | { ok: false; error: string; code: string };

/** handler 返回给人看的摘要；自己管理变更记录的操作（如撤销）返回 effect，执行器不再另写批次 */
type HandlerOutput = string | { summary: string; effectBatchId: string };
type Handler<N extends Command["command"]> = (cmd: Extract<Command, { command: N }>, ctx: CommandContext, changes: ChangeInput[]) => HandlerOutput;

/**
 * 撤销一个批次：先撤它引起的重排（否则会留下无解释的新安排），再撤它本身。
 * 之后有新修改的对象不覆盖，整体不动并说明冲突。
 */
export function undoWithFollowUps(batchId: string): UndoResult {
  class Abort extends Error {
    constructor(readonly result: UndoResult) {
      super("undo aborted");
    }
  }
  try {
    return getDb().transaction((): UndoResult => {
      // 重排批次动过的块如果后来又被改，就留着它，交给撤销后的重排去对账
      for (const child of listCausedBatches(batchId)) undoBatch(child);
      const r = undoBatch(batchId);
      if (r.kind !== "undone") throw new Abort(r); // 主批次撤不了：连带撤掉的重排一起回滚，整体不动
      // 提醒策略撤回后，既有提醒任务也要回到撤回后的策略（已发出的邮件收不回）
      const command = getBatch(batchId)?.command;
      if (command === "update_reminder_policy") refreshAllReminders(new Date().toISOString());
      // 身份/筛选规则撤回后，通知按撤回后的事实重新判断（已建任务不动）
      if (command === "update_profile_fact" || command === "upsert_notice_rule") reevaluateAllCurrent();
      return r;
    })();
  } catch (e) {
    if (e instanceof Abort) return e.result;
    throw e;
  }
}

/** 导出文件是外部产物，不走 journal；结果里给下载入口和有效期 */
function applyRequestExport(cmd: Extract<Command, { command: "request_export" }>): HandlerOutput {
  const r = createExport({ type: cmd.type });
  if (!r.ok) throw new HttpError(r.status, r.code, r.message);
  if (r.export.status !== "ready") throw new HttpError(500, "EXPORT_FAILED", `导出没有生成成功：${r.export.error ?? "写文件失败"}`);
  return { summary: `已生成数据导出（${Math.max(1, Math.round((r.export.byteSize ?? 0) / 1024))} KB），24 小时内可下载：/api/v1/exports/${r.export.id}/download。不含密码、会话和后台队列。`, effectBatchId: "" };
}

function applyUndoBatch(cmd: Extract<Command, { command: "undo_batch" }>): HandlerOutput {
  const r = undoWithFollowUps(cmd.batchId);
  if (r.kind === "not_found") throw new HttpError(404, "NOT_FOUND", "要撤销的变更不存在");
  if (r.kind === "already_undone") return "这次变更已经撤销过了";
  if (r.kind === "conflict") throw new HttpError(409, "UNDO_CONFLICT", `撤销不了：${r.conflicts.join("；")}`);
  return { summary: "已撤销", effectBatchId: cmd.batchId };
}

/** 每个注册操作必须有 handler：少一个编译不过，schema、类型、执行三者不会漂移 */
const HANDLERS: { [N in Command["command"]]: Handler<N> } = {
  upsert_course_set: applyCourseSet,
  record_practice: applyPractice,
  create_or_update_task: applyTask,
  import_fixed_events: applyFixedEvents,
  apply_event_exception: applyException,
  archive_entity: applyArchive,
  complete_task: applyCompleteTask,
  sync_holiday_calendar: applyHolidayCalendar,
  upsert_academic_calendar: applyAcademicCalendar,
  apply_teaching_day_override: applyTeachingOverride,
  update_calendar_sync_policy: applyCalendarSyncPolicy,
  update_planning_policy: applyPlanningPolicy,
  pause_task: applyPauseTask,
  correct_practice: applyCorrectPractice,
  reschedule_session: applyRescheduleSession,
  set_session_state: applySessionState,
  undo_batch: applyUndoBatch,
  update_reminder_policy: applyReminderPolicy,
  update_digest_policy: applyDigestPolicy,
  update_profile_fact: applyProfileFacts,
  upsert_notice_rule: applyNoticeRule,
  apply_notice: applyNotice,
  resolve_notice: applyResolveNotice,
  request_export: applyRequestExport,
};

export function isRegisteredOperation(name: unknown): name is Command["command"] {
  return typeof name === "string" && Object.prototype.hasOwnProperty.call(OPERATIONS, name);
}

export function executeCommand(raw: unknown, ctx: CommandContext): CommandResult {
  const name = (raw as { command?: unknown } | null)?.command;
  if (!isRegisteredOperation(name)) {
    return { ok: false, code: "UNKNOWN_OPERATION", error: `未注册的操作「${String(name)}」，已拒绝执行` };
  }
  const meta = OPERATIONS[name];
  const parsed = commandSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, code: "VALIDATION", error: `命令不合法：${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`.trim()).join("; ")}` };
  }
  // 资料里的文字不是授权：需要主人明确指令的操作，只有主人本人的输入/按钮可以触发
  if (meta.authorization === "owner_explicit" && ctx.explicit === false) {
    return { ok: false, code: "NOT_AUTHORIZED", error: `「${meta.title}」需要你本人明确提出，资料里的文字不能触发` };
  }
  // 旧部署周期的请求不得写入新周期（§9.1）
  if (ctx.instanceEpoch !== 0 && ctx.instanceEpoch !== getInstanceState().deploymentEpoch) {
    return { ok: false, code: "STALE_EPOCH", error: "这条请求来自恢复/重建之前，已不再执行" };
  }
  try {
    return getDb()
      .transaction((): CommandResult => {
        const changes: ChangeInput[] = [];
        const handler = HANDLERS[parsed.data.command] as Handler<Command["command"]>;
        const output = handler(parsed.data, ctx, changes);
        const summary = typeof output === "string" ? output : output.summary;
        const refs = uniqueRefs(changes);
        if (typeof output !== "string") return { ok: true, batchId: output.effectBatchId || null, summary, noChange: false, affects: meta.affects, refs } as CommandResult;
        if (!changes.length) return { ok: true, batchId: null, summary, noChange: true, affects: [], refs };
        const batchId = createBatch({
          command: parsed.data.command,
          reason: summary,
          intakeId: ctx.intakeId,
          itemId: ctx.itemId,
          policyVersion: COMMAND_POLICY_VERSION,
          instanceEpoch: ctx.instanceEpoch,
          conversationId: ctx.conversationId ?? null,
        });
        for (const c of changes) addChange(batchId, c);
        return { ok: true, batchId, summary, noChange: false, affects: meta.affects, refs };
      })
      .immediate();
  } catch (e) {
    const code = (e as { code?: unknown }).code;
    return { ok: false, code: typeof code === "string" ? code : "FAILED", error: e instanceof Error ? e.message : String(e) };
  }
}

function uniqueRefs(changes: ChangeInput[]): EntityRef[] {
  const seen = new Set<string>();
  const out: EntityRef[] = [];
  for (const c of changes) {
    const key = `${c.entityKind}:${c.entityId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ kind: c.entityKind, id: c.entityId });
  }
  return out;
}

export type FollowUp = { kind: "plan"; state: "updated" | "unchanged" | "failed"; batchId: string | null; placed: number; superseded: number; unscheduled: Unscheduled[]; conflicts: PlanConflict[]; error?: string };
export type OperationOutcome = { result: CommandResult; followUps: FollowUp[] };

/**
 * 执行操作并完成必要的后续（AGENT-INTERFACE-CONTRACT §3）：领域事务提交后再做重排等派生更新，
 * 各自状态分开报告——“已保存”和“安排已更新”不合并成一个完成。
 */
export function executeOperation(raw: unknown, ctx: CommandContext, opts: { replanDates?: string[] } = {}): OperationOutcome {
  const result = executeCommand(raw, ctx);
  const followUps: FollowUp[] = [];
  if (result.ok && !result.noChange && result.affects.includes("plan")) {
    try {
      const plan = rebuildPlan(ctx.now ?? nowDate(), { causedBy: result.batchId, conversationId: ctx.conversationId ?? null, intakeId: ctx.intakeId, replanDates: opts.replanDates });
      followUps.push({ kind: "plan", state: plan.changed ? "updated" : "unchanged", batchId: plan.batchId, placed: plan.placed, superseded: plan.superseded, unscheduled: plan.unscheduled, conflicts: plan.conflicts });
    } catch (e) {
      followUps.push({ kind: "plan", state: "failed", batchId: null, placed: 0, superseded: 0, unscheduled: [], conflicts: [], error: e instanceof Error ? e.message : String(e) });
    }
  }
  return { result, followUps };
}
