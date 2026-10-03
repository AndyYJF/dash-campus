import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import { createLog, listLogs } from "@/repositories/logs";
import { requireOwner } from "@/workflows/auth-guard";
import { errorResponse, withReferenceCheck } from "@/workflows/http";

export const dynamic = "force-dynamic";

const logSchema = z
  .object({
    clientEntryId: z.string().min(1).max(100),
    occurredOn: z.iso.date(),
    progress: z.string().max(5000).default(""),
    blocker: z.string().max(5000).default(""),
    taskId: z.string().uuid().nullable().optional(),
    projectId: z.string().uuid().nullable().optional(),
  })
  .refine((v) => v.progress.trim() !== "" || v.blocker.trim() !== "", {
    message: "进展与卡点至少一项非空",
  });

const listQuerySchema = z.object({
  projectId: z.string().uuid().optional(),
  taskId: z.string().uuid().optional(),
});

export function GET(request: NextRequest) {
  const auth = requireOwner(request);
  if (!auth.ok) return auth.response;
  const q = listQuerySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
  if (!q.success) return errorResponse("VALIDATION", "查询参数不合法", 422);
  return NextResponse.json({ logs: listLogs(q.data) });
}

/** POST /api/v1/logs —— clientEntryId 幂等（F17）；同 ID 异正文 409 */
export async function POST(request: NextRequest) {
  const auth = requireOwner(request);
  if (!auth.ok) return auth.response;
  const parsed = logSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return errorResponse("VALIDATION", "输入不合法", 422, parsed.error.issues);
  return withReferenceCheck(() => {
    const result = createLog({
      clientEntryId: parsed.data.clientEntryId,
      occurredOn: parsed.data.occurredOn,
      progress: parsed.data.progress,
      blocker: parsed.data.blocker,
      taskId: parsed.data.taskId ?? null,
      projectId: parsed.data.projectId ?? null,
    });
    if (result === "content_conflict") {
      return errorResponse("CONTENT_CONFLICT", "相同 clientEntryId 已用于不同内容的记录", 409);
    }
    return NextResponse.json({ log: result.log }, { status: result.replayed ? 200 : 201 });
  });
}
