import type { NextRequest } from "next/server";
import { requireOwner } from "@/workflows/auth-guard";
import { runIdempotent } from "@/workflows/http";
import { confirmPrefs } from "@/repositories/plan";

export const dynamic = "force-dynamic";

/**
 * POST /api/v2/preferences/confirm（MASTER-PLAN §10 P3：初次偏好一句话确认）：
 * 把暂定模板标记为已确认；预算数字不变，source 从 tentative 变 confirmed。
 */
export async function POST(request: NextRequest) {
  const auth = requireOwner(request);
  if (!auth.ok) return auth.response;
  const raw = await request.text();
  return runIdempotent(request, raw, {
    actorScope: `owner:${auth.session.ownerId}`,
    route: "v2.preferences.confirm",
    execute: () => {
      confirmPrefs();
      return { statusCode: 200, body: { status: "confirmed" }, resourceType: "planning_preferences", resourceId: "1" };
    },
  });
}
