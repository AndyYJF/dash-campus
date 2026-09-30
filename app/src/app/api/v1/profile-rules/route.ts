import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { profileRuleSchema } from "@/contracts/inbox";
import { requireOwner } from "@/workflows/auth-guard";
import { errorResponse } from "@/workflows/http";
import { createRule, listRules } from "@/repositories/profile";

export const dynamic = "force-dynamic";

/** GET /api/v1/profile-rules —— 规则列表（含未启用草稿） */
export function GET(request: NextRequest) {
  const auth = requireOwner(request);
  if (!auth.ok) return auth.response;
  return NextResponse.json({ rules: listRules() });
}

/** POST /api/v1/profile-rules —— 创建规则（默认未启用；预览影响后由主人启用） */
export async function POST(request: NextRequest) {
  const auth = requireOwner(request);
  if (!auth.ok) return auth.response;
  const parsed = profileRuleSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return errorResponse("VALIDATION", "输入不合法", 422, parsed.error.issues);
  const rule = createRule({
    source: parsed.data.source,
    noticeType: parsed.data.noticeType,
    condition: parsed.data.condition,
    outputPartition: parsed.data.outputPartition,
    priority: parsed.data.priority,
  });
  return NextResponse.json({ rule }, { status: 201 });
}
