import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { reportPreviewSchema } from "@/contracts/exports";
import { requireOwner } from "@/workflows/auth-guard";
import { errorResponse, parseJson } from "@/workflows/http";
import { buildProjectReport } from "@/workflows/exports";

export const dynamic = "force-dynamic";

/** POST —— 阶段报告预览：只计算，不写文件、不改状态（先选择字段和记录 → 预览 → 导出） */
export async function POST(request: NextRequest) {
  const auth = requireOwner(request);
  if (!auth.ok) return auth.response;
  const json = parseJson(await request.text());
  if (!json.ok) return json.response;
  const parsed = reportPreviewSchema.safeParse(json.value);
  if (!parsed.success) return errorResponse("VALIDATION", "输入不合法", 422, parsed.error.issues);
  const r = buildProjectReport(parsed.data);
  if (!r.ok) return errorResponse(r.code, r.message, r.code === "NOT_FOUND" ? 404 : 422);
  return NextResponse.json(r);
}
