import type { CalendarInput } from '@/contracts/calendar';
import { calendarSchema } from '@/contracts/calendar';
import type { TimetableInput } from '@/contracts/timetable';
import { timetableInputSchema } from '@/contracts/timetable';
import { addDays } from './time';

export type TimetableCourse = {
  line: number; name: string; teacher: string; location: string; weekday: number;
  periods: number[]; weeks: number[]; localStart: string; localEnd: string;
  dates: string[]; rules: CalendarInput[];
};
export type Timetable = { totalWeeks: number; firstMonday: string; timezone: string; courses: TimetableCourse[]; ruleCount: number; occurrenceCount: number };

export class TimetableError extends Error {}
function fail(line: number, message: string): never { throw new TimetableError(`第 ${line} 行：${message}`); }
function integers(value: string, limit: number, line: number): number[] {
  const result = new Set<number>();
  for (const segment of value.split(',')) {
    const match = /^(\d+)(?:-(\d+))?$/.exec(segment.trim());
    if (!match) fail(line, `“${value}”必须使用数字、逗号或范围，例如 3-18 或 6,10`);
    const start = Number(match[1]), end = Number(match[2] ?? match[1]);
    if (start < 1 || end > limit || start > end) fail(line, `范围必须在 1–${limit} 内且从小到大`);
    for (let n = start; n <= end; n++) result.add(n);
  }
  return [...result].sort((a, b) => a - b);
}
function runs(values: number[]): number[][] {
  const result: number[][] = [];
  for (const n of values) { const last = result[result.length - 1]; if (last && last[last.length - 1] + 1 === n) last.push(n); else result.push([n]); }
  return result;
}

/** SDCT1 is parsed deterministically. Unknown fields fail rather than silently losing timetable semantics. */
export function parseTimetable(input: TimetableInput): Timetable {
  const validated = timetableInputSchema.safeParse(input);
  if (!validated.success) throw new TimetableError(validated.error.issues.map(i => i.message).join('；'));
  const { text, firstMonday, timezone } = validated.data;
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).map((text, i) => ({ text: text.trim(), line: i + 1 })).filter(l => l.text);
  if (lines.shift()?.text !== 'SDCT1') throw new TimetableError('第一行必须是 SDCT1');
  let totalWeeks = 0;
  const periods = new Map<number, { start: string; end: string }>();
  const courseLines: { text: string; line: number }[] = [];
  for (const l of lines) {
    if (l.text.startsWith('T=')) {
      if (totalWeeks || !/^T=\d+$/.test(l.text)) fail(l.line, 'T 必须唯一且为学期总周数');
      totalWeeks = Number(l.text.slice(2));
      if (totalWeeks < 1 || totalWeeks > 60) fail(l.line, '学期周数必须在 1–60 内');
    } else if (l.text.startsWith('P=')) {
      if (periods.size) fail(l.line, 'P 节次时间表只能出现一次');
      for (const segment of l.text.slice(2).split(';')) {
        const match = /^(\d+),(([01]\d|2[0-3]):[0-5]\d)-(([01]\d|2[0-3]):[0-5]\d)$/.exec(segment.trim());
        if (!match) fail(l.line, '节次格式应为 1,08:15-09:00');
        const n = Number(match[1]), start = match[2], end = match[4];
        if (n < 1 || n > 30 || periods.has(n) || start >= end) fail(l.line, '节次必须唯一，且开始时间早于结束时间');
        periods.set(n, { start, end });
      }
    } else if (l.text.startsWith('C=')) courseLines.push(l);
    else fail(l.line, '不认识此字段，仅支持 T、P、C');
  }
  if (!totalWeeks || !periods.size || !courseLines.length) throw new TimetableError('需要完整的 T、P 和至少一条 C 课程');
  if (courseLines.length > 100) throw new TimetableError('一次最多导入 100 条课程安排');
  const ordered = [...periods].sort((a, b) => a[0] - b[0]);
  for (let i = 1; i < ordered.length; i++) if (ordered[i][1].start < ordered[i - 1][1].end) throw new TimetableError('节次时间必须随节次递增，不能重叠');
  const courses: TimetableCourse[] = courseLines.map(l => {
    const fields = l.text.slice(2).split('|').map(s => s.trim());
    if (fields.length !== 8) fail(l.line, 'C 需要课程|教师|地点|周几|节次|周次|A/O/E|- 共八项');
    const [name, teacher, location, day, periodText, weekText, parity, reserved] = fields;
    if (!name || !/^[1-7]$/.test(day)) fail(l.line, '课程名称不能为空，周几须为 1–7');
    if (!['A', 'O', 'E'].includes(parity)) fail(l.line, '周标记只支持 A（全部）、O（单周）、E（双周）');
    if (reserved !== '-') fail(l.line, '最后一项目前仅支持 -，请先将特殊调课手动录入');
    const selectedPeriods = integers(periodText, 30, l.line);
    for (const n of selectedPeriods) if (!periods.has(n)) fail(l.line, `第 ${n} 节没有时间定义`);
    let weeks = integers(weekText, totalWeeks, l.line);
    if (parity !== 'A') weeks = weeks.filter(w => w % 2 === (parity === 'O' ? 1 : 0));
    if (!weeks.length) fail(l.line, '所选周次与单双周标记没有交集');
    const weekday = Number(day), dates = weeks.map(w => addDays(firstMonday, (w - 1) * 7 + weekday - 1));
    const rules: CalendarInput[] = [];
    for (const span of runs(selectedPeriods)) for (const weekRun of runs(weeks)) {
      const title = [name, teacher && teacher !== '-' ? teacher : '', location && location !== '-' ? location : ''].filter(Boolean).join(' · ');
      const rule = { title, weekday, localStart: periods.get(span[0])!.start, localEnd: periods.get(span[span.length - 1])!.end, timezone,
        validFrom: addDays(firstMonday, (weekRun[0] - 1) * 7 + weekday - 1), validUntil: addDays(firstMonday, (weekRun[weekRun.length - 1] - 1) * 7 + weekday - 1), eventDate: null };
      const checked = calendarSchema.safeParse(rule);
      if (!checked.success) fail(l.line, checked.error.issues.map(i => i.message).join('；'));
      rules.push(checked.data);
    }
    return { line: l.line, name, teacher, location, weekday, periods: selectedPeriods, weeks,
      localStart: periods.get(selectedPeriods[0])!.start, localEnd: periods.get(selectedPeriods[selectedPeriods.length - 1])!.end, dates, rules };
  });
  const ruleCount = courses.reduce((n, c) => n + c.rules.length, 0);
  if (ruleCount > 1500) throw new TimetableError('拆分后的时段超过 1500 条，请分批导入');
  return { totalWeeks, firstMonday, timezone, courses, ruleCount, occurrenceCount: courses.reduce((n, c) => n + c.weeks.length * runs(c.periods).length, 0) };
}
