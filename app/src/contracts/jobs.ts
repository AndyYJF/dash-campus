import { z } from "zod";

/**
 * Job / 提醒 / 投递契约（计划 v1.2 第 8 节）。
 * T3 只有 reminder 一种 job 类型；T4+ 再扩展，不在 CHECK 里封死 type 枚举。
 */

/** 8.1 默认参数：lease 60 秒、15 秒续租、外部请求最长 45 秒、总工作流 180 秒 */
export const JOB_LEASE_MS = 60_000;
export const JOB_RENEW_INTERVAL_MS = 15_000;
export const JOB_EXTERNAL_TIMEOUT_MS = 45_000;
export const JOB_MAX_WORKFLOW_MS = 180_000;

export const REMINDER_JOB_TYPE = "reminder";

export const reminderJobPayloadSchema = z.object({
  taskId: z.string().uuid(),
  reminderRevision: z.number().int().min(0),
  triggerAt: z.string().min(1),
});

export type ReminderJobPayload = z.infer<typeof reminderJobPayloadSchema>;

export type JobStatus = "queued" | "running" | "done" | "failed" | "cancelled";

export type JobResult =
  | { kind: "sent"; deliveryId: string }
  | { kind: "skipped"; reason: string }
  | { kind: "cancelled" }
  | { kind: "unknown"; deliveryId: string; note: string }
  | { kind: "failed"; error: string };

export type JobRow = {
  id: string;
  type: string;
  taskId: string | null;
  dedupeKey: string;
  runAt: string;
  payload: unknown;
  status: JobStatus;
  leaseToken: string | null;
  leaseUntil: string | null;
  attempt: number;
  generation: number;
  cancelRequested: boolean;
  result: JobResult | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
};

/** 提醒触发点默认值（计划 4.3：日期型默认本日 09:00；精确时刻型提前量默认 24h） */
export const DATE_DUE_REMINDER_LOCAL_TIME = "09:00";
export const INSTANT_DUE_LEAD_MINUTES = 24 * 60;
