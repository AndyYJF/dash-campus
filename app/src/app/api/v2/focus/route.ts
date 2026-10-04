import type { NextRequest } from "next/server";
import { z } from "zod";
import { requireOwner } from "@/workflows/auth-guard";
import { errorResponse, runIdempotent } from "@/workflows/http";
import { getDb } from "@/repositories/db";
import { startFocus } from "@/repositories/focus-timer";

export const dynamic = "force-dynamic";

const startSchema = z.object({
  taskId: z.string().uuid().optional(),
  /** 从行动卡开始：计时与这一段学习安排明确关联 */
  sessionId: z.string().min(1).max(64).optional(),
  note: z.string().max(200).default(""),
});

/** POST /api/v2/focus：启动计时（§5.1 最多 1 个进行中，已有则 409）。从学习块开始时该块同时进入“进行中” */
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
      const db = getDb();
      let taskId = parsed.data.taskId ?? null;
      let note = parsed.data.note;
      if (parsed.data.sessionId) {
        const s = db.prepare(`SELECT s.task_id, s.status, t.title FROM plan_sessions s JOIN tasks t ON t.id = s.task_id WHERE s.id = ?`).get(parsed.data.sessionId) as { task_id: string; status: string; title: string } | undefined;
        if (!s || !["planned", "tentative", "in_progress"].includes(s.status)) return { statusCode: 404, body: { error: { code: "NOT_FOUND", message: "这个学习块不存在或已结束" } }, resourceType: null, resourceId: null };
        taskId = s.task_id;
        note = note || s.title;
      }
      const row = startFocus({ taskId, note, planSessionId: parsed.data.sessionId ?? null });
      if (!row) return { statusCode: 409, body: { error: { code: "FOCUS_IN_PROGRESS", message: "已有进行中的计时，先停止或暂停" } }, resourceType: null, resourceId: null };
      if (parsed.data.sessionId) db.prepare(`UPDATE plan_sessions SET status = 'in_progress', version = version + 1, updated_at = ? WHERE id = ? AND status IN ('planned','tentative')`).run(new Date().toISOString(), parsed.data.sessionId);
      return { statusCode: 201, body: { focusId: row.id, startedAt: row.startedAt, version: row.version }, resourceType: "focus_session", resourceId: row.id };
    },
  });
}
