import { getDb } from "@/repositories/db";
import { createTask, getTask, updateTask } from "@/repositories/planning";
import { listFixedEvents } from "@/domain/workload";
import { localDateInTz, wallTimeToUtc } from "@/domain/time";
import {
  getPlanningRevision,
  getProposal,
  type ProposalOperationInput,
  type ProposalRow,
} from "@/repositories/proposals";

/**
 * 原子应用提案（计划 v1.2 第 6 节 apply 流程）：
 * BEGIN IMMEDIATE → 校验 pending / 读集版本 / planningRevision → 写全部操作 → 标记 applied → COMMIT。
 * 中间失败全部回滚；模型调用不在这个事务里（T2 尚无模型调用）。
 * 已 applied 的提案重复 apply 返回既有结果（幂等）。
 */

export type ApplyResult =
  | { ok: true; proposal: ProposalRow }
  | { ok: false; status: number; code: string; message: string };

class ApplyError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

export function applyProposal(proposalId: string): ApplyResult {
  const db = getDb();
  try {
    const tx = db.transaction(() => applyInner(proposalId));
    tx.immediate();
    return { ok: true, proposal: getProposal(proposalId)! };
  } catch (e) {
    if (e instanceof ApplyError) {
      return { ok: false, status: e.status, code: e.code, message: e.message };
    }
    throw e;
  }
}

function applyInner(proposalId: string): void {
  const db = getDb();
  const proposal = getProposal(proposalId);
  if (!proposal) {
    throw new ApplyError(404, "NOT_FOUND", "提案不存在");
  }
  if (proposal.status === "applied") return; // 幂等重放：返回既有结果
  if (proposal.status !== "pending") {
    throw new ApplyError(409, "INVALID_STATE", `提案状态为 ${proposal.status}，不能应用`);
  }

  // 排程敏感操作校验 planningRevision（F10）
  const scheduleSensitive = proposal.operations.some((op) => op.kind === "reschedule_task");
  if (scheduleSensitive && getPlanningRevision() !== proposal.planningRevision) {
    throw new ApplyError(409, "STALE_PLANNING", "计划已变化，该排程提案已过时");
  }

  // 校验读集：inputVersions 快照 + 操作自身的 expectedVersion（F9）
  for (const [ref, version] of Object.entries(proposal.inputVersions)) {
    const [kind, id] = ref.split(":");
    if (kind !== "task") continue;
    const task = getTask(id);
    if (!task || task.archivedAt || task.version !== version) {
      throw new ApplyError(409, "CONFLICT", `任务 ${id} 已变化，提案已过时`);
    }
  }
  for (const op of proposal.operations) {
    if (op.kind === "reschedule_task" || op.kind === "set_task_status") {
      const task = getTask(op.taskId);
      if (!task || task.archivedAt) {
        throw new ApplyError(409, "CONFLICT", `任务 ${op.taskId} 不存在或已归档`);
      }
      if (task.version !== op.expectedVersion) {
        throw new ApplyError(409, "CONFLICT", `任务 ${op.taskId} 版本已变化`);
      }
    }
    // 校验任务字段与固定事件冲突（第 6 节）
    const times =
      op.kind === "reschedule_task"
        ? { start: op.scheduledStart, end: op.scheduledEnd }
        : op.kind === "create_task"
          ? { start: op.input.scheduledStart, end: op.input.scheduledEnd }
          : null;
    if (times) {
      const problem = scheduleProblem(times.start, times.end);
      if (problem) throw new ApplyError(422, "VALIDATION", problem);
      const clash = fixedEventClash(times.start, times.end);
      if (clash) throw new ApplyError(409, "FIXED_EVENT_CONFLICT", `与固定安排「${clash}」时间冲突`);
    }
  }

  const createdTaskIds: string[] = [];
  proposal.operations.forEach((op, i) => {
    const resultId = executeOperation(op);
    if (resultId) {
      createdTaskIds.push(resultId);
      db.prepare(`UPDATE proposal_operations SET result_task_id = ? WHERE proposal_id = ? AND seq = ?`).run(
        resultId,
        proposalId,
        i,
      );
    }
  });

  db.prepare(
    `UPDATE proposals SET status = 'applied', result_refs_json = ?, decided_at = ?, updated_at = ?, version = version + 1
     WHERE id = ?`,
  ).run(JSON.stringify({ taskIds: createdTaskIds }), new Date().toISOString(), new Date().toISOString(), proposalId);
}

/** 时段字段校验：只有结束没有开始、或结束不晚于开始 → 返回问题描述 */
export function scheduleProblem(start: string | null, end: string | null): string | null {
  if (end && !start) return "只有结束时间没有开始时间";
  if (start && end && new Date(end).getTime() <= new Date(start).getTime()) return "结束时间必须晚于开始时间";
  return null;
}

/** 与固定事件的重叠（按事件时区的当地日期和时刻比较）；返回冲突事件标题 */
export function fixedEventClash(start: string | null, end: string | null): string | null {
  if (!start) return null;
  const s = new Date(start);
  // 没有结束时间时按一个时刻判断
  const e = end ? new Date(end) : new Date(s.getTime() + 60_000);
  for (const ev of listFixedEvents()) {
    const date = localDateInTz(s, ev.timezone);
    if (date !== localDateInTz(new Date(e.getTime() - 1), ev.timezone)) continue; // 跨日时段 V1 不做细判
    const dow = ((new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7) + 1;
    if (ev.weekday !== dow) continue;
    if (ev.eventDate && ev.eventDate !== date) continue;
    if ((ev.validFrom && date < ev.validFrom) || (ev.validUntil && date > ev.validUntil)) continue;
    const evStart = wallTimeToUtc(date, ev.localStart, ev.timezone).getTime();
    const evEnd = wallTimeToUtc(date, ev.localEnd, ev.timezone).getTime();
    if (s.getTime() < evEnd && e.getTime() > evStart) return ev.title;
  }
  return null;
}

function executeOperation(op: ProposalOperationInput): string | null {
  switch (op.kind) {
    case "create_task": {
      const input = op.input;
      const task = createTask({
        title: input.title,
        description: input.description,
        projectId: input.projectId,
        goalId: input.goalId,
        status: input.status,
        priority: input.priority,
        estimateMinutes: input.estimateMinutes,
        plannedWeek: input.plannedWeek,
        scheduledStart: input.scheduledStart,
        scheduledEnd: input.scheduledEnd,
        due: input.due,
      });
      // create_task 的 reminderRevision 由服务端生成，模型不能设置（createTask 默认 0）
      return task.id;
    }
    case "reschedule_task": {
      const r = updateTask(
        op.taskId,
        { scheduledStart: op.scheduledStart, scheduledEnd: op.scheduledEnd },
        op.expectedVersion,
      );
      if (r === "conflict") throw new ApplyError(409, "CONFLICT", `任务 ${op.taskId} 版本冲突`);
      if (r === "not_found") throw new ApplyError(409, "CONFLICT", `任务 ${op.taskId} 不存在`);
      return null;
    }
    case "set_task_status": {
      const r = updateTask(op.taskId, { status: op.status }, op.expectedVersion);
      if (r === "conflict") throw new ApplyError(409, "CONFLICT", `任务 ${op.taskId} 版本冲突`);
      if (r === "not_found") throw new ApplyError(409, "CONFLICT", `任务 ${op.taskId} 不存在`);
      return null;
    }
  }
}
