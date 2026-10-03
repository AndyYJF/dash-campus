import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { requireOwner } from "@/workflows/auth-guard";
import { instanceTimezone, localDateInTz, mondayOf } from "@/domain/time";
import { buildActions } from "@/domain/today";
import { computeWorkload, weekRange } from "@/domain/workload";
import { getFocus } from "@/repositories/focus";
import { listProposals } from "@/repositories/proposals";
import { listTasks } from "@/repositories/planning";
import { listRecentLogs } from "@/repositories/logs";
import { listPendingInboxDecisions } from "@/workflows/pending-inbox";

export const dynamic = "force-dynamic";

/**
 * GET /api/v1/today —— 共同 asOf 的快照（计划 v1.2 第 13.2 节 TodaySummary）。
 * 客户端不得跨多个独立请求拼负担数值；普通刷新不触发模型调用。
 */

export function GET(request: NextRequest) {
  const auth = requireOwner(request);
  if (!auth.ok) return auth.response;
  const tz = instanceTimezone();
  const asOf = new Date();
  const localDate = localDateInTz(asOf, tz);
  const localMonday = mondayOf(localDate);

  const allTasks = listTasks();
  const actions = buildActions(allTasks, localDate, localMonday, asOf, tz);
  const shownActions = actions.slice(0, 6);

  const proposals = listProposals({ status: "pending" }).filter(
    (p) => !p.validation && (!p.snoozeUntil || new Date(p.snoozeUntil).getTime() <= asOf.getTime()),
  );
  // 收件箱当前修订的 action/review 项也进首页待决策（T4）
  const inboxDecisions = listPendingInboxDecisions();
  const allDecisions = [...inboxDecisions, ...proposals.map((p) => ({
    kind: "proposal" as const,
    id: p.id,
    title: p.reason || "（无标题提案）",
    version: p.version,
    href: `/reviews#${p.id}`,
  }))];
  const decisions = allDecisions.slice(0, 3);

  const focus = getFocus(localMonday, tz);

  return NextResponse.json({
    asOf: asOf.toISOString(),
    timezone: tz,
    localDate,
    week: weekRange(localMonday),
    focus: focus
      ? {
          title: focus.title,
          goalId: focus.goalId,
          projectId: focus.projectId,
          confirmedAt: focus.confirmedAt,
          version: focus.version,
        }
      : null,
    workload: (() => {
      const w = computeWorkload(allTasks, localMonday, asOf);
      return {
        remainingKnownMinutes: w.remainingKnownMinutes,
        remainingUnknownCount: w.remainingUnknownCount,
        futureCapacityMinutes: w.futureCapacityMinutes,
        bufferPercent: w.bufferPercent,
        estimateMode: w.estimateMode,
      };
    })(),
    actions: shownActions,
    moreActionCount: Math.max(0, actions.length - shownActions.length),
    unplannedTaskCount: allTasks.filter((task) => !task.plannedWeek && !["done", "cancelled"].includes(task.status)).length,
    decisions,
    moreDecisionCount: allDecisions.length - decisions.length,
    recentLogs: listRecentLogs(3),
  });
}
