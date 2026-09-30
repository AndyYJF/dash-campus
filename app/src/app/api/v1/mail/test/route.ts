import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import crypto from "node:crypto";
import { createDelivery, getDelivery, markOutcome, markSubmitting } from "@/repositories/deliveries";
import { resolveMailer } from "@/integrations/mailer";
import { getMailTemplateSettings } from "@/workflows/mail-settings";
import { renderReminderEmail } from "@/integrations/mail-template";
import { requireOwner } from "@/workflows/auth-guard";
import { errorResponse } from "@/workflows/http";
import { getConfig } from "@/config";
import { isRestoredHold, RESTORED_HOLD_MESSAGE } from "@/repositories/instance";

export const dynamic = "force-dynamic";

/**
 * POST /api/v1/mail/test —— 只向 MAIL_TO 发送，主人主动点击（计划 9 节）。
 * SMTP 未配置返回 503 INTEGRATION_UNAVAILABLE；结果记为一条 delivery。
 */
export async function POST(request: NextRequest) {
  const auth = requireOwner(request);
  if (!auth.ok) return auth.response;

  if (isRestoredHold()) return errorResponse("RESTORED_HOLD", RESTORED_HOLD_MESSAGE, 503);

  const mailer = resolveMailer();
  const cfg = getConfig();
  if (!mailer || !cfg.MAIL_TO) {
    return errorResponse("INTEGRATION_UNAVAILABLE", "SMTP 未配置，无法发送测试邮件", 503);
  }

  const nowIso = new Date().toISOString();
  const settings = getMailTemplateSettings();
  const email = renderReminderEmail(
    {
      taskTitle: "测试邮件",
      due: { kind: "none" },
      projectName: null,
      description: "这是一封测试邮件。如果你收到它，说明 SMTP 配置可用。",
      taskUrl: `${cfg.APP_BASE_URL.replace(/\/$/, "")}/today`,
      nowIso,
    },
    settings,
  );

  const delivery = createDelivery({
    jobId: null,
    taskId: null,
    // 测试邮件没有 job 租约；给独立 token 让 markOutcome 的条件更新可用
    leaseToken: crypto.randomUUID(),
    reminderRevision: 0,
    recipient: cfg.MAIL_TO,
    subject: email.subject,
    snapshot: {
      html: email.html,
      text: email.text,
      taskId: null,
      taskTitle: "测试邮件",
      dueLabel: "",
      generatedAt: nowIso,
      kind: "test",
    },
  });
  markSubmitting(delivery.id);

  const result = await mailer.send({
    to: delivery.recipient,
    subject: delivery.subject,
    html: delivery.snapshot.html,
    text: delivery.snapshot.text,
    requestId: delivery.requestId,
  });

  if (result.ok) {
    markOutcome(delivery.id, delivery.leaseToken!, { status: "accepted", response: result.response });
  } else {
    markOutcome(delivery.id, delivery.leaseToken!, { status: "failed", error: result.error.message });
  }

  const final = getDelivery(delivery.id)!;
  return NextResponse.json({
    delivery: { ...final, snapshot: undefined, leaseToken: undefined },
    recipient: cfg.MAIL_TO,
  });
}
