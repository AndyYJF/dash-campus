import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import { REJECTION_REASONS } from "@/contracts/review";
import { requireOwner } from "@/workflows/auth-guard";
import { conflict409, errorResponse } from "@/workflows/http";
import { rejectProposal } from "@/repositories/proposal-decisions";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/**
 * POST /api/v1/proposals/:id/reject —— { reason?, expectedVersion? }。
 * 拒绝后 14 天内同项目同操作类型同证据的建议不自动重复；主人主动重跑不受限制。
 */
export async function POST(request: NextRequest, ctx: Params) {
  const auth = requireOwner(request);
  if (!auth.ok) return auth.response;
  const { id } = await ctx.params;
  const parsed = z
    .object({
      reason: z.enum(REJECTION_REASONS).nullable().default(null),
      expectedVersion: z.number().int().min(1).optional(),
    })
    .safeParse((await request.json().catch(() => null)) ?? {});
  if (!parsed.success) return errorResponse("VALIDATION", "输入不合法", 422, parsed.error.issues);
  const result = rejectProposal(id, parsed.data.reason, parsed.data.expectedVersion);
  if (result === "not_found") return errorResponse("NOT_FOUND", "提案不存在", 404);
  if (result === "invalid_state") return errorResponse("INVALID_STATE", "提案已处理", 409);
  if (result === "conflict") return conflict409();
  return NextResponse.json({ ok: true });
}
