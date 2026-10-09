import nodemailer, { type Transporter } from "nodemailer";
import { getConfig } from "@/config";

/**
 * Mailer 窄接口（计划 v1.2 第 1、8 节）：Nodemailer SMTP，一个主人收件地址。
 * 测试与本地无凭证场景通过 setMailerForTests 注入捕获型实现；
 * SMTP 未配置时 resolveMailer() 返回 null，调用方报 INTEGRATION_UNAVAILABLE。
 */

export type MailPayload = {
  to: string;
  subject: string;
  html: string;
  text: string;
  requestId: string;
};

export type MailSendResult =
  | { ok: true; response: string }
  | { ok: false; error: { code: string; message: string; retryable: boolean } };

export interface Mailer {
  send(mail: MailPayload): Promise<MailSendResult>;
}

const EXTERNAL_TIMEOUT_MS = 45_000;

function isSmtpConfigured(): boolean {
  const cfg = getConfig();
  return Boolean(cfg.SMTP_HOST && cfg.SMTP_USER && cfg.SMTP_PASSWORD && cfg.MAIL_FROM && cfg.MAIL_TO);
}

function createSmtpMailer(): Mailer {
  const cfg = getConfig();
  let transporter: Transporter | null = null;
  const getTransporter = (): Transporter => {
    if (!transporter) {
      transporter = nodemailer.createTransport({
        host: cfg.SMTP_HOST,
        port: cfg.SMTP_PORT,
        secure: cfg.SMTP_TLS_MODE === "implicit",
        requireTLS: cfg.SMTP_TLS_MODE === "explicit",
        ignoreTLS: cfg.SMTP_TLS_MODE === "none",
        auth: { user: cfg.SMTP_USER!, pass: cfg.SMTP_PASSWORD! },
        connectionTimeout: EXTERNAL_TIMEOUT_MS,
        socketTimeout: EXTERNAL_TIMEOUT_MS,
      });
    }
    return transporter;
  };
  return {
    async send(mail) {
      try {
        const info = await Promise.race([
          getTransporter().sendMail({
            from: cfg.MAIL_FROM!,
            to: mail.to,
            subject: mail.subject,
            html: mail.html,
            text: mail.text,
            headers: { "x-request-id": mail.requestId },
          }),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("SMTP_TIMEOUT")), EXTERNAL_TIMEOUT_MS),
          ),
        ]);
        return { ok: true, response: info.response ?? "accepted" };
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        return {
          ok: false,
          error: { code: "SMTP_ERROR", message, retryable: true },
        };
      }
    },
  };
}

let mailerOverride: Mailer | null = null;

/** 测试注入；传 null 清除 */
export function setMailerForTests(m: Mailer | null): void {
  mailerOverride = m;
}

/** 实际发送前调用：null 表示 SMTP 未配置（503 INTEGRATION_UNAVAILABLE） */
export function resolveMailer(): Mailer | null {
  if (mailerOverride) return mailerOverride;
  // 演示实例永不发信：即使环境里误配了 SMTP，也按未配置处理
  if (getConfig().DEMO_MODE) return null;
  if (!isSmtpConfigured()) return null;
  return createSmtpMailer();
}
