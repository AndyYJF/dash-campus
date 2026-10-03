import { getDb } from "@/repositories/db";
import { getTemplate } from "@/repositories/exploration";
import { createProject, createTask } from "@/repositories/planning";
import { projectSchema, taskCreateSchema, type TaskInput } from "@/contracts/planning";
import { HttpError } from "./http";

export function startTemplate(id: string, expectedVersion: number, plannedWeek: TaskInput["plannedWeek"]) {
  return getDb().transaction(() => {
    const t = getTemplate(id);
    if (!t) throw new HttpError(404, "NOT_FOUND", "模板不存在");
    if (t.version !== expectedVersion) throw new HttpError(409, "CONFLICT", "模板已有新版本，请重新核对");
    if (t.status !== "ready") throw new HttpError(422, "TEMPLATE_NOT_READY", "草稿模板尚未核实来源");
    const project = createProject(projectSchema.parse({ title: t.direction, question: t.question, expectedOutcome: t.deliverables.join("\n"), prerequisites: [...t.prerequisites, ...t.requiredResources].join("\n"), reviewQuestions: t.reviewQuestions.join("\n") }));
    for (const [i, task] of t.initialTasks.entries()) createTask(taskCreateSchema.parse({ title: task.title, projectId: project.id, estimateMinutes: task.estimateMinutes, plannedWeek, description: `${i === 0 ? t.firstStep : t.activities[i] ?? ""}\n\n参考资料（模板 ${t.id} v${t.version}）：\n${t.sourceLinks.map((s) => `${s.title} ${s.url}\n${s.license}`).join("\n")}` }));
    return project;
  }).immediate();
}
