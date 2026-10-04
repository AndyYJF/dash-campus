import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireOwner } from "@/workflows/auth-guard";
import { errorResponse, HttpError, parseJson, runIdempotent } from "@/workflows/http";
import { OPERATIONS } from "@/contracts/commands";
import { executeOperation, isRegisteredOperation } from "@/workflows/commands";
import { operationResultView, statusForCode } from "@/workflows/results";
import { getInstanceState } from "@/repositories/instance";

export const dynamic = "force-dynamic";

/**
 * /api/v2/actions（AGENT-INTERFACE-CONTRACT §6）：卡片按钮与精简表单调用注册操作的入口。
 * 与 Agent 共用同一个执行器；只接已注册的操作，不接受任意工具名或 SQL。
 * GET 返回当前实例可用的操作（未注册的不展示）。
 */

const actionSchema = z.object({
  operation: z.string().min(1).max(64),
  args: z.record(z.string(), z.unknown()).default({}),
  /** 主人要求重新安排的日期（如“今天你看着排”） */
  replanDates: z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).max(7).default([]),
});

export async function GET(request: NextRequest) {
  const auth = requireOwner(request);
  if (!auth.ok) return auth.response;
  return NextResponse.json({
    operations: Object.entries(OPERATIONS).map(([name, m]) => ({ name, title: m.title, description: m.description, group: m.group, authorization: m.authorization, undo: m.undo })),
  });
}

export async function POST(request: NextRequest) {
  const auth = requireOwner(request);
  if (!auth.ok) return auth.response;
  const raw = await request.text();
  const json = parseJson(raw);
  if (!json.ok) return json.response;
  const parsed = actionSchema.safeParse(json.value);
  if (!parsed.success) return errorResponse("VALIDATION", "需要 operation 与 args", 422);
  const { operation, args, replanDates } = parsed.data;
  if (!isRegisteredOperation(operation)) return errorResponse("UNKNOWN_OPERATION", `未注册的操作「${operation}」`, 422);

  return runIdempotent(request, raw, {
    actorScope: `owner:${auth.session.ownerId}`,
    route: `v2.actions:${operation}`,
    execute: () => {
      const outcome = executeOperation(
        { ...args, command: operation },
        { intakeId: null, itemId: null, itemKey: "", instanceEpoch: getInstanceState().deploymentEpoch, evidence: "卡片操作", explicit: true },
        { replanDates },
      );
      const view = operationResultView(operation, outcome);
      // 失败不记幂等键（修正后可重试），也不留下半截结果
      if (view.error) throw new HttpError(statusForCode(view.error.code), view.error.code, view.error.message, { result: view });
      return { statusCode: 200, body: { result: view }, resourceType: "action_batch", resourceId: view.undo.batchId };
    },
  });
}
