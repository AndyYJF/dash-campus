import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import { requireOwner } from "@/workflows/auth-guard";
import { errorResponse, notFound404 } from "@/workflows/http";
import { selectRevision } from "@/workflows/inbox";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

const bodySchema = z.object({ revisionId: z.string().uuid() });

/**
 * POST /api/v1/inbox/:id/select-revision —— 主人为 revision_conflict 选择当前版本
 * （计划 5.1"待主人选择，不按网络抵达时间猜新旧"的落点；路由表外的最小补充）。
 */
export async function POST(request: NextRequest, ctx: Params) {
  const auth = requireOwner(request);
  if (!auth.ok) return auth.response;
  const { id } = await ctx.params;
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return errorResponse("VALIDATION", "输入不合法", 422, parsed.error.issues);
  const r = selectRevision(id, parsed.data.revisionId);
  if (r === "not_found") return notFound404("通知或修订不存在");
  return NextResponse.json({ selected: parsed.data.revisionId });
}
