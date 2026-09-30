import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { createProjectFromCandidateSchema } from "@/contracts/exploration";
import { requireOwner } from "@/workflows/auth-guard";
import { conflict409, errorResponse, notFound404 } from "@/workflows/http";
import { createProjectFromCandidate } from "@/workflows/candidates";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/**
 * POST /api/v1/candidates/:id/create-project —— 主人编辑确认后创建独立项目与初始任务。
 * 同一候选只建一次（重复返回 200 exists）；带未知条件必须 acceptUnknowns=true（422 列出待确认项）。
 */
export async function POST(request: NextRequest, ctx: Params) {
  const auth = requireOwner(request);
  if (!auth.ok) return auth.response;
  const { id } = await ctx.params;
  const parsed = createProjectFromCandidateSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return errorResponse("VALIDATION", "输入不合法", 422, parsed.error.issues);
  const r = createProjectFromCandidate(id, parsed.data);
  switch (r.kind) {
    case "not_found":
      return notFound404("候选不存在");
    case "conflict":
      return conflict409();
    case "unknowns_not_accepted":
      return errorResponse("UNKNOWNS_NOT_ACCEPTED", "仍有未确认的条件，需选择\"带这些未知条件开始\"", 422, {
        pending: r.pending,
      });
    case "exists":
      return NextResponse.json(r, { status: 200 });
    case "created":
      return NextResponse.json(r, { status: 201 });
  }
}
