import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { expectedVersionSchema } from "@/contracts/planning";
import { archiveProject } from "@/repositories/planning";
import { requireOwner } from "@/workflows/auth-guard";
import { conflict409, errorResponse, notFound404 } from "@/workflows/http";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/** POST /api/v1/projects/:id/archive —— 软删除 */
export async function POST(request: NextRequest, ctx: Params) {
  const auth = requireOwner(request);
  if (!auth.ok) return auth.response;
  const { id } = await ctx.params;
  const parsed = expectedVersionSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return errorResponse("VALIDATION", "输入不合法", 422, parsed.error.issues);
  }
  const result = archiveProject(id, parsed.data.expectedVersion);
  if (result === "not_found") return notFound404("项目不存在或已归档");
  if (result === "conflict") return conflict409();
  return NextResponse.json({ project: result });
}
