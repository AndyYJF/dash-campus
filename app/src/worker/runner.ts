import { getDb } from "@/repositories/db";
import { claimDueJobs, failJob, listJobs } from "@/repositories/jobs";
import {
  listDeliveriesByJob,
  markAllSubmittingUnknown,
} from "@/repositories/deliveries";
import { REMINDER_JOB_TYPE } from "@/contracts/jobs";
import { runReminderJob } from "@/worker/handlers";
import { EXPLORATION_JOB_TYPE } from "@/contracts/exploration";
import { runExplorationJob, scheduleDueTopics } from "@/workflows/exploration";
import { ASSISTANT_JOB_TYPE, REVIEW_JOB_TYPE } from "@/contracts/review";
import { runAssistantJob, runReviewJob, scheduleWeeklyReview } from "@/workflows/review";
import type { JobRow } from "@/contracts/jobs";
import { isRestoredHold, touchWorkerHeartbeat } from "@/repositories/instance";
import { sweepExpiredExports } from "@/workflows/exports";

import { NOTICE_EXTRACTION_JOB_TYPE } from "@/contracts/notice-extraction";
import { runNoticeExtractionJob } from "@/workflows/notice-extraction";

import { DIGEST_JOB_TYPE } from "@/contracts/digests";
import { runDigestJob, scheduleDigests } from "@/workflows/digests";

const HANDLERS: Record<string, (job: JobRow) => Promise<{ kind: string }>> = {
  [REMINDER_JOB_TYPE]: runReminderJob,
  [DIGEST_JOB_TYPE]: runDigestJob,
  [NOTICE_EXTRACTION_JOB_TYPE]: runNoticeExtractionJob,
  [EXPLORATION_JOB_TYPE]: runExplorationJob,
  [REVIEW_JOB_TYPE]: runReviewJob,
  [ASSISTANT_JOB_TYPE]: runAssistantJob,
};

/**
 * worker 运行器：一个实例一个 worker（计划第 1、8.1 节）。
 * runDueJobsOnce 是单趟执行，供主循环与测试共用；
 * recoverOnStartup 处理异常重启重叠：submitting→unknown（F13），孤儿 running job 恢复。
 */

export type RunOnceStats = { claimed: number; done: number; failed: number; cancelled: number };

// 串行执行，一次只领取 1 个：批量领取时排在后面的 job 会在等待中租约过期
export async function runDueJobsOnce(limit = 1): Promise<RunOnceStats & { held?: boolean }> {
  touchWorkerHeartbeat();
  // 本地文件清理，无外部请求：hold 期间也照常
  sweepExpiredExports();
  // 从备份恢复后：不调度、不领取，邮件/搜索/模型一律不发起，直到主人显式 resume（F14）
  if (isRestoredHold()) return { claimed: 0, done: 0, failed: 0, cancelled: 0, held: true };
  // 定期探索与定期周复盘：到期先入队（入队本身不调用外部服务）
  scheduleDueTopics();
  scheduleWeeklyReview();
  scheduleDigests();
  const nowIso = new Date().toISOString();
  const jobs = claimDueJobs(nowIso, limit);
  const stats: RunOnceStats = { claimed: jobs.length, done: 0, failed: 0, cancelled: 0 };
  for (const job of jobs) {
    const handler = HANDLERS[job.type];
    if (handler) {
      const outcome = await handler(job);
      if (outcome.kind === "done" || outcome.kind === "fenced") stats.done++;
      else if (outcome.kind === "failed") stats.failed++;
      else stats.cancelled++;
    } else {
      // 未知的 job 类型明确失败，不静默跳过
      failJob(job.id, job.leaseToken!, job.generation, `UNKNOWN_JOB_TYPE:${job.type}`, new Date().toISOString());
      stats.failed++;
    }
  }
  return stats;
}

/**
 * 启动恢复（一个实例一个 worker：启动时不存在其他在跑执行者，可安全越过 fencing）。
 * - submitting delivery 一律 unknown，不自动重发（F13/F8 的不确定结果）；
 * - 有过 delivery 的孤儿 job 落为 done，结果按最新 delivery 状态标注；
 * - 没有任何 delivery 的孤儿 job 重新排队（纯计算 job 可重试；准入会重验）。
 */
export function recoverOnStartup(): { unknownDeliveries: number; requeuedJobs: number } {
  const db = getDb();
  // 恢复 hold 期间的旧 job 由 restore 统一处理，这里不动
  if (isRestoredHold()) return { unknownDeliveries: 0, requeuedJobs: 0 };
  const unknownDeliveries = markAllSubmittingUnknown(
    "执行进程中断，发送结果不确定；不自动重发",
  );
  let requeuedJobs = 0;
  for (const job of listJobs({ status: "running" })) {
    const deliveries = listDeliveriesByJob(job.id);
    if (deliveries.length === 0) {
      db.prepare(
        `UPDATE jobs SET status = 'queued', lease_token = NULL, lease_until = NULL, updated_at = ? WHERE id = ? AND status = 'running'`,
      ).run(new Date().toISOString(), job.id);
      requeuedJobs++;
      continue;
    }
    const latest = deliveries[0];
    const result =
      latest.status === "accepted"
        ? { kind: "sent", deliveryId: latest.id }
        : { kind: "unknown", deliveryId: latest.id, note: "执行进程中断，结果不确定" };
    db.prepare(
      `UPDATE jobs SET status = 'done', result_json = ?, updated_at = ? WHERE id = ? AND status = 'running'`,
    ).run(JSON.stringify(result), new Date().toISOString(), job.id);
  }
  return { unknownDeliveries, requeuedJobs };
}
