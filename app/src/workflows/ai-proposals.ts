import crypto from "node:crypto";
import { getTask } from "@/repositories/planning";
import { getDb } from "@/repositories/db";
import {
  createProposal,
  pendingWithFingerprint,
  rejectedRecently,
  type ProposalOperationInput,
  type ProposalRow,
} from "@/repositories/proposals";
import { REJECTION_COOLDOWN_DAYS, type ModelOperation } from "@/contracts/review";
import type { z } from "zod";
import type { modelProposalSchema } from "@/contracts/review";
import { isoInstant } from "@/contracts/planning";
import { addDays, instanceTimezone, localDateInTz, mondayOf } from "@/domain/time";
import { scheduleProblem } from "@/workflows/apply-proposal";

/**
 * 模型提案 → 正式提案（第 6 节）：
 * - 模型只能引用上下文里提供的 ID：evidenceIds 必须属于允许集合，taskId/projectId 必须真实存在且在范围内；
 * - 读集快照 inputVersions 由程序生成（模型给不了版本号）；
 * - 冷却：同项目同操作类型同证据被拒绝后 14 天内不自动重复；已有同指纹待处理也不重复；
 * - 调整已有 due 不在 AI 操作集合内（4.1）。
 * 返回被丢弃的原因用于诊断，不静默吞掉。
 */

type ModelProposal = z.infer<typeof modelProposalSchema>;

export type TranslateContext = {
  /** 允许作为依据的记录 ID（log/task/artifact） */
  evidenceIds: Set<string>;
  /** 允许操作的已有任务 ID（范围内） */
  taskIds: Set<string>;
  /** 允许放入的项目 ID */
  projectIds: Set<string>;
  /** 所属项目（冷却键）；周范围为 null */
  projectId: string | null;
  sourceKind: "assistant" | "review";
  sourceId: string;
  groupId: string;
  groupTitle: string;
  /** 主人主动重跑：跳过拒绝冷却 */
  ignoreCooldown?: boolean;
  /** Versions captured before the model call; edits during a call cannot become a fresh read set. */
  inputVersions?: Record<string,number>;
};

export type TranslateResult = { created: ProposalRow[]; dropped: string[] };

export function fingerprint(projectId: string | null, ops: ModelOperation[], evidenceIds: string[]): string {
  const kinds = [...new Set(ops.map((o) => o.kind))].sort().join(",");
  const ev = [...new Set(evidenceIds)].sort().join(",");
  return crypto.createHash("sha256").update(`${projectId ?? "-"}|${kinds}|${ev}`).digest("hex");
}

function weekFor(which: "this" | "next" | "none"): { localMonday: string; timezone: string } | null {
  if (which === "none") return null;
  const tz = instanceTimezone();
  const monday = mondayOf(localDateInTz(new Date(), tz));
  return { localMonday: which === "this" ? monday : addDays(monday, 7), timezone: tz };
}

function toOperation(op: ModelOperation, ctx: TranslateContext): ProposalOperationInput | string {
  switch (op.kind) {
    case "create_task": {
      if (op.projectId && !ctx.projectIds.has(op.projectId)) return `新任务引用了范围外的项目 ${op.projectId}`;
      return {
        kind: "create_task",
        clientRef: crypto.randomUUID(),
        input: {
          title: op.title,
          description: op.description,
          projectId: op.projectId,
          goalId: null,
          status: "todo",
          priority: "normal",
          estimateMinutes: op.estimateMinutes,
          plannedWeek: weekFor(op.week),
          scheduledStart: null,
          scheduledEnd: null,
          due: { kind: "none" },
        },
      };
    }
    case "set_task_status": {
      if (!ctx.taskIds.has(op.taskId)) return `引用了不存在或范围外的任务 ${op.taskId}`;
      const t = getTask(op.taskId);
      if (!t || t.archivedAt) return `任务 ${op.taskId} 不存在`;
      if (t.status === op.status) return `任务「${t.title}」已是 ${op.status}，无需变更`;
      return { kind: "set_task_status", taskId: t.id, expectedVersion: ctx.inputVersions?.[`task:${t.id}`] ?? t.version, status: op.status };
    }
    case "reschedule_task": {
      if (!ctx.taskIds.has(op.taskId)) return `引用了不存在或范围外的任务 ${op.taskId}`;
      const t = getTask(op.taskId);
      if (!t || t.archivedAt) return `任务 ${op.taskId} 不存在`;
      for (const v of [op.scheduledStart, op.scheduledEnd]) {
        if (v !== null && !isoInstant.safeParse(v).success) return `改期时间格式不合法：${v}`;
      }
      const problem = scheduleProblem(op.scheduledStart, op.scheduledEnd);
      if (problem) return problem;
      return {
        kind: "reschedule_task",
        taskId: t.id,
        expectedVersion: ctx.inputVersions?.[`task:${t.id}`] ?? t.version,
        scheduledStart: op.scheduledStart,
        scheduledEnd: op.scheduledEnd,
      };
    }
  }
}

export function translateProposals(proposals: ModelProposal[], ctx: TranslateContext): TranslateResult {
  const created: ProposalRow[] = [];
  const dropped: string[] = [];
  const since = new Date(Date.now() - REJECTION_COOLDOWN_DAYS * 86_400_000).toISOString();
  const db = getDb();

  for (const p of proposals) {
    const badEvidence = p.evidenceIds.filter((id) => !ctx.evidenceIds.has(id));
    if (badEvidence.length > 0) {
      dropped.push(`建议「${p.reason.slice(0, 40)}」引用了上下文里没有的记录，已丢弃`);
      continue;
    }
    const ops: ProposalOperationInput[] = [];
    let problem: string | null = null;
    for (const op of p.operations) {
      const r = toOperation(op, ctx);
      if (typeof r === "string") {
        problem = r;
        break;
      }
      ops.push(r);
    }
    if (problem) {
      // 原子提案：任一操作不合法则整份丢弃，不做半份
      dropped.push(`建议「${p.reason.slice(0, 40)}」：${problem}，已丢弃`);
      continue;
    }
    const versions = Object.fromEntries(Object.entries(ctx.inputVersions ?? {}).filter(([ref]) => p.evidenceIds.includes(ref.split(":")[1]!)));
    // Keep initial-record fingerprints compatible with existing rejection cooldowns.
    // Only a revised log/artifact supplies new evidence; task changes remain read-set fences.
    const fp = fingerprint(ctx.projectId, p.operations, p.evidenceIds.map((id) => {
      const revision = Object.entries(versions).find(([ref]) => ref === `log:${id}` || ref === `artifact:${id}`);
      return revision && revision[1] > 1 ? `${revision[0]}:v${revision[1]}` : id;
    }));
    if (!ctx.ignoreCooldown && rejectedRecently(fp, since)) {
      dropped.push(`建议「${p.reason.slice(0, 40)}」与 ${REJECTION_COOLDOWN_DAYS} 天内被拒绝的建议依据相同，未重复提出`);
      continue;
    }
    if (pendingWithFingerprint(fp)) {
      dropped.push(`建议「${p.reason.slice(0, 40)}」已有同样依据的待处理提案`);
      continue;
    }
    const inputVersions: Record<string, number> = { ...versions };
    for (const op of ops) {
      if (op.kind !== "create_task") inputVersions[`task:${op.taskId}`] = op.expectedVersion;
    }
    const proposal = db.transaction(() =>
      createProposal({
        groupId: ctx.groupId,
        groupTitle: ctx.groupTitle,
        contextRefs: p.evidenceIds,
        inputVersions,
        operations: ops,
        reason: p.reason,
        reasonCode: ctx.sourceKind === "review" ? "weekly_review" : "blocker_assist",
        evidenceFingerprint: fp,
        sourceKind: ctx.sourceKind,
        sourceId: ctx.sourceId,
        projectId: ctx.projectId,
      }),
    )();
    created.push(proposal);
  }
  return { created, dropped };
}
