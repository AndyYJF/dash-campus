import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import { isoInstant } from "@/contracts/planning";
import { requireOwner } from "@/workflows/auth-guard";
import { conflict409, errorResponse } from "@/workflows/http";
import { snoozeProposal } from "@/repositories/proposal-decisions";
import { addDays, instanceTimezone, localDateInTz, wallTimeToUtc } from "@/domain/time";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/**
 * POST /api/v1/proposals/:id/snooze —— { expectedVersion, snoozeUntil? }。
 * 默认由服务端按实例时区计算次日 09:00；期满展示前重新检查有效性。
 */
export async function POST(request: NextRequest, ctx: Params) {
  const auth = requireOwner(request);
  if (!auth.ok) return auth.response;
  const { id } = await ctx.params;
  const parsed = z
    .object({ snoozeUntil: isoInstant.optional(), expectedVersion: z.number().int().min(1) })
    .safeParse(await request.json().catch(() => null));
  if (!parsed.success) return errorResponse("VALIDATION", "输入不合法", 422, parsed.error.issues);
  const now = new Date(), tz = instanceTimezone();
  const snoozeUntil = parsed.data.snoozeUntil ?? wallTimeToUtc(addDays(localDateInTz(now, tz), 1), "09:00", tz).toISOString();
  if (new Date(snoozeUntil) <= now) return errorResponse("VALIDATION", "暂缓时间必须在未来", 422);
  const result = snoozeProposal(id, snoozeUntil, parsed.data.expectedVersion);
  if (result === "not_found") return errorResponse("NOT_FOUND", "提案不存在", 404);
  if (result === "invalid_state") return errorResponse("INVALID_STATE", "提案已处理", 409);
  if (result === "conflict") return conflict409();
  return NextResponse.json({ ok: true, snoozeUntil });
}
