import { getDb } from "@/repositories/db";
import { addChange, createBatch, type ChangeInput } from "@/repositories/journal";
import { commandSchema, COMMAND_POLICY_VERSION, OPERATIONS, type Command, type CommandContext, type OperationAffect } from "@/contracts/commands";
import { getInstanceState } from "@/repositories/instance";
import { applyArchive, applyCourseSet, applyException, applyFixedEvents } from "@/workflows/ops/courses";
import { applyCompleteTask, applyPractice, applyTask } from "@/workflows/ops/tasks";
import { applyAcademicCalendar, applyCalendarSyncPolicy, applyHolidayCalendar, applyTeachingOverride } from "@/workflows/ops/calendar";
import { applyPlanningPolicy } from "@/workflows/ops/policy";

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

type Handler<N extends Command["command"]> = (cmd: Extract<Command, { command: N }>, ctx: CommandContext, changes: ChangeInput[]) => string;

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
        const summary = handler(parsed.data, ctx, changes);
        const refs = uniqueRefs(changes);
        if (!changes.length) return { ok: true, batchId: null, summary, noChange: true, affects: [], refs };
        const batchId = createBatch({
          command: parsed.data.command,
          reason: summary,
          intakeId: ctx.intakeId,
          itemId: ctx.itemId,
          policyVersion: COMMAND_POLICY_VERSION,
          instanceEpoch: ctx.instanceEpoch,
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
