import { getDb } from "@/repositories/db";
import { getTask } from "@/repositories/planning";
import {
  completeCancellation,
  completeJob,
  failJob,
  getJob,
  leaseValid,
  renewLease,
} from "@/repositories/jobs";
import {
  createDelivery,
  getDelivery,
  listDeliveriesByJob,
  markDeliveryUnknown,
  markOutcome,
  markSubmitting,
  type DeliveryRow,
} from "@/repositories/deliveries";
import { reminderJobPayloadSchema, type JobRow } from "@/contracts/jobs";
import { reminderOverdue } from "@/domain/reminders";
import { getMailTemplateSettings } from "@/workflows/mail-settings";
import { renderReminderEmail, type ReminderEmailInput } from "@/integrations/mail-template";
import { resolveMailer } from "@/integrations/mailer";
import { getConfig } from "@/config";

/**
 * 提醒 job 执行（计划 v1.2 第 8.2 节准入短事务）：
 * 验证有效 job lease、任务未结束、reminderRevision 相符、提醒未过期
 * → delivery queued→submitting，分配 requestId、冻结收件人和正文快照 → COMMIT → 调 SMTP。
 * 改期发生在准入之前：旧邮件不再准入（revision 已变）；
 * 改期发生在准入之后：在途旧邮件允许到达，不承诺撤回。
 */

export type ReminderRunOutcome =
  | { kind: "done" }
  | { kind: "failed"; error: string }
  | { kind: "cancelled" }
  | { kind: "fenced" }; // 丢失租约，结果未落库（旧执行者不能提交结果）

function taskUrl(projectId: string | null): string {
  const base = getConfig().APP_BASE_URL.replace(/\/$/, "");
  return projectId ? `${base}/projects/${projectId}` : `${base}/today`;
}

type Admission =
  | { kind: "delivery"; delivery: DeliveryRow }
  | { kind: "skip"; reason: string };

/** 准入短事务；调用前必须已领取租约（job.status === running） */
function admitReminderDelivery(job: JobRow, nowIso: string): Admission {
  const db = getDb();
  let result: Admission | null = null;
  const tx = db.transaction(() => {
    // 1. 有效 job lease：token+generation 仍持有且未过期
    const j = db
      .prepare(`SELECT lease_token, generation, status, lease_until FROM jobs WHERE id = ?`)
      .get(job.id) as
      | { lease_token: string | null; generation: number; status: string; lease_until: string | null }
      | undefined;
    if (
      !j ||
      j.lease_token !== job.leaseToken ||
      j.generation !== job.generation ||
      j.status !== "running" ||
      !j.lease_until ||
      j.lease_until <= nowIso
    ) {
      result = { kind: "skip", reason: "lease_lost" };
      return;
    }

    const payload = reminderJobPayloadSchema.parse(job.payload);
    const task = getTask(payload.taskId);
    if (!task || task.archivedAt || task.status === "done" || task.status === "cancelled") {
      result = { kind: "skip", reason: "task_inactive" };
      return;
    }
    // F12 前半：改期/重开使 revision 变化 → 旧邮件不能再准入
    if (task.reminderRevision !== payload.reminderRevision) {
      result = { kind: "skip", reason: "stale_revision" };
      return;
    }
    // 提醒未过期：已越过 due 边界的提醒发送无意义，任务会进入逾期列表
    if (reminderOverdue(task.due, nowIso)) {
      result = { kind: "skip", reason: "overdue" };
      return;
    }

    // 2. 未准入邮件使用发送时最新标题生成正文；冻结快照
    const settings = getMailTemplateSettings();
    const projectName = task.projectId
      ? (db.prepare(`SELECT title FROM projects WHERE id = ?`).get(task.projectId) as
          | { title: string }
          | undefined)?.title ?? null
      : null;
    const input: ReminderEmailInput = {
      taskTitle: task.title,
      due: task.due,
      projectName,
      description: task.description,
      taskUrl: taskUrl(task.projectId),
      nowIso,
    };
    const email = renderReminderEmail(input, settings);
    const delivery = createDelivery({
      jobId: job.id,
      taskId: task.id,
      leaseToken: job.leaseToken,
      reminderRevision: task.reminderRevision,
      recipient: getConfig().MAIL_TO ?? "",
      subject: email.subject,
      snapshot: {
        html: email.html,
        text: email.text,
        taskId: task.id,
        taskTitle: task.title,
        dueLabel: "",
        generatedAt: nowIso,
        kind: "reminder",
      },
    });
    markSubmitting(delivery.id);
    result = { kind: "delivery", delivery: getDelivery(delivery.id)! };
  });
  tx.immediate();
  return result!;
}

/** submitting→cancelled：仅发送前取消路径使用；已发出网络请求的不承诺撤回 */
function dbCancelDelivery(id: string, leaseToken: string): boolean {
  const db = getDb();
  const r = db
    .prepare(
      `UPDATE deliveries SET status = 'cancelled', updated_at = ?
       WHERE id = ? AND lease_token = ? AND status = 'submitting'`,
    )
    .run(new Date().toISOString(), id, leaseToken);
  return r.changes === 1;
}

/** 执行一个提醒 job；返回执行结果分类。mailer 由 resolveMailer 解析（测试可注入）。 */
export async function runReminderJob(job: JobRow): Promise<ReminderRunOutcome> {
  const token = job.leaseToken!;
  const gen = job.generation;
  const nowIso = () => new Date().toISOString();

  if (job.cancelRequested) {
    // 外部调用前检查取消
    return completeCancellation(job.id, token, gen, nowIso())
      ? { kind: "cancelled" }
      : { kind: "fenced" };
  }

  // 重领的 job（前一执行者丢租约）：已有 submitting/accepted/unknown 投递说明可能已发出，
  // 8.1 规定带 SMTP 副作用的投递不能按普通 job 重试 → 标 unknown，由主人显式重发
  const prior = listDeliveriesByJob(job.id).find((d) =>
    ["submitting", "accepted", "unknown"].includes(d.status),
  );
  if (prior) {
    if (prior.status === "submitting") markDeliveryUnknown(prior.id, "前一执行者丢失租约，发送结果不确定；不自动重发");
    const result =
      prior.status === "accepted"
        ? ({ kind: "sent", deliveryId: prior.id } as const)
        : ({ kind: "unknown", deliveryId: prior.id, note: "前一执行者丢失租约" } as const);
    return completeJob(job.id, token, gen, result, nowIso()) ? { kind: "done" } : { kind: "fenced" };
  }

  const mailer = resolveMailer();
  if (!mailer) {
    // SMTP 未配置：job 失败并明确报集成不可用；提醒不冒充已发送
    const ok = failJob(job.id, token, gen, "INTEGRATION_UNAVAILABLE: SMTP 未配置", nowIso());
    return ok ? { kind: "failed", error: "INTEGRATION_UNAVAILABLE" } : { kind: "fenced" };
  }

  const admission = admitReminderDelivery(job, nowIso());
  if (admission.kind === "skip") {
    if (admission.reason === "lease_lost") return { kind: "fenced" };
    const ok = completeJob(job.id, token, gen, { kind: "skipped", reason: admission.reason }, nowIso());
    return ok ? { kind: "done" } : { kind: "fenced" };
  }
  const delivery = admission.delivery;

  // 外部调用（SMTP）前再检查一次取消请求
  const fresh = getJob(job.id);
  if (fresh?.cancelRequested) {
    dbCancelDelivery(delivery.id, token);
    const ok = completeCancellation(job.id, token, gen, nowIso());
    return ok ? { kind: "cancelled" } : { kind: "fenced" };
  }

  // 发送期间持续续租（15s 一次，lease 60s）；外部调用最长 45s
  let renewBroken = false;
  const renewTimer = setInterval(() => {
    if (!renewLease(job.id, token, gen, new Date().toISOString())) renewBroken = true;
  }, 15_000);
  let sendResult;
  try {
    sendResult = await mailer.send({
      to: delivery.recipient,
      subject: delivery.subject,
      html: delivery.snapshot.html,
      text: delivery.snapshot.text,
      requestId: delivery.requestId,
    });
  } finally {
    clearInterval(renewTimer);
  }
  if (renewBroken || !leaseValid(job.id, token, gen, nowIso())) {
    // 丢租约：禁止提交结果；delivery 留在 submitting，由恢复流程标 unknown
    return { kind: "fenced" };
  }

  if (sendResult.ok) {
    markOutcome(delivery.id, token, { status: "accepted", response: sendResult.response });
    const ok = completeJob(job.id, token, gen, { kind: "sent", deliveryId: delivery.id }, nowIso());
    return ok ? { kind: "done" } : { kind: "fenced" };
  }
  markOutcome(delivery.id, token, { status: "failed", error: sendResult.error.message });
  const ok = failJob(job.id, token, gen, sendResult.error.message, nowIso());
  return ok ? { kind: "failed", error: sendResult.error.message } : { kind: "fenced" };
}

