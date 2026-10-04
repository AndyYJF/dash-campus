import type { NextRequest } from "next/server";
import { requireOwner } from "@/workflows/auth-guard";
import { dashboardSnapshot } from "@/workflows/snapshot";
import { instanceTimezone, localDateInTz } from "@/domain/time";
import { nowDate } from "@/domain/clock";

export const dynamic = "force-dynamic";

/** GET /api/v2/dashboard?date=（MASTER-PLAN §8）：统一 snapshot，纯读取。 */
export async function GET(request: NextRequest) {
  const auth = requireOwner(request);
  if (!auth.ok) return auth.response;
  const now = nowDate();
  const date = request.nextUrl.searchParams.get("date") ?? localDateInTz(now, instanceTimezone());
  return Response.json(dashboardSnapshot(date, now));
}
