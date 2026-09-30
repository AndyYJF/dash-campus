import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { reviewPatchSchema } from "@/contracts/review";
import { getReview, listReviewEdits, updateOwnerFields } from "@/repositories/reviews";
import { requireOwner } from "@/workflows/auth-guard";
import { conflict409, errorResponse, notFound404 } from "@/workflows/http";
import { proposalsFrom } from "@/workflows/review";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/** GET —— 事实快照、AI 草案（推测+提案）、主人修订与修订历史，三者分开返回 */
export async function GET(request: NextRequest, ctx: Params) {
  const auth = requireOwner(request);
  if (!auth.ok) return auth.response;
  const { id } = await ctx.params;
  const review = getReview(id);
  if (!review) return notFound404("复盘不存在");
  return NextResponse.json({ review, proposals: proposalsFrom("review", id), edits: listReviewEdits(id) });
}

/** PATCH —— 主人修订（本人总结 / 下周打算），expectedVersion 乐观锁；不改 AI 草案与事实 */
export async function PATCH(request: NextRequest, ctx: Params) {
  const auth = requireOwner(request);
  if (!auth.ok) return auth.response;
  const { id } = await ctx.params;
  const parsed = reviewPatchSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return errorResponse("VALIDATION", "输入不合法", 422, parsed.error.issues);
  const { expectedVersion, ...fields } = parsed.data;
  const r = updateOwnerFields(id, expectedVersion, fields);
  if (r === "not_found") return notFound404("复盘不存在");
  if (r === "conflict") return conflict409();
  return NextResponse.json({ review: r });
}
