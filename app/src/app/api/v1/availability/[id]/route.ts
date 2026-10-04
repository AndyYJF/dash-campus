import { NextResponse,type NextRequest } from 'next/server';
import { z } from 'zod';
import { requireOwner } from '@/workflows/auth-guard';
import { calendarSchema } from '@/contracts/calendar';
import { calendarTable,writeCalendar,deleteCalendar } from '@/repositories/calendar';
import { journaledWrite } from '@/workflows/compat';
import { errorResponse,conflict409,notFound404 } from '@/workflows/http';
export const dynamic='force-dynamic';
type Context={params:Promise<{id:string}>};
async function mutate(request:NextRequest,ctx:Context,remove:boolean){
 const auth=requireOwner(request);if(!auth.ok)return auth.response;
 const kind=new URL(request.url).searchParams.get('kind');if(!calendarTable(kind))return errorResponse('VALIDATION','kind 不合法',422);
 const {id}=await ctx.params,raw=await request.json().catch(()=>null);
 const version=z.object({expectedVersion:z.number().int().min(1)}).safeParse(raw);if(!version.success)return errorResponse('VALIDATION','缺少正确版本',422);
 const input=calendarSchema.safeParse(raw);if(!remove&&!input.success)return errorResponse('VALIDATION','时间字段不合法',422,input.error.issues);
 const run=()=>remove?deleteCalendar(kind!,id,version.data.expectedVersion):writeCalendar(kind!,id,input.success?input.data:undefined!,version.data.expectedVersion);
 // 固定活动的修改/删除进同一份变更记录（可用时间块不属于变更记录的对象）
 const result=kind==='fixed-event'?journaledWrite('fixed_event',id,run,r=>(r==='not_found'||r==='conflict'?null:id)):run();
 if(result==='not_found')return notFound404();if(result==='conflict')return conflict409();return NextResponse.json({id,result});
}
export function PATCH(r:NextRequest,c:Context){return mutate(r,c,false);}
export function DELETE(r:NextRequest,c:Context){return mutate(r,c,true);}
