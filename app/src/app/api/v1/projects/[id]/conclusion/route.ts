import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { projectConclusionSchema } from "@/contracts/exploration";
import { requireOwner } from "@/workflows/auth-guard";
import { conflict409, errorResponse, notFound404 } from "@/workflows/http";
import { getProjectExploration, saveProjectConclusion } from "@/workflows/candidates";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

export async function GET(request: NextRequest, ctx: Params) {
  const auth = requireOwner(request);
  if (!auth.ok) return auth.response;
  const { id } = await ctx.params;
  const exploration = getProjectExploration(id);
  if (!exploration) return notFound404("项目不存在");
  return NextResponse.json({ exploration });
}

/** POST：保存本人探索结论（7.3）。只记录本次结论，不改关注方向，不生成适配分数 */
export async function POST(request: NextRequest, ctx: Params) {
  const auth = requireOwner(request);
  if (!auth.ok) return auth.response;
  const { id } = await ctx.params;
  const parsed = projectConclusionSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return errorResponse("VALIDATION", "输入不合法", 422, parsed.error.issues);
  const r = saveProjectConclusion(id, parsed.data);
  if (r === "not_found") return notFound404("项目不存在或已归档");
  if (r === "conflict") return conflict409();
  if (r === "bad_artifact") return errorResponse("VALIDATION", "成果引用必须属于本项目", 422);
  return NextResponse.json({ exploration: getProjectExploration(id) });
}
