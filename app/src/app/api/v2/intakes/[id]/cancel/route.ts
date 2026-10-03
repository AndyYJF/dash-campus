import type { NextRequest } from "next/server";
import { z } from "zod";
import { requireOwner } from "@/workflows/auth-guard";
import { errorResponse, parseJson, runIdempotent } from "@/workflows/http";
import { cancelIntake } from "@/workflows/intake";

export const dynamic = "force-dynamic";

/**
 * POST /api/v2/intakes/:id/cancel（MASTER-PLAN §8）：
 * expectedVersion；取消未应用部分，保留已有结果和撤销入口。
 */
const cancelSchema = z.object({ expectedVersion: z.number().int().min(1) });

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = requireOwner(request);
  if (!auth.ok) return auth.response;
  const { id } = await params;
  const raw = await request.text();
  const json = parseJson(raw);
  if (!json.ok) return json.response;
  const parsed = cancelSchema.safeParse(json.value);
  if (!parsed.success) return errorResponse("VALIDATION", "需要 expectedVersion", 422);

  return runIdempotent(request, raw, {
    actorScope: `owner:${auth.session.ownerId}`,
    route: "v2.intakes.cancel",
    execute: () => {
      const result = cancelIntake(id, parsed.data.expectedVersion);
      if (result.kind === "not_found") return { statusCode: 404, body: { error: { code: "NOT_FOUND", message: "投递不存在" } }, resourceType: null, resourceId: null };
      if (result.kind === "stale") {
        return { statusCode: 409, body: { error: { code: "STALE_VERSION", message: "投递状态已变化，请重新读取后再试" } }, resourceType: null, resourceId: null };
      }
      if (result.kind === "completed") {
        return { statusCode: 409, body: { error: { code: "ALREADY_COMPLETED", message: "投递已完成，没有可取消的部分" } }, resourceType: null, resourceId: null };
      }
      return { statusCode: 200, body: { intakeId: id, status: "cancelled" }, resourceType: "intake", resourceId: id };
    },
  });
}
