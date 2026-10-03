import { NextResponse,type NextRequest } from 'next/server';
import { requireOwner } from '@/workflows/auth-guard';
import { calendarExceptionSchema } from '@/contracts/calendar';
import { saveCalendarException } from '@/repositories/calendar';
import { conflict409,errorResponse,notFound404 } from '@/workflows/http';
export const dynamic='force-dynamic';
export async function PUT(request:NextRequest,ctx:{params:Promise<{id:string}>}){
 const auth=requireOwner(request);if(!auth.ok)return auth.response;
 const p=calendarExceptionSchema.safeParse(await request.json().catch(()=>null));if(!p.success)return errorResponse('VALIDATION','单日例外无效',422,p.error.issues);
 const r=saveCalendarException((await ctx.params).id,p.data);if(r==='conflict')return conflict409();if(r==='not_found')return notFound404();return NextResponse.json({result:r});
}
