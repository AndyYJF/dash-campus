/**
 * 一次性 SMTP 联调（主人指定收件人 = MAIL_TO）。
 * 默认只验证连接与登录，不发信；传 --send 才走与 POST /mail/test 相同的路径发一封测试邮件并记一条 delivery。
 * 不打印密码。
 */
import crypto from "node:crypto";
import nodemailer from "nodemailer";
import { getConfig } from "@/config";
import { resolveMailer } from "@/integrations/mailer";
import { createDelivery, getDelivery, markOutcome, markSubmitting } from "@/repositories/deliveries";
import { getMailTemplateSettings } from "@/workflows/mail-settings";
import { renderReminderEmail } from "@/integrations/mail-template";
import { closeDb } from "@/repositories/db";

const cfg = getConfig();
console.log(`SMTP ${cfg.SMTP_HOST}:${cfg.SMTP_PORT} (${cfg.SMTP_TLS_MODE})，用户 ${cfg.SMTP_USER}，收件人 ${cfg.MAIL_TO}`);

const t = nodemailer.createTransport({
  host: cfg.SMTP_HOST,
  port: cfg.SMTP_PORT,
  secure: cfg.SMTP_TLS_MODE === "implicit",
  requireTLS: cfg.SMTP_TLS_MODE === "explicit",
  auth: { user: cfg.SMTP_USER!, pass: cfg.SMTP_PASSWORD! },
  connectionTimeout: 20_000,
});
await t.verify();
console.log("连接与登录：成功（未发信）");
t.close();

if (process.argv.includes("--send")) {
  const mailer = resolveMailer();
  if (!mailer || !cfg.MAIL_TO) throw new Error("SMTP 未配置完整");
  const nowIso = new Date().toISOString();
  const email = renderReminderEmail(
    {
      taskTitle: "测试邮件",
      due: { kind: "none" },
      projectName: null,
      description: "这是一封测试邮件。如果你收到它，说明 SMTP 配置可用。",
      taskUrl: `${cfg.APP_BASE_URL.replace(/\/$/, "")}/today`,
      nowIso,
    },
    getMailTemplateSettings(),
  );
  const d = createDelivery({
    jobId: null,
    taskId: null,
    leaseToken: crypto.randomUUID(),
    reminderRevision: 0,
    recipient: cfg.MAIL_TO,
    subject: email.subject,
    snapshot: { html: email.html, text: email.text, taskId: null, taskTitle: "测试邮件", dueLabel: "", generatedAt: nowIso, kind: "test" },
  });
  markSubmitting(d.id);
  const r = await mailer.send({ to: d.recipient, subject: d.subject, html: d.snapshot.html, text: d.snapshot.text, requestId: d.requestId });
  markOutcome(d.id, d.leaseToken!, r.ok ? { status: "accepted", response: r.response } : { status: "failed", error: r.error.message });
  const final = getDelivery(d.id)!;
  console.log(`测试邮件：${final.status === "accepted" ? "发送服务已接受" : "失败"}（主题「${final.subject}」${r.ok ? `，服务器响应 ${r.response}` : `，${r.error.message}`}）`);
}
closeDb();
