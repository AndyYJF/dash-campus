import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { toPublicJob } from "@/contracts/jobs";
import { getJob, requestCancel } from "@/repositories/jobs";
import { requireOwner } from "@/workflows/auth-guard";
import { errorResponse, notFound404 } from "@/workflows/http";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/**
 * POST /api/v1/jobs/:id/cancel —— queued 可取消；running 保存取消请求，
 * 执行者在外部调用前与业务发布前检查。不承诺撤回已发送网络请求。
 * T3 只有 reminder 一种可取消 job 类型。
 */
export async function POST(request: NextRequest, ctx: Params) {
  const auth = requireOwner(request);
  if (!auth.ok) return auth.response;
  const { id } = await ctx.params;
  const job = getJob(id);
  if (!job) return notFound404("任务不存在");
  if (job.type !== "reminder") {
    return errorResponse("NOT_CANCELLABLE", "该作业类型不可取消", 422);
  }
  const result = requestCancel(id);
  const after = getJob(id);
  return NextResponse.json({ result, job: after ? toPublicJob(after) : null });
}
