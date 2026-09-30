import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import { expectedVersionSchema, taskPatchSchema } from "@/contracts/planning";
import { getTask, setTaskSourceRevision, updateTask } from "@/repositories/planning";
import { requireOwner } from "@/workflows/auth-guard";
import { conflict409, errorResponse, notFound404 } from "@/workflows/http";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

export async function GET(request: NextRequest, ctx: Params) {
  const auth = requireOwner(request);
  if (!auth.ok) return auth.response;
  const { id } = await ctx.params;
  const task = getTask(id);
  if (!task) return notFound404("任务不存在");
  return NextResponse.json({ task });
}

export async function PATCH(request: NextRequest, ctx: Params) {
  const auth = requireOwner(request);
  if (!auth.ok) return auth.response;
  const { id } = await ctx.params;
  const parsed = expectedVersionSchema
    .merge(taskPatchSchema)
    .extend({ sourceRevisionId: z.string().uuid().optional() })
    .safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return errorResponse("VALIDATION", "输入不合法", 422, parsed.error.issues);
  }
  const { expectedVersion, sourceRevisionId, ...patch } = parsed.data;
  const result = updateTask(id, patch, expectedVersion);
  if (result === "not_found") return notFound404("任务不存在或已归档");
  if (result === "conflict") return conflict409();
  // 人工编辑路径：主人确认来源修订后记录来源版本（计划 5.1），不自动覆盖来自收件箱的其他字段
  // （planningRevision 已在 updateTask 事务内递增）
  if (sourceRevisionId) setTaskSourceRevision(id, sourceRevisionId);
  return NextResponse.json({ task: sourceRevisionId ? (getTask(id) ?? result) : result });
}
