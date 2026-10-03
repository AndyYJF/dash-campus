import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { explorationRequestSchema } from "@/contracts/exploration";
import { listRuns } from "@/repositories/exploration";
import { requireOwner } from "@/workflows/auth-guard";
import { checkIdempotency, recordIdempotency } from "@/workflows/idempotency";
import { errorResponse } from "@/workflows/http";
import { startExploration } from "@/workflows/exploration";

export const dynamic = "force-dynamic";

export function GET(request: NextRequest) {
  const auth = requireOwner(request);
  if (!auth.ok) return auth.response;
  return NextResponse.json({ runs: listRuns(20) });
}

/**
 * POST /api/v1/explorations —— 按需探索（计划第 9 节）：Idempotency-Key 必填，202 {jobId, runId}。
 * 202 只表示已入队，不表示完成；进度看 GET /explorations/:id。
 */
export async function POST(request: NextRequest) {
  const auth = requireOwner(request);
  if (!auth.ok) return auth.response;
  const key = request.headers.get("idempotency-key");
  if (!key) return errorResponse("IDEMPOTENCY_KEY_REQUIRED", "创建请求必须携带 Idempotency-Key 头", 422);
  const raw = await request.text();
  const scope = { actorScope: `owner:${auth.session.ownerId}`, route: "explorations", key, requestBody: raw };
  const existing = checkIdempotency(scope);
  if (existing.kind === "collision") {
    return errorResponse("IDEMPOTENCY_COLLISION", "相同 Idempotency-Key 携带了不同的请求体", 409);
  }
  if (existing.kind === "replay") return NextResponse.json(existing.body, { status: existing.statusCode });

  let json: unknown;
  try {
    json = raw ? JSON.parse(raw) : null;
  } catch {
    return errorResponse("VALIDATION", "请求体不是合法 JSON", 422);
  }
  const parsed = explorationRequestSchema.safeParse(json);
  if (!parsed.success) return errorResponse("VALIDATION", "输入不合法", 422, parsed.error.issues);

  const r = startExploration(parsed.data);
  if (!r.ok) {
    return errorResponse(r.code, r.message, r.code === "NOT_FOUND" ? 404 : r.code === "INVALID_REFERENCE" ? 422 : r.code === "BUDGET_EXCEEDED" ? 429 : r.code === "RESTORED_HOLD" ? 409 : 503);
  }
  const body = { jobId: r.jobId, runId: r.run.id, integrationMode: r.run.integrationMode };
  recordIdempotency({ ...scope, statusCode: 202, resourceType: "exploration_run", resourceId: r.run.id, responseBody: body });
  return NextResponse.json(body, { status: 202 });
}
