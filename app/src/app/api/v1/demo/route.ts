import { NextResponse } from "next/server";
import { demoStatus } from "@/workflows/demo";

export const dynamic = "force-dynamic";

/**
 * GET /api/v1/demo —— 公开的展示模式状态（不需要会话）。
 * 正式实例：只告诉登录页有没有演示入口；演示实例：下次恢复时间与当天 AI 余量。不含密钥与业务数据。
 */
export function GET() {
  return NextResponse.json(demoStatus(), { headers: { "cache-control": "no-store" } });
}
