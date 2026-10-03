import type { NextRequest } from "next/server";
import { z } from "zod";
import { requireOwner } from "@/workflows/auth-guard";
import { errorResponse, parseJson, runIdempotent } from "@/workflows/http";
import { retryIntake } from "@/workflows/intake";

export const dynamic = "force-dynamic";

/**
 * POST /api/v2/intakes/:id/retry（MASTER-PLAN §8）：
 * 幂等 + expectedVersion；仅重试失败/未执行分支，不重放已成功的 effects。
 */
const retrySchema = z.object({ expectedVersion: z.number().int().min(1) });

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = requireOwner(request);
  if (!auth.ok) return auth.response;
  const { id } = await params;
  const raw = await request.text();
  const json = parseJson(raw);
  if (!json.ok) return json.response;
  const parsed = retrySchema.safeParse(json.value);
  if (!parsed.success) return errorResponse("VALIDATION", "需要 expectedVersion", 422);

  return runIdempotent(request, raw, {
    actorScope: `owner:${auth.session.ownerId}`,
    route: "v2.intakes.retry",
    execute: () => {
      const result = retryIntake(id, parsed.data.expectedVersion);
      if (result.kind === "not_found") return { statusCode: 404, body: { error: { code: "NOT_FOUND", message: "投递不存在" } }, resourceType: null, resourceId: null };
      if (result.kind === "stale") {
        return { statusCode: 409, body: { error: { code: "STALE_VERSION", message: "投递状态已变化，请重新读取后再试" } }, resourceType: null, resourceId: null };
      }
      if (result.kind === "nothing") {
        return { statusCode: 200, body: { intakeId: id, retried: false, message: "没有可重试的失败分支" }, resourceType: "intake", resourceId: id };
      }
      return { statusCode: 202, body: { intakeId: id, retried: true }, resourceType: "intake", resourceId: id };
    },
  });
}
