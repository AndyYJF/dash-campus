import crypto from "node:crypto";
import { getDb } from "@/repositories/db";
import { getTask } from "@/repositories/planning";
import {
  createDelivery,
  getDelivery,
  markOutcome,
  markSubmitting,
  type DeliveryRow,
} from "@/repositories/deliveries";
import { resolveMailer } from "@/integrations/mailer";
import { isRestoredHold, RESTORED_HOLD_MESSAGE } from "@/repositories/instance";
import { HttpError } from "@/workflows/http";

/**
 * 显式重发（计划 8.2 / 开发计划 T3）：只允许 unknown 与 failed 的投递，由主人确认"可能重复"后触发。
 * - 产生新 attempt（新 requestId），正文与收件人沿用原快照，不按当前任务重新生成；
 * - 提醒类要求任务仍未结束、提醒版本未变（改期后旧提醒不再重发，新提醒由 job 负责）；
 * - 同一原投递只能重发一次（resent_from 唯一索引），重复点击返回 409；
 * - web 进程直接发送（与测试邮件相同），不经 worker，不自动重试。
 */

export const RESENDABLE = ["unknown", "failed"] as const;

function admitResend(originalId: string): DeliveryRow {
  const db = getDb();
  const tx = db.transaction((): DeliveryRow => {
    const original = getDelivery(originalId);
    if (!original) throw new HttpError(404, "NOT_FOUND", "投递记录不存在");
    if (!(RESENDABLE as readonly string[]).includes(original.status)) {
      throw new HttpError(409, "NOT_RESENDABLE", "只有结果不确定或失败的投递可以重发");
    }
    const already = db.prepare(`SELECT id FROM deliveries WHERE resent_from = ?`).get(original.id) as
      | { id: string }
      | undefined;
    if (already) throw new HttpError(409, "ALREADY_RESENT", "这条投递已经重发过", { deliveryId: already.id });

    if (original.snapshot.kind === "reminder" && original.taskId) {
      const task = getTask(original.taskId);
      if (!task || task.archivedAt || task.status === "done" || task.status === "cancelled") {
        throw new HttpError(409, "TASK_INACTIVE", "任务已结束或归档，不再重发提醒");
      }
      if (task.reminderRevision !== original.reminderRevision) {
        throw new HttpError(409, "STALE_REMINDER", "任务截止已改动，这是旧提醒；新提醒会按新时间发送");
      }
    }

    const next = createDelivery({
      jobId: null,
      taskId: original.taskId,
      // web 进程发送没有 job 租约；独立 token 让 markOutcome 的条件更新可用
      leaseToken: crypto.randomUUID(),
      reminderRevision: original.reminderRevision,
      recipient: original.recipient,
      subject: original.subject,
      snapshot: original.snapshot,
      attempt: original.attempt + 1,
      resentFrom: original.id,
    });
    markSubmitting(next.id);
    return getDelivery(next.id)!;
  });
  return tx.immediate();
}

export async function resendDelivery(originalId: string): Promise<DeliveryRow> {
  if (isRestoredHold()) throw new HttpError(503, "RESTORED_HOLD", RESTORED_HOLD_MESSAGE);
  const mailer = resolveMailer();
  if (!mailer) throw new HttpError(503, "INTEGRATION_UNAVAILABLE", "SMTP 未配置，无法重发");

  const delivery = admitResend(originalId);
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
  return getDelivery(delivery.id)!;
}
