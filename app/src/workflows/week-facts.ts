import { getDb } from "@/repositories/db";
import { addDays, instanceTimezone, wallTimeToUtc } from "@/domain/time";
import { computeWorkload } from "@/domain/workload";
import { listTasks, type TaskRow } from "@/repositories/planning";
import { getFocus } from "@/repositories/focus";
import { listProposals } from "@/repositories/proposals";

/**
 * 周事实查询（T6"周记录查询"）：纯程序汇总，不经过模型。
 * 复盘页的"事实"部分直接来自这里；模型只在此基础上给推测与提案。
 */

export type WeekFacts = {
  localMonday: string;
  timezone: string;
  range: { startsAt: string; endsAt: string };
  focus: { title: string } | null;
  logs: Array<{ id: string; occurredOn: string; progress: string; blocker: string; taskId: string | null; projectId: string | null; version: number }>;
  completedTasks: Array<{ id: string; title: string; projectId: string | null; completedAt: string; estimateMinutes: number | null }>;
  openTasks: Array<{ id: string; title: string; status: string; projectId: string | null; estimateMinutes: number | null; version: number; plannedWeek: string | null }>;
  artifacts: Array<{ id: string; projectId: string; title: string; kind: string; createdAt: string; version: number }>;
  projects: Array<{ id: string; title: string; question: string }>;
  workload: { committedMinutes: number; committedUnknownCount: number; weekCapacityMinutes: number | null };
  lastWeekProposals: Array<{ id: string; reason: string; status: string; rejectionReason: string | null }>;
  counts: { logs: number; blockers: number; completed: number; artifacts: number };
  /** V2 事实（迁移 0019/0018 之后才有数据；老库为空表计 0，不编造） */
  planSessions: { planned: number; completed: number; skipped: number };
  practice: { count: number; totalMinutes: number };
};

const nextMondayOf = (m: string) => addDays(m, 7);

export function weekFacts(localMonday: string, tz = instanceTimezone()): WeekFacts {
  const db = getDb();
  const startsAt = wallTimeToUtc(localMonday, "00:00", tz).toISOString();
  const endsAt = wallTimeToUtc(nextMondayOf(localMonday), "00:00", tz).toISOString();
  const weekEnd = addDays(localMonday, 6);

  const logs = (
    db
      .prepare(
        `SELECT id, occurred_on, progress, blocker, task_id, project_id,version FROM daily_logs
         WHERE archived_at IS NULL AND occurred_on >= ? AND occurred_on <= ? ORDER BY occurred_on, created_at`,
      )
      .all(localMonday, weekEnd) as Array<Record<string, unknown>>
  ).map((r) => ({
    id: r.id as string,
    occurredOn: r.occurred_on as string,
    progress: r.progress as string,
    blocker: r.blocker as string,
    taskId: (r.task_id as string | null) ?? null,
    projectId: (r.project_id as string | null) ?? null,
    version: r.version as number,
  }));

  const all = listTasks();
  const completedTasks = all
    .filter((t) => t.status === "done" && t.completedAt && t.completedAt >= startsAt && t.completedAt < endsAt)
    .map((t) => ({ id: t.id, title: t.title, projectId: t.projectId, completedAt: t.completedAt!, estimateMinutes: t.estimateMinutes }));

  const openTasks = all
    .filter((t) => ["todo", "doing", "blocked"].includes(t.status))
    .filter(
      (t: TaskRow) =>
        t.plannedWeek?.localMonday === localMonday ||
        t.plannedWeek?.localMonday === nextMondayOf(localMonday) ||
        logs.some((l) => l.taskId === t.id),
    )
    .map((t) => ({
      id: t.id,
      title: t.title,
      status: t.status,
      projectId: t.projectId,
      estimateMinutes: t.estimateMinutes,
      version: t.version,
      plannedWeek: t.plannedWeek?.localMonday ?? null,
    }));

  const artifacts = (
    db
      .prepare(
        `SELECT id, project_id, title, kind, created_at,version FROM artifacts
         WHERE archived_at IS NULL AND created_at >= ? AND created_at < ? ORDER BY created_at`,
      )
      .all(startsAt, endsAt) as Array<Record<string, unknown>>
  ).map((r) => ({
    id: r.id as string,
    projectId: r.project_id as string,
    title: r.title as string,
    kind: r.kind as string,
    createdAt: r.created_at as string,
    version: r.version as number,
  }));

  const projectIds = new Set<string>([
    ...logs.map((l) => l.projectId).filter((x): x is string => Boolean(x)),
    ...completedTasks.map((t) => t.projectId).filter((x): x is string => Boolean(x)),
    ...openTasks.map((t) => t.projectId).filter((x): x is string => Boolean(x)),
    ...artifacts.map((a) => a.projectId),
  ]);
  const projects = [...projectIds].flatMap((id) => {
    const p = db.prepare(`SELECT id, title, question FROM projects WHERE id = ? AND archived_at IS NULL`).get(id) as
      | { id: string; title: string; question: string }
      | undefined;
    return p ? [p] : [];
  });

  const w = computeWorkload(all, localMonday, new Date(endsAt));
  const prevStart = wallTimeToUtc(addDays(localMonday, -7), "00:00", tz).toISOString();
  const lastWeekProposals = listProposals({ sourceKind: "review" })
    .filter((p) => p.createdAt >= prevStart && p.createdAt < startsAt)
    .map((p) => ({ id: p.id, reason: p.reason, status: p.status, rejectionReason: p.rejectionReason }));

  const focus = getFocus(localMonday, tz);
  return {
    localMonday,
    timezone: tz,
    range: { startsAt, endsAt },
    focus: focus ? { title: focus.title } : null,
    logs,
    completedTasks,
    openTasks,
    artifacts,
    projects,
    workload: {
      committedMinutes: w.committedMinutes,
      committedUnknownCount: w.committedUnknownCount,
      weekCapacityMinutes: w.weekCapacityMinutes,
    },
    lastWeekProposals,
    counts: {
      logs: logs.length,
      blockers: logs.filter((l) => l.blocker.trim()).length,
      completed: completedTasks.length,
      artifacts: artifacts.length,
    },
    planSessions: {
      planned: (db.prepare(`SELECT COUNT(*) AS n FROM plan_sessions WHERE start_utc >= ? AND start_utc < ? AND status IN ('tentative','planned','in_progress','completed')`).get(startsAt, endsAt) as { n: number }).n,
      completed: (db.prepare(`SELECT COUNT(*) AS n FROM plan_sessions WHERE start_utc >= ? AND start_utc < ? AND status = 'completed'`).get(startsAt, endsAt) as { n: number }).n,
      skipped: (db.prepare(`SELECT COUNT(*) AS n FROM plan_sessions WHERE start_utc >= ? AND start_utc < ? AND status = 'skipped'`).get(startsAt, endsAt) as { n: number }).n,
    },
    practice: (() => {
      const r = db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(actual_minutes), 0) AS m FROM practice_entries WHERE occurred_on >= ? AND occurred_on <= ?`).get(localMonday, weekEnd) as { n: number; m: number };
      return { count: r.n, totalMinutes: r.m };
    })(),
  };
}

/** 该周是否有任何可复盘的新增记录（第 6 节：无新增记录不凭空编写成长结论） */
export function hasRecords(f: WeekFacts): boolean {
  return f.counts.logs + f.counts.completed + f.counts.artifacts > 0;
}
