import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import { PROFILE_FIELDS, profileFactSchema } from "@/contracts/inbox";
import { requireOwner } from "@/workflows/auth-guard";
import { conflict409, errorResponse } from "@/workflows/http";
import { listFacts } from "@/repositories/profile";
import { resolveProfile } from "@/workflows/inbox";

export const dynamic = "force-dynamic";

const patchSchema = z.object({
  facts: z.array(profileFactSchema).min(1).max(20),
});

/** GET /api/v1/profile —— 主人确认的身份事实 */
export function GET(request: NextRequest) {
  const auth = requireOwner(request);
  if (!auth.ok) return auth.response;
  return NextResponse.json({ facts: listFacts(), allowedFields: PROFILE_FIELDS });
}

/** PATCH /api/v1/profile —— 更正身份（每字段 expectedVersion 乐观锁）；变更后重评受影响判断 */
export async function PATCH(request: NextRequest) {
  const auth = requireOwner(request);
  if (!auth.ok) return auth.response;
  const parsed = patchSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return errorResponse("VALIDATION", "输入不合法", 422, parsed.error.issues);
  const result = resolveProfile(parsed.data.facts);
  if (result === "invalid_field") return errorResponse("VALIDATION", "包含不允许的身份字段", 422);
  if (result.conflicts.length > 0) return conflict409(`版本冲突字段：${result.conflicts.join(", ")}`);
  return NextResponse.json({ updated: result.updated, facts: listFacts() });
}
