import type { Command, CommandContext } from "@/contracts/commands";
import type { ChangeInput } from "@/repositories/journal";
import { getSetting, updateSetting } from "@/repositories/settings";
import { activeNewsRun, updateNewsRun } from "@/repositories/ai-news";
import { reverifyAfterJob } from "@/workflows/intake";
import { requestCancel, getJob } from "@/repositories/jobs";
import { newsPolicy } from "@/repositories/ai-news";
import { AI_NEWS_POLICY_KEY, newsPolicySchema } from "@/contracts/ai-news";
import { startNews } from "@/workflows/ai-news";
import { HttpError } from "@/workflows/http";
export function applyRequestNews(
  cmd: Extract<Command, { command: "request_ai_news" }>,
) {
  const r = startNews(cmd.days);
  return {
    summary: "AI资讯正在后台更新，完成后可在「AI资讯」查看",
    effectBatchId: "",
    effects: [
      { kind: "ai_news_run", id: r.id },
      { kind: "job", id: r.jobId! },
    ],
  };
}
export function applyNewsPolicy(
  cmd: Extract<Command, { command: "update_ai_news_policy" }>,
  _ctx: CommandContext,
  changes: ChangeInput[],
): string {
  const entry = getSetting(AI_NEWS_POLICY_KEY),
    before = newsPolicy().policy;
  if (cmd.expectedVersion !== null && cmd.expectedVersion !== entry.version)
    throw new HttpError(409, "CONFLICT", "资讯自动更新设置已变化，请重新查看");
  const after = newsPolicySchema.parse({
    ...before,
    ...Object.fromEntries(
      Object.entries(cmd).filter(
        ([k, v]) =>
          !["command", "expectedVersion"].includes(k) && v !== undefined,
      ),
    ),
  });
  if (JSON.stringify(before) === JSON.stringify(after))
    return "AI资讯设置没有变化";
  const saved = updateSetting(AI_NEWS_POLICY_KEY, after, entry.version);
  if (saved === "conflict")
    throw new HttpError(409, "CONFLICT", "资讯设置刚被修改");
  changes.push(
    entry.version === 0
      ? {
          entityKind: "setting",
          entityId: AI_NEWS_POLICY_KEY,
          action: "create",
          after: after,
          afterVersion: saved.version,
        }
      : {
          entityKind: "setting",
          entityId: AI_NEWS_POLICY_KEY,
          action: "update",
          before: { valueJson: JSON.stringify(entry.value) },
          after: { valueJson: JSON.stringify(after) },
          beforeVersion: entry.version,
          afterVersion: saved.version,
        },
  );
  return after.enabled
    ? `每天 ${after.localTime} 自动盘点最近 ${after.days} 天AI资讯，仍受定期AI总开关和预算限制`
    : "已暂停AI资讯自动更新，仍可手动更新";
}

export function applyCancelNews() {
  const r = activeNewsRun();
  if (!r || !r.jobId) return "当前没有正在更新的AI资讯";
  requestCancel(r.jobId);
  if (getJob(r.jobId)?.status === "cancelled")
    updateNewsRun(r.id, {
      status: "cancelled",
      errorMessage: "主人停止本次更新",
    });
  // 外层命令/幂等事务提交后，再把等待这项后台结果的原对话更新为停止。
  queueMicrotask(() => {
    try {
      reverifyAfterJob(r.jobId!);
    } catch {
      console.error("AI资讯停止后的状态核对未完成");
    }
  });
  return {
    summary: "已请求停止本次资讯更新，已有盘点保留",
    effectBatchId: "",
    effects: [
      { kind: "ai_news_cancellation", id: r.id },
      { kind: "job", id: r.jobId },
    ],
  };
}
