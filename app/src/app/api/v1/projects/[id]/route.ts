import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { expectedVersionSchema, projectPatchSchema } from "@/contracts/planning";
import { getProject, updateProject } from "@/repositories/planning";
import { requireOwner } from "@/workflows/auth-guard";
import { conflict409, errorResponse, notFound404, withReferenceCheck } from "@/workflows/http";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

export async function GET(request: NextRequest, ctx: Params) {
  const auth = requireOwner(request);
  if (!auth.ok) return auth.response;
  const { id } = await ctx.params;
  const project = getProject(id);
  if (!project) return notFound404("项目不存在");
  return NextResponse.json({ project });
}

export async function PATCH(request: NextRequest, ctx: Params) {
  const auth = requireOwner(request);
  if (!auth.ok) return auth.response;
  const { id } = await ctx.params;
  const parsed = expectedVersionSchema
    .merge(projectPatchSchema)
    .safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return errorResponse("VALIDATION", "输入不合法", 422, parsed.error.issues);
  }
  const { expectedVersion, ...patch } = parsed.data;
  return withReferenceCheck(() => {
    const result = updateProject(id, patch, expectedVersion);
    if (result === "not_found") return notFound404("项目不存在或已归档");
    if (result === "conflict") return conflict409();
    return NextResponse.json({ project: result });
  });
}
