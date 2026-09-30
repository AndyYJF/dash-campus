import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { listReviews } from "@/repositories/reviews";
import { requireOwner } from "@/workflows/auth-guard";

export const dynamic = "force-dynamic";

/** GET /api/v1/reviews —— 复盘列表（摘要，不含事实正文） */
export function GET(request: NextRequest) {
  const auth = requireOwner(request);
  if (!auth.ok) return auth.response;
  return NextResponse.json({
    reviews: listReviews(30).map((r) => ({
      id: r.id,
      localMonday: r.localMonday,
      timezone: r.timezone,
      trigger: r.trigger,
      status: r.status,
      aiSkippedReason: r.aiSkippedReason,
      integrationMode: r.integrationMode,
      generatedAt: r.generatedAt,
      hasOwnerEdit: Boolean(r.ownerSummary || r.ownerNextWeek),
      createdAt: r.createdAt,
    })),
  });
}
