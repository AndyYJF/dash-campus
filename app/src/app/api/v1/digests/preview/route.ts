import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireOwner } from "@/workflows/auth-guard";
import { renderDigest } from "@/workflows/digests";
import { instanceTimezone, localDateInTz } from "@/domain/time";
import { errorResponse } from "@/workflows/http";
export const dynamic = "force-dynamic";
export async function POST(request: NextRequest) {
  const auth = requireOwner(request); if (!auth.ok) return auth.response;
  const p = z.object({ kind: z.enum(["daily", "weekly", "system"]) }).safeParse(await request.json().catch(() => null));
  if (!p.success) return errorResponse("VALIDATION", "请选择摘要类型", 422);
  return NextResponse.json(renderDigest(p.data.kind, localDateInTz(new Date(), instanceTimezone())));
}
