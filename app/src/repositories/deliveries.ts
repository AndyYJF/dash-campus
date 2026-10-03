import crypto from "node:crypto";
import { getDb } from "@/repositories/db";

/**
 * deliveries repository（计划 v1.2 第 8.2 节）。
 * 状态机 queued→submitting→accepted/failed；提交后落库前崩溃为 unknown；
 * accepted 是发送服务接受，不是入箱或已读。
 */

export type DeliveryStatus =
  | "queued"
  | "submitting"
  | "accepted"
  | "failed"
  | "unknown"
  | "cancelled";

export type DeliveryRow = {
  id: string;
  jobId: string | null;
  taskId: string | null;
  requestId: string;
  leaseToken: string | null;
  reminderRevision: number;
  recipient: string;
  subject: string;
  snapshot: {
    html: string;
    text: string;
    taskId: string | null;
    taskTitle: string;
    dueLabel: string;
    generatedAt: string;
    kind: "reminder" | "test" | "daily" | "weekly" | "system";
  };
  status: DeliveryStatus;
  attempt: number;
  /** 主人显式重发时指向原投递 */
  resentFrom: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
};

function now(): string {
  return new Date().toISOString();
}

function mapDelivery(r: Record<string, unknown>): DeliveryRow {
  return {
    id: r.id as string,
    jobId: (r.job_id as string | null) ?? null,
    taskId: (r.task_id as string | null) ?? null,
    requestId: r.request_id as string,
    leaseToken: (r.lease_token as string | null) ?? null,
    reminderRevision: r.reminder_revision as number,
    recipient: r.recipient as string,
    subject: r.subject as string,
    snapshot: JSON.parse(r.snapshot_json as string) as DeliveryRow["snapshot"],
    status: r.status as DeliveryStatus,
    attempt: r.attempt as number,
    resentFrom: (r.resent_from as string | null) ?? null,
    error: (r.error as string | null) ?? null,
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
  };
}

/** 创建 delivery（初始 queued），冻结收件人与正文快照 */
export function createDelivery(input: {
  jobId: string | null;
  taskId: string | null;
  leaseToken: string | null;
  reminderRevision: number;
  recipient: string;
  subject: string;
  snapshot: DeliveryRow["snapshot"];
  attempt?: number;
  resentFrom?: string | null;
}): DeliveryRow {
  const db = getDb();
  const id = crypto.randomUUID();
  const requestId = crypto.randomUUID();
  const t = now();
  db.prepare(
    `INSERT INTO deliveries (id, job_id, task_id, request_id, lease_token, reminder_revision,
       recipient, subject, snapshot_json, status, attempt, resent_from, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?)`,
  ).run(
    id,
    input.jobId,
    input.taskId,
    requestId,
    input.leaseToken,
    input.reminderRevision,
    input.recipient,
    input.subject,
    JSON.stringify(input.snapshot),
    input.attempt ?? 1,
    input.resentFrom ?? null,
    t,
    t,
  );
  return getDelivery(id)!;
}

export function getDelivery(id: string): DeliveryRow | null {
  const db = getDb();
  const row = db.prepare(`SELECT * FROM deliveries WHERE id = ?`).get(id) as
    | Record<string, unknown>
    | undefined;
  return row ? mapDelivery(row) : null;
}

export function listDeliveries(filter: { status?: DeliveryStatus; taskId?: string } = {}): DeliveryRow[] {
  const db = getDb();
  const where: string[] = [];
  const vals: string[] = [];
  if (filter.status) {
    where.push("status = ?");
    vals.push(filter.status);
  }
  if (filter.taskId) {
    where.push("task_id = ?");
    vals.push(filter.taskId);
  }
  const rows = db
    .prepare(
      `SELECT * FROM deliveries ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC LIMIT 100`,
    )
    .all(...vals) as Array<Record<string, unknown>>;
  return rows.map(mapDelivery);
}

export function listDeliveriesByJob(jobId: string): DeliveryRow[] {
  const db = getDb();
  const rows = db
    .prepare(`SELECT * FROM deliveries WHERE job_id = ? ORDER BY created_at DESC`)
    .all(jobId) as Array<Record<string, unknown>>;
  return rows.map(mapDelivery);
}

/** 准入：queued→submitting 条件更新（准入短事务内调用，8.2） */
export function markSubmitting(id: string): boolean {
  const db = getDb();
  const r = db
    .prepare(`UPDATE deliveries SET status = 'submitting', updated_at = ? WHERE id = ? AND status = 'queued'`)
    .run(now(), id);
  return r.changes === 1;
}

/**
 * 提交结果：submitting→accepted/failed，条件更新要求仍是本执行者的租约。
 * 不自动重发；unknown 由恢复流程标记。
 */
export function markOutcome(
  id: string,
  leaseToken: string,
  outcome: { status: "accepted"; response?: string } | { status: "failed"; error: string },
): boolean {
  const db = getDb();
  const error = outcome.status === "failed" ? outcome.error : null;
  const r = db
    .prepare(
      `UPDATE deliveries SET status = ?, error = ?, updated_at = ?
       WHERE id = ? AND lease_token = ? AND status = 'submitting'`,
    )
    .run(outcome.status, error, now(), id, leaseToken);
  return r.changes === 1;
}

/** 恢复：submitting 一律 unknown，不自动重发（F13；执行进程已死） */
/** worker 启动恢复：只处理 job 发起的投递；web 进程的测试邮件（job_id 为空）不归 worker 管 */
export function markAllSubmittingUnknown(note: string): number {
  const db = getDb();
  const r = db
    .prepare(
      `UPDATE deliveries SET status = 'unknown', error = ?, updated_at = ?
       WHERE status = 'submitting' AND job_id IS NOT NULL`,
    )
    .run(note, now());
  return r.changes;
}

export function markDeliveryUnknown(id: string, note: string): boolean {
  const r = getDb()
    .prepare(
      `UPDATE deliveries SET status = 'unknown', error = ?, updated_at = ? WHERE id = ? AND status = 'submitting'`,
    )
    .run(note, now(), id);
  return r.changes === 1;
}

/** 同一任务所有未准入（queued）delivery 取消（任务提醒版本变化时在业务事务内调用） */
export function cancelQueuedForTask(taskId: string): number {
  const db = getDb();
  const r = db
    .prepare(
      `UPDATE deliveries SET status = 'cancelled', updated_at = ? WHERE task_id = ? AND status = 'queued'`,
    )
    .run(now(), taskId);
  return r.changes;
}
