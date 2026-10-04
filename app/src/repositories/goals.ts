import crypto from "node:crypto";
import { getDb } from "./db";
import { requestCancel } from "./jobs";

/**
 * Agent 目标与修订（Agent 方案 §4、§5.1；迁移 0031）：一次主人要求是一个目标，结果后的改口、回答后的续办、
 * “继续这个目标”都在同一目标上提高 revision。目标是业务流程状态（随业务导出），不是另一套聊天记录：
 * 原话与结果仍在 conversations/intakes 里，这里只存目标、修订号、状态与结构化摘要。
 */

export const GOAL_STATES = ["active", "awaiting_input", "awaiting_confirmation", "completed", "partial", "blocked", "cancelled"] as const;
export type GoalState = (typeof GOAL_STATES)[number];
export type GoalRevisionCause = "initial" | "revise" | "continue" | "cancel";

/** 目标摘要：只放服务端核对过的事实（原话、确认过的约束、最近结果、待答问题、已执行批次），不放模型自述 */
export type GoalSummary = {
  scope?: { dateFrom: string; dateTo: string } | null;
  lastDecision?: { rationale: string; intents: unknown[] } | null;
  lastResult?: string | null;
  constraints?: string[];
  openQuestionIds?: string[];
  appliedBatchIds?: string[];
};

export type GoalRow = {
  id: string;
  conversationId: string | null;
  originIntakeId: string;
  objective: string;
  revision: number;
  state: GoalState;
  summary: GoalSummary;
  repairCount: number;
  version: number;
  createdAt: string;
  updatedAt: string;
};

export type GoalRevisionRow = { goalId: string; revision: number; intakeId: string | null; cause: GoalRevisionCause; ownerText: string; createdAt: string };

function mapGoal(r: Record<string, unknown>): GoalRow {
  return {
    id: r.id as string,
    conversationId: (r.conversation_id as string | null) ?? null,
    originIntakeId: r.origin_intake_id as string,
    objective: r.objective as string,
    revision: r.revision as number,
    state: r.state as GoalState,
    summary: JSON.parse((r.summary_json as string) || "{}") as GoalSummary,
    repairCount: r.repair_count as number,
    version: r.version as number,
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
  };
}

export function getGoal(id: string): GoalRow | null {
  const r = getDb().prepare(`SELECT * FROM agent_goals WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
  return r ? mapGoal(r) : null;
}

export function listGoalRevisions(goalId: string): GoalRevisionRow[] {
  return (getDb().prepare(`SELECT * FROM agent_goal_revisions WHERE goal_id = ? ORDER BY revision`).all(goalId) as Array<Record<string, unknown>>).map((r) => ({
    goalId: r.goal_id as string,
    revision: r.revision as number,
    intakeId: (r.intake_id as string | null) ?? null,
    cause: r.cause as GoalRevisionCause,
    ownerText: r.owner_text as string,
    createdAt: r.created_at as string,
  }));
}

/** 新目标：第 1 版，投递记到这个目标上。必须在调用方事务里 */
export function createGoal(input: { conversationId: string | null; intakeId: string; objective: string; at?: Date }): GoalRow {
  const db = getDb();
  const id = crypto.randomUUID();
  const t = (input.at ?? new Date()).toISOString();
  db.prepare(`INSERT INTO agent_goals (id, conversation_id, origin_intake_id, objective, revision, state, summary_json, created_at, updated_at) VALUES (?, ?, ?, ?, 1, 'active', '{}', ?, ?)`)
    .run(id, input.conversationId, input.intakeId, input.objective.slice(0, 500), t, t);
  db.prepare(`INSERT INTO agent_goal_revisions (goal_id, revision, intake_id, cause, owner_text, created_at) VALUES (?, 1, ?, 'initial', ?, ?)`).run(id, input.intakeId, input.objective.slice(0, 2000), t);
  db.prepare(`UPDATE intakes SET goal_id = ?, goal_revision = 1 WHERE id = ?`).run(id, input.intakeId);
  return getGoal(id)!;
}

export type ReviseResult = { kind: "revised"; goal: GoalRow; superseded: { items: number; questions: number; intakes: string[] } } | { kind: "stale"; goal: GoalRow } | { kind: "not_found" };

/**
 * 同一目标的新修订：revision+1，投递记到新版本；旧版本还没执行的事项、待答问题与确认一并作废，
 * 仍在处理的旧投递请求取消（旧模型响应晚到也写不进来）。已经生效的修改不动，由结果如实列出。
 * expectedRevision 给了就核对，不一致返回 stale。必须在调用方事务里。
 */
export function reviseGoal(goalId: string, input: { intakeId: string | null; cause: GoalRevisionCause; ownerText: string; expectedRevision?: number; at?: Date }): ReviseResult {
  const db = getDb();
  const goal = getGoal(goalId);
  if (!goal) return { kind: "not_found" };
  if (input.expectedRevision !== undefined && input.expectedRevision !== goal.revision) return { kind: "stale", goal };
  const t = (input.at ?? new Date()).toISOString();
  const revision = goal.revision + 1;
  const superseded = supersedeOlderRevisions(goalId, revision, input.intakeId, t);
  db.prepare(`UPDATE agent_goals SET revision = ?, state = ?, version = version + 1, updated_at = ? WHERE id = ?`).run(revision, input.cause === "cancel" ? "cancelled" : "active", t, goalId);
  db.prepare(`INSERT INTO agent_goal_revisions (goal_id, revision, intake_id, cause, owner_text, created_at) VALUES (?, ?, ?, ?, ?, ?)`).run(goalId, revision, input.intakeId, input.cause, input.ownerText.slice(0, 2000), t);
  if (input.intakeId) db.prepare(`UPDATE intakes SET goal_id = ?, goal_revision = ? WHERE id = ?`).run(goalId, revision, input.intakeId);
  return { kind: "revised", goal: getGoal(goalId)!, superseded };
}

function supersedeOlderRevisions(goalId: string, revision: number, exceptIntakeId: string | null, t: string): { items: number; questions: number; intakes: string[] } {
  const db = getDb();
  const intakes = (db.prepare(`SELECT id FROM intakes WHERE goal_id = ? AND goal_revision < ? AND id IS NOT ?`).all(goalId, revision, exceptIntakeId) as Array<{ id: string }>).map((r) => r.id);
  let items = 0;
  let questions = 0;
  for (const id of intakes) {
    const pending = db.prepare(`SELECT id, evidence_json FROM intake_items WHERE intake_id = ? AND state IN ('extracted', 'resolving', 'awaiting_input', 'ready')`).all(id) as Array<{ id: string; evidence_json: string | null }>;
    for (const p of pending) {
      const evidence = { ...(p.evidence_json ? (JSON.parse(p.evidence_json) as Record<string, unknown>) : {}), supersededBy: revision, error: `目标已按新要求改为第 ${revision} 版，这一步没有执行` };
      db.prepare(`UPDATE intake_items SET state = 'cancelled', waiting_question_id = NULL, evidence_json = ?, version = version + 1, updated_at = ? WHERE id = ?`).run(JSON.stringify(evidence), t, p.id);
      items++;
    }
    questions += db.prepare(`UPDATE clarification_questions SET status = 'superseded', version = version + 1, updated_at = ? WHERE status = 'open' AND (intake_id = ? OR id IN (SELECT waiting_question_id FROM intake_items WHERE intake_id = ? AND waiting_question_id IS NOT NULL))`).run(t, id, id).changes;
    for (const job of db.prepare(`SELECT id, payload_json FROM jobs WHERE type = 'intake_process' AND status IN ('queued', 'running')`).all() as Array<{ id: string; payload_json: string }>) {
      if ((JSON.parse(job.payload_json) as { intakeId?: string }).intakeId === id) requestCancel(job.id);
    }
    if (pending.length) db.prepare(`UPDATE intakes SET status = CASE WHEN status IN ('completed', 'partially_applied', 'failed') THEN status ELSE 'cancelled' END, version = version + 1, updated_at = ? WHERE id = ?`).run(t, id);
  }
  return { items, questions, intakes };
}

/** 这份投递是不是所属目标的当前版本：不是就不能再写入（旧轮响应失效） */
export function intakeRevisionCurrent(intakeId: string): { current: true } | { current: false; goalRevision: number; intakeRevision: number } {
  const r = getDb().prepare(`SELECT i.goal_revision AS ir, g.revision AS gr, g.state AS gs FROM intakes i JOIN agent_goals g ON g.id = i.goal_id WHERE i.id = ?`).get(intakeId) as { ir: number; gr: number; gs: string } | undefined;
  if (!r || r.ir === r.gr) return { current: true };
  return { current: false, goalRevision: r.gr, intakeRevision: r.ir };
}

/** 当前对话里最近的目标（不含本投递所在目标、不含已取消）：结果后的改口默认指它 */
export function recentGoalInConversation(conversationId: string, exceptGoalId: string | null = null): GoalRow | null {
  const r = getDb().prepare(`SELECT * FROM agent_goals WHERE conversation_id = ? AND id IS NOT ? AND state != 'cancelled' ORDER BY updated_at DESC, rowid DESC LIMIT 1`).get(conversationId, exceptGoalId) as Record<string, unknown> | undefined;
  return r ? mapGoal(r) : null;
}

export function updateGoalState(goalId: string, state: GoalState, summary: GoalSummary, at: Date = new Date()): void {
  getDb().prepare(`UPDATE agent_goals SET state = ?, summary_json = ?, version = version + 1, updated_at = ? WHERE id = ?`).run(state, JSON.stringify(summary), at.toISOString(), goalId);
}

/** 历史目标（新→旧）；open=true 只列未完结的 */
export function listGoals(opts: { limit?: number; open?: boolean } = {}): GoalRow[] {
  const where = opts.open ? `WHERE state IN ('active', 'awaiting_input', 'awaiting_confirmation', 'partial', 'blocked')` : "";
  return (getDb().prepare(`SELECT * FROM agent_goals ${where} ORDER BY updated_at DESC, rowid DESC LIMIT ?`).all(Math.min(Math.max(opts.limit ?? 10, 1), 50)) as Array<Record<string, unknown>>).map(mapGoal);
}
