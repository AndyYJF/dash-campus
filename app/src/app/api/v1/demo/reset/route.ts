import { NextResponse, type NextRequest } from "next/server";
import { isDemoMode } from "@/domain/demo";
import { requireOwner } from "@/workflows/auth-guard";
import { errorResponse } from "@/workflows/http";
import { demoStatus, resetDemoData } from "@/workflows/demo";

export const dynamic = "force-dynamic";

/**
 * POST /api/v1/demo/reset —— 访客手动把数据恢复成初始示例（只在演示实例上存在）。
 * 所有访客共用一份数据，恢复会影响正在用的人：两次恢复之间有最短间隔。访客会话与当天 AI 余量不变。
 */
export function POST(request: NextRequest) {
  if (!isDemoMode()) return errorResponse("NOT_FOUND", "这个实例没有开启演示模式", 404);
  const auth = requireOwner(request);
  if (!auth.ok) return auth.response;
  const before = demoStatus();
  if (before.demo && before.resetCooldownSeconds > 0) {
    return NextResponse.json(
      { error: { code: "RATE_LIMITED", message: `示例数据刚恢复过，${Math.ceil(before.resetCooldownSeconds / 60)} 分钟后才能再恢复一次` } },
      { status: 429, headers: { "Retry-After": String(before.resetCooldownSeconds) } },
    );
  }
  resetDemoData();
  return NextResponse.json(demoStatus());
}
