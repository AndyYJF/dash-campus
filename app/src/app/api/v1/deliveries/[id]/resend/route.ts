import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import { requireOwner } from "@/workflows/auth-guard";
import { errorResponse, HttpError } from "@/workflows/http";
import { resendDelivery } from "@/workflows/resend";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

const bodySchema = z.object({ confirmDuplicateRisk: z.literal(true) });

/**
 * POST /api/v1/deliveries/:id/resend —— unknown / failed 投递显式重发。
 * 必须带 confirmDuplicateRisk: true：unknown 可能已经送达，重发可能产生重复邮件。
 */
export async function POST(request: NextRequest, ctx: Params) {
  const auth = requireOwner(request);
  if (!auth.ok) return auth.response;
  const { id } = await ctx.params;
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return errorResponse("CONFIRMATION_REQUIRED", "重发可能产生重复邮件，需要确认 confirmDuplicateRisk", 422);
  }
  try {
    const delivery = await resendDelivery(id);
    return NextResponse.json({
      delivery: { ...delivery, snapshot: undefined, leaseToken: undefined },
    });
  } catch (e) {
    if (e instanceof HttpError) return errorResponse(e.code, e.message, e.status, e.details);
    throw e;
  }
}
