import crypto from "node:crypto";
import { getDb } from "./db";

/** 课程语义模型仓储（semesters/course_sets/courses/course_meetings/projections + 来源关联）。全部函数须在调用方事务内使用。 */

function now(): string {
  return new Date().toISOString();
}

export function findSemester(firstMonday: string, totalWeeks: number, timezone: string): { id: string; version: number } | null {
  const r = getDb()
    .prepare(`SELECT id, version FROM semesters WHERE first_monday = ? AND total_weeks = ? AND timezone = ?`)
    .get(firstMonday, totalWeeks, timezone) as { id: string; version: number } | undefined;
  return r ?? null;
}

export function insertSemester(input: { firstMonday: string; totalWeeks: number; timezone: string; source: string }): string {
  const id = crypto.randomUUID();
  getDb()
    .prepare(`INSERT INTO semesters (id, first_monday, total_weeks, timezone, fact_origin, source, created_at, updated_at) VALUES (?, ?, ?, ?, 'user_confirmed', ?, ?, ?)`)
    .run(id, input.firstMonday, input.totalWeeks, input.timezone, input.source, now(), now());
  return id;
}

export function activeCourseSet(semesterId: string): { id: string; version: number } | null {
  const r = getDb().prepare(`SELECT id, version FROM course_sets WHERE semester_id = ? AND status = 'active'`).get(semesterId) as
    | { id: string; version: number }
    | undefined;
  return r ?? null;
}

export function insertCourseSet(semesterId: string, source: string): string {
  const id = crypto.randomUUID();
  getDb().prepare(`INSERT INTO course_sets (id, semester_id, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`).run(id, semesterId, source, now(), now());
  return id;
}

export function supersedeCourseSet(id: string): void {
  getDb().prepare(`UPDATE course_sets SET status = 'superseded', version = version + 1, updated_at = ? WHERE id = ?`).run(now(), id);
}

export function insertCourse(input: { courseSetId: string; name: string; teacher: string; location: string }): string {
  const id = crypto.randomUUID();
  getDb()
    .prepare(`INSERT INTO courses (id, course_set_id, name, teacher, location, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(id, input.courseSetId, input.name, input.teacher, input.location, now(), now());
  return id;
}

export function insertMeeting(input: { courseId: string; weekday: number; localStart: string; localEnd: string; weeks: number[]; source: string }): string {
  const id = crypto.randomUUID();
  getDb()
    .prepare(`INSERT INTO course_meetings (id, course_id, weekday, local_start, local_end, weeks_json, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, input.courseId, input.weekday, input.localStart, input.localEnd, JSON.stringify(input.weeks), input.source, now(), now());
  return id;
}

export function findFixedEventByRule(rule: { title: string; weekday: number; localStart: string; localEnd: string; timezone: string; validFrom: string | null; validUntil: string | null; eventDate: string | null }): string | null {
  const r = getDb()
    .prepare(`SELECT id FROM fixed_events WHERE title=? AND weekday=? AND local_start=? AND local_end=? AND timezone=? AND valid_from IS ? AND valid_until IS ? AND event_date IS ?`)
    .get(rule.title, rule.weekday, rule.localStart, rule.localEnd, rule.timezone, rule.validFrom, rule.validUntil, rule.eventDate) as { id: string } | undefined;
  return r?.id ?? null;
}

export function insertFixedEvent(rule: { title: string; weekday: number; localStart: string; localEnd: string; timezone: string; validFrom: string | null; validUntil: string | null; eventDate: string | null }): string {
  const id = crypto.randomUUID();
  getDb()
    .prepare(`INSERT INTO fixed_events (id, title, weekday, local_start, local_end, timezone, event_date, valid_from, valid_until) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, rule.title, rule.weekday, rule.localStart, rule.localEnd, rule.timezone, rule.eventDate, rule.validFrom, rule.validUntil);
  return id;
}

export function insertProjection(input: { meetingId: string; fixedEventId: string; sourceVersion: number; ruleHash: string }): string {
  const id = crypto.randomUUID();
  getDb()
    .prepare(`INSERT INTO course_meeting_projections (id, meeting_id, fixed_event_id, source_version, rule_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(id, input.meetingId, input.fixedEventId, input.sourceVersion, input.ruleHash, now());
  return id;
}

export function ruleHash(rule: unknown): string {
  return crypto.createHash("sha256").update(JSON.stringify(rule)).digest("hex").slice(0, 32);
}

export function linkSource(input: { entityKind: string; entityId: string; namespace: string; externalId: string; itemKey: string; evidence: string }): string {
  const id = crypto.randomUUID();
  getDb()
    .prepare(
      `INSERT INTO entity_source_links (id, entity_kind, entity_id, source_namespace, external_id, revision, item_key, field_path, evidence, created_at)
       VALUES (?, ?, ?, ?, ?, '', ?, '', ?, ?)
       ON CONFLICT (entity_kind, entity_id, source_namespace, external_id, revision, item_key) DO NOTHING`,
    )
    .run(id, input.entityKind, input.entityId, input.namespace, input.externalId, input.itemKey, input.evidence, now());
  return id;
}
