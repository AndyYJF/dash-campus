import type { NextRequest } from "next/server";
import { z } from "zod";
import { requireOwner } from "@/workflows/auth-guard";
import { errorResponse, runIdempotent } from "@/workflows/http";
import { stopFocusAndRecord } from "@/workflows/focus-timer";

export const dynamic = "force-dynamic";

const actionSchema = z.object({
  expectedVersion: z.number().int().min(1),
  confirm: z.boolean().default(false),
});

/** POST /api/v2/focus/:id/stop：停止计时落实践（>4h 需 confirm=true；A08 同日手动近值合并） */
export async function POST(request: NextRequest, ctx: { params: Promise<{ id: string; action: string }> }) {
  const auth = requireOwner(request);
  if (!auth.ok) return auth.response;
  const { id, action } = await ctx.params;
  if (action !== "stop") return errorResponse("VALIDATION", `不支持的操作：${action}`, 422);
  const raw = await request.text();
  let value: unknown;
  try {
    value = raw ? JSON.parse(raw) : {};
  } catch {
    return errorResponse("VALIDATION", "请求体不是合法 JSON", 422);
  }
  const parsed = actionSchema.safeParse(value);
  if (!parsed.success) return errorResponse("VALIDATION", parsed.error.issues.map((i) => i.message).join("；"), 422);

  return runIdempotent(request, raw, {
    actorScope: `owner:${auth.session.ownerId}`,
    route: `v2.focus.${action}`,
    execute: () => {
      const r = stopFocusAndRecord(id, parsed.data.expectedVersion, parsed.data.confirm);
      if (r.kind === "not_open") return { statusCode: 404, body: { error: { code: "NOT_FOUND", message: "计时不存在或已完成" } }, resourceType: null, resourceId: null };
      if (r.kind === "stale") return { statusCode: 409, body: { error: { code: "STALE_VERSION", message: "版本已变化，请刷新后重试" } }, resourceType: null, resourceId: null };
      if (r.kind === "needs_confirmation") {
        return { statusCode: 409, body: { error: { code: "NEEDS_CONFIRMATION", message: `计时 ${r.minutes} 分钟超过 4 小时，确认后计入` } }, resourceType: null, resourceId: null };
      }
      return { statusCode: 200, body: { focusId: id, minutes: r.minutes, merged: r.merged }, resourceType: "focus_session", resourceId: id };
    },
  });
}
