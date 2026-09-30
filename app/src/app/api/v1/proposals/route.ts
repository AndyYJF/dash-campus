import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { requireOwner } from "@/workflows/auth-guard";
import { errorResponse, HttpError, parseJson, runIdempotent } from "@/workflows/http";
import { createProposal, listProposals } from "@/repositories/proposals";
import { scheduleProblem } from "@/workflows/apply-proposal";
import { getTask } from "@/repositories/planning";
import { z } from "zod";
import { isoInstant } from "@/contracts/planning";

export const dynamic = "force-dynamic";

/**
 * T2 提案骨架：创建入口只支持"改期提案"（reschedule_task 单操作），
 * 供 UI 发起改期 → 提案 diff → 原子 apply 的闭环。AI 生成提案在 T6 接入。
 */

const createSchema = z.object({
  type: z.literal("reschedule"),
  taskId: z.string().uuid(),
  scheduledStart: isoInstant.nullable(),
  scheduledEnd: isoInstant.nullable(),
  reason: z.string().max(1000).default(""),
});

const listQuerySchema = z.object({
  status: z.enum(["pending", "applied", "rejected", "snoozed"]).optional(),
});

export function GET(request: NextRequest) {
  const auth = requireOwner(request);
  if (!auth.ok) return auth.response;
  const q = listQuerySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
  if (!q.success) return errorResponse("VALIDATION", "查询参数不合法", 422);
  return NextResponse.json({ proposals: listProposals(q.data) });
}

/** POST —— 创建要求 Idempotency-Key；开始/结束时间在创建时即校验，apply 时再校验一次 */
export async function POST(request: NextRequest) {
  const auth = requireOwner(request);
  if (!auth.ok) return auth.response;
  const rawBody = await request.text();
  const json = parseJson(rawBody);
  if (!json.ok) return json.response;
  const parsed = createSchema.safeParse(json.value);
  if (!parsed.success) return errorResponse("VALIDATION", "输入不合法", 422, parsed.error.issues);
  const timeProblem = scheduleProblem(parsed.data.scheduledStart, parsed.data.scheduledEnd);
  if (timeProblem) return errorResponse("VALIDATION", timeProblem, 422);
  return runIdempotent(request, rawBody, {
    actorScope: `owner:${auth.session.ownerId}`,
    route: "proposals",
    execute: () => {
      const task = getTask(parsed.data.taskId);
      if (!task || task.archivedAt) throw new HttpError(404, "NOT_FOUND", "任务不存在或已归档");
      // 读集版本快照：apply 时校验
      const proposal = createProposal({
        contextRefs: [`task:${task.id}`],
        inputVersions: { [`task:${task.id}`]: task.version },
        operations: [
          {
            kind: "reschedule_task",
            taskId: task.id,
            expectedVersion: task.version,
            scheduledStart: parsed.data.scheduledStart,
            scheduledEnd: parsed.data.scheduledEnd,
          },
        ],
        reason: parsed.data.reason || `将「${task.title}」改期`,
        reasonCode: "manual_reschedule",
      });
      return { statusCode: 201, body: { proposal }, resourceType: "proposal", resourceId: proposal.id };
    },
  });
}
