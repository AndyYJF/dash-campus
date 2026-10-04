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
import type { ChangeInput } from "@/repositories/journal";
import type { Command, CommandContext } from "@/contracts/commands";
import { HttpError } from "@/workflows/http";
import { addDays } from "@/domain/time";
import { activeAcademicCalendars } from "@/repositories/calendar-facts";

/** 课程/固定事件/归档 操作 handler。全部在 executeCommand 的事务内执行。 */

type Cmd<N extends Command["command"]> = Extract<Command, { command: N }>;

/** 归档（软删除）：task/goal 置 archived_at + bump version；course_set 转 superseded。undo 恢复 */
export function applyArchive(cmd: Cmd<"archive_entity">, ctx: CommandContext, changes: ChangeInput[]): string {
  const db = getDb();
  const nowIso = new Date().toISOString();
  const table = cmd.entityKind === "course_set" ? "course_sets" : cmd.entityKind === "goal" ? "goals" : "tasks";
  const row = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(cmd.entityId) as Record<string, unknown> | undefined;
  if (!row) throw new HttpError(404, "NOT_FOUND", `${cmd.entityKind} 不存在`);
  const before = { archivedAt: (row.archived_at as string | null) ?? null, status: (row.status as string) ?? null, version: (row.version as number) ?? null };
  if (cmd.entityKind === "course_set") {
    if (row.status === "superseded") return "该课表已是归档状态";
    db.prepare(`UPDATE course_sets SET status = 'superseded', version = version + 1 WHERE id = ?`).run(cmd.entityId);
  } else {
    if (row.archived_at) return "已是归档状态";
    db.prepare(`UPDATE ${table} SET archived_at = ?, version = version + 1, updated_at = ? WHERE id = ?`).run(nowIso, nowIso, cmd.entityId);
  }
  changes.push({
    entityKind: cmd.entityKind,
    entityId: cmd.entityId,
    action: "update",
    before,
    after: { archivedAt: cmd.entityKind === "course_set" ? null : nowIso, status: cmd.entityKind === "course_set" ? "superseded" : before.status },
    beforeVersion: before.version,
    afterVersion: (before.version ?? 0) + 1,
  });
  linkSource({ entityKind: cmd.entityKind, entityId: cmd.entityId, namespace: "intake", externalId: ctx.intakeId ?? "", itemKey: ctx.itemKey, evidence: ctx.evidence });
  bumpPlanningRevision();
  return `${cmd.entityKind} 已归档`;
}

/** 单日停课例外（A03）：独立事实表，不改课程本体；同 course_set+date 幂等去重 */
export function applyException(cmd: Cmd<"apply_event_exception">, ctx: CommandContext, changes: ChangeInput[]): string {
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
export function applyFixedEvents(cmd: Cmd<"import_fixed_events">, ctx: CommandContext, changes: ChangeInput[]): string {
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

export function applyCourseSet(cmd: Cmd<"upsert_course_set">, ctx: CommandContext, changes: ChangeInput[]): string {
  const parsed = parseTimetable({ text: cmd.sdctText, firstMonday: cmd.firstMonday, timezone: cmd.timezone });
  const source = ctx.intakeId ? `intake:${ctx.intakeId}` : "manual";
  const semesterId = ensureSemester(parsed.firstMonday, parsed.totalWeeks, parsed.timezone, source, changes);
  replaceActiveSet(semesterId, changes);
  const setId = insertCourseSet(semesterId, source);
  changes.push({ entityKind: "course_set", entityId: setId, action: "create", after: { semesterId, status: "active" }, afterVersion: 1 });
  linkSource({ entityKind: "course_set", entityId: setId, namespace: "intake", externalId: ctx.intakeId ?? "", itemKey: ctx.itemKey, evidence: ctx.evidence });
  for (const course of parsed.courses) applyCourse(setId, course, source, changes);
  // 校历明确有不计教学周的周：课程日期按校历的周次表展开
  const skipped = activeAcademicCalendars().find((c) => c.semesterId === semesterId)?.skippedWeeks ?? [];
  if (skipped.length) reprojectActiveSet(semesterId, parsed.firstMonday, skipped, changes);
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


/** 第 w 教学周的周一：从首周周一起数，跳过学校明确不计教学周的周 */
function weekMonday(firstMonday: string, skipped: string[], week: number): string {
  let monday = firstMonday;
  for (let counted = 0; ; monday = addDays(monday, 7)) {
    if (skipped.includes(monday)) continue;
    counted++;
    if (counted === week) return monday;
  }
}

/**
 * 学期首周或周次表变化后，按课程语义（星期/钟点/周次）重新展开进行中课表的投影。
 * 课程规则本体不变；只增删投影出的固定活动规则，全部进 journal，可随校历修正一并撤销。
 * 返回变化的规则数。
 */
export function reprojectActiveSet(semesterId: string, firstMonday: string, skipped: string[], changes: ChangeInput[]): number {
  const db = getDb();
  const set = activeCourseSet(semesterId);
  if (!set) return 0;
  const semester = db.prepare(`SELECT timezone FROM semesters WHERE id = ?`).get(semesterId) as { timezone: string };
  const meetings = db
    .prepare(
      `SELECT m.id, m.weekday, m.local_start, m.local_end, m.weeks_json, c.name, c.teacher, c.location
       FROM course_meetings m JOIN courses c ON c.id = m.course_id WHERE c.course_set_id = ? ORDER BY m.created_at, m.id`,
    )
    .all(set.id) as Array<{ id: string; weekday: number; local_start: string; local_end: string; weeks_json: string; name: string; teacher: string; location: string }>;
  // 同一门课同一时段的多条 meeting（按周次段拆出来的）合并成一组重新展开
  const groups = new Map<string, typeof meetings>();
  for (const m of meetings) {
    const key = [m.name, m.teacher, m.location, m.weekday, m.local_start, m.local_end, m.weeks_json].join("|");
    groups.set(key, [...(groups.get(key) ?? []), m]);
  }
  let changed = 0;
  for (const group of groups.values()) {
    const head = group[0]!;
    const title = [head.name, head.teacher && head.teacher !== "-" ? head.teacher : "", head.location && head.location !== "-" ? head.location : ""].filter(Boolean).join(" · ");
    const dates = (JSON.parse(head.weeks_json) as number[]).map((w) => addDays(weekMonday(firstMonday, skipped, w), head.weekday - 1));
    // 连续（相隔 7 天）的日期合成一条每周规则
    const desired: Array<{ title: string; weekday: number; localStart: string; localEnd: string; timezone: string; validFrom: string; validUntil: string; eventDate: null }> = [];
    for (const d of dates) {
      const last = desired[desired.length - 1];
      if (last && addDays(last.validUntil, 7) === d) last.validUntil = d;
      else desired.push({ title, weekday: head.weekday, localStart: head.local_start, localEnd: head.local_end, timezone: semester.timezone, validFrom: d, validUntil: d, eventDate: null });
    }
    const wanted = new Map(desired.map((r) => [ruleHash(r), r] as const));
    const existing = db
      .prepare(`SELECT p.id AS projection_id, p.fixed_event_id, p.rule_hash FROM course_meeting_projections p WHERE p.meeting_id IN (${group.map(() => "?").join(",")})`)
      .all(...group.map((m) => m.id)) as Array<{ projection_id: string; fixed_event_id: string; rule_hash: string }>;
    for (const p of existing) {
      if (wanted.has(p.rule_hash)) wanted.delete(p.rule_hash);
      else {
        deleteProjectionAndEvent(p.projection_id, p.fixed_event_id, changes);
        changed++;
      }
    }
    for (const rule of wanted.values()) {
      projectRule(head.id, rule, changes);
      changed++;
    }
  }
  return changed;
}
