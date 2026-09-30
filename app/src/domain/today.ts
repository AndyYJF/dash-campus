import { addDays, dueBoundaryUtc, localDateInTz } from "@/domain/time";
import type { TaskRow } from "@/repositories/planning";

/**
 * 首页近期行动（计划 v1.2 第 4 节"近期行动"）：
 * 逾期 → 今天（今天计划或今天截止）→ 未来七天已安排或临近截止 → 本周未定时。
 * 组内先有具体时间的（按时间），再高优先级，再创建顺序。
 * 既没有近期时间也不归属本周的任务不上首页（去计划页看），不伪装成临近截止。
 */

export type ActionSection = "overdue" | "today" | "upcoming" | "this_week";

const SECTION_ORDER: Record<ActionSection, number> = { overdue: 0, today: 1, upcoming: 2, this_week: 3 };

export function classifyAction(
  task: TaskRow,
  localDate: string,
  localMonday: string,
  asOf: Date,
  tz: string,
): ActionSection | null {
  const boundary = dueBoundaryUtc(task.due);
  if (boundary && new Date(boundary).getTime() < asOf.getTime()) return "overdue";

  const dueLocal =
    task.due.kind === "date"
      ? task.due.localDate
      : task.due.kind === "instant"
        ? localDateInTz(new Date(task.due.at), task.due.timezone)
        : null;
  const scheduledLocal = task.scheduledStart ? localDateInTz(new Date(task.scheduledStart), tz) : null;
  if (dueLocal === localDate || scheduledLocal === localDate) return "today";

  const horizon = addDays(localDate, 7);
  const soon = (d: string | null) => d !== null && d > localDate && d <= horizon;
  if (soon(dueLocal) || soon(scheduledLocal)) return "upcoming";

  if (task.plannedWeek?.localMonday === localMonday) return "this_week";
  return null;
}

/** 组内排序键：具体时间（时段开始或截止）优先且按时间先后 */
function concreteTime(task: TaskRow): string | null {
  return task.scheduledStart ?? dueBoundaryUtc(task.due);
}

export function compareActions(
  a: { task: TaskRow; section: ActionSection },
  b: { task: TaskRow; section: ActionSection },
): number {
  const bySection = SECTION_ORDER[a.section] - SECTION_ORDER[b.section];
  if (bySection !== 0) return bySection;
  const ta = concreteTime(a.task);
  const tb = concreteTime(b.task);
  if (ta && !tb) return -1;
  if (!ta && tb) return 1;
  if (ta && tb && ta !== tb) return ta < tb ? -1 : 1;
  const pa = a.task.priority === "high" ? 0 : 1;
  const pb = b.task.priority === "high" ? 0 : 1;
  if (pa !== pb) return pa - pb;
  return a.task.createdAt < b.task.createdAt ? -1 : a.task.createdAt > b.task.createdAt ? 1 : 0;
}

export function buildActions(
  tasks: TaskRow[],
  localDate: string,
  localMonday: string,
  asOf: Date,
  tz: string,
): Array<{ task: TaskRow; section: ActionSection }> {
  return tasks
    .filter((t) => t.status === "todo" || t.status === "doing" || t.status === "blocked")
    .flatMap((task) => {
      const section = classifyAction(task, localDate, localMonday, asOf, tz);
      return section ? [{ task, section }] : [];
    })
    .sort(compareActions);
}
