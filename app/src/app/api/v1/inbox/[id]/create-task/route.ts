import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import { dueSchema } from "@/contracts/planning";
import { requireOwner } from "@/workflows/auth-guard";
import { errorResponse, notFound404 } from "@/workflows/http";
import { createTaskFromAction } from "@/workflows/inbox";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

const bodySchema = z.object({
  actionKey: z.string().min(1).max(100),
  title: z.string().trim().min(1).max(200).optional(),
  due: dueSchema.optional(),
});

/**
 * POST /api/v1/inbox/:id/create-task —— 从行动草案创建正式任务（主人显式动作）。
 * 已关联时返回既有任务与差异草案，不复制不覆盖（F5）。
 */
export async function POST(request: NextRequest, ctx: Params) {
  const auth = requireOwner(request);
  if (!auth.ok) return auth.response;
  const { id } = await ctx.params;
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return errorResponse("VALIDATION", "输入不合法", 422, parsed.error.issues);
  const result = createTaskFromAction(id, parsed.data.actionKey, {
    title: parsed.data.title,
    due: parsed.data.due,
  });
  if (result.kind === "not_found") return notFound404("通知或行动草案不存在");
  return NextResponse.json(result, { status: result.kind === "created" ? 201 : 200 });
}
