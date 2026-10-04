import { NextResponse, type NextRequest } from "next/server";
import { requireOwner } from "@/workflows/auth-guard";
import { listGoals } from "@/repositories/goals";

export const dynamic = "force-dynamic";

/**
 * GET /api/v2/goals?open=1&limit= —— 最近的目标（新→旧）：换设备或隔几小时后从这里“继续这个目标”。
 * 纯读取；继续时把 goalId 与 expectedGoalRevision 随投递一起提交，版本已变返回 409。
 */
export async function GET(request: NextRequest) {
  const auth = requireOwner(request);
  if (!auth.ok) return auth.response;
  const q = request.nextUrl.searchParams;
  const goals = listGoals({ limit: Number(q.get("limit") ?? 5) || 5, open: q.get("open") === "1" });
  return NextResponse.json({
    goals: goals.map((g) => ({
      id: g.id,
      conversationId: g.conversationId,
      objective: g.objective,
      revision: g.revision,
      state: g.state,
      lastResult: g.summary.lastResult ?? null,
      openQuestionIds: g.summary.openQuestionIds ?? [],
      updatedAt: g.updatedAt,
    })),
  });
}
