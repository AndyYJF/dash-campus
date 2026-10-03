import { NextResponse,type NextRequest } from 'next/server';
import { z } from 'zod';
import { requireOwner } from '@/workflows/auth-guard';
import { timezoneSchema,localTimeSchema } from '@/contracts/calendar';
import { resolveWallTime } from '@/domain/time';
import { errorResponse } from '@/workflows/http';
export const dynamic='force-dynamic';
export function GET(request:NextRequest){
 const auth=requireOwner(request);if(!auth.ok)return auth.response;
 const p=z.object({date:z.iso.date(),time:localTimeSchema,timezone:timezoneSchema}).safeParse(Object.fromEntries(new URL(request.url).searchParams));
 if(!p.success)return errorResponse('VALIDATION','当地日期、时间或时区无效',422);
 const r=resolveWallTime(p.data.date,p.data.time,p.data.timezone);return NextResponse.json({instant:r.instant.toISOString(),adjustment:r.adjustment});
}
