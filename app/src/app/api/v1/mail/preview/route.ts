import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import { getTask } from "@/repositories/planning";
import { getDb } from "@/repositories/db";
import { getMailTemplateSettings } from "@/workflows/mail-settings";
import { renderReminderEmail, type ReminderEmailInput } from "@/integrations/mail-template";
import { requireOwner } from "@/workflows/auth-guard";
import { errorResponse, notFound404 } from "@/workflows/http";
import { getConfig } from "@/config";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  taskId: z.string().uuid().optional(),
});

/**
 * POST /api/v1/mail/preview —— 预览不产生发送（计划 9 节）。
 * 带 taskId 用真实任务渲染；不带则用合成示例（明确标记 sample）。
 */
export async function POST(request: NextRequest) {
  const auth = requireOwner(request);
  if (!auth.ok) return auth.response;
  const parsed = bodySchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) return errorResponse("VALIDATION", "输入不合法", 422, parsed.error.issues);

  let input: ReminderEmailInput;
  let sample: boolean;
  if (parsed.data.taskId) {
    const task = getTask(parsed.data.taskId);
    if (!task) return notFound404("任务不存在");
    const base = getConfig().APP_BASE_URL.replace(/\/$/, "");
    const projectName = task.projectId
      ? (getDb()
          .prepare(`SELECT title FROM projects WHERE id = ?`)
          .get(task.projectId) as { title: string } | undefined)?.title ?? null
      : null;
    input = {
      taskTitle: task.title,
      due: task.due,
      projectName,
      description: task.description,
      taskUrl: task.projectId ? `${base}/projects/${task.projectId}` : `${base}/today`,
      nowIso: new Date().toISOString(),
    };
    sample = false;
  } else {
    input = {
      taskTitle: "示例任务：完成课程作业第 3 章",
      due: { kind: "date", localDate: "2026-10-01", timezone: "Asia/Shanghai" },
      projectName: "示例项目",
      description: "这是一封预览邮件的合成示例说明，不会发送到任何邮箱。",
      taskUrl: `${getConfig().APP_BASE_URL.replace(/\/$/, "")}/today`,
      nowIso: new Date().toISOString(),
    };
    sample = true;
  }

  const email = renderReminderEmail(input, getMailTemplateSettings());
  return NextResponse.json({ sample, ...email });
}
