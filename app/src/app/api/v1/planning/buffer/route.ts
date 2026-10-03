import { NextResponse,type NextRequest } from 'next/server';
import { z } from 'zod';
import { requireOwner } from '@/workflows/auth-guard';
import { getDb } from '@/repositories/db';
import { getPlanningRevision,bumpPlanningRevision } from '@/repositories/proposals';
import { errorResponse,conflict409 } from '@/workflows/http';
export const dynamic='force-dynamic';
export async function PUT(request:NextRequest){
 const auth=requireOwner(request);if(!auth.ok)return auth.response;
 const p=z.object({bufferPercent:z.number().int().min(0).max(80),expectedRevision:z.number().int().min(0)}).safeParse(await request.json().catch(()=>null));
 if(!p.success)return errorResponse('VALIDATION','缓冲比例须为 0–80 的整数',422);
 return getDb().transaction(()=>{if(getPlanningRevision()!==p.data.expectedRevision)return conflict409();getDb().prepare('UPDATE planning_state SET buffer_percent=? WHERE id=1').run(p.data.bufferPercent);bumpPlanningRevision();return NextResponse.json({bufferPercent:p.data.bufferPercent,planningRevision:getPlanningRevision()});}).immediate();
}
