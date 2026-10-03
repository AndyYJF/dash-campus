import crypto from 'node:crypto';
import type { TimetableInput } from '@/contracts/timetable';
import type { CalendarInput } from '@/contracts/calendar';
import { parseTimetable } from '@/domain/timetable';
import { getDb } from './db';
import { bumpPlanningRevision, getPlanningRevision } from './proposals';
import { HttpError } from '@/workflows/http';

function identicalRule(rule: CalendarInput): boolean {
  return Boolean(getDb().prepare(`SELECT id FROM fixed_events WHERE title=? AND weekday=? AND local_start=? AND local_end=? AND timezone=? AND valid_from IS ? AND valid_until IS ? AND event_date IS ?`).get(rule.title, rule.weekday, rule.localStart, rule.localEnd, rule.timezone, rule.validFrom, rule.validUntil, rule.eventDate));
}
export function previewTimetable(input: TimetableInput) {
  return getDb().transaction(() => {
    const timetable = parseTimetable(input), seen = new Set<string>();
    let newRules = 0, duplicateRules = 0;
    for (const rule of timetable.courses.flatMap(c => c.rules)) {
      const key = JSON.stringify(rule);
      if (seen.has(key) || identicalRule(rule)) duplicateRules++; else newRules++;
      seen.add(key);
    }
    return { ...timetable, planningRevision: getPlanningRevision(), newRules, duplicateRules };
  })();
}
export function importTimetable(input: TimetableInput, expectedRevision: number) {
  return getDb().transaction(() => {
    if (getPlanningRevision() !== expectedRevision) throw new HttpError(409, 'CONFLICT', '课程或计划已发生变化，请重新预览课表');
    const timetable = parseTimetable(input), ids: string[] = [];
    let skipped = 0;
    const insert = getDb().prepare(`INSERT INTO fixed_events(id,title,weekday,local_start,local_end,timezone,valid_from,valid_until,event_date) VALUES(?,?,?,?,?,?,?,?,?)`);
    for (const r of timetable.courses.flatMap(c => c.rules)) {
      if (identicalRule(r)) { skipped++; continue; }
      const id = crypto.randomUUID();
      insert.run(id, r.title, r.weekday, r.localStart, r.localEnd, r.timezone, r.validFrom, r.validUntil, r.eventDate);
      ids.push(id);
    }
    if (ids.length) bumpPlanningRevision();
    return { created: ids.length, skipped, ids, planningRevision: getPlanningRevision() };
  }).immediate();
}
