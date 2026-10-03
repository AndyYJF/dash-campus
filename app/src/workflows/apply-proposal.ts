import { getDb } from "@/repositories/db";
import { createTask, updateTask } from "@/repositories/planning";
import { proposalProblem } from "@/repositories/proposal-validity";
import { HttpError } from '@/workflows/http';
export { scheduleProblem, fixedEventClash } from '@/domain/schedule';
import {
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
    if (e instanceof ApplyError || e instanceof HttpError) {
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

  const problem = proposalProblem(proposal);
  if (problem) throw new ApplyError(problem.status, problem.code, problem.message);

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
      }, { validateSchedule: false });
      // create_task 的 reminderRevision 由服务端生成，模型不能设置（createTask 默认 0）
      return task.id;
    }
    case "reschedule_task": {
      const r = updateTask(
        op.taskId,
        { scheduledStart: op.scheduledStart, scheduledEnd: op.scheduledEnd, planningOverrideReason: op.overrideReason ?? null },
        op.expectedVersion,
        { validateSchedule: false },
      );
      if (r === "conflict") throw new ApplyError(409, "CONFLICT", `任务 ${op.taskId} 版本冲突`);
      if (r === "not_found") throw new ApplyError(409, "CONFLICT", `任务 ${op.taskId} 不存在`);
      return null;
    }
    case "set_task_status": {
      const r = updateTask(op.taskId, { status: op.status }, op.expectedVersion, { validateSchedule: false });
      if (r === "conflict") throw new ApplyError(409, "CONFLICT", `任务 ${op.taskId} 版本冲突`);
      if (r === "not_found") throw new ApplyError(409, "CONFLICT", `任务 ${op.taskId} 不存在`);
      return null;
    }
  }
}
