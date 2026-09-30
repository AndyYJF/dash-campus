import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { exportRequestSchema } from "@/contracts/exports";
import { requireOwner } from "@/workflows/auth-guard";
import { errorResponse, HttpError, parseJson, runIdempotent } from "@/workflows/http";
import { createExport, listExports, sweepExpiredExports } from "@/workflows/exports";

export const dynamic = "force-dynamic";

/** GET /api/v1/exports —— 最近导出与状态（到期的显示为已过期） */
export function GET(request: NextRequest) {
  const auth = requireOwner(request);
  if (!auth.ok) return auth.response;
  sweepExpiredExports();
  return NextResponse.json({ exports: listExports() });
}

/**
 * POST /api/v1/exports —— {type: project_markdown|full_json, ...}，Idempotency-Key 必填，202。
 * 本地生成、无外部调用：返回时导出已 ready（或 failed 并说明原因）。
 */
export async function POST(request: NextRequest) {
  const auth = requireOwner(request);
  if (!auth.ok) return auth.response;
  const raw = await request.text();
  const json = parseJson(raw);
  if (!json.ok) return json.response;
  const parsed = exportRequestSchema.safeParse(json.value);
  if (!parsed.success) return errorResponse("VALIDATION", "输入不合法", 422, parsed.error.issues);
  return runIdempotent(request, raw, {
    actorScope: `owner:${auth.session.ownerId}`,
    route: "exports",
    execute: () => {
      const r = createExport(parsed.data);
      if (!r.ok) throw new HttpError(r.status, r.code, r.message);
      return {
        statusCode: 202,
        body: { export: r.export, missing: r.missing ?? [], ignoredIds: r.ignoredIds ?? [] },
        resourceType: "export",
        resourceId: r.export.id,
      };
    },
  });
}
