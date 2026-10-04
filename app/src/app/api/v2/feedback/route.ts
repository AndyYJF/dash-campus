import type { NextRequest } from "next/server";
import { requireOwner } from "@/workflows/auth-guard";
import { errorResponse, HttpError, parseJson, runIdempotent } from "@/workflows/http";
import { feedbackSubmitSchema } from "@/contracts/intake";
import { recordFeedback } from "@/workflows/agent-feedback";

export const dynamic = "force-dynamic";

/**
 * POST /api/v2/feedback（Agent 方案 §6 P3）：结果卡“理解错了”。
 * 主人鉴权 + CSRF + 幂等；只写纠错记录，不改业务数据。
 */
export async function POST(request: NextRequest) {
  const auth = requireOwner(request);
  if (!auth.ok) return auth.response;
  const raw = await request.text();
  const json = parseJson(raw);
  if (!json.ok) return json.response;
  const parsed = feedbackSubmitSchema.safeParse(json.value);
  if (!parsed.success) {
    return errorResponse("VALIDATION", parsed.error.issues.map((i) => i.message).join("；"), 422);
  }
  return runIdempotent(request, raw, {
    actorScope: `owner:${auth.session.ownerId}`,
    route: "v2.feedback",
    execute: () => {
      const r = recordFeedback(parsed.data);
      if (r.kind === "not_found") throw new HttpError(404, "NOT_FOUND", "找不到这次投递");
      if (r.kind === "item_not_found") throw new HttpError(404, "NOT_FOUND", "这次投递里没有该事项");
      if (r.kind === "not_finished") throw new HttpError(409, "INTAKE_NOT_FINISHED", "还在处理中，处理完再反馈");
      return { statusCode: 201, body: { feedbackId: r.id }, resourceType: "agent_feedback", resourceId: r.id };
    },
  });
}
