import type { TaskRow } from "@/repositories/planning";

/** TodaySummary 前端类型（与 /api/v1/today 契约一致，计划 v1.2 第 13.2 节） */

export type TodaySummary = {
  asOf: string;
  timezone: string;
  localDate: string;
  week: { localMonday: string; endsAt: string };
  focus: null | {
    title: string;
    goalId: string | null;
    projectId: string | null;
    confirmedAt: string;
    version: number;
  };
  workload: {
    remainingKnownMinutes: number;
    remainingUnknownCount: number;
    futureCapacityMinutes: number | null;
    bufferPercent: number;
    estimateMode: "full_estimate_for_unfinished";
  };
  actions: Array<{ task: TaskRow; section: "overdue" | "today" | "upcoming" | "this_week" }>;
  moreActionCount: number;
  unplannedTaskCount: number;
  decisions: Array<{ kind: "inbox" | "proposal"; id: string; title: string; version: number; href: string }>;
  moreDecisionCount: number;
  recentLogs: Array<{
    id: string;
    occurredOn: string;
    progress: string;
    blocker: string;
    taskId: string | null;
    projectId: string | null;
  }>;
};

export type WeekPlan = {
  asOf: string;
  timezone: string;
  localDate: string;
  week: { localMonday: string; endsAt: string };
  focus: {
    id: string;
    localMonday: string;
    timezone: string;
    title: string;
    goalId: string | null;
    projectId: string | null;
    confirmedAt: string;
    version: number;
  } | null;
  workload: {
    committedMinutes: number;
    committedUnknownCount: number;
    remainingKnownMinutes: number;
    remainingUnknownCount: number;
    weekCapacityMinutes: number | null;
    futureCapacityMinutes: number | null;
    bufferPercent: number;
    estimateMode: string;
    hasAnyTimeData: boolean;
  };
  tasks: TaskRow[];
  conflicts: Array<{taskId: string; title: string; code: string; message: string; overrideReason: string | null}>;
};
