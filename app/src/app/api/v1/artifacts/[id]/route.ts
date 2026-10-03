import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import { archiveArtifact,getArtifact,getLog,updateArtifact,recordRevisions } from "@/repositories/logs";
import { artifactPatchSchema } from "@/contracts/records";
import { getProject } from "@/repositories/planning";
import { requireOwner } from "@/workflows/auth-guard";
import { conflict409, errorResponse, notFound404,withReferenceCheck,HttpError } from "@/workflows/http";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };
export async function GET(request:NextRequest,ctx:Params){const auth=requireOwner(request);if(!auth.ok)return auth.response;const {id}=await ctx.params,artifact=getArtifact(id);return artifact?NextResponse.json({artifact,revisions:recordRevisions("artifact",id)}):notFound404("成果不存在");}
export async function PATCH(request:NextRequest,ctx:Params){
 const auth=requireOwner(request);if(!auth.ok)return auth.response;const {id}=await ctx.params,p=artifactPatchSchema.safeParse(await request.json().catch(()=>null));if(!p.success)return errorResponse("VALIDATION","输入不合法",422,p.error.issues);
 const {expectedVersion,...patch}=p.data;return withReferenceCheck(()=>{if(patch.projectId){const pr=getProject(patch.projectId);if(!pr||pr.archivedAt)throw new HttpError(422,"INVALID_REFERENCE","所属项目不存在或已归档");}if(patch.logId){const log=getLog(patch.logId),projectId=patch.projectId??getArtifact(id)?.projectId;if(!log||log.archivedAt||(log.projectId&&log.projectId!==projectId))throw new HttpError(422,"INVALID_REFERENCE","关联记录不存在、已归档或属于其他项目");}const r=updateArtifact(id,patch,expectedVersion);return r==="not_found"?notFound404("成果不存在或已归档"):r==="conflict"?conflict409():NextResponse.json({artifact:r});});
}

/** DELETE /api/v1/artifacts/:id —— 软删除，要求 expectedVersion */
export async function DELETE(request: NextRequest, ctx: Params) {
  const auth = requireOwner(request);
  if (!auth.ok) return auth.response;
  const { id } = await ctx.params;
  const parsed = z
    .object({ expectedVersion: z.number().int().min(1) })
    .safeParse(await request.json().catch(() => null));
  if (!parsed.success) return errorResponse("VALIDATION", "输入不合法", 422, parsed.error.issues);
  const result = archiveArtifact(id, parsed.data.expectedVersion);
  if (result === "not_found") return notFound404("成果不存在或已删除");
  if (result === "conflict") return conflict409();
  return NextResponse.json({ artifact: result });
}
