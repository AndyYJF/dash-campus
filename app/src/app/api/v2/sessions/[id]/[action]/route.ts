import type { NextRequest } from "next/server";
import { z } from "zod";
import { requireOwner } from "@/workflows/auth-guard";
import { errorResponse, parseJson, runIdempotent } from "@/workflows/http";
import { setSessionStatus } from "@/repositories/plan";

export const dynamic = "force-dynamic";

/**
 * POST /api/v2/sessions/:id/:action（MASTER-PLAN §8）：start/complete/skip/lock。
 * 幂等 + expectedVersion；complete 只完成学习块，不自动完成任务（任务完成走白名单 complete_task）。
 */
const actionSchema = z.object({ expectedVersion: z.number().int().min(1) });
const ACTIONS: Record<string, { status?: string; locked?: boolean }> = {
  start: { status: "in_progress" },
  complete: { status: "completed" },
  skip: { status: "skipped" },
  lock: { locked: true },
};

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string; action: string }> }) {
  const auth = requireOwner(request);
  if (!auth.ok) return auth.response;
  const { id, action } = await params;
  const patch = ACTIONS[action];
  if (!patch) return errorResponse("VALIDATION", `未知操作 ${action}`, 422);
  const raw = await request.text();
  const json = parseJson(raw);
  if (!json.ok) return json.response;
  const parsed = actionSchema.safeParse(json.value);
  if (!parsed.success) return errorResponse("VALIDATION", "需要 expectedVersion", 422);

  return runIdempotent(request, raw, {
    actorScope: `owner:${auth.session.ownerId}`,
    route: `v2.sessions.${action}`,
    execute: () => {
      const result = setSessionStatus(id, parsed.data.expectedVersion, patch);
      if (result === "not_found") {
        return { statusCode: 404, body: { error: { code: "NOT_FOUND", message: "学习块不存在" } }, resourceType: null, resourceId: null };
      }
      if (result === "stale") {
        return { statusCode: 409, body: { error: { code: "STALE_VERSION", message: "学习块状态已变化，请刷新后再试" } }, resourceType: null, resourceId: null };
      }
      return { statusCode: 200, body: { sessionId: id, action, ...patch }, resourceType: "plan_session", resourceId: id };
    },
  });
}
