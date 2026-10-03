import { NextResponse, type NextRequest } from 'next/server';
import { requireOwner } from '@/workflows/auth-guard';
import { listAvailabilityBlocks,listFixedEvents } from '@/domain/workload';
import { getDb } from '@/repositories/db';
import { getPlanningRevision } from '@/repositories/proposals';
import { calendarSchema } from '@/contracts/calendar';
import { calendarTable,writeCalendar } from '@/repositories/calendar';
import { errorResponse,handleIdempotentCreate } from '@/workflows/http';
import { detailedOccurrences } from '@/domain/calendar-occurrences';
import { instanceTimezone,localDateInTz,mondayOf,addDays,wallTimeToUtc } from '@/domain/time';
export const dynamic='force-dynamic';
export function GET(request:NextRequest){
 const auth=requireOwner(request);if(!auth.ok)return auth.response;
 const availabilityBlocks=listAvailabilityBlocks(),fixedEvents=listFixedEvents(),timezone=instanceTimezone(),monday=mondayOf(localDateInTz(new Date(),timezone));
 const start=wallTimeToUtc(monday,'00:00',timezone).getTime(),end=wallTimeToUtc(addDays(monday,7),'00:00',timezone).getTime();
 return NextResponse.json({planningRevision:getPlanningRevision(),availabilityBlocks,fixedEvents,occurrenceWeek:{localMonday:monday,timezone},occurrences:[...availabilityBlocks,...fixedEvents].flatMap(r=>detailedOccurrences(r,start,end)),exceptions:getDb().prepare('SELECT * FROM fixed_event_exceptions').all(),bufferPercent:(getDb().prepare('SELECT buffer_percent FROM planning_state WHERE id=1').get() as {buffer_percent:number}).buffer_percent});
}
export async function POST(request:NextRequest){
 const auth=requireOwner(request);if(!auth.ok)return auth.response;
 const kind=new URL(request.url).searchParams.get('kind');if(!calendarTable(kind))return errorResponse('VALIDATION','请选择可用时间或固定活动',422);
 return handleIdempotentCreate(request,{actorScope:`owner:${auth.session.ownerId}`,route:`availability.${kind}`,schema:calendarSchema,resourceType:kind!,execute:input=>({id:writeCalendar(kind!,null,input)})});
}
