import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { listSavedCandidates } from "@/repositories/exploration";
import { requireOwner } from "@/workflows/auth-guard";

export const dynamic = "force-dynamic";

/** GET /api/v1/candidates —— 已保存为想法或已开始的候选 */
export function GET(request: NextRequest) {
  const auth = requireOwner(request);
  if (!auth.ok) return auth.response;
  return NextResponse.json({ candidates: listSavedCandidates() });
}
