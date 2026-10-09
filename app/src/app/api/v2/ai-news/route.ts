import { NextResponse, type NextRequest } from "next/server";
import { requireOwner } from "@/workflows/auth-guard";
import {
  latestNewsDigest,
  listNewsRuns,
  newsPolicy,
} from "@/repositories/ai-news";
import { getAiBudget } from "@/workflows/ai-budget";
import { instanceTimezone } from "@/domain/time";
export const dynamic = "force-dynamic";
export function GET(request: NextRequest) {
  const auth = requireOwner(request);
  if (!auth.ok) return auth.response;
  return NextResponse.json({
    latest: latestNewsDigest(),
    runs: listNewsRuns(8).map((r) => ({
      id: r.id,
      status: r.status,
      days: r.days,
      createdAt: r.createdAt,
      errorMessage: r.errorMessage,
      trigger: r.trigger,
    })),
    ...newsPolicy(),
    scheduledEnabled: getAiBudget().budget.scheduledEnabled,
    timezone: instanceTimezone(),
  });
}
