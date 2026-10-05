import crypto from "node:crypto";
import { appendVerification, listVerifications, recordRepairOutcome, type CheckRecord, type RepairRecord, type VerificationRow } from "@/repositories/agent-runs";
import { intakeRequestUsage, intakeTimeSpent, INTAKE_ACTIVE_MS_LIMIT } from "@/workflows/ai-budget";
import type { IntakeRow } from "@/repositories/intakes";
import { verifyIntake } from "./agent-verify";

/**
 * Execute–Observe–Verify–Repair（Agent 方案 §5.3）：执行后核验，未通过且能在原授权内修的才修。
 * - 修正只做确定性动作：按最新状态重新绑定再执行（rebind）、重跑派生的学习安排（replan）；不调用模型、不扩大范围、
 *   不改截止/预算/课程，需要取舍的交给现成问题由主人决定。
 * - 每份投递最多 2 次修正、每次最多 4 步；同一失败指纹不重复尝试；累计执行时间超限就停。
 * - 修正决定先落库再执行：中途崩溃恢复后修正次数照算，不会多修。
 */

export const MAX_REPAIRS = 2;
export const MAX_REPAIR_STEPS = 4;

export type RepairHooks = {
  /** 重排派生的学习安排（不重做原写入）；返回给人看的结果 */
  replan(itemIds: string[]): string;
  /** 按最新状态重新绑定并执行这一步 */
  rebind(itemId: string): string;
};

function fingerprintOf(checks: CheckRecord[]): string {
  const key = checks.map((c) => `${c.kind}|${c.itemId ?? ""}|${c.subject}|${c.detail}`).sort().join("\n");
  return crypto.createHash("sha256").update(key).digest("hex").slice(0, 16);
}

function planSteps(failing: CheckRecord[]): RepairRecord["steps"] {
  const steps: RepairRecord["steps"] = [];
  for (const c of failing.filter((x) => x.repair === "rebind" && x.itemId)) steps.push({ kind: "rebind", detail: c.itemId! });
  if (failing.some((x) => x.repair === "replan")) steps.push({ kind: "replan", detail: [...new Set(failing.filter((x) => x.repair === "replan" && x.itemId).map((x) => x.itemId!))].join(",") });
  return steps.slice(0, MAX_REPAIR_STEPS);
}

/** 核验这份投递，必要时有限修正；没有执行过任何步骤时不记录（返回 null） */
export function verifyAndRepair(intake: IntakeRow, hooks: RepairHooks, now: Date): VerificationRow | null {
  const prior = listVerifications(intake.id);
  let repairs = prior.filter((r) => r.repair).length;
  const tried = new Set(prior.map((r) => r.repair?.fingerprint).filter(Boolean));
  let last: VerificationRow | null = null;
  for (let round = 0; round <= MAX_REPAIRS; round++) {
    const v = verifyIntake(intake.id, now);
    if (!v) return last;
    const repairable = v.checks.filter((c) => c.ok === false && c.repair);
    const fingerprint = repairable.length ? fingerprintOf(repairable) : null;
    const checks = [...v.checks];
    let status = v.status;
    let stop: string | null = null;
    if (fingerprint) {
      if (tried.has(fingerprint)) stop = "修正后仍是同样的问题，不再重复尝试";
      else if (repairs >= MAX_REPAIRS) stop = `已自动修正 ${MAX_REPAIRS} 次仍未通过，不再继续`;
      else if (intakeTimeSpent(intakeRequestUsage(intake.id))) stop = `这份投递的处理已累计 ${INTAKE_ACTIVE_MS_LIMIT / 1000} 秒（含模型请求、查询与执行），没有继续修正`;
    }
    if (stop) {
      status = "blocked";
      checks.push({ kind: "repair_limit", ok: false, itemId: null, subject: "自动修正", detail: stop });
    }
    const steps = fingerprint && !stop ? planSteps(repairable) : [];
    const repair: RepairRecord | null = steps.length ? { reason: repairable.map((c) => `${c.subject}：${c.detail}`).join("；").slice(0, 500), steps, fingerprint: fingerprint! } : null;
    last = appendVerification({ intakeId: intake.id, goalId: intake.goalId, goalRevision: intake.goalRevision, status, checks, fingerprint, repair, at: now });
    if (!repair) return last;
    tried.add(repair.fingerprint);
    repairs++;
    const done = steps.map((s) => {
      try {
        return { kind: s.kind, detail: s.kind === "rebind" ? hooks.rebind(s.detail) : hooks.replan(s.detail ? s.detail.split(",") : []) };
      } catch (e) {
        return { kind: s.kind, detail: `修正没有成功：${e instanceof Error ? e.message : String(e)}` };
      }
    });
    recordRepairOutcome(last.id, { ...repair, steps: done });
  }
  return last;
}

/**
 * 异步结果到达后的再核验（复盘/探索/摘要任务结束时由 worker 调用，不轮询）：只核验、不修正；
 * 结论和上一轮相同就不重复记一轮。
 */
export function reverifyAfterEffect(intake: IntakeRow, now: Date): VerificationRow | null {
  const v = verifyIntake(intake.id, now);
  if (!v) return null;
  const prior = listVerifications(intake.id).at(-1);
  if (prior && prior.status === v.status && fingerprintOf(prior.checks) === fingerprintOf(v.checks)) return prior;
  return appendVerification({ intakeId: intake.id, goalId: intake.goalId, goalRevision: intake.goalRevision, status: v.status, checks: v.checks, fingerprint: null, repair: null, at: now });
}
