import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import { topicPatchSchema } from "@/contracts/exploration";
import { getTopic } from "@/repositories/exploration";
import { requireOwner } from "@/workflows/auth-guard";
import { conflict409, errorResponse, notFound404 } from "@/workflows/http";
import { archiveTopic, updateTopic } from "@/workflows/topics";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

export async function GET(request: NextRequest, ctx: Params) {
  const auth = requireOwner(request);
  if (!auth.ok) return auth.response;
  const { id } = await ctx.params;
  const topic = getTopic(id);
  if (!topic) return notFound404("关注方向不存在");
  return NextResponse.json({ topic });
}

/** PATCH：开关订阅、改时间或内容；增加版本，使未开始的旧 run 失效 */
export async function PATCH(request: NextRequest, ctx: Params) {
  const auth = requireOwner(request);
  if (!auth.ok) return auth.response;
  const { id } = await ctx.params;
  const parsed = topicPatchSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return errorResponse("VALIDATION", "输入不合法", 422, parsed.error.issues);
  const r = updateTopic(id, parsed.data);
  if (r === "not_found") return notFound404("关注方向不存在");
  if (r === "conflict") return conflict409();
  return NextResponse.json({ topic: r });
}

/** DELETE：软删除（归档）并停用，要求 expectedVersion */
export async function DELETE(request: NextRequest, ctx: Params) {
  const auth = requireOwner(request);
  if (!auth.ok) return auth.response;
  const { id } = await ctx.params;
  const parsed = z
    .object({ expectedVersion: z.number().int().min(1) })
    .safeParse(await request.json().catch(() => null));
  if (!parsed.success) return errorResponse("VALIDATION", "需要 expectedVersion", 422, parsed.error.issues);
  const r = archiveTopic(id, parsed.data.expectedVersion);
  if (r === "not_found") return notFound404("关注方向不存在");
  if (r === "conflict") return conflict409();
  return NextResponse.json({ topic: r });
}
