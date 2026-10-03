import { getDb } from "./db";
import { getTask, getProject, getGoal, listTasks } from "./planning";
import type { ProposalRow } from "./proposals";
import { scheduleIssues } from "@/domain/schedule";

export type ProposalProblem = { status: number; code: string; message: string };

/** Read-only validation shared by display and atomic apply; never changes the proposal or tasks. */
export function proposalProblem(proposal: ProposalRow): ProposalProblem | null {
  const scheduleSensitive = proposal.operations.some((op) => op.kind === "reschedule_task" || (op.kind === "create_task" && (op.input.scheduledStart || op.input.plannedWeek)));
  const revision = getDb().prepare("SELECT planning_revision FROM planning_state WHERE id=1").get() as { planning_revision: number };
  if (scheduleSensitive && revision.planning_revision !== proposal.planningRevision) {
    return { status: 409, code: "STALE_PLANNING", message: "计划已变化，该排程提案已过时" };
  }
  // Before records became editable, proposals stored record IDs without versions.
  // Their evidence is the migration baseline, never a later owner correction.
  for (const ref of proposal.contextRefs) {
    const id=ref.replace(/^(log|artifact):/, "");
    for (const kind of ["log","artifact"] as const) {
      if (proposal.inputVersions[`${kind}:${id}`] !== undefined) continue;
      const table=kind==="log"?"daily_logs":"artifacts",journal=kind==="log"?"daily_log_revisions":"artifact_revisions",column=kind==="log"?"log_id":"artifact_id";
      const row=getDb().prepare(`SELECT version,archived_at,(SELECT MIN(version) FROM ${journal} WHERE ${column}=${table}.id) baseline FROM ${table} WHERE id=?`).get(id) as {version:number;archived_at:string|null;baseline:number}|undefined;
      if (row && (row.archived_at || row.version!==row.baseline)) return {status:409,code:"CONFLICT",message:"旧提案引用的记录已修订，请重新分析"};
    }
  }
  for (const [ref, version] of Object.entries(proposal.inputVersions)) {
    const [kind, id] = ref.split(":");
    if (kind === "log" || kind === "artifact" || kind === "resource") {
      const table = {log:"daily_logs",artifact:"artifacts",resource:"resources"}[kind];
      const row=getDb().prepare(`SELECT version,archived_at FROM ${table} WHERE id=?`).get(id) as {version:number;archived_at:string|null}|undefined;
      if(!row||row.archived_at||row.version!==version)return {status:409,code:"CONFLICT",message:"引用的记录或资料已修订，请重新分析"};
      continue;
    }
    if (kind !== "task") continue;
    const task = getTask(id);
    if (!task || task.archivedAt || task.version !== version) {
      return { status: 409, code: "CONFLICT", message: `任务 ${id} 已变化，提案已过时` };
    }
  }
  const finalTasks = new Map(listTasks().map((t) => [t.id, { id: t.id, title: t.title, status: t.status, scheduledStart: t.scheduledStart, scheduledEnd: t.scheduledEnd }]));
  for (const op of proposal.operations) {
    if (op.kind === "create_task") {
      if (op.input.projectId) {
        const project = getProject(op.input.projectId);
        if (!project || project.archivedAt) return { status: 409, code: "CONFLICT", message: "所属项目不存在或已归档，请重新分析" };
      }
      if (op.input.goalId) {
        const goal = getGoal(op.input.goalId);
        if (!goal || goal.archivedAt) return { status: 409, code: "CONFLICT", message: "所属目标不存在或已归档，请重新分析" };
      }
      finalTasks.set(`new:${op.clientRef}`, { ...op.input, id: `new:${op.clientRef}` });
    } else {
      const task = getTask(op.taskId);
      if (!task || task.archivedAt || task.version !== op.expectedVersion) {
        return { status: 409, code: "CONFLICT", message: `任务 ${op.taskId} 不存在、已归档或版本已变化` };
      }
      const t = finalTasks.get(op.taskId)!;
      if (op.kind === "reschedule_task") finalTasks.set(op.taskId, { ...t, scheduledStart: op.scheduledStart, scheduledEnd: op.scheduledEnd });
      else finalTasks.set(op.taskId, { ...t, status: op.status });
    }
  }
  for (const op of proposal.operations) {
    const t = finalTasks.get(op.kind === "create_task" ? `new:${op.clientRef}` : op.taskId);
    if (!t) continue;
    const issues = scheduleIssues(t, [...finalTasks.values()]);
    const override = op.kind === "reschedule_task" ? op.overrideReason : null;
    const issue = issues.find((i) => i.code === "VALIDATION") ?? (override ? null : issues[0]);
    if (issue) return { status: issue.code === "VALIDATION" ? 422 : 409, ...issue };
  }
  return null;
}
