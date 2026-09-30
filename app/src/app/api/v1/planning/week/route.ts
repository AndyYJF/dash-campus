import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import { requireOwner } from "@/workflows/auth-guard";
import { errorResponse } from "@/workflows/http";
import { computeWorkload, weekRange } from "@/domain/workload";
import { instanceTimezone, localDateInTz, mondayOf } from "@/domain/time";
import { getFocus } from "@/repositories/focus";
import { listTasks } from "@/repositories/planning";

export const dynamic = "force-dynamic";

const querySchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

/** GET /api/v1/planning/week —— 周负担 + 周重点 + 当周任务 */
export function GET(request: NextRequest) {
  const auth = requireOwner(request);
  if (!auth.ok) return auth.response;
  const q = querySchema.safeParse(
    Object.fromEntries(new URL(request.url).searchParams),
  );
  if (!q.success) return errorResponse("VALIDATION", "查询参数不合法", 422);
  const tz = instanceTimezone();
  const asOf = new Date();
  const localDate = q.data.date ?? localDateInTz(asOf, tz);
  const localMonday = mondayOf(localDate);
  const tasks = listTasks().filter((t) => t.plannedWeek?.localMonday === localMonday);
  return NextResponse.json({
    asOf: asOf.toISOString(),
    timezone: tz,
    localDate,
    week: weekRange(localMonday),
    focus: getFocus(localMonday, tz),
    workload: computeWorkload(listTasks(), localMonday, asOf),
    tasks,
  });
}
