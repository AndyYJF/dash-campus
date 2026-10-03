import crypto from 'node:crypto';
import { getDb } from './db';
import { bumpPlanningRevision } from './proposals';
import type { CalendarInput, calendarExceptionSchema } from '@/contracts/calendar';
import type { z } from 'zod';
export function calendarTable(kind:string|null) { return kind==='availability'?'availability_blocks':kind==='fixed-event'?'fixed_events':null; }
export function writeCalendar(kind:string,id:string|null,input:CalendarInput,expectedVersion?:number):string|'conflict'|'not_found' {
 const table=calendarTable(kind);if(!table)throw new Error('unknown calendar kind');
 const db=getDb();return db.transaction(()=>{
  const row=id?db.prepare(`SELECT version FROM ${table} WHERE id=?`).get(id) as {version:number}|undefined:undefined;
  if(id&&!row)return 'not_found';if(id&&row!.version!==expectedVersion)return 'conflict';
  const values:Record<string,unknown>={title:input.title,weekday:input.weekday,local_start:input.localStart,local_end:input.localEnd,timezone:input.timezone,valid_from:input.validFrom,valid_until:input.validUntil};
  if(table==='fixed_events')values.event_date=input.eventDate;
  const key=id??crypto.randomUUID(),cols=Object.keys(values);
  if(id)db.prepare(`UPDATE ${table} SET ${cols.map(c=>`${c}=?`).join(',')},version=version+1 WHERE id=?`).run(...Object.values(values),id);
  else db.prepare(`INSERT INTO ${table} (id,${cols.join(',')}) VALUES (${cols.map(()=>'?').join(',')},?)`).run(key,...Object.values(values));
  bumpPlanningRevision();return key;
 }).immediate();
}
export function deleteCalendar(kind:string,id:string,expectedVersion:number){
 const table=calendarTable(kind);if(!table)throw new Error('unknown calendar kind');
 const db=getDb();return db.transaction(()=>{
  const row=db.prepare(`SELECT version FROM ${table} WHERE id=?`).get(id) as {version:number}|undefined;
  if(!row)return 'not_found';if(row.version!==expectedVersion)return 'conflict';
  db.prepare(`DELETE FROM ${table} WHERE id=?`).run(id);bumpPlanningRevision();return 'ok';
 }).immediate();
}
export function saveCalendarException(eventId:string,input:z.infer<typeof calendarExceptionSchema>){
 const db=getDb();return db.transaction(()=>{
  if(!db.prepare('SELECT id FROM fixed_events WHERE id=?').get(eventId))return 'not_found';
  const old=db.prepare('SELECT version FROM fixed_event_exceptions WHERE event_id=? AND local_date=?').get(eventId,input.localDate) as {version:number}|undefined;
  if((old?.version??0)!==input.expectedVersion)return 'conflict';
  db.prepare(`INSERT INTO fixed_event_exceptions (event_id,local_date,cancelled,local_start,local_end) VALUES (?,?,?,?,?) ON CONFLICT(event_id,local_date) DO UPDATE SET cancelled=excluded.cancelled,local_start=excluded.local_start,local_end=excluded.local_end,version=version+1`).run(eventId,input.localDate,input.cancelled?1:0,input.localStart,input.localEnd);
  bumpPlanningRevision();return 'ok';
 }).immediate();
}
