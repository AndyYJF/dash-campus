import type { NextRequest } from "next/server";
import { z } from "zod";
import { requireOwner } from "@/workflows/auth-guard";
import { errorResponse, parseJson, runIdempotent } from "@/workflows/http";
import { undoWithFollowUps } from "@/workflows/commands";
import { rebuildPlan } from "@/workflows/plan";

export const dynamic = "force-dynamic";

/**
 * POST /api/v2/actions/:batchId/undo（MASTER-PLAN §8）：
 * 幂等 + expectedVersion；版本冲突 409 且整体不动，不静默半撤。
 * expectedVersion 语义：批次代际，当前为 1（applied）。
 */
const undoSchema = z.object({ expectedVersion: z.number().int().min(1) });

export async function POST(request: NextRequest, { params }: { params: Promise<{ batchId: string }> }) {
  const auth = requireOwner(request);
  if (!auth.ok) return auth.response;
  const { batchId } = await params;
  const raw = await request.text();
  const json = parseJson(raw);
  if (!json.ok) return json.response;
  const parsed = undoSchema.safeParse(json.value);
  if (!parsed.success) return errorResponse("VALIDATION", "需要 expectedVersion", 422);

  return runIdempotent(request, raw, {
    actorScope: `owner:${auth.session.ownerId}`,
    route: "v2.actions.undo",
    execute: () => {
      // 连同它引起的重排一起撤，再按撤销后的事实对一次账（不留下无解释的新安排）
      const result = undoWithFollowUps(batchId);
      if (result.kind === "not_found") return { statusCode: 404, body: { error: { code: "NOT_FOUND", message: "批次不存在" } }, resourceType: null, resourceId: null };
      if (result.kind === "already_undone") {
        return { statusCode: 409, body: { error: { code: "ALREADY_UNDONE", message: "该批次已撤销，不能重复撤销" } }, resourceType: null, resourceId: null };
      }
      if (result.kind === "conflict") {
        return {
          statusCode: 409,
          body: { error: { code: "VERSION_CONFLICT", message: `撤销冲突：${result.conflicts.join("；")}`, details: result.conflicts } },
          resourceType: null,
          resourceId: null,
        };
      }
      rebuildPlan(new Date());
      return { statusCode: 200, body: { batchId, status: "undone" }, resourceType: "action_batch", resourceId: batchId };
    },
  });
}
