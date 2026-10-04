import { getDb } from "@/repositories/db";
import { occurrences } from "@/domain/calendar-occurrences";
import { addDays, mondayOf, wallTimeToUtc } from "@/domain/time";
import { isoWeekday } from "@/domain/day-policy";
import { mergeIntervals, type Interval } from "@/domain/budget";
import {
  activeAcademicCalendars,
  activeHolidayDataset,
  calendarEventsOn,
  holidayOn,
  listSemesters,
  overridesBySource,
  overridesByTarget,
  type CalendarEventRow,
  type TeachingOverrideRow,
} from "@/repositories/calendar-facts";
import { getFactByField } from "@/repositories/profile";

/**
 * 统一日历解释器（ACADEMIC-CALENDAR-AND-HOLIDAYS §5）：
 * 输入当地日期，输出公历日类型、教学周/阶段、有效课程实例及其来源。预算、排程、页面都只读这里。
 * civilDayType 与 teachingWeek 分开；课程先按原教学日期展开，再应用明确的单日/范围例外；
 * 补课映射从源教学日搬到目标日（周次、单双周按源日判断）；国家补班不推导补哪天的课。
 */

export type CourseInstance = {
  /** 源实例标识：规则 + 原教学日期；搬到别的日期也不变 */
  occurrenceId: string;
  fixedEventId: string;
  courseId: string | null;
  courseName: string;
  title: string;
  teacher: string;
  location: string;
  date: string;
  sourceDate: string;
  interval: Interval;
  origin: "regular" | "makeup" | "moved";
  overrideId: string | null;
};

export type FixedInstance = { id: string; title: string; interval: Interval };

export type CivilDay = {
  type: "workday" | "weekend" | "holiday" | "adjusted_workday";
  name: string | null;
  /** 该年度是否已有核对过的国家安排；false 时不能说“全年无节假日” */
  known: boolean;
  origin: string | null;
  sourceUrl: string | null;
};

export type TeachingStatus = "normal" | "cancelled" | "makeup" | "pending" | "none";

export type CalendarDay = {
  date: string;
  weekday: number;
  civil: CivilDay;
  semesterId: string | null;
  teachingWeek: number | null;
  phase: "teaching" | "exam" | "school_holiday" | "out_of_term" | "unknown";
  schoolEvents: Array<{ id: string; kind: string; title: string; cancelsClasses: boolean }>;
  teaching: { status: TeachingStatus; note: string; sourceTeachingDate: string | null; mode: string | null; overrideIds: string[] };
  courses: CourseInstance[];
  fixed: FixedInstance[];
  /** 学校安排待核对时的保守预留（可能的上课时段），不显示为已确认课程 */
  pending: Interval[];
};

type CourseRule = {
  id: string;
  title: string;
  weekday: number;
  localStart: string;
  localEnd: string;
  timezone: string;
  eventDate: string | null;
  validFrom: string | null;
  validUntil: string | null;
  courseId: string | null;
  courseName: string;
  teacher: string;
  location: string;
};

function dayRange(date: string, tz: string): Interval {
  return [wallTimeToUtc(date, "00:00", tz).getTime(), wallTimeToUtc(addDays(date, 1), "00:00", tz).getTime()];
}

function ruleFromRow(r: Record<string, unknown>): CourseRule {
  return {
    id: r.id as string,
    title: r.title as string,
    weekday: r.weekday as number,
    localStart: r.local_start as string,
    localEnd: r.local_end as string,
    timezone: r.timezone as string,
    eventDate: (r.event_date as string | null) ?? null,
    validFrom: (r.valid_from as string | null) ?? null,
    validUntil: (r.valid_until as string | null) ?? null,
    courseId: (r.course_id as string | null) ?? null,
    courseName: (r.course_name as string | null) ?? "",
    teacher: (r.teacher as string | null) ?? "",
    location: (r.location as string | null) ?? "",
  };
}

/** 进行中课表的课程规则（每条固定活动规则只取一次）与非课程固定活动 */
function loadRules(): { courses: CourseRule[]; fixed: CourseRule[] } {
  const db = getDb();
  const courseRows = db
    .prepare(
      `SELECT fe.*, MIN(c.id) AS course_id, MIN(c.name) AS course_name, MIN(c.teacher) AS teacher, MIN(c.location) AS location
       FROM fixed_events fe
       JOIN course_meeting_projections p ON p.fixed_event_id = fe.id
       JOIN course_meetings m ON m.id = p.meeting_id
       JOIN courses c ON c.id = m.course_id
       JOIN course_sets cs ON cs.id = c.course_set_id AND cs.status = 'active'
       GROUP BY fe.id ORDER BY fe.id`,
    )
    .all() as Array<Record<string, unknown>>;
  // 没有任何课程投影的才是普通固定活动；只属于已归档课表的投影不再占时
  const fixedRows = db
    .prepare(`SELECT fe.* FROM fixed_events fe WHERE NOT EXISTS (SELECT 1 FROM course_meeting_projections p WHERE p.fixed_event_id = fe.id) ORDER BY fe.id`)
    .all() as Array<Record<string, unknown>>;
  return { courses: courseRows.map(ruleFromRow), fixed: fixedRows.map(ruleFromRow) };
}

/**
 * 某个原教学日期按课表本应有的课程实例。
 * 课程级的单次取消/移动（更具体的事实）在这里就排除；学校范围的停课不在这里处理，
 * 因为被停课的那天正是补课映射的来源。
 */
function regularCourses(date: string, tz: string, rules: CourseRule[], opts: { onlyCourseId?: string; ignoreCourseOverrides?: boolean } = {}): CourseInstance[] {
  const [first, last] = dayRange(date, tz);
  const db = getDb();
  const legacyCancelled = new Set(
    (db.prepare(`SELECT course_name FROM course_event_exceptions WHERE event_date = ?`).all(date) as Array<{ course_name: string }>).map((r) => r.course_name),
  );
  const courseOverrides = opts.ignoreCourseOverrides ? [] : overridesBySource(date).filter((o) => o.scope === "course");
  const out: CourseInstance[] = [];
  for (const rule of rules) {
    if (opts.onlyCourseId && rule.courseId !== opts.onlyCourseId) continue;
    if (!opts.ignoreCourseOverrides) {
      if (legacyCancelled.has(rule.courseName) || [...legacyCancelled].some((name) => !rule.courseName && rule.title.startsWith(name))) continue;
      if (courseOverrides.some((o) => o.courseId === rule.courseId)) continue;
    }
    for (const [s, e] of occurrences(rule, first, last)) {
      out.push({
        occurrenceId: `${rule.id}@${date}`,
        fixedEventId: rule.id,
        courseId: rule.courseId,
        courseName: rule.courseName || rule.title,
        title: rule.title,
        teacher: rule.teacher,
        location: rule.location,
        date,
        sourceDate: date,
        interval: [s, e],
        origin: "regular",
        overrideId: null,
      });
    }
  }
  return out;
}

/** 把源教学日的课程实例搬到目标日期：保留当地钟点（课程级移动可改钟点），源实例标识不变 */
function transpose(instances: CourseInstance[], rules: CourseRule[], target: string, override: TeachingOverrideRow, origin: "makeup" | "moved"): CourseInstance[] {
  return instances.map((inst) => {
    const rule = rules.find((r) => r.id === inst.fixedEventId)!;
    const start = override.targetStart ?? rule.localStart;
    const end = override.targetEnd ?? rule.localEnd;
    return {
      ...inst,
      date: target,
      interval: [wallTimeToUtc(target, start, rule.timezone).getTime(), wallTimeToUtc(target, end, rule.timezone).getTime()] as Interval,
      origin,
      overrideId: override.id,
    };
  });
}

/** 主人已确认的学历层次；未知时只应用面向所有人的校历事项 */
function ownerAudience(): "undergraduate" | "graduate" | null {
  const fact = getFactByField("education_level")?.value ?? "";
  if (/本科/.test(fact)) return "undergraduate";
  if (/研究生|硕士|博士/.test(fact)) return "graduate";
  return null;
}

function eventApplies(e: CalendarEventRow, audience: string | null): boolean {
  return e.audience === "all" || e.audience === audience;
}

export function teachingWeekOf(date: string): { semesterId: string; week: number | null; firstMonday: string; totalWeeks: number } | null {
  const semesters = listSemesters();
  const calendars = activeAcademicCalendars();
  for (const s of [...semesters].reverse()) {
    const skipped = calendars.find((c) => c.semesterId === s.id)?.skippedWeeks ?? [];
    const span = (s.totalWeeks + skipped.length) * 7;
    if (date < s.firstMonday || date >= addDays(s.firstMonday, span)) continue;
    const monday = mondayOf(date);
    if (skipped.includes(monday)) return { semesterId: s.id, week: null, firstMonday: s.firstMonday, totalWeeks: s.totalWeeks };
    const index = Math.round((Date.parse(`${monday}T00:00:00Z`) - Date.parse(`${s.firstMonday}T00:00:00Z`)) / (7 * 86_400_000)) + 1;
    const week = index - skipped.filter((m) => m < monday).length;
    return { semesterId: s.id, week: week >= 1 && week <= s.totalWeeks ? week : null, firstMonday: s.firstMonday, totalWeeks: s.totalWeeks };
  }
  return null;
}

export function calendarDay(date: string, tz: string): CalendarDay {
  const rules = loadRules();
  const weekday = isoWeekday(date);
  const audience = ownerAudience();

  // 公历日类型：只来自已入库的年度安排；没有该年度数据时照常按星期，但标 known=false
  const holiday = holidayOn(date);
  const known = Boolean(activeHolidayDataset(Number(date.slice(0, 4))));
  const civil: CivilDay = holiday
    ? { type: holiday.kind, name: holiday.name, known: true, origin: holiday.origin, sourceUrl: holiday.sourceUrl }
    : { type: weekday >= 6 ? "weekend" : "workday", name: null, known, origin: null, sourceUrl: null };

  const schoolEvents = calendarEventsOn(date).filter((e) => eventApplies(e, audience));
  const bySource = overridesBySource(date);
  const byTarget = overridesByTarget(date);
  const closureEvent = schoolEvents.find((e) => e.cancelsClasses);
  const closureOverride = bySource.find((o) => o.scope === "school" && o.mode === "cancel");
  const closed = Boolean(closureEvent || closureOverride);

  let courses = closed ? [] : regularCourses(date, tz, rules.courses);
  const overrideIds: string[] = closureOverride ? [closureOverride.id] : [];
  let status: TeachingStatus = closed ? "cancelled" : courses.length ? "normal" : "none";
  let note = closed ? `停课：${closureEvent?.title ?? closureOverride?.note ?? "学校安排"}` : "";
  let sourceTeachingDate: string | null = null;
  let mode: string | null = null;

  for (const o of byTarget.filter((x) => x.scope === "school" && (x.mode === "replace" || x.mode === "add"))) {
    const moved = transpose(regularCourses(o.sourceTeachingDate, tz, rules.courses), rules.courses, date, o, "makeup");
    courses = o.mode === "replace" ? moved : [...courses, ...moved];
    status = "makeup";
    sourceTeachingDate = o.sourceTeachingDate;
    mode = o.mode;
    overrideIds.push(o.id);
    const src = teachingWeekOf(o.sourceTeachingDate);
    note = `补${src?.week ? `第 ${src.week} 周` : ""}周${"一二三四五六日"[isoWeekday(o.sourceTeachingDate) - 1]}（${o.sourceTeachingDate}）的课`;
  }
  for (const o of byTarget.filter((x) => x.scope === "course" && x.mode === "move" && x.courseId)) {
    const src = regularCourses(o.sourceTeachingDate, tz, rules.courses, { onlyCourseId: o.courseId!, ignoreCourseOverrides: true });
    courses = [...courses, ...transpose(src, rules.courses, date, o, "moved")];
    overrideIds.push(o.id);
    if (status === "none") status = "normal";
  }

  // 只有国家安排、没有学校规则：教学安排待核对。调整上班的周末保守预留可能的上课时段；
  // 放假日保留原课程占用，不显示为已确认停课。
  let pending: Interval[] = [];
  const hasSchoolRule = closed || byTarget.some((o) => o.scope === "school");
  if (!hasSchoolRule && civil.type === "adjusted_workday" && weekday >= 6) {
    const monday = mondayOf(date);
    const envelope: Interval[] = [];
    for (let i = 0; i < 5; i++) {
      const source = addDays(monday, i);
      const pseudo = { id: "pending", scope: "school", courseId: null, mode: "add", sourceTeachingDate: source, targetDate: date, targetStart: null, targetEnd: null } as unknown as TeachingOverrideRow;
      for (const inst of transpose(regularCourses(source, tz, rules.courses), rules.courses, date, pseudo, "makeup")) envelope.push(inst.interval);
    }
    pending = mergeIntervals(envelope);
    if (pending.length) {
      status = "pending";
      note = "国家调整为上班日，学校是否补课、补哪天的课待核对";
    }
  } else if (!hasSchoolRule && civil.type === "holiday" && courses.length) {
    status = "pending";
    note = `${civil.name ?? "国家节假日"}：学校是否停课待核对，暂按原课表预留`;
  }

  const week = teachingWeekOf(date);
  const phase: CalendarDay["phase"] = schoolEvents.some((e) => e.kind === "exam")
    ? "exam"
    : schoolEvents.some((e) => e.kind === "holiday")
      ? "school_holiday"
      : week?.week
        ? "teaching"
        : listSemesters().length
          ? "out_of_term"
          : "unknown";

  const [first, last] = dayRange(date, tz);
  const fixed: FixedInstance[] = [];
  for (const rule of rules.fixed) for (const [s, e] of occurrences(rule, first, last)) fixed.push({ id: rule.id, title: rule.title, interval: [s, e] });

  courses.sort((a, b) => a.interval[0] - b.interval[0] || (a.occurrenceId < b.occurrenceId ? -1 : 1));
  return {
    date,
    weekday,
    civil,
    semesterId: week?.semesterId ?? null,
    teachingWeek: week?.week ?? null,
    phase,
    schoolEvents: schoolEvents.map((e) => ({ id: e.id, kind: e.kind, title: e.title, cancelsClasses: e.cancelsClasses })),
    teaching: { status, note, sourceTeachingDate, mode, overrideIds },
    courses,
    fixed,
    pending,
  };
}
