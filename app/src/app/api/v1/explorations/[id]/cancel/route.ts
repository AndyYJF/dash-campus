import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { requireOwner } from "@/workflows/auth-guard";
import { errorResponse, notFound404 } from "@/workflows/http";
import { cancelExploration } from "@/workflows/exploration";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/** 取消：queued 立即取消；运行中记录取消请求，在下一次外部调用前与发布前生效 */
export async function POST(request: NextRequest, ctx: Params) {
  const auth = requireOwner(request);
  if (!auth.ok) return auth.response;
  const { id } = await ctx.params;
  const r = cancelExploration(id);
  if (r === "not_found") return notFound404("探索记录不存在");
  if (r === "finished") return errorResponse("ALREADY_FINISHED", "该探索已结束", 409);
  return NextResponse.json({ result: r });
}
