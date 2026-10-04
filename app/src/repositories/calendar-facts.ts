import crypto from "node:crypto";
import { getDb } from "./db";
import type { PolicyRule } from "@/domain/day-policy";

/** 校历 / 节假日 / 教学日例外 / 时间政策规则 仓储。写函数须在调用方事务内使用。 */

const now = () => new Date().toISOString();

// ===== 时间政策规则 =====

export function activePolicyRules(): PolicyRule[] {
  const rows = getDb().prepare(`SELECT * FROM planning_policy_rules WHERE status = 'active' ORDER BY created_at, id`).all() as Array<Record<string, unknown>>;
  return rows.map(mapRule);
}

export function getPolicyRule(id: string): (PolicyRule & { status: string }) | null {
  const r = getDb().prepare(`SELECT * FROM planning_policy_rules WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
  return r ? { ...mapRule(r), status: r.status as string } : null;
}

function mapRule(r: Record<string, unknown>): PolicyRule {
  return {
    id: r.id as string,
    kind: r.kind as PolicyRule["kind"],
    weekday: (r.weekday as number | null) ?? null,
    dateFrom: (r.date_from as string | null) ?? null,
    dateTo: (r.date_to as string | null) ?? null,
    value: JSON.parse(r.value_json as string) as Record<string, unknown>,
    scope: r.scope as PolicyRule["scope"],
    origin: r.origin as PolicyRule["origin"],
    evidence: r.evidence as string,
    version: r.version as number,
  };
}

export function insertPolicyRule(input: Omit<PolicyRule, "id" | "version">): string {
  const id = crypto.randomUUID();
  getDb()
    .prepare(`INSERT INTO planning_policy_rules (id, kind, weekday, date_from, date_to, value_json, scope, status, origin, evidence, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)`)
    .run(id, input.kind, input.weekday, input.dateFrom, input.dateTo, JSON.stringify(input.value), input.scope, input.origin, input.evidence, now(), now());
  return id;
}

export function revokePolicyRule(id: string): void {
  getDb().prepare(`UPDATE planning_policy_rules SET status = 'revoked', version = version + 1, updated_at = ? WHERE id = ?`).run(now(), id);
}

// ===== 国家节假日 =====

export type HolidayFact = { localDate: string; name: string; kind: "holiday" | "adjusted_workday"; origin: string; datasetId: string; sourceUrl: string };

export function holidayOn(date: string): HolidayFact | null {
  const r = getDb()
    .prepare(
      `SELECT d.local_date, d.name, d.kind, s.origin, s.id AS dataset_id, s.source_url FROM holiday_days d
       JOIN holiday_datasets s ON s.id = d.dataset_id WHERE d.local_date = ? AND s.status = 'active' ORDER BY s.created_at DESC LIMIT 1`,
    )
    .get(date) as Record<string, unknown> | undefined;
  return r ? { localDate: r.local_date as string, name: r.name as string, kind: r.kind as HolidayFact["kind"], origin: r.origin as string, datasetId: r.dataset_id as string, sourceUrl: r.source_url as string } : null;
}

export type HolidayDatasetRow = { id: string; year: number; revisionHash: string; origin: string; sourceUrl: string; sourceTitle: string; checkedAt: string; publishedAt: string | null; status: string; version: number };

export function activeHolidayDataset(year: number, region = "CN"): HolidayDatasetRow | null {
  const r = getDb().prepare(`SELECT * FROM holiday_datasets WHERE region = ? AND year = ? AND status = 'active' ORDER BY created_at DESC LIMIT 1`).get(region, year) as Record<string, unknown> | undefined;
  return r ? mapDataset(r) : null;
}

function mapDataset(r: Record<string, unknown>): HolidayDatasetRow {
  return {
    id: r.id as string,
    year: r.year as number,
    revisionHash: r.revision_hash as string,
    origin: r.origin as string,
    sourceUrl: r.source_url as string,
    sourceTitle: r.source_title as string,
    checkedAt: r.checked_at as string,
    publishedAt: (r.published_at as string | null) ?? null,
    status: r.status as string,
    version: r.version as number,
  };
}

// ===== 学期 / 校历 =====

export type SemesterRow = { id: string; firstMonday: string; totalWeeks: number; timezone: string; version: number };

export function listSemesters(): SemesterRow[] {
  const rows = getDb().prepare(`SELECT id, first_monday, total_weeks, timezone, version FROM semesters ORDER BY first_monday`).all() as Array<Record<string, unknown>>;
  return rows.map((r) => ({ id: r.id as string, firstMonday: r.first_monday as string, totalWeeks: r.total_weeks as number, timezone: r.timezone as string, version: r.version as number }));
}

export type AcademicCalendarRow = {
  id: string;
  school: string;
  audience: string;
  academicYear: string;
  termLabel: string;
  semesterId: string | null;
  registrationDate: string | null;
  teachingStart: string | null;
  firstMonday: string | null;
  totalWeeks: number | null;
  termEnd: string | null;
  skippedWeeks: string[];
  source: string;
  sourceRevision: string;
  origin: string;
  status: string;
  version: number;
};

export function mapAcademicCalendar(r: Record<string, unknown>): AcademicCalendarRow {
  return {
    id: r.id as string,
    school: r.school as string,
    audience: r.audience as string,
    academicYear: r.academic_year as string,
    termLabel: r.term_label as string,
    semesterId: (r.semester_id as string | null) ?? null,
    registrationDate: (r.registration_date as string | null) ?? null,
    teachingStart: (r.teaching_start as string | null) ?? null,
    firstMonday: (r.first_monday as string | null) ?? null,
    totalWeeks: (r.total_weeks as number | null) ?? null,
    termEnd: (r.term_end as string | null) ?? null,
    skippedWeeks: JSON.parse(r.skipped_weeks_json as string) as string[],
    source: r.source as string,
    sourceRevision: r.source_revision as string,
    origin: r.origin as string,
    status: r.status as string,
    version: r.version as number,
  };
}

export function activeAcademicCalendars(): AcademicCalendarRow[] {
  return (getDb().prepare(`SELECT * FROM academic_calendars WHERE status = 'active' ORDER BY created_at`).all() as Array<Record<string, unknown>>).map(mapAcademicCalendar);
}

export type CalendarEventRow = { id: string; calendarId: string; kind: string; title: string; startDate: string; endDate: string; audience: string; cancelsClasses: boolean; evidence: string };

export function calendarEventsOn(date: string): CalendarEventRow[] {
  const rows = getDb()
    .prepare(
      `SELECT e.* FROM academic_calendar_events e JOIN academic_calendars c ON c.id = e.calendar_id
       WHERE c.status = 'active' AND e.start_date <= ? AND e.end_date >= ? ORDER BY e.start_date, e.id`,
    )
    .all(date, date) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    id: r.id as string,
    calendarId: r.calendar_id as string,
    kind: r.kind as string,
    title: r.title as string,
    startDate: r.start_date as string,
    endDate: r.end_date as string,
    audience: r.audience as string,
    cancelsClasses: Boolean(r.cancels_classes),
    evidence: r.evidence as string,
  }));
}

// ===== 教学日例外 =====

export type TeachingOverrideRow = {
  id: string;
  scope: "school" | "course";
  courseId: string | null;
  mode: "cancel" | "replace" | "add" | "move";
  sourceTeachingDate: string;
  targetDate: string | null;
  targetStart: string | null;
  targetEnd: string | null;
  origin: string;
  source: string;
  evidence: string;
  note: string;
  status: string;
  version: number;
};

function mapOverride(r: Record<string, unknown>): TeachingOverrideRow {
  return {
    id: r.id as string,
    scope: r.scope as TeachingOverrideRow["scope"],
    courseId: (r.course_id as string | null) ?? null,
    mode: r.mode as TeachingOverrideRow["mode"],
    sourceTeachingDate: r.source_teaching_date as string,
    targetDate: (r.target_date as string | null) ?? null,
    targetStart: (r.target_start as string | null) ?? null,
    targetEnd: (r.target_end as string | null) ?? null,
    origin: r.origin as string,
    source: r.source as string,
    evidence: r.evidence as string,
    note: r.note as string,
    status: r.status as string,
    version: r.version as number,
  };
}

export function overridesBySource(date: string): TeachingOverrideRow[] {
  return (getDb().prepare(`SELECT * FROM teaching_day_overrides WHERE source_teaching_date = ? AND status = 'active' ORDER BY created_at, id`).all(date) as Array<Record<string, unknown>>).map(mapOverride);
}

export function overridesByTarget(date: string): TeachingOverrideRow[] {
  return (getDb().prepare(`SELECT * FROM teaching_day_overrides WHERE target_date = ? AND status = 'active' ORDER BY created_at, id`).all(date) as Array<Record<string, unknown>>).map(mapOverride);
}

export function insertTeachingOverride(input: {
  scope: "school" | "course";
  courseId: string | null;
  mode: TeachingOverrideRow["mode"];
  sourceTeachingDate: string;
  targetDate: string | null;
  targetStart?: string | null;
  targetEnd?: string | null;
  calendarId?: string | null;
  origin: "source" | "user";
  source: string;
  evidence: string;
  note: string;
}): string {
  const id = crypto.randomUUID();
  getDb()
    .prepare(
      `INSERT INTO teaching_day_overrides (id, scope, course_id, mode, source_teaching_date, target_date, target_start, target_end, calendar_id, origin, source, evidence, note, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, input.scope, input.courseId, input.mode, input.sourceTeachingDate, input.targetDate, input.targetStart ?? null, input.targetEnd ?? null, input.calendarId ?? null, input.origin, input.source, input.evidence, input.note, now(), now());
  return id;
}

// ===== 来源撤销墓碑 =====

export function hasTombstone(namespace: string, externalId: string, revision: string): boolean {
  return Boolean(getDb().prepare(`SELECT 1 FROM source_tombstones WHERE namespace = ? AND external_id = ? AND revision = ?`).get(namespace, externalId, revision));
}

export function addTombstone(namespace: string, externalId: string, revision: string): void {
  getDb()
    .prepare(`INSERT INTO source_tombstones (id, namespace, external_id, revision, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (namespace, external_id, revision) DO NOTHING`)
    .run(crypto.randomUUID(), namespace, externalId, revision, now());
}
