import { getDb } from "@/repositories/db";
import { getJob, requestCancel } from "@/repositories/jobs";
import { getReview, getAssistantRequest, finishReview, finishAssistant } from "@/repositories/reviews";
import { REVIEW_JOB_TYPE, ASSISTANT_JOB_TYPE } from "@/contracts/review";
import { EXPLORATION_JOB_TYPE } from "@/contracts/exploration";
import { NOTICE_EXTRACTION_JOB_TYPE } from "@/contracts/notice-extraction";
import { REMINDER_JOB_TYPE } from "@/contracts/jobs";
import { cancelExploration } from "./exploration";
import { HttpError } from "./http";

/** Only owner-visible work can be cancelled; do not expose an arbitrary worker control endpoint. */
export function cancelOwnerJob(id: string): "cancelled" | "cancel_requested" | "finished" {
  return getDb().transaction(() => {
    const job = getJob(id);
    if (!job) throw new HttpError(404, "NOT_FOUND", "任务不存在");
    if (![REMINDER_JOB_TYPE, REVIEW_JOB_TYPE, ASSISTANT_JOB_TYPE, EXPLORATION_JOB_TYPE, NOTICE_EXTRACTION_JOB_TYPE].includes(job.type)) {
      throw new HttpError(422, "NOT_CANCELLABLE", "该作业类型不可取消");
    }
    if (job.status === "cancelled") return "cancelled" as const;
    if (job.status === "done" || job.status === "failed") return "finished" as const;
    const payload = job.payload as { reviewId?: string; requestId?: string; runId?: string; revisionId?: string };
    if (job.type === REVIEW_JOB_TYPE && (!payload.reviewId || getReview(payload.reviewId)?.jobId !== id)) {
      throw new HttpError(404, "NOT_FOUND", "关联复盘不存在");
    }
    if (job.type === ASSISTANT_JOB_TYPE && (!payload.requestId || getAssistantRequest(payload.requestId)?.jobId !== id)) {
      throw new HttpError(404, "NOT_FOUND", "关联分析不存在");
    }
    if (job.type === EXPLORATION_JOB_TYPE) {
      const result = payload.runId ? cancelExploration(payload.runId) : "not_found";
      if (result === "not_found") throw new HttpError(404, "NOT_FOUND", "关联探索不存在");
      return result;
    }
    if (job.cancelRequested) return "cancel_requested" as const;
    const result = requestCancel(id);
    if (result === "cancelled") {
      if (job.type === REVIEW_JOB_TYPE) finishReview(payload.reviewId!, { status: "cancelled", aiSkippedReason: "user_cancelled" });
      if (job.type === ASSISTANT_JOB_TYPE) finishAssistant(payload.requestId!, { status: "cancelled", errorMessage: "已取消，可重新分析" });
      if (job.type === NOTICE_EXTRACTION_JOB_TYPE) getDb().prepare("UPDATE notice_extractions SET status='failed',error='提取已取消，可重新发起',updated_at=? WHERE revision_id=? AND job_id=?").run(new Date().toISOString(), payload.revisionId, id);
      return "cancelled" as const;
    }
    return result === "cancel_requested" ? "cancel_requested" as const : "finished" as const;
  }).immediate();
}
