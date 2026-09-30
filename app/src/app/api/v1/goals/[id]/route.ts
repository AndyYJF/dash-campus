import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { expectedVersionSchema, goalPatchSchema } from "@/contracts/planning";
import { getGoal, updateGoal } from "@/repositories/planning";
import { requireOwner } from "@/workflows/auth-guard";
import { conflict409, errorResponse, notFound404 } from "@/workflows/http";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

export async function GET(request: NextRequest, ctx: Params) {
  const auth = requireOwner(request);
  if (!auth.ok) return auth.response;
  const { id } = await ctx.params;
  const goal = getGoal(id);
  if (!goal) return notFound404("目标不存在");
  return NextResponse.json({ goal });
}

export async function PATCH(request: NextRequest, ctx: Params) {
  const auth = requireOwner(request);
  if (!auth.ok) return auth.response;
  const { id } = await ctx.params;
  const parsed = expectedVersionSchema
    .merge(goalPatchSchema)
    .safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return errorResponse("VALIDATION", "输入不合法", 422, parsed.error.issues);
  }
  const { expectedVersion, ...patch } = parsed.data;
  const result = updateGoal(id, patch, expectedVersion);
  if (result === "not_found") return notFound404("目标不存在或已归档");
  if (result === "conflict") return conflict409();
  return NextResponse.json({ goal: result });
}
