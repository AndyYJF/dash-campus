import type { NextRequest } from "next/server";
import { z } from "zod";
import { requireOwner } from "@/workflows/auth-guard";
import { errorResponse, runIdempotent } from "@/workflows/http";
import { startFocus } from "@/repositories/focus-timer";

export const dynamic = "force-dynamic";

const startSchema = z.object({
  taskId: z.string().uuid().optional(),
  note: z.string().max(200).default(""),
});

/** POST /api/v2/focus：启动计时（§5.1 最多 1 个进行中，已有则 409） */
export async function POST(request: NextRequest) {
  const auth = requireOwner(request);
  if (!auth.ok) return auth.response;
  const raw = await request.text();
  let value: unknown;
  try {
    value = raw ? JSON.parse(raw) : {};
  } catch {
    return errorResponse("VALIDATION", "请求体不是合法 JSON", 422);
  }
  const parsed = startSchema.safeParse(value);
  if (!parsed.success) return errorResponse("VALIDATION", parsed.error.issues.map((i) => i.message).join("；"), 422);

  return runIdempotent(request, raw, {
    actorScope: `owner:${auth.session.ownerId}`,
    route: "v2.focus.start",
    execute: () => {
      const row = startFocus({ taskId: parsed.data.taskId, note: parsed.data.note });
      if (!row) return { statusCode: 409, body: { error: { code: "FOCUS_IN_PROGRESS", message: "已有进行中的计时，先停止或暂停" } }, resourceType: null, resourceId: null };
      return { statusCode: 201, body: { focusId: row.id, startedAt: row.startedAt, version: row.version }, resourceType: "focus_session", resourceId: row.id };
    },
  });
}
