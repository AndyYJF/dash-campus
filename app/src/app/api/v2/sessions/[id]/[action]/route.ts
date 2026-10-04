import type { NextRequest } from "next/server";
import { z } from "zod";
import { requireOwner } from "@/workflows/auth-guard";
import { errorResponse, HttpError, parseJson, runIdempotent } from "@/workflows/http";
import { executeOperation } from "@/workflows/commands";
import { operationResultView, statusForCode } from "@/workflows/results";
import { getInstanceState } from "@/repositories/instance";

export const dynamic = "force-dynamic";

/**
 * POST /api/v2/sessions/:id/:action（MASTER-PLAN §8）：start/complete/skip/lock/unlock/move。
 * 兼容适配层：转给统一操作（set_session_state / reschedule_session），与聊天、卡片走同一执行器和 journal。
 * complete 只完成学习块，不自动完成任务（任务完成走 complete_task）。
 */
const actionSchema = z.object({
  expectedVersion: z.number().int().min(1),
  actualMinutes: z.number().int().min(1).max(1440).nullable().optional(),
  note: z.string().max(500).optional(),
  targetDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  part: z.enum(["morning", "afternoon", "evening", "any"]).optional(),
  startLocalTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).nullable().optional(),
  durationMinutes: z.number().int().min(5).max(240).nullable().optional(),
});
const STATE_ACTIONS = new Set(["start", "complete", "skip", "lock", "unlock"]);
const LEGACY_PATCH: Record<string, Record<string, unknown>> = {
  start: { status: "in_progress" },
  complete: { status: "completed" },
  skip: { status: "skipped" },
  lock: { locked: true },
  unlock: { locked: false },
};

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string; action: string }> }) {
  const auth = requireOwner(request);
  if (!auth.ok) return auth.response;
  const { id, action } = await params;
  if (!STATE_ACTIONS.has(action) && action !== "move") return errorResponse("VALIDATION", `未知操作 ${action}`, 422);
  const raw = await request.text();
  const json = parseJson(raw);
  if (!json.ok) return json.response;
  const parsed = actionSchema.safeParse(json.value);
  if (!parsed.success) return errorResponse("VALIDATION", "需要 expectedVersion", 422);
  const d = parsed.data;

  return runIdempotent(request, raw, {
    actorScope: `owner:${auth.session.ownerId}`,
    route: `v2.sessions.${action}`,
    execute: () => {
      const command =
        action === "move"
          ? { command: "reschedule_session", sessionId: id, expectedVersion: d.expectedVersion, targetDate: d.targetDate ?? null, part: d.part ?? "any", startLocalTime: d.startLocalTime ?? null, durationMinutes: d.durationMinutes ?? null }
          : { command: "set_session_state", sessionId: id, action, expectedVersion: d.expectedVersion, actualMinutes: d.actualMinutes ?? null, note: d.note ?? "" };
      const outcome = executeOperation(command, { intakeId: null, itemId: null, itemKey: "", instanceEpoch: getInstanceState().deploymentEpoch, evidence: "学习块按钮", explicit: true });
      const view = operationResultView(command.command, outcome);
      if (view.error) throw new HttpError(statusForCode(view.error.code), view.error.code, view.error.message);
      return { statusCode: 200, body: { sessionId: id, action, ...(LEGACY_PATCH[action] ?? {}), result: view }, resourceType: "plan_session", resourceId: id };
    },
  });
}
