import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { requireOwner } from "@/workflows/auth-guard";
import { dueBoundaryUtc, instanceTimezone, localDateInTz, mondayOf } from "@/domain/time";
import { computeWorkload, weekRange } from "@/domain/workload";
import { getFocus } from "@/repositories/focus";
import { listProposals } from "@/repositories/proposals";
import { listTasks, type TaskRow } from "@/repositories/planning";
import { listRecentLogs } from "@/repositories/logs";
import { getDecisionByRevision, getRevision, listMessages } from "@/repositories/inbox";

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
  const actionable = allTasks.filter(
    (t) => t.status === "todo" || t.status === "doing" || t.status === "blocked",
  );

  const sections: Record<string, TaskRow[]> = { overdue: [], today: [], upcoming: [], this_week: [] };
  for (const task of actionable) {
    sections[classify(task, localDate, localMonday, asOf)].push(task);
  }
  const order = { overdue: 0, today: 1, upcoming: 2, this_week: 3 };
  const actions = (Object.entries(sections) as Array<[string, TaskRow[]]>)
    .flatMap(([section, tasks]) =>
      tasks.sort((a, b) => (dueBoundaryUtc(a.due) ?? "9999") < (dueBoundaryUtc(b.due) ?? "9999") ? -1 : 1)
        .map((task) => ({ task, section: section as "overdue" | "today" | "upcoming" | "this_week" })),
    )
    .sort((a, b) => order[a.section] - order[b.section]);
  const shownActions = actions.slice(0, 6);

  const proposals = listProposals({ status: "pending" }).filter(
    (p) => !p.snoozeUntil || new Date(p.snoozeUntil).getTime() <= asOf.getTime(),
  );
  // 收件箱当前修订的 action/review 项也进首页待决策（T4）
  const inboxDecisions = listMessages({ status: "active" }).flatMap((m) => {
    if (!m.currentRevisionId) return [];
    const revision = getRevision(m.currentRevisionId);
    const decision = getDecisionByRevision(m.currentRevisionId);
    if (!revision || !decision) return [];
    if (decision.partition !== "action" && decision.partition !== "review") return [];
    return [
      {
        kind: "inbox" as const,
        id: m.id,
        title: revision.structured?.action?.title ?? revision.text.slice(0, 60),
        version: decision.version,
        href: `/inbox/${m.id}`,
      },
    ];
  });
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
    decisions,
    moreDecisionCount: allDecisions.length - decisions.length,
    recentLogs: listRecentLogs(3),
  });
}

function classify(
  task: TaskRow,
  localDate: string,
  localMonday: string,
  asOf: Date,
): "overdue" | "today" | "upcoming" | "this_week" {
  const boundary = dueBoundaryUtc(task.due);
  if (boundary && new Date(boundary).getTime() < asOf.getTime()) return "overdue";
  if (task.due.kind === "date" && task.due.localDate === localDate) return "today";
  if (task.due.kind === "instant" && localDateInTz(new Date(task.due.at), task.due.timezone) === localDate) {
    return "today";
  }
  if (boundary) return "upcoming";
  if (task.plannedWeek?.localMonday === localMonday) return "this_week";
  return "upcoming";
}
