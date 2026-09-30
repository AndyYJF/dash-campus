import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { requireOwner } from "@/workflows/auth-guard";
import { restoreStatus } from "@/workflows/restore";

export const dynamic = "force-dynamic";

/**
 * GET /api/v1/instance —— 恢复暂停状态与待处理摘要（只读）。
 * Web 不提供恢复/解除按钮：解除只能由 scripts/resume-after-restore.sh 显式确认（计划 5.2、10.2）。
 */
export function GET(request: NextRequest) {
  const auth = requireOwner(request);
  if (!auth.ok) return auth.response;
  return NextResponse.json(restoreStatus());
}
