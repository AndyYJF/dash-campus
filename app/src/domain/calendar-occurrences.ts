import { addDays, localDateInTz, resolveWallTime, tzOffsetMs, type WallTimeAdjustment } from './time';
import type { AvailabilityRow, FixedEventRow } from './workload';
import { getDb } from '@/repositories/db';
type Exception = { cancelled: number; local_start: string | null; local_end: string | null; version:number };
export type CalendarOccurrence = {key:string;ruleId:string;ruleVersion:number;exceptionVersion:number;title:string;localDate:string;timezone:string;start:string;end:string;startOffsetMinutes:number;endOffsetMinutes:number;startAdjustment:WallTimeAdjustment;endAdjustment:WallTimeAdjustment;collapsed:boolean};
/** Expand in each row's timezone, including both dates of overnight tasks. */
export function occurrences(row: AvailabilityRow | FixedEventRow, start: number, end: number): [number, number][] {
  return detailedOccurrences(row,start,end).filter(o=>!o.collapsed).map(o=>[Date.parse(o.start),Date.parse(o.end)]);
}
/** Derived occurrences retain rule identity and DST choices without a second scheduling store. */
export function detailedOccurrences(row: AvailabilityRow | FixedEventRow, start: number, end: number): CalendarOccurrence[] {
  const first = localDateInTz(new Date(start), row.timezone);
  const last = localDateInTz(new Date(end - 1), row.timezone);
  const out: CalendarOccurrence[] = [];
  for (let date = first; date <= last; date = addDays(date, 1)) {
    const dow = ((new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7) + 1;
    if (row.weekday !== dow || (row.validFrom && date < row.validFrom) || (row.validUntil && date > row.validUntil)) continue;
    if ('eventDate' in row && row.eventDate && row.eventDate !== date) continue;
    const exception = 'eventDate' in row ? getDb().prepare('SELECT * FROM fixed_event_exceptions WHERE event_id=? AND local_date=?').get(row.id, date) as Exception | undefined : undefined;
    if (exception?.cancelled) continue;
    const s=resolveWallTime(date,exception?.local_start??row.localStart,row.timezone),e=resolveWallTime(date,exception?.local_end??row.localEnd,row.timezone);
    const startOffsetMinutes=tzOffsetMs(s.instant,row.timezone)/60000,endOffsetMinutes=tzOffsetMs(e.instant,row.timezone)/60000;
    const ruleVersion=row.version??1,exceptionVersion=exception?.version??0;
    out.push({key:JSON.stringify([row.id,ruleVersion,date,startOffsetMinutes,endOffsetMinutes,exceptionVersion]),ruleId:row.id,ruleVersion,exceptionVersion,title:row.title,localDate:date,timezone:row.timezone,start:s.instant.toISOString(),end:e.instant.toISOString(),startOffsetMinutes,endOffsetMinutes,startAdjustment:s.adjustment,endAdjustment:e.adjustment,collapsed:e.instant.getTime()<=s.instant.getTime()});
  }
  return out;
}
