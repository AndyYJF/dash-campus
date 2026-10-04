import type { NextRequest } from "next/server";
import { z } from "zod";
import { requireOwner } from "@/workflows/auth-guard";
import { errorResponse, runIdempotent } from "@/workflows/http";
import { splitFocusMerge, stopFocusAndRecord } from "@/workflows/focus-timer";

export const dynamic = "force-dynamic";

const actionSchema = z.object({
  expectedVersion: z.number().int().min(1),
  /** 长计时/跨日：确认按候选分钟计入 */
  confirm: z.boolean().default(false),
  /** 修正为实际分钟（不超过计时时长） */
  minutes: z.number().int().min(1).max(24 * 60).nullable().optional(),
  /** 放弃这次计时，不计入 */
  discard: z.boolean().default(false),
});

/**
 * POST /api/v2/focus/:id/stop | split
 * stop：停止计时落实践。超过 4 小时或跨日先返回具体时段与候选分钟（409），由主人确认/修正/放弃。
 * split：上次停止被合并进手动记录，而主人说“不是同一次”时分开记。
 */
export async function POST(request: NextRequest, ctx: { params: Promise<{ id: string; action: string }> }) {
  const auth = requireOwner(request);
  if (!auth.ok) return auth.response;
  const { id, action } = await ctx.params;
  if (action !== "stop" && action !== "split") return errorResponse("VALIDATION", `不支持的操作：${action}`, 422);
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
      if (action === "split") {
        const s = splitFocusMerge(id);
        if (s.kind === "not_merged") return { statusCode: 409, body: { error: { code: "NOT_MERGED", message: "这次计时没有和别的记录合并" } }, resourceType: null, resourceId: null };
        return { statusCode: 200, body: { focusId: id, practiceId: s.practiceId, split: true }, resourceType: "focus_session", resourceId: id };
      }
      const r = stopFocusAndRecord(id, parsed.data.expectedVersion, { confirm: parsed.data.confirm, minutes: parsed.data.minutes ?? null, discard: parsed.data.discard });
      if (r.kind === "not_open") return { statusCode: 404, body: { error: { code: "NOT_FOUND", message: "计时不存在或已完成" } }, resourceType: null, resourceId: null };
      if (r.kind === "stale") return { statusCode: 409, body: { error: { code: "STALE_VERSION", message: "版本已变化，请刷新后重试" } }, resourceType: null, resourceId: null };
      if (r.kind === "invalid_minutes") return { statusCode: 422, body: { error: { code: "VALIDATION", message: `实际分钟要在 1 到 ${r.max} 之间（计时一共 ${r.max} 分钟）` } }, resourceType: null, resourceId: null };
      if (r.kind === "needs_confirmation") {
        const why = r.reason === "long" ? "超过 4 小时" : "跨了一天";
        return {
          statusCode: 409,
          body: { error: { code: "NEEDS_CONFIRMATION", message: `这次计时从 ${r.startedAt} 开始，共 ${r.minutes} 分钟，${why}。确认照此计入、改成实际分钟，或放弃这次计时`, details: { minutes: r.minutes, startedAt: r.startedAt, reason: r.reason } } },
          resourceType: null,
          resourceId: null,
        };
      }
      if (r.kind === "discarded") return { statusCode: 200, body: { focusId: id, discarded: true }, resourceType: "focus_session", resourceId: id };
      return { statusCode: 200, body: { focusId: id, minutes: r.minutes, merged: r.merged, practiceId: r.practiceId, mergedNote: r.mergedNote }, resourceType: "focus_session", resourceId: id };
    },
  });
}
