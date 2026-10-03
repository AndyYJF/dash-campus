import crypto from "node:crypto";
import { getDb } from "@/repositories/db";
import { parseTimetable } from "@/domain/timetable";
import { bumpPlanningRevision } from "@/repositories/proposals";
import {
  activeCourseSet,
  findFixedEventByRule,
  findSemester,
  insertCourse,
  insertCourseSet,
  insertFixedEvent,
  insertMeeting,
  insertProjection,
  insertSemester,
  linkSource,
  ruleHash,
  supersedeCourseSet,
} from "@/repositories/courses";
import { insertPracticeEntry } from "@/repositories/practice";
import { addChange, createBatch, type ChangeInput } from "@/repositories/journal";
import { commandSchema, COMMAND_POLICY_VERSION, type Command, type CommandContext } from "@/contracts/commands";
import { instanceTimezone } from "@/domain/time";
import { HttpError } from "@/workflows/http";

/**
 * 命令执行器（MASTER-PLAN §4.2/§5.3）：
 * 白名单 schema 校验 → 单个 IMMEDIATE 事务内完成领域写入 + journal（batch+changes）。
 * 模型/管线只给命令参数，不能直接写领域表。
 */

export type CommandResult = { ok: true; batchId: string; summary: string } | { ok: false; error: string };

export function executeCommand(raw: unknown, ctx: CommandContext): CommandResult {
  const parsed = commandSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, error: `命令不合法：${parsed.error.issues.map((i) => i.message).join("; ")}` };
  }
  try {
    return getDb()
      .transaction((): CommandResult => {
        const changes: ChangeInput[] = [];
        const summary = applyCommand(parsed.data, ctx, changes);
        const batchId = createBatch({
          command: parsed.data.command,
          reason: summary,
          intakeId: ctx.intakeId,
          itemId: ctx.itemId,
          policyVersion: COMMAND_POLICY_VERSION,
          instanceEpoch: ctx.instanceEpoch,
        });
        for (const c of changes) addChange(batchId, c);
        return { ok: true, batchId, summary };
      })
      .immediate();
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

function applyCommand(cmd: Command, ctx: CommandContext, changes: ChangeInput[]): string {
  if (cmd.command === "upsert_course_set") return applyCourseSet(cmd, ctx, changes);
  if (cmd.command === "record_practice") return applyPractice(cmd, ctx, changes);
  if (cmd.command === "import_fixed_events") return applyFixedEvents(cmd, ctx, changes);
  if (cmd.command === "apply_event_exception") return applyException(cmd, ctx, changes);
  return applyTask(cmd, ctx, changes);
}

/** 单日停课例外（A03）：独立事实表，不改课程本体；同 course_set+date 幂等去重 */
function applyException(cmd: Extract<Command, { command: "apply_event_exception" }>, ctx: CommandContext, changes: ChangeInput[]): string {
  const db = getDb();
  const set = db
    .prepare(
      `SELECT cs.id FROM course_sets cs JOIN courses c ON c.course_set_id = cs.id
       WHERE cs.status = 'active' AND c.name = ? ORDER BY cs.created_at DESC LIMIT 1`,
    )
    .get(cmd.courseName) as { id: string } | undefined;
  if (!set) throw new HttpError(422, "INVALID_REFERENCE", `找不到课程「${cmd.courseName}」的进行中课表`);
  const existing = db.prepare(`SELECT id FROM course_event_exceptions WHERE course_set_id = ? AND event_date = ?`).get(set.id, cmd.eventDate) as { id: string } | undefined;
  if (existing) return `${cmd.eventDate} 已有停课例外，不重复记录`;
  const id = crypto.randomUUID();
  db.prepare(`INSERT INTO course_event_exceptions (id, course_set_id, course_name, event_date, action, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
    id,
    set.id,
    cmd.courseName,
    cmd.eventDate,
    cmd.action,
    cmd.note,
    new Date().toISOString(),
  );
  changes.push({ entityKind: "course_exception", entityId: id, action: "create", after: { ...cmd }, afterVersion: null });
  linkSource({ entityKind: "course_exception", entityId: id, namespace: "intake", externalId: ctx.intakeId ?? "", itemKey: ctx.itemKey, evidence: ctx.evidence });
  bumpPlanningRevision();
  return `${cmd.courseName} ${cmd.eventDate} 停课例外已记录`;
}

/** ICS 等文件来源的一次性固定事件（确定性解析结果，weekday 取当日） */
function applyFixedEvents(cmd: Extract<Command, { command: "import_fixed_events" }>, ctx: CommandContext, changes: ChangeInput[]): string {
  for (const e of cmd.events) {
    const weekday = new Date(`${e.eventDate}T12:00:00Z`).getUTCDay() || 7;
    const id = insertFixedEvent({
      title: e.title,
      weekday,
      localStart: e.localStart,
      localEnd: e.localEnd,
      timezone: cmd.timezone,
      validFrom: null,
      validUntil: null,
      eventDate: e.eventDate,
    });
    changes.push({ entityKind: "fixed_event", entityId: id, action: "create", after: { ...e }, afterVersion: null });
    linkSource({ entityKind: "fixed_event", entityId: id, namespace: "intake", externalId: ctx.intakeId ?? "", itemKey: ctx.itemKey, evidence: ctx.evidence });
  }
  bumpPlanningRevision();
  return `固定事件入库：${cmd.events.length} 条`;
}

function applyCourseSet(cmd: Extract<Command, { command: "upsert_course_set" }>, ctx: CommandContext, changes: ChangeInput[]): string {
  const parsed = parseTimetable({ text: cmd.sdctText, firstMonday: cmd.firstMonday, timezone: cmd.timezone });
  const source = ctx.intakeId ? `intake:${ctx.intakeId}` : "manual";
  const semesterId = ensureSemester(parsed.firstMonday, parsed.totalWeeks, parsed.timezone, source, changes);
  replaceActiveSet(semesterId, changes);
  const setId = insertCourseSet(semesterId, source);
  changes.push({ entityKind: "course_set", entityId: setId, action: "create", after: { semesterId, status: "active" }, afterVersion: 1 });
  linkSource({ entityKind: "course_set", entityId: setId, namespace: "intake", externalId: ctx.intakeId ?? "", itemKey: ctx.itemKey, evidence: ctx.evidence });
  for (const course of parsed.courses) applyCourse(setId, course, source, changes);
  bumpPlanningRevision();
  return `课表入库：${parsed.courses.length} 门课 / ${parsed.occurrenceCount} 次课（学期首日 ${parsed.firstMonday}）`;
}

function ensureSemester(firstMonday: string, totalWeeks: number, timezone: string, source: string, changes: ChangeInput[]): string {
  const existing = findSemester(firstMonday, totalWeeks, timezone);
  if (existing) return existing.id;
  const id = insertSemester({ firstMonday, totalWeeks, timezone, source });
  changes.push({ entityKind: "semester", entityId: id, action: "create", after: { firstMonday, totalWeeks, timezone }, afterVersion: 1 });
  return id;
}

/** 同学期已有 active set：整套替换（supersede + 删除其投影），全部进 journal 可一并撤销 */
function replaceActiveSet(semesterId: string, changes: ChangeInput[]): void {
  const active = activeCourseSet(semesterId);
  if (!active) return;
  const db = getDb();
  supersedeCourseSet(active.id);
  changes.push({
    entityKind: "course_set",
    entityId: active.id,
    action: "update",
    before: { status: "active" },
    after: { status: "superseded" },
    beforeVersion: active.version,
    afterVersion: active.version + 1,
  });
  const projections = db
    .prepare(
      `SELECT p.id AS projection_id, p.fixed_event_id FROM course_meeting_projections p
       JOIN course_meetings m ON m.id = p.meeting_id JOIN courses c ON c.id = m.course_id WHERE c.course_set_id = ?`,
    )
    .all(active.id) as Array<{ projection_id: string; fixed_event_id: string }>;
  for (const p of projections) deleteProjectionAndEvent(p.projection_id, p.fixed_event_id, changes);
}

function deleteProjectionAndEvent(projectionId: string, fixedEventId: string, changes: ChangeInput[]): void {
  const db = getDb();
  const row = db.prepare(`SELECT * FROM course_meeting_projections WHERE id = ?`).get(projectionId) as Record<string, unknown>;
  db.prepare(`DELETE FROM course_meeting_projections WHERE id = ?`).run(projectionId);
  changes.push({ entityKind: "projection", entityId: projectionId, action: "delete", before: row, beforeVersion: null });
  const remaining = db.prepare(`SELECT COUNT(*) AS n FROM course_meeting_projections WHERE fixed_event_id = ?`).get(fixedEventId) as { n: number };
  if (remaining.n === 0) {
    const row = db.prepare(`SELECT * FROM fixed_events WHERE id = ?`).get(fixedEventId) as Record<string, unknown> | undefined;
    db.prepare(`DELETE FROM fixed_events WHERE id = ?`).run(fixedEventId);
    changes.push({ entityKind: "fixed_event", entityId: fixedEventId, action: "delete", before: row ?? null, beforeVersion: null });
  }
}

function applyCourse(setId: string, course: ReturnType<typeof parseTimetable>["courses"][number], source: string, changes: ChangeInput[]): void {
  const courseId = insertCourse({ courseSetId: setId, name: course.name, teacher: course.teacher, location: course.location });
  changes.push({ entityKind: "course", entityId: courseId, action: "create", after: { name: course.name }, afterVersion: 1 });
  for (const rule of course.rules) {
    const meetingId = insertMeeting({ courseId, weekday: rule.weekday, localStart: rule.localStart, localEnd: rule.localEnd, weeks: course.weeks, source });
    changes.push({ entityKind: "course_meeting", entityId: meetingId, action: "create", after: { weekday: rule.weekday, localStart: rule.localStart }, afterVersion: 1 });
    projectRule(meetingId, rule, changes);
  }
}

function projectRule(meetingId: string, rule: { title: string; weekday: number; localStart: string; localEnd: string; timezone: string; validFrom: string | null; validUntil: string | null; eventDate: string | null }, changes: ChangeInput[]): void {
  let fixedEventId = findFixedEventByRule(rule);
  if (!fixedEventId) {
    fixedEventId = insertFixedEvent(rule);
    changes.push({ entityKind: "fixed_event", entityId: fixedEventId, action: "create", after: rule, afterVersion: null });
  }
  const projectionId = insertProjection({ meetingId, fixedEventId, sourceVersion: 1, ruleHash: ruleHash(rule) });
  changes.push({ entityKind: "projection", entityId: projectionId, action: "create", after: { meetingId, fixedEventId }, afterVersion: null });
}

function applyPractice(cmd: Extract<Command, { command: "record_practice" }>, ctx: CommandContext, changes: ChangeInput[]): string {
  const id = insertPracticeEntry({ occurredOn: cmd.occurredOn, actualMinutes: cmd.actualMinutes, note: cmd.note });
  changes.push({ entityKind: "practice_entry", entityId: id, action: "create", after: { occurredOn: cmd.occurredOn, actualMinutes: cmd.actualMinutes }, afterVersion: 1 });
  linkSource({ entityKind: "practice_entry", entityId: id, namespace: "intake", externalId: ctx.intakeId ?? "", itemKey: ctx.itemKey, evidence: ctx.evidence });
  return `实践记录：${cmd.occurredOn}${cmd.actualMinutes ? ` ${cmd.actualMinutes} 分钟` : "（分钟未知）"}`;
}

function applyTask(cmd: Extract<Command, { command: "create_or_update_task" }>, ctx: CommandContext, changes: ChangeInput[]): string {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  getDb()
    .prepare(
      `INSERT INTO tasks (id, title, description, status, priority, estimate_minutes, due_kind, due_local_date, due_timezone, created_at, updated_at)
       VALUES (?, ?, '', 'todo', 'normal', ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, cmd.title, cmd.estimateMinutes, cmd.dueLocalDate ? "date" : "none", cmd.dueLocalDate, cmd.dueLocalDate ? instanceTimezone() : null, now, now);
  changes.push({ entityKind: "task", entityId: id, action: "create", after: { title: cmd.title }, afterVersion: 1 });
  linkSource({ entityKind: "task", entityId: id, namespace: "intake", externalId: ctx.intakeId ?? "", itemKey: ctx.itemKey, evidence: ctx.evidence });
  return `任务创建：${cmd.title}`;
}
