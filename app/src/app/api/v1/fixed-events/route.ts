import { NextResponse,type NextRequest } from "next/server";
import { requireOwner } from "@/workflows/auth-guard";
import { listFixedEvents } from "@/domain/workload";
import { getDb } from "@/repositories/db";
import { calendarSchema } from "@/contracts/calendar";
import { writeCalendar } from "@/repositories/calendar";
import { handleIdempotentCreate } from "@/workflows/http";
export const dynamic="force-dynamic";
export function GET(request:NextRequest) {
  const auth=requireOwner(request);if(!auth.ok)return auth.response;
  return NextResponse.json({fixedEvents:listFixedEvents(),exceptions:getDb().prepare("SELECT * FROM fixed_event_exceptions").all()});
}
export async function POST(request:NextRequest) {
  const auth=requireOwner(request);if(!auth.ok)return auth.response;
  return handleIdempotentCreate(request,{actorScope:`owner:${auth.session.ownerId}`,route:"availability.fixed-event",schema:calendarSchema,resourceType:"fixed-event",execute:input=>({id:writeCalendar("fixed-event",null,input)})});
}
