import { NextResponse, type NextRequest } from "next/server";
import { requireOwner } from "@/workflows/auth-guard";
import { errorResponse } from "@/workflows/http";
import { addDays, instanceTimezone } from "@/domain/time";
import { calendarDay } from "@/workflows/calendar";
import { calendarSyncStatus } from "@/workflows/calendar-sync";
import { calendarSyncPolicy } from "@/workflows/ops/calendar";

export const dynamic = "force-dynamic";

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_DAYS = 62;

/**
 * GET /api/v2/calendar-context?from=&to=：指定日期范围的公历日类型、教学周/阶段、有效课程、来源与同步状态。
 * 与预算、排程、页面共用同一个日历解释器；纯读取，只返回范围内的日期，不带整个历史。
 */
export async function GET(request: NextRequest) {
  const auth = requireOwner(request);
  if (!auth.ok) return auth.response;
  const q = request.nextUrl.searchParams;
  const from = q.get("from") ?? "";
  const to = q.get("to") ?? from;
  if (!DATE.test(from) || !DATE.test(to) || to < from) return errorResponse("VALIDATION", "需要 from/to（YYYY-MM-DD），且 to 不早于 from", 422);
  const tz = instanceTimezone();
  const days = [];
  for (let d = from, n = 0; d <= to && n < MAX_DAYS; d = addDays(d, 1), n++) {
    const c = calendarDay(d, tz);
    days.push({
      date: d,
      weekday: c.weekday,
      civil: c.civil,
      teachingWeek: c.teachingWeek,
      phase: c.phase,
      teaching: c.teaching,
      schoolEvents: c.schoolEvents,
      courses: c.courses.map((x) => ({ occurrenceId: x.occurrenceId, courseId: x.courseId, name: x.courseName, teacher: x.teacher, location: x.location, startUtc: new Date(x.interval[0]).toISOString(), endUtc: new Date(x.interval[1]).toISOString(), sourceDate: x.sourceDate, origin: x.origin })),
      pending: c.pending.map(([s, e]) => ({ startUtc: new Date(s).toISOString(), endUtc: new Date(e).toISOString() })),
    });
  }
  const policy = calendarSyncPolicy();
  return NextResponse.json({ from, to, truncated: addDays(from, MAX_DAYS - 1) < to, days, sync: { enabled: policy.enabled, intervalDays: policy.intervalDays, school: policy.school, sources: calendarSyncStatus() } });
}
