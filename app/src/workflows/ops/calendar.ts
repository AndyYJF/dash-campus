import crypto from "node:crypto";
import { getDb } from "@/repositories/db";
import { bumpPlanningRevision } from "@/repositories/proposals";
import { activeCourseSet, linkSource } from "@/repositories/courses";
import type { ChangeInput } from "@/repositories/journal";
import type { Command, CommandContext } from "@/contracts/commands";
import { addDays, instanceTimezone, mondayOf } from "@/domain/time";
import { isoWeekday } from "@/domain/day-policy";
import {
  activeAcademicCalendars,
  activeHolidayDataset,
  hasTombstone,
  insertTeachingOverride,
  listSemesters,
  overridesBySource,
  overridesByTarget,
} from "@/repositories/calendar-facts";
import { getSetting } from "@/repositories/settings";
import { HttpError } from "@/workflows/http";
import { calendarDay } from "@/workflows/calendar";
import { reprojectActiveSet } from "@/workflows/ops/courses";

/**
 * 校历 / 国家节假日 / 教学日例外 操作 handler（ACADEMIC-CALENDAR-AND-HOLIDAYS §4–§6）。
 * 国家日历只进公历日标签；学校规则才产生停课与补课映射；每个原教学日最多一个去向。
 */

type Cmd<N extends Command["command"]> = Extract<Command, { command: N }>;

const now = () => new Date().toISOString();
const WEEKDAY = "一二三四五六日";

function validDate(d: string): boolean {
  const t = new Date(`${d}T00:00:00Z`);
  return !Number.isNaN(t.getTime()) && t.toISOString().slice(0, 10) === d;
}

/** 国家年度节假日安排入库。同一修订不重复导入；撤销过的修订不被再次同步套用 */
export function applyHolidayCalendar(cmd: Cmd<"sync_holiday_calendar">, ctx: CommandContext, changes: ChangeInput[]): string {
  if (cmd.origin === "third_party") {
    throw new HttpError(422, "NO_OFFICIAL_SOURCE", "这份日期没有官方出处，不能当作节假日事实；可以上传国务院办公厅通知原文或给出官方链接");
  }
  for (const d of cmd.days) {
    if (!validDate(d.localDate) || Number(d.localDate.slice(0, 4)) !== cmd.year) throw new HttpError(422, "VALIDATION", `${d.localDate} 不属于 ${cmd.year} 年度`);
  }
  const externalId = `CN:${cmd.year}`;
  if (hasTombstone("holiday", externalId, cmd.revisionHash)) return `${cmd.year} 年节假日的这一版已被你撤销，不再自动套用`;
  const db = getDb();
  const current = activeHolidayDataset(cmd.year);
  if (current?.revisionHash === cmd.revisionHash) {
    return `${cmd.year} 年节假日安排没有变化`;
  }
  if (current) {
    db.prepare(`UPDATE holiday_datasets SET status = 'superseded', version = version + 1, updated_at = ? WHERE id = ?`).run(now(), current.id);
    changes.push({ entityKind: "holiday_dataset", entityId: current.id, action: "update", before: { status: "active" }, after: { status: "superseded" }, beforeVersion: current.version, afterVersion: current.version + 1 });
  }
  const id = crypto.randomUUID();
  db.prepare(
    `INSERT INTO holiday_datasets (id, region, year, source_url, source_title, revision_hash, origin, published_at, checked_at, created_at, updated_at) VALUES (?, 'CN', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, cmd.year, cmd.sourceUrl, cmd.sourceTitle, cmd.revisionHash, cmd.origin, cmd.publishedAt, now(), now(), now());
  changes.push({ entityKind: "holiday_dataset", entityId: id, action: "create", after: { year: cmd.year, revisionHash: cmd.revisionHash, origin: cmd.origin }, afterVersion: 1 });
  const insert = db.prepare(`INSERT INTO holiday_days (id, dataset_id, local_date, name, kind) VALUES (?, ?, ?, ?, ?)`);
  for (const d of cmd.days) {
    const dayId = crypto.randomUUID();
    insert.run(dayId, id, d.localDate, d.name, d.kind);
    changes.push({ entityKind: "holiday_day", entityId: dayId, action: "create", after: { ...d }, afterVersion: null });
  }
  linkSource({ entityKind: "holiday_dataset", entityId: id, namespace: "intake", externalId: ctx.intakeId ?? "", itemKey: ctx.itemKey, evidence: cmd.sourceUrl || ctx.evidence });
  bumpPlanningRevision();
  const holidays = cmd.days.filter((d) => d.kind === "holiday").length;
  const workdays = cmd.days.length - holidays;
  return `${cmd.year} 年节假日安排已${current ? "更新" : "入库"}：放假 ${holidays} 天、调整上班 ${workdays} 天。只标注公历日；学校是否停课/补课另按校历和学校通知。`;
}

/** 与 [from, to] 有交集的学期 */
function overlappingSemester(from: string, to: string) {
  return listSemesters().find((s) => s.firstMonday <= to && addDays(s.firstMonday, s.totalWeeks * 7 - 1) >= from) ?? null;
}

/** 校历入库：学期日期/教学周/停课区间/补课映射。首周与现有课表不一致时不暗改，交回提问 */
export function applyAcademicCalendar(cmd: Cmd<"upsert_academic_calendar">, ctx: CommandContext, changes: ChangeInput[]): string {
  const db = getDb();
  const tz = instanceTimezone();
  for (const d of [cmd.registrationDate, cmd.teachingStart, cmd.firstMonday, cmd.termEnd, ...cmd.skippedWeeks]) {
    if (d && !validDate(d)) throw new HttpError(422, "VALIDATION", `日期 ${d} 不合法`);
  }
  // 报到日、开始授课日、第一教学周周一分开保存：只有明确的首周或授课日才推出周一，报到日不行
  const firstMonday = cmd.firstMonday ?? (cmd.teachingStart ? mondayOf(cmd.teachingStart) : null);
  if (firstMonday && isoWeekday(firstMonday) !== 1) throw new HttpError(422, "VALIDATION", `第一教学周 ${firstMonday} 不是周一`);
  if (cmd.termEnd && firstMonday && cmd.termEnd < firstMonday) throw new HttpError(422, "VALIDATION", "学期结束早于第一教学周");
  for (const m of cmd.skippedWeeks) if (isoWeekday(m) !== 1) throw new HttpError(422, "VALIDATION", `不计教学周的周 ${m} 需用周一表示`);
  for (const e of cmd.events) {
    if (!validDate(e.startDate) || !validDate(e.endDate) || e.endDate < e.startDate) throw new HttpError(422, "VALIDATION", `「${e.title}」的日期区间不合法`);
  }

  const externalId = `${cmd.school}|${cmd.academicYear}|${cmd.termLabel}`;
  if (cmd.origin === "source" && cmd.sourceRevision && hasTombstone("academic", externalId, cmd.sourceRevision)) return "这一版校历已被你撤销，不再自动套用";
  const previous = activeAcademicCalendars().find((c) => c.school === cmd.school && c.academicYear === cmd.academicYear && c.termLabel === cmd.termLabel) ?? null;
  if (previous && cmd.sourceRevision && previous.sourceRevision === cmd.sourceRevision) return "校历没有变化";

  // 学期关联：同一学期原地修正，不另建第二个学期让课表失去关联
  let semesterId: string | null = previous?.semesterId ?? null;
  const notes: string[] = [];
  if (firstMonday && cmd.totalWeeks) {
    const termTo = addDays(firstMonday, (cmd.totalWeeks + cmd.skippedWeeks.length) * 7 - 1);
    const semester = (semesterId ? listSemesters().find((s) => s.id === semesterId) : null) ?? overlappingSemester(firstMonday, termTo);
    if (!semester) {
      semesterId = crypto.randomUUID();
      db.prepare(`INSERT INTO semesters (id, first_monday, total_weeks, timezone, fact_origin, source, created_at, updated_at) VALUES (?, ?, ?, ?, 'source', ?, ?, ?)`).run(semesterId, firstMonday, cmd.totalWeeks, tz, cmd.source, now(), now());
      changes.push({ entityKind: "semester", entityId: semesterId, action: "create", after: { firstMonday, totalWeeks: cmd.totalWeeks }, afterVersion: 1 });
      notes.push(`新建学期（首周 ${firstMonday}，共 ${cmd.totalWeeks} 周）`);
    } else {
      semesterId = semester.id;
      const anchorChanged = semester.firstMonday !== firstMonday || semester.totalWeeks !== cmd.totalWeeks;
      const skippedChanged = JSON.stringify(previous?.skippedWeeks ?? []) !== JSON.stringify(cmd.skippedWeeks);
      const hasCourses = Boolean(activeCourseSet(semester.id));
      if (anchorChanged && hasCourses && !cmd.confirmAnchorChange) {
        throw new HttpError(
          409,
          "ANCHOR_CONFLICT",
          `校历写的第一教学周是 ${firstMonday}（共 ${cmd.totalWeeks} 周），现有课表是按 ${semester.firstMonday}（共 ${semester.totalWeeks} 周）排的。要按校历修正课表日期吗？`,
        );
      }
      if (anchorChanged) {
        db.prepare(`UPDATE semesters SET first_monday = ?, total_weeks = ?, version = version + 1, updated_at = ? WHERE id = ?`).run(firstMonday, cmd.totalWeeks, now(), semester.id);
        changes.push({
          entityKind: "semester",
          entityId: semester.id,
          action: "update",
          before: { firstMonday: semester.firstMonday, totalWeeks: semester.totalWeeks },
          after: { firstMonday, totalWeeks: cmd.totalWeeks },
          beforeVersion: semester.version,
          afterVersion: semester.version + 1,
        });
        notes.push(`学期首周由 ${semester.firstMonday} 修正为 ${firstMonday}`);
      }
      if ((anchorChanged || skippedChanged) && hasCourses) {
        const n = reprojectActiveSet(semester.id, firstMonday, cmd.skippedWeeks, changes);
        if (n) notes.push(`课程日期随之重新展开（${n} 条规则变化）`);
      }
    }
  }

  if (previous) {
    db.prepare(`UPDATE academic_calendars SET status = 'superseded', version = version + 1, updated_at = ? WHERE id = ?`).run(now(), previous.id);
    changes.push({ entityKind: "academic_calendar", entityId: previous.id, action: "update", before: { status: "active" }, after: { status: "superseded" }, beforeVersion: previous.version, afterVersion: previous.version + 1 });
    // 旧版校历带来的学校范围例外随旧版失效；课程级与主人自己的例外更具体，保留
    const stale = db.prepare(`SELECT id, version FROM teaching_day_overrides WHERE calendar_id = ? AND status = 'active'`).all(previous.id) as Array<{ id: string; version: number }>;
    for (const o of stale) {
      db.prepare(`UPDATE teaching_day_overrides SET status = 'undone', version = version + 1, updated_at = ? WHERE id = ?`).run(now(), o.id);
      changes.push({ entityKind: "teaching_override", entityId: o.id, action: "update", before: { status: "active" }, after: { status: "undone" }, beforeVersion: o.version, afterVersion: o.version + 1 });
    }
  }

  const id = crypto.randomUUID();
  db.prepare(
    `INSERT INTO academic_calendars (id, school, audience, academic_year, term_label, semester_id, registration_date, teaching_start, first_monday, total_weeks, term_end, skipped_weeks_json, source, source_revision, origin, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, cmd.school, cmd.audience, cmd.academicYear, cmd.termLabel, semesterId, cmd.registrationDate, cmd.teachingStart, firstMonday, cmd.totalWeeks, cmd.termEnd, JSON.stringify(cmd.skippedWeeks), cmd.source, cmd.sourceRevision, cmd.origin, now(), now());
  changes.push({ entityKind: "academic_calendar", entityId: id, action: "create", after: { school: cmd.school, academicYear: cmd.academicYear, termLabel: cmd.termLabel, sourceRevision: cmd.sourceRevision }, afterVersion: 1 });
  linkSource({ entityKind: "academic_calendar", entityId: id, namespace: "intake", externalId: ctx.intakeId ?? "", itemKey: ctx.itemKey, evidence: cmd.source || ctx.evidence });

  const insertEvent = db.prepare(
    `INSERT INTO academic_calendar_events (id, calendar_id, kind, title, start_date, end_date, audience, cancels_classes, evidence, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const e of cmd.events) {
    const eventId = crypto.randomUUID();
    insertEvent.run(eventId, id, e.kind, e.title, e.startDate, e.endDate, e.audience, e.cancelsClasses ? 1 : 0, e.evidence, now(), now());
    changes.push({ entityKind: "academic_calendar_event", entityId: eventId, action: "create", after: { title: e.title, startDate: e.startDate, endDate: e.endDate }, afterVersion: 1 });
  }
  for (const o of cmd.overrides) {
    addSchoolMapping({ sourceTeachingDate: o.sourceTeachingDate, targetDate: o.targetDate, mode: o.mode, cancelSource: o.cancelSource, calendarId: id, origin: cmd.origin, source: cmd.source, evidence: o.evidence, note: "" }, changes);
  }
  bumpPlanningRevision();
  const label = [cmd.school, cmd.academicYear, cmd.termLabel].filter(Boolean).join(" ") || "校历";
  const parts = [`${label}已入库`, ...notes];
  if (cmd.events.length) parts.push(`${cmd.events.length} 个日期事项`);
  if (cmd.overrides.length) parts.push(`${cmd.overrides.length} 条补课映射`);
  return parts.join("；");
}

type SchoolMapping = { sourceTeachingDate: string; targetDate: string; mode: "replace" | "add"; cancelSource: boolean; calendarId: string | null; origin: "source" | "user"; source: string; evidence: string; note: string };

/** 学校范围的补课映射：校验源教学日存在、不成环、不重复去向，再落库 */
function addSchoolMapping(m: SchoolMapping, changes: ChangeInput[]): boolean {
  if (!validDate(m.sourceTeachingDate) || !validDate(m.targetDate)) throw new HttpError(422, "VALIDATION", "补课映射的日期不合法");
  if (m.sourceTeachingDate === m.targetDate) throw new HttpError(422, "VALIDATION", "补课的目标日期和原教学日期相同");
  const sameSource = overridesBySource(m.sourceTeachingDate).filter((o) => o.scope === "school" && o.mode !== "cancel");
  if (sameSource.some((o) => o.targetDate === m.targetDate && o.mode === m.mode)) return false; // 完全相同的映射已存在
  if (sameSource.length) {
    throw new HttpError(409, "MAPPING_CONFLICT", `${m.sourceTeachingDate} 的课已经安排补到 ${sameSource[0]!.targetDate}，同一天的课只能有一个去向；请确认以哪条为准`);
  }
  const sameTarget = overridesByTarget(m.targetDate).filter((o) => o.scope === "school");
  if (sameTarget.length) {
    throw new HttpError(409, "MAPPING_CONFLICT", `${m.targetDate} 已经安排补 ${sameTarget[0]!.sourceTeachingDate} 的课，请确认以哪条为准`);
  }
  // 链式映射含义不明（A 补到 B、B 又补到 C）：不猜
  if (overridesByTarget(m.sourceTeachingDate).some((o) => o.scope === "school") || overridesBySource(m.targetDate).some((o) => o.scope === "school" && o.mode !== "cancel")) {
    throw new HttpError(409, "MAPPING_CONFLICT", `${m.sourceTeachingDate} 或 ${m.targetDate} 已出现在别的补课映射里，无法确定按哪天的课上`);
  }
  if (calendarDay(m.sourceTeachingDate, instanceTimezone()).teachingWeek === null && listSemesters().length) {
    throw new HttpError(422, "INVALID_REFERENCE", `${m.sourceTeachingDate} 不在任何教学周内，不能作为补课来源`);
  }
  const id = insertTeachingOverride({ scope: "school", courseId: null, mode: m.mode, sourceTeachingDate: m.sourceTeachingDate, targetDate: m.targetDate, calendarId: m.calendarId, origin: m.origin, source: m.source, evidence: m.evidence, note: m.note });
  changes.push({ entityKind: "teaching_override", entityId: id, action: "create", after: { mode: m.mode, sourceTeachingDate: m.sourceTeachingDate, targetDate: m.targetDate }, afterVersion: 1 });
  if (m.cancelSource && !overridesBySource(m.sourceTeachingDate).some((o) => o.scope === "school" && o.mode === "cancel")) {
    const cancelId = insertTeachingOverride({ scope: "school", courseId: null, mode: "cancel", sourceTeachingDate: m.sourceTeachingDate, targetDate: null, calendarId: m.calendarId, origin: m.origin, source: m.source, evidence: m.evidence, note: `改到 ${m.targetDate} 上` });
    changes.push({ entityKind: "teaching_override", entityId: cancelId, action: "create", after: { mode: "cancel", sourceTeachingDate: m.sourceTeachingDate }, afterVersion: 1 });
  }
  return true;
}

/** 按名称或 ID 找进行中课表里的课程；找不到或有多个都不猜 */
function resolveCourse(courseId: string | null, courseName: string | null): { id: string; name: string } {
  const db = getDb();
  if (courseId) {
    const r = db.prepare(`SELECT c.id, c.name FROM courses c JOIN course_sets cs ON cs.id = c.course_set_id WHERE c.id = ? AND cs.status = 'active'`).get(courseId) as { id: string; name: string } | undefined;
    if (!r) throw new HttpError(422, "INVALID_REFERENCE", "找不到这门课");
    return r;
  }
  const name = (courseName ?? "").trim();
  if (!name) throw new HttpError(422, "VALIDATION", "需要说明是哪门课");
  const all = db.prepare(`SELECT c.id, c.name FROM courses c JOIN course_sets cs ON cs.id = c.course_set_id WHERE cs.status = 'active' ORDER BY c.name`).all() as Array<{ id: string; name: string }>;
  const exact = all.filter((c) => c.name === name);
  const hits = exact.length ? exact : all.filter((c) => c.name.includes(name) || name.includes(c.name));
  const names = [...new Set(hits.map((c) => c.name))];
  if (!names.length) throw new HttpError(422, "INVALID_REFERENCE", `进行中的课表里没有「${name}」`);
  if (names.length > 1) throw new HttpError(409, "AMBIGUOUS_REFERENCE", `「${name}」对应多门课：${names.join("、")}，请说清是哪一门`);
  return hits[0]!;
}

/** 单次教学日例外：某门课取消/移到别的时间，或整天停课/按另一天的课上 */
export function applyTeachingOverride(cmd: Cmd<"apply_teaching_day_override">, ctx: CommandContext, changes: ChangeInput[]): string {
  const tz = instanceTimezone();
  if (!validDate(cmd.sourceTeachingDate) || (cmd.targetDate && !validDate(cmd.targetDate))) throw new HttpError(422, "VALIDATION", "日期不合法");
  const source = cmd.sourceTeachingDate;
  const label = (d: string) => `${d}（周${WEEKDAY[isoWeekday(d) - 1]}）`;
  let summary: string;
  if (cmd.scope === "school") {
    if (cmd.mode === "move") throw new HttpError(422, "VALIDATION", "整天调课请用 replace 或 add");
    if (cmd.mode === "cancel") {
      if (overridesBySource(source).some((o) => o.scope === "school" && o.mode === "cancel")) return `${label(source)} 已是停课`;
      const id = insertTeachingOverride({ scope: "school", courseId: null, mode: "cancel", sourceTeachingDate: source, targetDate: null, origin: cmd.origin, source: ctx.intakeId ? `intake:${ctx.intakeId}` : "manual", evidence: cmd.evidence || ctx.evidence, note: cmd.note });
      changes.push({ entityKind: "teaching_override", entityId: id, action: "create", after: { mode: "cancel", sourceTeachingDate: source }, afterVersion: 1 });
      summary = `${label(source)} 全天停课`;
    } else {
      if (!cmd.targetDate) throw new HttpError(422, "VALIDATION", "需要目标日期");
      const added = addSchoolMapping({ sourceTeachingDate: source, targetDate: cmd.targetDate, mode: cmd.mode, cancelSource: cmd.cancelSource, calendarId: null, origin: cmd.origin, source: ctx.intakeId ? `intake:${ctx.intakeId}` : "manual", evidence: cmd.evidence || ctx.evidence, note: cmd.note }, changes);
      if (!added) return `${label(cmd.targetDate)} 已按 ${label(source)} 的课上，没有变化`;
      summary = `${label(cmd.targetDate)} 按 ${label(source)} 的课表上课${cmd.mode === "add" ? "（在原有课程之外增加）" : ""}${cmd.cancelSource ? `；${label(source)} 当天不上` : ""}`;
    }
  } else {
    const course = resolveCourse(cmd.courseId, cmd.courseName);
    const day = calendarDay(source, tz);
    if (!day.courses.some((c) => c.courseId === course.id && c.origin === "regular")) {
      throw new HttpError(422, "INVALID_REFERENCE", `${label(source)} 没有「${course.name}」这门课`);
    }
    if (cmd.mode === "cancel") {
      const id = insertTeachingOverride({ scope: "course", courseId: course.id, mode: "cancel", sourceTeachingDate: source, targetDate: null, origin: cmd.origin, source: ctx.intakeId ? `intake:${ctx.intakeId}` : "manual", evidence: cmd.evidence || ctx.evidence, note: cmd.note });
      changes.push({ entityKind: "teaching_override", entityId: id, action: "create", after: { mode: "cancel", courseId: course.id, sourceTeachingDate: source }, afterVersion: 1 });
      summary = `${course.name} ${label(source)} 这次停课`;
    } else if (cmd.mode === "move") {
      if (!cmd.targetDate) throw new HttpError(422, "VALIDATION", "需要调到哪一天");
      if (Boolean(cmd.targetStart) !== Boolean(cmd.targetEnd)) throw new HttpError(422, "VALIDATION", "改钟点需要同时给开始和结束");
      if (cmd.targetStart && cmd.targetEnd && cmd.targetStart >= cmd.targetEnd) throw new HttpError(422, "VALIDATION", "结束时间必须晚于开始时间");
      const id = insertTeachingOverride({ scope: "course", courseId: course.id, mode: "move", sourceTeachingDate: source, targetDate: cmd.targetDate, targetStart: cmd.targetStart, targetEnd: cmd.targetEnd, origin: cmd.origin, source: ctx.intakeId ? `intake:${ctx.intakeId}` : "manual", evidence: cmd.evidence || ctx.evidence, note: cmd.note });
      changes.push({ entityKind: "teaching_override", entityId: id, action: "create", after: { mode: "move", courseId: course.id, sourceTeachingDate: source, targetDate: cmd.targetDate }, afterVersion: 1 });
      summary = `${course.name} 由 ${label(source)} 调到 ${label(cmd.targetDate)}${cmd.targetStart ? ` ${cmd.targetStart}–${cmd.targetEnd}` : ""}`;
    } else {
      throw new HttpError(422, "VALIDATION", "单门课只支持取消（cancel）或移动（move）");
    }
  }
  bumpPlanningRevision();
  return summary;
}

export const CALENDAR_SYNC_POLICY_KEY = "calendarSyncPolicy";
export type CalendarSyncPolicy = { enabled: boolean; school: string; audience: "all" | "undergraduate" | "graduate"; intervalDays: number; holidayUrls: Record<string, string>; academicUrl: string };
export const DEFAULT_CALENDAR_SYNC_POLICY: CalendarSyncPolicy = { enabled: false, school: "", audience: "all", intervalDays: 7, holidayUrls: {}, academicUrl: "" };

export function calendarSyncPolicy(): CalendarSyncPolicy {
  return { ...DEFAULT_CALENDAR_SYNC_POLICY, ...((getSetting(CALENDAR_SYNC_POLICY_KEY).value as Partial<CalendarSyncPolicy> | null) ?? {}) };
}

/** 有限来源刷新的政策：开关、学校/人群、检查间隔与官方入口；worker 读同一份设置 */
export function applyCalendarSyncPolicy(cmd: Cmd<"update_calendar_sync_policy">, _ctx: CommandContext, changes: ChangeInput[]): string {
  const db = getDb();
  const entry = getSetting(CALENDAR_SYNC_POLICY_KEY);
  const before = calendarSyncPolicy();
  const after: CalendarSyncPolicy = {
    enabled: cmd.enabled ?? before.enabled,
    school: cmd.school ?? before.school,
    audience: cmd.audience ?? before.audience,
    intervalDays: cmd.intervalDays ?? before.intervalDays,
    holidayUrls: cmd.holidayUrl ? { ...before.holidayUrls, [String(cmd.holidayYear ?? new Date().getUTCFullYear())]: cmd.holidayUrl } : before.holidayUrls,
    academicUrl: cmd.academicUrl ?? before.academicUrl,
  };
  if (JSON.stringify(before) === JSON.stringify(after) && entry.version > 0) return "日历自动更新设置没有变化";
  if (entry.version === 0) {
    db.prepare(`INSERT INTO settings (key, value_json, version, updated_at) VALUES (?, ?, 1, ?)`).run(CALENDAR_SYNC_POLICY_KEY, JSON.stringify(after), now());
    changes.push({ entityKind: "setting", entityId: CALENDAR_SYNC_POLICY_KEY, action: "create", after: { ...after }, afterVersion: 1 });
  } else {
    db.prepare(`UPDATE settings SET value_json = ?, version = version + 1, updated_at = ? WHERE key = ?`).run(JSON.stringify(after), now(), CALENDAR_SYNC_POLICY_KEY);
    changes.push({ entityKind: "setting", entityId: CALENDAR_SYNC_POLICY_KEY, action: "update", before: { valueJson: JSON.stringify(before) }, after: { valueJson: JSON.stringify(after) }, beforeVersion: entry.version, afterVersion: entry.version + 1 });
  }
  const parts = [after.enabled ? `自动更新已开启，每 ${after.intervalDays} 天核对一次` : "自动更新已关闭（已入库的日期保留）"];
  if (after.school) parts.push(`学校：${after.school}`);
  return parts.join("；");
}
