import { z } from "zod";

/** A deadline or an estimate is not permission to spend learning time. */
export const taskKindSchema = z.enum(["auto", "study", "todo", "decision", "event", "notice", "unknown"]);
export type TaskKind = z.infer<typeof taskKindSchema>;
export type ResolvedTaskKind = Exclude<TaskKind, "auto">;
export const TASK_KIND_LABEL: Record<ResolvedTaskKind, string> = {
  study: "学习 / 项目", todo: "日常待办", decision: "待决策", event: "活动", notice: "通知", unknown: "待确认",
};

/** Conservative fallback for existing imports. Explicit owner corrections take precedence. */
export function resolveTaskKind(task: { title: string; taskKind?: string | null }): ResolvedTaskKind {
  const stored = taskKindSchema.safeParse(task.taskKind);
  if (stored.success && stored.data !== "auto") return stored.data;
  const title = task.title.trim();
  // Source notices can mention learning or contests; they do not establish participation.
  if (/通知|公告|公示|温馨提醒/.test(title)) return "notice";
  if (/报名|是否|要不要|选购|选题|选择|决定|考虑参加/.test(title)) return "decision";
  if (/^(购买|买|缴|交费|报销|绑定|办卡|取件|寄件)|生日|请假|打卡|签到/.test(title)) return "todo";
  if (/见面会|会议|讲座|晚会|开放日|聚餐|活动/.test(title)) return "event";
  if (/学习|复习|预习|学\s*[a-z]|错题|作业|练习|实验|基线|代码|编程|开发|调试|实现|复现|阅读.{0,12}(论文|文献)|论文.{0,12}(阅读|笔记|写作)|研究|实训|科研|读.{0,12}论文|(?:线代|读书|课程).{0,12}报告|英语听力|总结.{0,12}(课程|实验)/i.test(title)) return "study";
  return "unknown";
}

export function admitsLearning(task: { title: string; taskKind?: string | null }): boolean {
  return resolveTaskKind(task) === "study";
}

export function pendingReason(kind: ResolvedTaskKind): string {
  if (kind === "unknown") return "还不确定是否要投入学习时间，等你确认";
  if (kind === "decision") return "先决定是否投入；确认具体工作后再排时间";
  if (kind === "event") return "只在确认起止时间后作为日程占用空档";
  if (kind === "notice") return "保留信息和截止提醒，不占用学习预算";
  return "保留待办和截止提醒，不占用学习预算";
}
