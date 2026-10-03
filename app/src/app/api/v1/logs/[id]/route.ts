import { NextResponse,type NextRequest } from "next/server";
import { requireOwner } from "@/workflows/auth-guard";
import { logPatchSchema } from "@/contracts/records";
import { getLog,recordRevisions,updateLog } from "@/repositories/logs";
import { getProject,getTask } from "@/repositories/planning";
import { conflict409,errorResponse,notFound404,withReferenceCheck,HttpError } from "@/workflows/http";
export const dynamic="force-dynamic";
type Context={params:Promise<{id:string}>};
export async function GET(request:NextRequest,ctx:Context){const auth=requireOwner(request);if(!auth.ok)return auth.response;const {id}=await ctx.params,log=getLog(id);return log?NextResponse.json({log,revisions:recordRevisions("log",id)}):notFound404("记录不存在");}
async function mutate(request:NextRequest,ctx:Context,archive:boolean){
 const auth=requireOwner(request);if(!auth.ok)return auth.response;const {id}=await ctx.params,p=logPatchSchema.safeParse(await request.json().catch(()=>null));if(!p.success)return errorResponse("VALIDATION","输入不合法",422,p.error.issues);
 const {expectedVersion,...patch}=p.data;return withReferenceCheck(()=>{
  if("taskId" in patch&&patch.taskId){const t=getTask(patch.taskId);if(!t||t.archivedAt)throw new HttpError(422,"INVALID_REFERENCE","关联任务不存在或已归档");}
  if("projectId" in patch&&patch.projectId){const pr=getProject(patch.projectId);if(!pr||pr.archivedAt)throw new HttpError(422,"INVALID_REFERENCE","关联项目不存在或已归档");}
  const r=updateLog(id,archive?{}:patch,expectedVersion,archive);return r==="not_found"?notFound404("记录不存在或已归档"):r==="conflict"?conflict409():NextResponse.json({log:r});
 });
}
export function PATCH(r:NextRequest,c:Context){return mutate(r,c,false);}
export function DELETE(r:NextRequest,c:Context){return mutate(r,c,true);}
