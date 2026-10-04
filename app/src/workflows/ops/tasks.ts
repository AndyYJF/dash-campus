import crypto from "node:crypto";
import { getDb } from "@/repositories/db";
import { TASK_KIND_LABEL } from "@/domain/task-admission";
import { bumpPlanningRevision } from "@/repositories/proposals";
import { linkSource } from "@/repositories/courses";
import { insertPracticeEntry } from "@/repositories/practice";
import type { ChangeInput } from "@/repositories/journal";
import type { Command, CommandContext } from "@/contracts/commands";
import { instanceTimezone, localDateInTz, wallTimeToUtc } from "@/domain/time";
import { getTask, updateTask } from "@/repositories/planning";
import { HttpError } from "@/workflows/http";
import { refreshReminders } from "@/workflows/reminders";
import { nowDate } from "@/domain/clock";

/** 任务/实践 操作 handler。全部在 executeCommand 的事务内执行。 */

type Cmd<N extends Command["command"]> = Extract<Command, { command: N }>;

export function applyPractice(cmd: Cmd<"record_practice">, ctx: CommandContext, changes: ChangeInput[]): string {
  if (cmd.taskId && !getTask(cmd.taskId)) throw new HttpError(422, "INVALID_REFERENCE", "关联的任务不存在");
  assertProject(cmd.projectId);
  // 关联了任务的记录自动带上任务所属项目：项目页的证据来自真实投入
  const projectId = cmd.projectId ?? (cmd.taskId ? ((getDb().prepare(`SELECT project_id FROM tasks WHERE id = ?`).get(cmd.taskId) as { project_id: string | null } | undefined)?.project_id ?? null) : null);
  const id = insertPracticeEntry({ occurredOn: cmd.occurredOn, actualMinutes: cmd.actualMinutes, note: cmd.note, taskId: cmd.taskId, category: cmd.category, blocker: cmd.blocker, projectId });
  changes.push({ entityKind: "practice_entry", entityId: id, action: "create", after: { occurredOn: cmd.occurredOn, actualMinutes: cmd.actualMinutes, taskId: cmd.taskId, category: cmd.category }, afterVersion: 1 });
  linkSource({ entityKind: "practice_entry", entityId: id, namespace: "intake", externalId: ctx.intakeId ?? "", itemKey: ctx.itemKey, evidence: ctx.evidence });
  if (cmd.taskId || cmd.blocker) bumpPlanningRevision();
  return `实践记录：${cmd.occurredOn}${cmd.actualMinutes ? ` ${cmd.actualMinutes} 分钟` : "（分钟未知）"}${cmd.blocker ? `；卡点已记下，下一步先排一小段处理它` : ""}`;
}

type TaskCmd = Cmd<"create_or_update_task">;

function assertProject(projectId: string | null | undefined): void {
  if (projectId && !getDb().prepare(`SELECT 1 FROM projects WHERE id = ? AND archived_at IS NULL`).get(projectId)) throw new HttpError(422, "INVALID_REFERENCE", "要归入的项目不存在");
}

/** 截止字段 → 存储列；给了钟点就是具体时刻 */
function dueColumns(cmd: TaskCmd): { kind: "none" | "date" | "instant"; localDate: string | null; timezone: string | null; at: string | null } {
  if (!cmd.dueLocalDate) return { kind: "none", localDate: null, timezone: null, at: null };
  const tz = instanceTimezone();
  if (cmd.dueLocalTime) return { kind: "instant", localDate: null, timezone: tz, at: wallTimeToUtc(cmd.dueLocalDate, cmd.dueLocalTime, tz).toISOString() };
  return { kind: "date", localDate: cmd.dueLocalDate, timezone: tz, at: null };
}

export function applyTask(cmd: TaskCmd, ctx: CommandContext, changes: ChangeInput[]): string {
  if (cmd.taskId) return applyTaskUpdate(cmd, ctx, changes);
  if (!cmd.title) throw new HttpError(422, "VALIDATION", "新建任务需要标题");
  assertProject(cmd.projectId);
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const due = dueColumns(cmd);
  getDb()
    .prepare(
      `INSERT INTO tasks (id, title, description, status, priority, estimate_minutes, due_kind, due_local_date, due_timezone, due_at, effort_mode, remaining_minutes, remaining_reported_at, created_at, updated_at)
       VALUES (?, ?, '', 'todo', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, cmd.title, cmd.priority ?? "normal", cmd.estimateMinutes ?? null, due.kind, due.localDate, due.timezone, due.at, cmd.effortMode ?? "deliverable", cmd.remainingMinutes ?? null, cmd.remainingMinutes != null ? (ctx.now ?? nowDate()).toISOString() : null, now, now);
  getDb().prepare("UPDATE tasks SET task_kind = ?, project_id = ? WHERE id = ?").run(cmd.taskKind ?? "auto", cmd.projectId ?? null, id);
  changes.push({ entityKind: "task", entityId: id, action: "create", after: { title: cmd.title, taskKind: cmd.taskKind ?? "auto", ...(cmd.projectId ? { projectId: cmd.projectId } : {}) }, afterVersion: 1 });
  linkSource({ entityKind: "task", entityId: id, namespace: "intake", externalId: ctx.intakeId ?? "", itemKey: ctx.itemKey, evidence: ctx.evidence });
  // 提醒按当前策略建立（主人关掉提醒、截止在安静时段等都在里面处理）；聊天、卡片、兼容接口同一套
  if (due.kind !== "none") refreshReminders(getTask(id)!, now);
  return `任务创建：${cmd.title}`;
}

/** 修改原任务：只动给出的字段，版本前进，提醒版本随截止变化失效；不产生副本 */
function applyTaskUpdate(cmd: TaskCmd, ctx: CommandContext, changes: ChangeInput[]): string {
  const db = getDb();
  const row = db.prepare(`SELECT * FROM tasks WHERE id = ? AND archived_at IS NULL`).get(cmd.taskId) as Record<string, unknown> | undefined;
  if (!row) throw new HttpError(404, "NOT_FOUND", "要修改的任务不存在");
  const before: Record<string, unknown> = {};
  const after: Record<string, unknown> = {};
  const set = (camel: string, column: string, value: unknown) => {
    if ((row[column] ?? null) === (value ?? null)) return;
    before[camel] = row[column] ?? null;
    after[camel] = value ?? null;
  };
  if (cmd.taskKind !== undefined) set("taskKind", "task_kind", cmd.taskKind);
  if (cmd.title !== undefined) set("title", "title", cmd.title);
  if (cmd.estimateMinutes !== undefined) set("estimateMinutes", "estimate_minutes", cmd.estimateMinutes);
  if (cmd.effortMode !== undefined) set("effortMode", "effort_mode", cmd.effortMode);
  if (cmd.priority !== undefined) set("priority", "priority", cmd.priority);
  if (cmd.projectId !== undefined) {
    assertProject(cmd.projectId);
    set("projectId", "project_id", cmd.projectId);
  }
  if (cmd.remainingMinutes !== undefined) {
    // 报告剩余需求：记下报告时刻，之后的投入从这个数扣
    before.remainingMinutes = row.remaining_minutes ?? null;
    after.remainingMinutes = cmd.remainingMinutes;
    before.remainingReportedAt = row.remaining_reported_at ?? null;
    after.remainingReportedAt = cmd.remainingMinutes === null ? null : (ctx.now ?? nowDate()).toISOString();
  }
  if (cmd.dueLocalDate !== undefined) {
    const due = dueColumns(cmd);
    set("dueKind", "due_kind", due.kind);
    set("dueLocalDate", "due_local_date", due.localDate);
    set("dueTimezone", "due_timezone", due.timezone);
    set("dueAt", "due_at", due.at);
  }
  const fields = Object.keys(after);
  if (!fields.length) return `任务无变化：${row.title as string}`;
  const dueChanged = fields.some((f) => f.startsWith("due"));
  const sets = fields.map((f) => `${f.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`)} = ?`);
  db.prepare(`UPDATE tasks SET ${sets.join(", ")}, version = version + 1${dueChanged ? ", reminder_revision = reminder_revision + 1" : ""}, updated_at = ? WHERE id = ?`).run(...Object.values(after), new Date().toISOString(), cmd.taskId);
  const version = row.version as number;
  changes.push({ entityKind: "task", entityId: cmd.taskId!, action: "update", before, after, beforeVersion: version, afterVersion: version + 1 });
  linkSource({ entityKind: "task", entityId: cmd.taskId!, namespace: "intake", externalId: ctx.intakeId ?? "", itemKey: ctx.itemKey, evidence: ctx.evidence });
  // 截止变了：旧提醒失效，按新截止重建
  if (dueChanged) refreshReminders(getTask(cmd.taskId!)!, new Date().toISOString());
  bumpPlanningRevision();
  return `任务已修改：${(after.title as string) ?? (row.title as string)}${cmd.taskKind && cmd.taskKind !== "auto" ? `；已归为${TASK_KIND_LABEL[cmd.taskKind]}${cmd.taskKind === "study" ? "，纳入学习安排" : "，不自动占用学习时间"}` : ""}`;
}

/** 完成原任务：走与按钮/兼容 API 相同的 updateTask（记完成时刻、取消提醒），并取消未执行的学习块 */
export function applyCompleteTask(cmd: Cmd<"complete_task">, ctx: CommandContext, changes: ChangeInput[]): string {
  const db = getDb();
  const current = getTask(cmd.taskId);
  if (!current || current.archivedAt) throw new HttpError(404, "NOT_FOUND", "要完成的任务不存在");
  if (current.status === "done") return `任务已是完成状态：${current.title}`;
  const updated = updateTask(cmd.taskId, { status: "done" }, current.version, { validateSchedule: false });
  if (updated === "conflict" || updated === "not_found") throw new HttpError(409, "CONFLICT", "任务刚被修改，请重试");
  changes.push({ entityKind: "task", entityId: cmd.taskId, action: "update", before: { status: current.status, completedAt: null }, after: { status: "done" }, beforeVersion: current.version, afterVersion: updated.version });
  const pending = db.prepare(`SELECT id, status, version FROM plan_sessions WHERE task_id = ? AND status IN ('tentative','planned')`).all(cmd.taskId) as Array<{ id: string; status: string; version: number }>;
  for (const s of pending) {
    db.prepare(`UPDATE plan_sessions SET status = 'superseded', version = version + 1, updated_at = ? WHERE id = ?`).run(new Date().toISOString(), s.id);
    changes.push({ entityKind: "plan_session", entityId: s.id, action: "update", before: { status: s.status }, after: { status: "superseded" }, beforeVersion: s.version, afterVersion: s.version + 1 });
  }
  if (cmd.actualMinutes !== null) {
    const occurredOn = cmd.occurredOn ?? localDateInTz(ctx.now ?? nowDate(), instanceTimezone());
    const id = insertPracticeEntry({ occurredOn, actualMinutes: cmd.actualMinutes, note: cmd.note, taskId: cmd.taskId });
    changes.push({ entityKind: "practice_entry", entityId: id, action: "create", after: { occurredOn, actualMinutes: cmd.actualMinutes, taskId: cmd.taskId }, afterVersion: 1 });
  }
  linkSource({ entityKind: "task", entityId: cmd.taskId, namespace: "intake", externalId: ctx.intakeId ?? "", itemKey: ctx.itemKey, evidence: ctx.evidence });
  bumpPlanningRevision();
  return `任务完成：${current.title}${pending.length ? `（取消 ${pending.length} 个未执行的学习块）` : ""}`;
}

/** 暂停/恢复任务：暂停让出还没开始的学习块（进行中的保留），不取消任务本身 */
export function applyPauseTask(cmd: Cmd<"pause_task">, ctx: CommandContext, changes: ChangeInput[]): string {
  const db = getDb();
  const row = db.prepare(`SELECT id, title, status, paused_until, version FROM tasks WHERE id = ? AND archived_at IS NULL`).get(cmd.taskId) as
    | { id: string; title: string; status: string; paused_until: string | null; version: number }
    | undefined;
  if (!row) throw new HttpError(404, "NOT_FOUND", "要暂停的任务不存在");
  const nowIso = new Date().toISOString();
  const next = cmd.resume ? null : (cmd.until ?? "9999-12-31");
  if ((row.paused_until ?? null) === next) return cmd.resume ? `「${row.title}」本来就没有暂停` : `「${row.title}」已经是暂停状态`;
  db.prepare(`UPDATE tasks SET paused_until = ?, version = version + 1, updated_at = ? WHERE id = ?`).run(next, nowIso, cmd.taskId);
  changes.push({ entityKind: "task", entityId: cmd.taskId, action: "update", before: { pausedUntil: row.paused_until ?? null }, after: { pausedUntil: next }, beforeVersion: row.version, afterVersion: row.version + 1 });
  let released = 0;
  if (!cmd.resume) {
    const pending = db.prepare(`SELECT id, status, version FROM plan_sessions WHERE task_id = ? AND status IN ('tentative','planned')`).all(cmd.taskId) as Array<{ id: string; status: string; version: number }>;
    for (const s of pending) {
      db.prepare(`UPDATE plan_sessions SET status = 'superseded', version = version + 1, updated_at = ? WHERE id = ?`).run(nowIso, s.id);
      changes.push({ entityKind: "plan_session", entityId: s.id, action: "update", before: { status: s.status }, after: { status: "superseded" }, beforeVersion: s.version, afterVersion: s.version + 1 });
    }
    released = pending.length;
  }
  linkSource({ entityKind: "task", entityId: cmd.taskId, namespace: "intake", externalId: ctx.intakeId ?? "", itemKey: ctx.itemKey, evidence: ctx.evidence });
  // 暂停期间不提醒；恢复后按截止重建
  refreshReminders(getTask(cmd.taskId)!, nowIso);
  bumpPlanningRevision();
  if (cmd.resume) return `「${row.title}」已恢复，会重新安排时间`;
  return `「${row.title}」先放一放${cmd.until ? `，${cmd.until} 起恢复安排` : "（没定恢复时间，想继续时说一声）"}${released ? `；让出 ${released} 个还没开始的学习块` : ""}`;
}

/** 纠正实践记录：旧值进变更历史，预算与任务剩余随之刷新 */
export function applyCorrectPractice(cmd: Cmd<"correct_practice">, ctx: CommandContext, changes: ChangeInput[]): string {
  const db = getDb();
  const row = db.prepare(`SELECT * FROM practice_entries WHERE id = ?`).get(cmd.practiceId) as Record<string, unknown> | undefined;
  if (!row) throw new HttpError(404, "NOT_FOUND", "这条实践记录不存在");
  if (cmd.taskId && !getTask(cmd.taskId)) throw new HttpError(422, "INVALID_REFERENCE", "关联的任务不存在");
  const before: Record<string, unknown> = {};
  const after: Record<string, unknown> = {};
  const set = (camel: string, column: string, value: unknown) => {
    if (value === undefined || (row[column] ?? null) === (value ?? null)) return;
    before[camel] = row[column] ?? null;
    after[camel] = value ?? null;
  };
  set("actualMinutes", "actual_minutes", cmd.actualMinutes);
  set("occurredOn", "occurred_on", cmd.occurredOn);
  set("note", "note", cmd.note);
  set("taskId", "task_id", cmd.taskId);
  set("category", "category", cmd.category);
  const fields = Object.keys(after);
  if (!fields.length) return "这条记录没有变化";
  const sets = fields.map((f) => `${f.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`)} = ?`);
  db.prepare(`UPDATE practice_entries SET ${sets.join(", ")}, version = version + 1, updated_at = ? WHERE id = ?`).run(...Object.values(after), new Date().toISOString(), cmd.practiceId);
  const version = row.version as number;
  changes.push({ entityKind: "practice_entry", entityId: cmd.practiceId, action: "update", before, after, beforeVersion: version, afterVersion: version + 1 });
  linkSource({ entityKind: "practice_entry", entityId: cmd.practiceId, namespace: "intake", externalId: ctx.intakeId ?? "", itemKey: ctx.itemKey, evidence: ctx.evidence });
  bumpPlanningRevision();
  const parts: string[] = [];
  if ("actualMinutes" in after) parts.push(`${before.actualMinutes ?? "未知"} 分钟 → ${after.actualMinutes ?? "未知"} 分钟`);
  if ("occurredOn" in after) parts.push(`日期改为 ${after.occurredOn}`);
  if ("category" in after) parts.push(after.category === "other" ? "不算学习投入" : "算学习投入");
  if ("taskId" in after) parts.push(after.taskId ? "已关联任务" : "不再关联任务");
  if ("note" in after) parts.push("说明已更新");
  return `实践记录已纠正：${parts.join("，")}`;
}
