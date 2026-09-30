import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getTopic } from "@/repositories/exploration";
import { requireOwner } from "@/workflows/auth-guard";
import { checkIdempotency, recordIdempotency } from "@/workflows/idempotency";
import { errorResponse, notFound404 } from "@/workflows/http";
import { startExploration } from "@/workflows/exploration";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/**
 * POST /api/v1/exploration-topics/:id/run —— "立即运行一次"：与定期同一工作流，明确是手动触发
 * （产品计划：演示由立即运行触发并说明）。结果按 topic 去重。
 */
export async function POST(request: NextRequest, ctx: Params) {
  const auth = requireOwner(request);
  if (!auth.ok) return auth.response;
  const { id } = await ctx.params;
  const key = request.headers.get("idempotency-key");
  if (!key) return errorResponse("IDEMPOTENCY_KEY_REQUIRED", "创建请求必须携带 Idempotency-Key 头", 422);
  const scope = { actorScope: `owner:${auth.session.ownerId}`, route: `exploration-topics/${id}/run`, key, requestBody: "" };
  const existing = checkIdempotency(scope);
  if (existing.kind === "replay") return NextResponse.json(existing.body, { status: existing.statusCode });

  const topic = getTopic(id);
  if (!topic || topic.archivedAt) return notFound404("关注方向不存在");
  const r = startExploration({
    query: topic.purpose ? `${topic.title}：${topic.purpose}` : topic.title,
    topicId: topic.id,
    projectId: null,
    background: "",
    materials: [],
  });
  if (!r.ok) return errorResponse(r.code, r.message, r.code === "NOT_FOUND" ? 404 : 503);
  const body = { jobId: r.jobId, runId: r.run.id, integrationMode: r.run.integrationMode, trigger: "manual" };
  recordIdempotency({ ...scope, statusCode: 202, resourceType: "exploration_run", resourceId: r.run.id, responseBody: body });
  return NextResponse.json(body, { status: 202 });
}
