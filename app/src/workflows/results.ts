import { getDb } from "@/repositories/db";
import { OPERATIONS, type Command } from "@/contracts/commands";
import { getBatch, listChanges } from "@/repositories/journal";
import type { FollowUp, OperationOutcome } from "@/workflows/commands";
import { snapshotRevision } from "@/workflows/snapshot";
import { instanceTimezone, localDateInTz } from "@/domain/time";

/**
 * 统一业务结果（AGENT-INTERFACE-CONTRACT §5.3）：聊天、卡片按钮、兼容 API 的结果同一形状。
 * 实际变更、后续状态（安排是否已更新）、撤销入口分开给出；主界面不暴露 job/epoch/JSON 等实现词。
 */

export type ChangeView = { entity: { kind: string; id: string }; label: string; action: "create" | "update" | "delete"; detail: string };

export type OperationResultView = {
  operation: string;
  title: string;
  state: "applied" | "no_change" | "failed";
  summary: string;
  changes: ChangeView[];
  affectedDates: string[];
  followUps: Array<{ kind: string; state: string; summary: string }>;
  undo: { available: boolean; batchId: string | null; note: string };
  snapshotRevision: string;
  error: { code: string; message: string; recoverable: boolean } | null;
};

const KIND_LABEL: Record<string, string> = {
  task: "任务",
  plan_session: "学习安排",
  practice_entry: "实践记录",
  course_set: "课表",
  course: "课程",
  fixed_event: "固定活动",
  course_exception: "停课例外",
  teaching_override: "调课/停课",
  holiday_dataset: "节假日安排",
  academic_calendar: "校历",
  policy_rule: "时间规则",
  planning_preferences: "作息",
  goal: "目标",
  project: "项目",
  semester: "学期",
  setting: "设置",
  profile_fact: "身份信息",
  profile_rule: "筛选规则",
};

const RECOVERABLE = new Set(["STALE_VERSION", "NO_SLOT", "OVER_BUDGET", "DEADLINE_CONFLICT", "SLOT_CONFLICT", "AMBIGUOUS_REFERENCE", "ANCHOR_CONFLICT", "MAPPING_CONFLICT", "UNDO_CONFLICT", "CONFLICT"]);

/** 失败码 → HTTP 状态（兼容适配层用） */
export function statusForCode(code: string): number {
  if (code === "NOT_FOUND") return 404;
  if (code === "NOT_AUTHORIZED" || code === "STALE_EPOCH") return 403;
  if (code === "VALIDATION" || code === "UNKNOWN_OPERATION" || code === "INVALID_REFERENCE" || code === "IN_THE_PAST" || code === "NO_OFFICIAL_SOURCE") return 422;
  return 409;
}

function entityLabel(kind: string, id: string): string {
  const db = getDb();
  if (kind === "task") return (db.prepare(`SELECT title FROM tasks WHERE id = ?`).get(id) as { title: string } | undefined)?.title ?? "任务";
  if (kind === "plan_session") {
    const r = db.prepare(`SELECT t.title FROM plan_sessions s JOIN tasks t ON t.id = s.task_id WHERE s.id = ?`).get(id) as { title: string } | undefined;
    return r ? `${r.title} 的学习安排` : "学习安排";
  }
  if (kind === "course") return (db.prepare(`SELECT name FROM courses WHERE id = ?`).get(id) as { name: string } | undefined)?.name ?? "课程";
  if (kind === "goal") return (db.prepare(`SELECT title FROM goals WHERE id = ?`).get(id) as { title: string } | undefined)?.title ?? "目标";
  if (kind === "project") return (db.prepare(`SELECT title FROM projects WHERE id = ?`).get(id) as { title: string } | undefined)?.title ?? "项目";
  return KIND_LABEL[kind] ?? kind;
}

/** 一个批次的变更列表（同类大量变更合并成一行，如课表的几十条规则） */
export function batchChanges(batchId: string): { changes: ChangeView[]; dates: string[] } {
  const tz = instanceTimezone();
  const rows = listChanges(batchId);
  const dates = new Set<string>();
  const counts = new Map<string, number>();
  const views: ChangeView[] = [];
  for (const c of rows) {
    for (const v of [c.before, c.after]) {
      for (const key of ["startUtc", "start"]) {
        const raw = v?.[key];
        if (typeof raw === "string" || typeof raw === "number") dates.add(localDateInTz(new Date(raw), tz));
      }
      for (const key of ["sourceTeachingDate", "targetDate", "occurredOn", "dateFrom", "dateTo", "eventDate"]) {
        if (typeof v?.[key] === "string") dates.add(v[key] as string);
      }
    }
    const bulky = ["course", "course_meeting", "projection", "fixed_event", "holiday_day", "academic_calendar_event"].includes(c.entityKind);
    if (bulky) {
      const key = `${c.entityKind}:${c.action}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
      continue;
    }
    const verb = c.action === "create" ? "新增" : c.action === "delete" ? "移除" : "修改";
    views.push({ entity: { kind: c.entityKind, id: c.entityId }, label: entityLabel(c.entityKind, c.entityId), action: c.action, detail: `${verb}${KIND_LABEL[c.entityKind] ?? ""}` });
  }
  const bulkLabel: Record<string, string> = { course: "门课程", course_meeting: "个上课时段", projection: "条课程规则", fixed_event: "条日程规则", holiday_day: "个日期", academic_calendar_event: "个校历事项" };
  for (const [key, n] of counts) {
    const [kind, action] = key.split(":") as [string, ChangeView["action"]];
    if (kind === "projection" || kind === "course_meeting") continue; // 实现细节，不单独展示
    views.push({ entity: { kind, id: "" }, label: `${n} ${bulkLabel[kind] ?? kind}`, action, detail: action === "create" ? "新增" : action === "delete" ? "移除" : "修改" });
  }
  return { changes: views.slice(0, 20), dates: [...dates].sort() };
}

export function followUpView(f: FollowUp): { kind: string; state: string; summary: string } {
  if (f.state === "failed") return { kind: f.kind, state: "failed", summary: `学习安排没有更新成功：${f.error ?? ""}` };
  const parts: string[] = [];
  if (f.placed) parts.push(`新排 ${f.placed} 段`);
  if (f.superseded) parts.push(`替换 ${f.superseded} 段`);
  if (f.unscheduled.length) parts.push(`${f.unscheduled.length} 项排不下`);
  if (f.conflicts.length) parts.push(`${f.conflicts.length} 段近期安排有冲突，等你决定`);
  return { kind: f.kind, state: f.state, summary: parts.length ? `学习安排已更新：${parts.join("，")}` : "学习安排不需要变化" };
}

export function undoView(batchId: string | null, operation: string): OperationResultView["undo"] {
  if (!batchId) return { available: false, batchId: null, note: "" };
  const meta = OPERATIONS[operation as Command["command"]];
  const batch = getBatch(batchId);
  if (!batch || batch.status === "undone") return { available: false, batchId, note: batch ? "已撤销" : "" };
  if (meta && meta.undo === "none") return { available: false, batchId, note: "这个操作不能撤销" };
  return { available: true, batchId, note: "" };
}

export function operationResultView(operation: string, outcome: OperationOutcome): OperationResultView {
  const title = OPERATIONS[operation as Command["command"]]?.title ?? operation;
  const r = outcome.result;
  if (!r.ok) {
    return { operation, title, state: "failed", summary: r.error, changes: [], affectedDates: [], followUps: [], undo: { available: false, batchId: null, note: "" }, snapshotRevision: snapshotRevision(), error: { code: r.code, message: r.error, recoverable: RECOVERABLE.has(r.code) } };
  }
  const detail = r.batchId && operation !== "undo_batch" ? batchChanges(r.batchId) : { changes: [], dates: [] };
  return {
    operation,
    title,
    state: r.noChange ? "no_change" : "applied",
    summary: r.summary,
    changes: detail.changes,
    affectedDates: detail.dates,
    followUps: outcome.followUps.map(followUpView),
    undo: operation === "undo_batch" ? { available: false, batchId: r.batchId, note: "" } : undoView(r.batchId, operation),
    snapshotRevision: snapshotRevision(),
    error: null,
  };
}
