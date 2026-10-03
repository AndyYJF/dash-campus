import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { toPublicJob } from "@/contracts/jobs";
import { getJob } from "@/repositories/jobs";
import { requireOwner } from "@/workflows/auth-guard";
import { errorResponse, HttpError } from "@/workflows/http";
import { cancelOwnerJob } from "@/workflows/cancel-job";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/**
 * POST /api/v1/jobs/:id/cancel —— queued 可取消；running 保存取消请求，
 * 执行者在外部调用前与业务发布前检查。不承诺撤回已发送网络请求。
 * 主人可见的提醒、探索、原文提取、周复盘与卡点分析可取消。
 */
export async function POST(request: NextRequest, ctx: Params) {
  const auth = requireOwner(request);
  if (!auth.ok) return auth.response;
  const { id } = await ctx.params;
  try {
    const result = cancelOwnerJob(id);
    const after = getJob(id);
    return NextResponse.json({ result, job: after ? toPublicJob(after) : null });
  } catch (error) {
    if (error instanceof HttpError) return errorResponse(error.code, error.message, error.status);
    throw error;
  }
}
