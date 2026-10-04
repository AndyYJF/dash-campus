import type { NextRequest } from "next/server";
import { requireOwner } from "@/workflows/auth-guard";
import { runIdempotent } from "@/workflows/http";
import { executeOperation } from "@/workflows/commands";

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
      // 兼容入口：确认当前模板，走与对话相同的时间政策操作
      executeOperation({ command: "update_planning_policy", confirm: true, evidence: "确认作息模板" }, { intakeId: null, itemId: null, itemKey: "", instanceEpoch: 0, evidence: "确认作息模板", explicit: true });
      return { statusCode: 200, body: { status: "confirmed" }, resourceType: "planning_preferences", resourceId: "1" };
    },
  });
}
