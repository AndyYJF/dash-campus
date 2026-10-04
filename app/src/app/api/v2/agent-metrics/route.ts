import { NextResponse, type NextRequest } from "next/server";
import { requireOwner } from "@/workflows/auth-guard";
import { trialMetrics } from "@/workflows/agent-metrics";

export const dynamic = "force-dynamic";

/** GET /api/v2/agent-metrics?days=7 —— 试用指标（只读聚合，不调模型、不写库） */
export async function GET(request: NextRequest) {
  const auth = requireOwner(request);
  if (!auth.ok) return auth.response;
  const days = Number(request.nextUrl.searchParams.get("days") ?? 7) || 7;
  return NextResponse.json({ metrics: trialMetrics({ days }) });
}
