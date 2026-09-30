import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import { requireOwner } from "@/workflows/auth-guard";
import { checkIdempotency } from "@/workflows/idempotency";
import { conflict409, errorResponse, parseJson, runIdempotent } from "@/workflows/http";
import { deleteFocus, getFocus, upsertFocus } from "@/repositories/focus";

export const dynamic = "force-dynamic";

const focusSchema = z
  .object({
    localMonday: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    timezone: z.string().min(1),
    title: z.string().trim().min(1).max(200),
    goalId: z.string().uuid().nullable().optional(),
    projectId: z.string().uuid().nullable().optional(),
    expectedVersion: z.number().int().min(1).optional(),
  })
  .refine((v) => !(v.goalId && v.projectId), {
    message: "goal 与 project 至多关联一个",
  });

/**
 * PUT /api/v1/planning/week/focus —— 无则创建（需 Idempotency-Key），有则更新（需 expectedVersion）。
 * 带幂等键时先查幂等记录：首次创建后网络重发同一请求返回原结果，而不是落进更新分支 409。
 * 周重点不属于课程/可用时间/任务计划时间，不递增 planningRevision（第 6 节）。
 */
export async function PUT(request: NextRequest) {
  const auth = requireOwner(request);
  if (!auth.ok) return auth.response;
  const rawBody = await request.text();
  const json = parseJson(rawBody);
  if (!json.ok) return json.response;
  const parsed = focusSchema.safeParse(json.value);
  if (!parsed.success) return errorResponse("VALIDATION", "输入不合法", 422, parsed.error.issues);
  const { localMonday, timezone, title, goalId, projectId, expectedVersion } = parsed.data;
  const actorScope = `owner:${auth.session.ownerId}`;
  const route = "planning.week.focus";
  const key = request.headers.get("idempotency-key");

  if (key) {
    const prior = checkIdempotency({ actorScope, route, key, requestBody: rawBody });
    if (prior.kind === "replay") return NextResponse.json(prior.body, { status: prior.statusCode });
    if (prior.kind === "collision") {
      return errorResponse("IDEMPOTENCY_COLLISION", "相同 Idempotency-Key 携带了不同请求体", 409);
    }
  }

  const existing = getFocus(localMonday, timezone);
  if (!existing) {
    if (!key) return errorResponse("IDEMPOTENCY_KEY_REQUIRED", "首次设置重点必须携带 Idempotency-Key 头", 422);
    return runIdempotent(request, rawBody, {
      actorScope,
      route,
      execute: () => {
        const created = upsertFocus({ localMonday, timezone, title, goalId: goalId ?? null, projectId: projectId ?? null });
        if (created === "conflict") throw new Error("unreachable: focus create conflict");
        return { statusCode: 201, body: { focus: created }, resourceType: "weekly_focus", resourceId: created.id };
      },
    });
  }

  const updated = upsertFocus({
    localMonday,
    timezone,
    title,
    goalId: goalId ?? null,
    projectId: projectId ?? null,
    expectedVersion,
  });
  if (updated === "conflict") return conflict409();
  return NextResponse.json({ focus: updated });
}

/** DELETE /api/v1/planning/week/focus —— { localMonday, timezone, expectedVersion } */
export async function DELETE(request: NextRequest) {
  const auth = requireOwner(request);
  if (!auth.ok) return auth.response;
  const parsed = z
    .object({
      localMonday: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      timezone: z.string().min(1),
      expectedVersion: z.number().int().min(1),
    })
    .safeParse(await request.json().catch(() => null));
  if (!parsed.success) return errorResponse("VALIDATION", "输入不合法", 422, parsed.error.issues);
  const ok = deleteFocus(parsed.data.localMonday, parsed.data.timezone, parsed.data.expectedVersion);
  if (!ok) return errorResponse("CONFLICT", "重点不存在或版本冲突", 409);
  return NextResponse.json({ ok: true });
}
