import type { NextRequest } from "next/server";
import { reviewGenerateSchema } from "@/contracts/review";
import { requireOwner } from "@/workflows/auth-guard";
import { errorResponse, HttpError, parseJson, runIdempotent } from "@/workflows/http";
import { startReview } from "@/workflows/review";

export const dynamic = "force-dynamic";

/**
 * POST /api/v1/reviews/generate —— 202 {reviewId, jobId}（计划第 9 节）。
 * 同周已有进行中的复盘时返回它；已完成的周可再次生成（新草案，旧的保留）。
 */
export async function POST(request: NextRequest) {
  const auth = requireOwner(request);
  if (!auth.ok) return auth.response;
  const raw = await request.text();
  const json = parseJson(raw || "{}");
  if (!json.ok) return json.response;
  const parsed = reviewGenerateSchema.safeParse(json.value ?? {});
  if (!parsed.success) return errorResponse("VALIDATION", "输入不合法", 422, parsed.error.issues);
  return runIdempotent(request, raw, {
    actorScope: `owner:${auth.session.ownerId}`,
    route: "reviews.generate",
    execute: () => {
      const r = startReview(parsed.data.localMonday, "manual");
      if (!r.ok) throw new HttpError(r.code === "RESTORED_HOLD" ? 503 : 422, r.code, r.message);
      return {
        statusCode: 202,
        body: { reviewId: r.review.id, jobId: r.jobId, localMonday: r.review.localMonday },
        resourceType: "review",
        resourceId: r.review.id,
      };
    },
  });
}
