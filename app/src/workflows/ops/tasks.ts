import crypto from "node:crypto";
import { getDb } from "@/repositories/db";
import { bumpPlanningRevision } from "@/repositories/proposals";
import { linkSource } from "@/repositories/courses";
import { insertPracticeEntry } from "@/repositories/practice";
import type { ChangeInput } from "@/repositories/journal";
import type { Command, CommandContext } from "@/contracts/commands";
import { instanceTimezone, localDateInTz, wallTimeToUtc } from "@/domain/time";
import { getTask, updateTask } from "@/repositories/planning";
import { HttpError } from "@/workflows/http";

/** 任务/实践 操作 handler。全部在 executeCommand 的事务内执行。 */

type Cmd<N extends Command["command"]> = Extract<Command, { command: N }>;

export function applyPractice(cmd: Cmd<"record_practice">, ctx: CommandContext, changes: ChangeInput[]): string {
  if (cmd.taskId && !getTask(cmd.taskId)) throw new HttpError(422, "INVALID_REFERENCE", "关联的任务不存在");
  const id = insertPracticeEntry({ occurredOn: cmd.occurredOn, actualMinutes: cmd.actualMinutes, note: cmd.note, taskId: cmd.taskId, category: cmd.category });
  changes.push({ entityKind: "practice_entry", entityId: id, action: "create", after: { occurredOn: cmd.occurredOn, actualMinutes: cmd.actualMinutes, taskId: cmd.taskId, category: cmd.category }, afterVersion: 1 });
  linkSource({ entityKind: "practice_entry", entityId: id, namespace: "intake", externalId: ctx.intakeId ?? "", itemKey: ctx.itemKey, evidence: ctx.evidence });
  return `实践记录：${cmd.occurredOn}${cmd.actualMinutes ? ` ${cmd.actualMinutes} 分钟` : "（分钟未知）"}`;
}

type TaskCmd = Cmd<"create_or_update_task">;

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
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const due = dueColumns(cmd);
  getDb()
    .prepare(
      `INSERT INTO tasks (id, title, description, status, priority, estimate_minutes, due_kind, due_local_date, due_timezone, due_at, effort_mode, created_at, updated_at)
       VALUES (?, ?, '', 'todo', 'normal', ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, cmd.title, cmd.estimateMinutes ?? null, due.kind, due.localDate, due.timezone, due.at, cmd.effortMode ?? "deliverable", now, now);
  changes.push({ entityKind: "task", entityId: id, action: "create", after: { title: cmd.title }, afterVersion: 1 });
  linkSource({ entityKind: "task", entityId: id, namespace: "intake", externalId: ctx.intakeId ?? "", itemKey: ctx.itemKey, evidence: ctx.evidence });
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
  if (cmd.title !== undefined) set("title", "title", cmd.title);
  if (cmd.estimateMinutes !== undefined) set("estimateMinutes", "estimate_minutes", cmd.estimateMinutes);
  if (cmd.effortMode !== undefined) set("effortMode", "effort_mode", cmd.effortMode);
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
  bumpPlanningRevision();
  return `任务已修改：${(after.title as string) ?? (row.title as string)}`;
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
    const occurredOn = cmd.occurredOn ?? localDateInTz(new Date(), instanceTimezone());
    const id = insertPracticeEntry({ occurredOn, actualMinutes: cmd.actualMinutes, note: cmd.note, taskId: cmd.taskId });
    changes.push({ entityKind: "practice_entry", entityId: id, action: "create", after: { occurredOn, actualMinutes: cmd.actualMinutes, taskId: cmd.taskId }, afterVersion: 1 });
  }
  linkSource({ entityKind: "task", entityId: cmd.taskId, namespace: "intake", externalId: ctx.intakeId ?? "", itemKey: ctx.itemKey, evidence: ctx.evidence });
  bumpPlanningRevision();
  return `任务完成：${current.title}${pending.length ? `（取消 ${pending.length} 个未执行的学习块）` : ""}`;
}
