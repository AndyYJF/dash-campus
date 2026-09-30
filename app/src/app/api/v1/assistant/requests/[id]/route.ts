import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getAssistantRequest } from "@/repositories/reviews";
import { requireOwner } from "@/workflows/auth-guard";
import { notFound404 } from "@/workflows/http";
import { proposalsFrom } from "@/workflows/review";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/** GET —— 分析状态、结果（含实际读取范围）与产生的提案 */
export async function GET(request: NextRequest, ctx: Params) {
  const auth = requireOwner(request);
  if (!auth.ok) return auth.response;
  const { id } = await ctx.params;
  const req = getAssistantRequest(id);
  if (!req) return notFound404("分析请求不存在");
  return NextResponse.json({ request: req, proposals: proposalsFrom("assistant", id) });
}
