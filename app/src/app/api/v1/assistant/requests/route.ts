import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { assistantRequestSchema } from "@/contracts/review";
import { requireOwner } from "@/workflows/auth-guard";
import { errorResponse, HttpError, parseJson, runIdempotent } from "@/workflows/http";
import { startAssistant } from "@/workflows/review";
import { listAssistantRequestsForLog } from "@/repositories/reviews";

export const dynamic = "force-dynamic";

/** GET ?logId= —— 某条记录的分析请求 */
export function GET(request: NextRequest) {
  const auth = requireOwner(request);
  if (!auth.ok) return auth.response;
  const logId = new URL(request.url).searchParams.get("logId");
  if (!logId) return errorResponse("VALIDATION", "缺少 logId", 422);
  return NextResponse.json({ requests: listAssistantRequestsForLog(logId) });
}

/**
 * POST /api/v1/assistant/requests —— {scopeType, scopeId, question, logId?, rerun?}，202 {requestId, jobId}。
 * 范围限定当前项目或当前周；缺模型 503，超预算 429。
 */
export async function POST(request: NextRequest) {
  const auth = requireOwner(request);
  if (!auth.ok) return auth.response;
  const raw = await request.text();
  const json = parseJson(raw);
  if (!json.ok) return json.response;
  const parsed = assistantRequestSchema.safeParse(json.value);
  if (!parsed.success) return errorResponse("VALIDATION", "输入不合法", 422, parsed.error.issues);
  return runIdempotent(request, raw, {
    actorScope: `owner:${auth.session.ownerId}`,
    route: "assistant.requests",
    execute: () => {
      const r = startAssistant(parsed.data);
      if (!r.ok) throw new HttpError(r.status, r.code, r.message);
      return {
        statusCode: 202,
        body: { requestId: r.requestId, jobId: r.jobId, integrationMode: r.integrationMode },
        resourceType: "assistant_request",
        resourceId: r.requestId,
      };
    },
  });
}
