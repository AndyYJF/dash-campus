import crypto from "node:crypto";
import { getDb } from "@/repositories/db";
import { refreshReminders } from "@/workflows/reminders";
import { instanceTimezone, localDateInTz, mondayOf } from "@/domain/time";
import { scheduleIssues } from '@/domain/schedule';
import { HttpError } from '@/workflows/http';
import { markPlanStale } from "@/repositories/proposals";
import type {
  Due,
  GoalInput,
  ProjectInput,
  TaskInput,
} from "@/contracts/planning";

/**
 * 目标 / 项目 / 任务 repository。
 * 所有可变对象整数 version 从 1 递增；PATCH 用 expectedVersion 乐观锁，不匹配返回 0 行 → 409。
 * 删除一律 archived_at 软删除。
 */

export type GoalRow = {
  id: string;
  title: string;
  reason: string;
  horizon: "long_term" | "semester";
  status: "active" | "paused" | "completed";
  version: number;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
};

export type ProjectRow = {
  id: string;
  title: string;
  question: string;
  expectedOutcome: string;
  prerequisites: string;
  reviewQuestions: string;
  status: "active" | "paused" | "completed";
  goalIds: string[];
  version: number;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
};

export type TaskRow = {
  taskKind?: import("@/domain/task-admission").TaskKind;
  id: string;
  title: string;
  description: string;
  projectId: string | null;
  goalId: string | null;
  status: "todo" | "doing" | "blocked" | "done" | "cancelled";
  priority: "normal" | "high";
  estimateMinutes: number | null;
  plannedWeek: { localMonday: string; timezone: string } | null;
  scheduledStart: string | null;
  scheduledEnd: string | null;
  due: Due;
  planningOverrideReason?: string | null;
  reminderLeadMinutes?: number | null;
  version: number;
  reminderRevision: number;
  /** 人工编辑时确认过的来源修订（计划 5.1）；非收件箱任务为 null */
  sourceRevisionId: string | null;
  /** 进入 done 的时刻；离开 done 清空 */
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
};

function now(): string {
  return new Date().toISOString();
}

// ===== goals =====

export function listGoals(includeArchived = false): GoalRow[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT * FROM goals ${includeArchived ? "" : "WHERE archived_at IS NULL"} ORDER BY created_at DESC`,
    )
    .all() as Array<Record<string, unknown>>;
  return rows.map(mapGoal);
}

export function getGoal(id: string): GoalRow | null {
  const db = getDb();
  const row = db.prepare(`SELECT * FROM goals WHERE id = ?`).get(id) as
    | Record<string, unknown>
    | undefined;
  return row ? mapGoal(row) : null;
}

export function createGoal(input: GoalInput): GoalRow {
  const db = getDb();
  const id = crypto.randomUUID();
  const t = now();
  db.prepare(
    `INSERT INTO goals (id, title, reason, horizon, status, version, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'active', 1, ?, ?)`,
  ).run(id, input.title, input.reason, input.horizon, t, t);
  return getGoal(id)!;
}

export function updateGoal(
  id: string,
  patch: Partial<GoalInput> & { status?: GoalRow["status"] },
  expectedVersion: number,
): GoalRow | "conflict" | "not_found" {
  const db = getDb();
  const current = getGoal(id);
  if (!current || current.archivedAt) return "not_found";
  const sets: string[] = [];
  const vals: Array<string | number> = [];
  for (const col of ["title", "reason", "horizon", "status"] as const) {
    const v = patch[col];
    if (v !== undefined) {
      sets.push(`${col} = ?`);
      vals.push(v as string);
    }
  }
  // 空 patch 只校验版本，不递增
  if (sets.length === 0) return current.version === expectedVersion ? current : "conflict";
  sets.push("version = version + 1", "updated_at = ?");
  vals.push(now(), id, expectedVersion);
  const r = db
    .prepare(`UPDATE goals SET ${sets.join(", ")} WHERE id = ? AND version = ?`)
    .run(...vals);
  if (r.changes === 0) return "conflict";
  return getGoal(id)!;
}

export function archiveGoal(id: string, expectedVersion: number): GoalRow | "conflict" | "not_found" {
  const db = getDb();
  const r = db
    .prepare(
      `UPDATE goals SET archived_at = ?, version = version + 1, updated_at = ?
       WHERE id = ? AND version = ? AND archived_at IS NULL`,
    )
    .run(now(), now(), id, expectedVersion);
  if (r.changes === 0) {
    return getGoal(id) ? "conflict" : "not_found";
  }
  return getGoal(id)!;
}

function mapGoal(r: Record<string, unknown>): GoalRow {
  return {
    id: r.id as string,
    title: r.title as string,
    reason: r.reason as string,
    horizon: r.horizon as GoalRow["horizon"],
    status: r.status as GoalRow["status"],
    version: r.version as number,
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
    archivedAt: (r.archived_at as string | null) ?? null,
  };
}

// ===== projects =====

export function listProjects(includeArchived = false): ProjectRow[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT * FROM projects ${includeArchived ? "" : "WHERE archived_at IS NULL"} ORDER BY created_at DESC`,
    )
    .all() as Array<Record<string, unknown>>;
  return rows.map(mapProject);
}

export function getProject(id: string): ProjectRow | null {
  const db = getDb();
  const row = db.prepare(`SELECT * FROM projects WHERE id = ?`).get(id) as
    | Record<string, unknown>
    | undefined;
  return row ? mapProject(row) : null;
}

function goalIdsOf(projectId: string): string[] {
  const db = getDb();
  return (
    db.prepare(`SELECT goal_id FROM project_goals WHERE project_id = ?`).all(projectId) as Array<{
      goal_id: string;
    }>
  ).map((r) => r.goal_id);
}

export function createProject(input: ProjectInput): ProjectRow {
  const db = getDb();
  const id = crypto.randomUUID();
  const t = now();
  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO projects (id, title, question, expected_outcome, prerequisites, review_questions, status, version, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'active', 1, ?, ?)`,
    ).run(
      id,
      input.title,
      input.question,
      input.expectedOutcome,
      input.prerequisites,
      input.reviewQuestions,
      t,
      t,
    );
    for (const goalId of input.goalIds) {
      db.prepare(`INSERT INTO project_goals (project_id, goal_id) VALUES (?, ?)`).run(id, goalId);
    }
  });
  tx();
  return getProject(id)!;
}

export function updateProject(
  id: string,
  patch: Partial<ProjectInput> & { status?: ProjectRow["status"] },
  expectedVersion: number,
): ProjectRow | "conflict" | "not_found" {
  const db = getDb();
  const current = getProject(id);
  if (!current || current.archivedAt) return "not_found";
  const cols = {
    title: patch.title,
    question: patch.question,
    expected_outcome: patch.expectedOutcome,
    prerequisites: patch.prerequisites,
    review_questions: patch.reviewQuestions,
    status: patch.status,
  } as Record<string, string | undefined>;
  const sets: string[] = [];
  const vals: Array<string | number> = [];
  for (const [col, v] of Object.entries(cols)) {
    if (v !== undefined) {
      sets.push(`${col} = ?`);
      vals.push(v);
    }
  }
  const tx = db.transaction(() => {
    if (sets.length > 0) {
      sets.push("version = version + 1", "updated_at = ?");
      vals.push(now(), id, expectedVersion);
      const r = db
        .prepare(`UPDATE projects SET ${sets.join(", ")} WHERE id = ? AND version = ?`)
        .run(...vals);
      if (r.changes === 0) return "conflict" as const;
    } else if (patch.goalIds === undefined) {
      // 空 patch 只校验版本
      return current.version === expectedVersion ? current : ("conflict" as const);
    }
    if (patch.goalIds !== undefined) {
      // goalIds 变更也走版本检查
      const r = db
        .prepare(
          `UPDATE projects SET version = version + 1, updated_at = ? WHERE id = ? AND version = ?`,
        )
        .run(now(), id, sets.length > 0 ? expectedVersion + 1 : expectedVersion);
      if (r.changes === 0) return "conflict" as const;
      db.prepare(`DELETE FROM project_goals WHERE project_id = ?`).run(id);
      for (const goalId of patch.goalIds) {
        db.prepare(`INSERT INTO project_goals (project_id, goal_id) VALUES (?, ?)`).run(id, goalId);
      }
    }
    return getProject(id)!;
  });
  return tx();
}

export function archiveProject(
  id: string,
  expectedVersion: number,
): ProjectRow | "conflict" | "not_found" {
  const db = getDb();
  const r = db
    .prepare(
      `UPDATE projects SET archived_at = ?, version = version + 1, updated_at = ?
       WHERE id = ? AND version = ? AND archived_at IS NULL`,
    )
    .run(now(), now(), id, expectedVersion);
  if (r.changes === 0) {
    return getProject(id) ? "conflict" : "not_found";
  }
  return getProject(id)!;
}

function mapProject(r: Record<string, unknown>): ProjectRow {
  const id = r.id as string;
  return {
    id,
    title: r.title as string,
    question: r.question as string,
    expectedOutcome: r.expected_outcome as string,
    prerequisites: r.prerequisites as string,
    reviewQuestions: r.review_questions as string,
    status: r.status as ProjectRow["status"],
    goalIds: goalIdsOf(id),
    version: r.version as number,
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
    archivedAt: (r.archived_at as string | null) ?? null,
  };
}

// ===== tasks =====

export function listTasks(filter: { projectId?: string; includeArchived?: boolean } = {}): TaskRow[] {
  const db = getDb();
  const where: string[] = [];
  const vals: string[] = [];
  if (!filter.includeArchived) where.push("archived_at IS NULL");
  if (filter.projectId) {
    where.push("project_id = ?");
    vals.push(filter.projectId);
  }
  const rows = db
    .prepare(
      `SELECT * FROM tasks ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC`,
    )
    .all(...vals) as Array<Record<string, unknown>>;
  return rows.map(mapTask);
}

export function getTask(id: string): TaskRow | null {
  const db = getDb();
  const row = db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(id) as
    | Record<string, unknown>
    | undefined;
  return row ? mapTask(row) : null;
}

export function createTask(input: TaskInput, options: { validateSchedule?: boolean; scheduleReminders?: boolean } = {}): TaskRow {
  const db = getDb();
  const id = crypto.randomUUID();
  const t = now();
  const due = input.due;
  const tx = db.transaction(() => {
    if (options.validateSchedule !== false) checkTaskSchedule(input);
    db.prepare(
      `INSERT INTO tasks (id, title, description, project_id, goal_id, status, priority,
         estimate_minutes, planned_week_monday, planned_week_timezone,
         scheduled_start, scheduled_end,
         due_kind, due_local_date, due_timezone, due_at,
         version, reminder_revision, completed_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, ?, ?, ?)`,
    ).run(
      id,
      input.title,
      input.description,
      input.projectId,
      input.goalId,
      input.status,
      input.priority,
      input.estimateMinutes,
      input.plannedWeek?.localMonday ?? null,
      input.plannedWeek?.timezone ?? null,
      input.scheduledStart,
      input.scheduledEnd,
      due.kind,
      due.kind === "date" ? due.localDate : null,
      due.kind === "none" ? null : due.timezone,
      due.kind === "instant" ? due.at : null,
      input.status === "done" ? t : null,
      t,
      t,
    );
    db.prepare('UPDATE tasks SET planning_override_reason=?, reminder_lead_minutes=?, task_kind=? WHERE id=?').run(input.planningOverrideReason ?? null, input.reminderLeadMinutes ?? null, input.taskKind ?? 'auto', id);
    if (input.scheduledStart || input.plannedWeek) db.prepare('UPDATE planning_state SET planning_revision=planning_revision+1 WHERE id=1').run();
    // 同一事务内建提醒：只建触发点在未来的 job；due=none 不建
    if (options.scheduleReminders !== false) refreshReminders(getTask(id)!, t);
    markPlanStale();
    return getTask(id)!;
  });
  return tx();
}

export function updateTask(
  id: string,
  patch: Partial<TaskInput>,
  expectedVersion: number,
  options: { validateSchedule?: boolean } = {},
): TaskRow | "conflict" | "not_found" {
  const db = getDb();
  const current = getTask(id);
  if (!current || current.archivedAt) return "not_found";
  if (current.version !== expectedVersion) return 'conflict';

  const sets: string[] = [];
  const vals: Array<string | number | null> = [];
  const add = (col: string, v: string | number | null) => {
    sets.push(`${col} = ?`);
    vals.push(v);
  };
  if (patch.taskKind !== undefined) add("task_kind", patch.taskKind);
  if (patch.title !== undefined) add("title", patch.title);
  if (patch.description !== undefined) add("description", patch.description);
  if (patch.projectId !== undefined) add("project_id", patch.projectId);
  if (patch.goalId !== undefined) add("goal_id", patch.goalId);
  if (patch.status !== undefined) add("status", patch.status);
  if (patch.priority !== undefined) add("priority", patch.priority);
  if (patch.estimateMinutes !== undefined) add("estimate_minutes", patch.estimateMinutes);
  if (patch.planningOverrideReason !== undefined) add('planning_override_reason', patch.planningOverrideReason);
  if (patch.reminderLeadMinutes !== undefined) add('reminder_lead_minutes', patch.reminderLeadMinutes);
  if (patch.plannedWeek !== undefined) {
    add("planned_week_monday", patch.plannedWeek?.localMonday ?? null);
    add("planned_week_timezone", patch.plannedWeek?.timezone ?? null);
  }
  if (patch.scheduledStart !== undefined) add("scheduled_start", patch.scheduledStart);
  if (patch.scheduledEnd !== undefined) add("scheduled_end", patch.scheduledEnd);
  if (patch.due !== undefined) {
    add("due_kind", patch.due.kind);
    add("due_local_date", patch.due.kind === "date" ? patch.due.localDate : null);
    add("due_timezone", patch.due.kind === "none" ? null : patch.due.timezone);
    add("due_at", patch.due.kind === "instant" ? patch.due.at : null);
  }
  // 排到具体时段时，同一事务按规划时区更新 plannedWeek（4.3）；调用方显式给 plannedWeek 时以调用方为准
  if (patch.scheduledStart && patch.plannedWeek === undefined) {
    const tz = current.plannedWeek?.timezone ?? instanceTimezone();
    const monday = mondayOf(localDateInTz(new Date(patch.scheduledStart), tz));
    if (current.plannedWeek?.localMonday !== monday || current.plannedWeek?.timezone !== tz) {
      add("planned_week_monday", monday);
      add("planned_week_timezone", tz);
    }
  }
  // 空 PATCH 也校验版本：旧版本号不能得到 200
  if (sets.length === 0) return current.version === expectedVersion ? current : "conflict";

  // 提醒版本递增条件（计划 8.2）：due 变化、进入终态、从终态重开；
  // 普通标题/备注变化不重建提醒（正文在准入时用最新标题生成）。
  // 重复打开同一状态（status 值相同）不递增 revision，也不重建提醒（F22）。
  const statusChanged = patch.status !== undefined && patch.status !== current.status;
  const toTerminal =
    statusChanged && (patch.status === "done" || patch.status === "cancelled");
  const reopened =
    statusChanged &&
    (current.status === "done" || current.status === "cancelled") &&
    patch.status !== "done" &&
    patch.status !== "cancelled";
  // due 值真正变化才递增（同值重发不让已 accepted 的提醒重新出现在待处理里）
  const dueChanged = patch.due !== undefined && JSON.stringify(patch.due) !== JSON.stringify(current.due);
  const reminderAffected = dueChanged || toTerminal || reopened || (patch.reminderLeadMinutes !== undefined && patch.reminderLeadMinutes !== current.reminderLeadMinutes);
  // 任务计划时间变化使排程草案保守失效（F10）；与写入同一事务
  const scheduleChanged =
    (patch.scheduledStart !== undefined && patch.scheduledStart !== current.scheduledStart) ||
    (patch.scheduledEnd !== undefined && patch.scheduledEnd !== current.scheduledEnd) ||
    (patch.plannedWeek !== undefined && JSON.stringify(patch.plannedWeek) !== JSON.stringify(current.plannedWeek));

  const tx = db.transaction(() => {
    if (options.validateSchedule !== false && (scheduleChanged || reopened)) checkTaskSchedule({ ...current, ...patch, planningOverrideReason: patch.planningOverrideReason ?? null }, id);
    if (scheduleChanged && patch.planningOverrideReason === undefined) add('planning_override_reason', null);
    if (reminderAffected) sets.push("reminder_revision = reminder_revision + 1");
    // 完成时刻：进入 done 记录，离开 done 清空（周复盘"本周完成"依据）
    if (statusChanged && patch.status === "done") {
      sets.push("completed_at = ?");
      vals.push(now());
    } else if (statusChanged && current.status === "done") {
      sets.push("completed_at = NULL");
    }
    if (scheduleChanged) {
      db.prepare(`UPDATE planning_state SET planning_revision = planning_revision + 1 WHERE id = 1`).run();
    }
    sets.push("version = version + 1", "updated_at = ?");
    vals.push(now(), id, expectedVersion);
    const r = db
      .prepare(`UPDATE tasks SET ${sets.join(", ")} WHERE id = ? AND version = ?`)
      .run(...vals);
    if (r.changes === 0) return "conflict";
    const updated = getTask(id)!;
    // 同一事务内：取消旧未准入提醒，重建未来的新版本提醒
    if (reminderAffected) refreshReminders(updated, now());
    markPlanStale();
    return updated;
  });
  return tx();
}

export function archiveTask(
  id: string,
  expectedVersion: number,
): TaskRow | "conflict" | "not_found" {
  const db = getDb();
  // 归档递增 reminderRevision（计划 8.2）；同一事务取消未准入提醒
  const tx = db.transaction(() => {
    const t = now();
    const r = db
      .prepare(
        `UPDATE tasks SET archived_at = ?, version = version + 1, reminder_revision = reminder_revision + 1, updated_at = ?
         WHERE id = ? AND version = ? AND archived_at IS NULL`,
      )
      .run(t, t, id, expectedVersion);
    if (r.changes === 0) {
      return getTask(id) ? "conflict" : "not_found";
    }
    const task = getTask(id)!;
    refreshReminders(task, t);
    markPlanStale();
    return task;
  });
  return tx();
}

/** 人工编辑路径：记录来源修订（计划 5.1；不改任务业务字段与提醒逻辑） */
export function setTaskSourceRevision(id: string, revisionId: string): void {
  getDb().prepare(`UPDATE tasks SET source_revision_id = ? WHERE id = ?`).run(revisionId, id);
}

function mapTask(r: Record<string, unknown>): TaskRow {
  const dueKind = r.due_kind as "none" | "date" | "instant";
  const due: Due =
    dueKind === "date"
      ? { kind: "date", localDate: r.due_local_date as string, timezone: r.due_timezone as string }
      : dueKind === "instant"
        ? { kind: "instant", at: r.due_at as string, timezone: r.due_timezone as string }
        : { kind: "none" };
  return {
    id: r.id as string,
    title: r.title as string,
    description: r.description as string,
    projectId: (r.project_id as string | null) ?? null,
    goalId: (r.goal_id as string | null) ?? null,
    taskKind: (r.task_kind as TaskRow["taskKind"]) ?? "auto",
    status: r.status as TaskRow["status"],
    priority: r.priority as TaskRow["priority"],
    estimateMinutes: (r.estimate_minutes as number | null) ?? null,
    plannedWeek:
      r.planned_week_monday && r.planned_week_timezone
        ? {
            localMonday: r.planned_week_monday as string,
            timezone: r.planned_week_timezone as string,
          }
        : null,
    scheduledStart: (r.scheduled_start as string | null) ?? null,
    scheduledEnd: (r.scheduled_end as string | null) ?? null,
    due,
    planningOverrideReason: (r.planning_override_reason as string | null) ?? null,
    reminderLeadMinutes: (r.reminder_lead_minutes as number | null) ?? null,
    version: r.version as number,
    reminderRevision: r.reminder_revision as number,
    sourceRevisionId: (r.source_revision_id as string | null) ?? null,
    completedAt: (r.completed_at as string | null) ?? null,
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
    archivedAt: (r.archived_at as string | null) ?? null,
  };
}

function checkTaskSchedule(input: TaskInput, id?: string) {
  const issues = scheduleIssues({ ...input, id }, listTasks());
  const issue = issues.find(i => i.code === 'VALIDATION') ?? (input.planningOverrideReason ? null : issues[0]);
  if (issue) throw new HttpError(issue.code === 'VALIDATION' ? 422 : 409, issue.code, issue.message, { conflicts: issues });
}
