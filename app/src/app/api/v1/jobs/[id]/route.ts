import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getJob } from "@/repositories/jobs";
import { listDeliveriesByJob } from "@/repositories/deliveries";
import { requireOwner } from "@/workflows/auth-guard";
import { notFound404 } from "@/workflows/http";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/** GET /api/v1/jobs/:id —— 说明阶段和错误；不以 HTTP 202 表示完成 */
export async function GET(request: NextRequest, ctx: Params) {
  const auth = requireOwner(request);
  if (!auth.ok) return auth.response;
  const { id } = await ctx.params;
  const job = getJob(id);
  if (!job) return notFound404("任务不存在");
  const deliveries = listDeliveriesByJob(id).map((d) => {
    const copy: Record<string, unknown> = { ...d };
    delete copy.snapshot;
    return copy;
  });
  return NextResponse.json({ job, deliveries });
}
