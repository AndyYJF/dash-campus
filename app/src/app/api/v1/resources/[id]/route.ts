import { NextResponse, type NextRequest } from "next/server";
import { requireOwner } from "@/workflows/auth-guard";
import { recordVersion,resourcePatchSchema } from "@/contracts/records";
import { getResource,resourceRevisions,updateResource } from "@/repositories/resources";
import { conflict409,errorResponse,notFound404,withReferenceCheck } from "@/workflows/http";
export const dynamic="force-dynamic";
type Context={params:Promise<{id:string}>};
export async function GET(request:NextRequest,ctx:Context){const auth=requireOwner(request);if(!auth.ok)return auth.response;const {id}=await ctx.params,r=getResource(id);return r?NextResponse.json({resource:r,revisions:resourceRevisions(id)}):notFound404("资料不存在");}
async function mutate(request:NextRequest,ctx:Context,archive:boolean){
 const auth=requireOwner(request);if(!auth.ok)return auth.response;const {id}=await ctx.params,p=(archive?recordVersion:resourcePatchSchema).safeParse(await request.json().catch(()=>null));if(!p.success)return errorResponse("VALIDATION","输入不合法",422,p.error.issues);
 const {expectedVersion,...patch}=p.data;return withReferenceCheck(()=>{const r=updateResource(id,patch,expectedVersion,archive);return r==="not_found"?notFound404("资料不存在或已归档"):r==="conflict"?conflict409():NextResponse.json({resource:r});});
}
export function PATCH(r:NextRequest,c:Context){return mutate(r,c,false);}
export function DELETE(r:NextRequest,c:Context){return mutate(r,c,true);}
