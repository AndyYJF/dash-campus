import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import { aiBudgetSchema } from "@/contracts/review";
import { requireOwner } from "@/workflows/auth-guard";
import { conflict409, errorResponse } from "@/workflows/http";
import { getAiBudget, saveAiBudget, usageToday } from "@/workflows/ai-budget";

export const dynamic = "force-dynamic";

/** GET —— 预算设置 + 今日用量（次数与 token；不估算金额） */
export function GET(request: NextRequest) {
  const auth = requireOwner(request);
  if (!auth.ok) return auth.response;
  const { budget, version } = getAiBudget();
  return NextResponse.json({ budget, version, usage: usageToday() });
}

/** PATCH —— expectedVersion 乐观锁；0 表示首次保存。只合并请求里显式给出的字段 */
export async function PATCH(request: NextRequest) {
  const auth = requireOwner(request);
  if (!auth.ok) return auth.response;
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const version = z.object({ expectedVersion: z.number().int().min(0) }).safeParse(body);
  if (!body || !version.success) return errorResponse("VALIDATION", "需要 expectedVersion", 422);
  const { expectedVersion, ...patch } = body;
  void expectedVersion;
  const parsed = aiBudgetSchema.safeParse({ ...getAiBudget().budget, ...patch });
  if (!parsed.success) return errorResponse("VALIDATION", "输入不合法", 422, parsed.error.issues);
  const merged = parsed.data;
  const expected = version.data.expectedVersion;
  const r = saveAiBudget(merged, expected);
  if (r === "conflict") return conflict409();
  return NextResponse.json({ budget: merged, version: r.version, usage: usageToday() });
}
