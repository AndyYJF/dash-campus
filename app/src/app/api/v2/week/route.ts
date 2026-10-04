import type { NextRequest } from "next/server";
import { requireOwner } from "@/workflows/auth-guard";
import { weekSnapshot } from "@/workflows/snapshot";
import { instanceTimezone, localDateInTz, mondayOf } from "@/domain/time";
import { nowDate } from "@/domain/clock";

export const dynamic = "force-dynamic";

/** GET /api/v2/week?monday=（MASTER-PLAN §8）：周时间线/预算账本/未排原因，纯读取。 */
export async function GET(request: NextRequest) {
  const auth = requireOwner(request);
  if (!auth.ok) return auth.response;
  const now = nowDate();
  const monday = request.nextUrl.searchParams.get("monday") ?? mondayOf(localDateInTz(now, instanceTimezone()));
  return Response.json(weekSnapshot(monday, now));
}
