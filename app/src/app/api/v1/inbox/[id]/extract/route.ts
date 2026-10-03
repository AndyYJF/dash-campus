import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireOwner } from "@/workflows/auth-guard";
import { getMessage } from "@/repositories/inbox";
import { enqueueNoticeExtraction } from "@/workflows/notice-extraction";
import { errorResponse, notFound404, conflict409 } from "@/workflows/http";
export const dynamic = "force-dynamic";
export async function POST(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = requireOwner(request); if (!auth.ok) return auth.response;
  const { id } = await ctx.params, message = getMessage(id);
  if (!message?.currentRevisionId) return notFound404("通知不存在");
  const input = z.object({ revisionId: z.string().uuid() }).safeParse(await request.json().catch(() => null));
  if (!input.success) return errorResponse("VALIDATION", "必须提供读取的修订版本", 422);
  if (message.currentRevisionId !== input.data.revisionId) return conflict409("通知已有新版本，请重新加载");
  const result = enqueueNoticeExtraction(input.data.revisionId, true);
  if (result.error) return errorResponse("EXTRACTION_UNAVAILABLE", result.error, 503);
  return NextResponse.json(result, { status: 202 });
}
