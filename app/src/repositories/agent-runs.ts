import crypto from "node:crypto";
import { getDb } from "./db";

/**
 * 执行后的核验与修正记录（Agent 方案 §5.2/§5.3；迁移 0032）。每份投递（= 目标的一版）按轮次追加：
 * round 0 是首次核验，之后每次修正后再核验一轮；repair 记的是这一轮之前做了什么修正、为什么。
 * 轮次持久化——worker 恢复后接着数，修正次数不重置。
 */

export const VERIFICATION_STATUSES = ["verified", "partial", "needs_action", "blocked", "pending"] as const;
export type VerificationStatus = (typeof VERIFICATION_STATUSES)[number];

export type CheckRecord = {
  kind: string;
  /** true 通过；false 未通过；null 还在等（异步结果未到） */
  ok: boolean | null;
  itemId: string | null;
  subject: string;
  detail: string;
  /** 未通过时能否在原授权内自动修正 */
  repair?: "replan" | "rebind" | null;
  /** 需要主人决定（取舍、冲突），附现成问题 */
  questionId?: string | null;
};

export type RepairRecord = { reason: string; steps: Array<{ kind: string; detail: string }>; fingerprint: string };

export type VerificationRow = {
  id: string;
  intakeId: string;
  goalId: string | null;
  goalRevision: number | null;
  round: number;
  status: VerificationStatus;
  checks: CheckRecord[];
  fingerprint: string | null;
  repair: RepairRecord | null;
  createdAt: string;
};

function mapRow(r: Record<string, unknown>): VerificationRow {
  return {
    id: r.id as string,
    intakeId: r.intake_id as string,
    goalId: (r.goal_id as string | null) ?? null,
    goalRevision: (r.goal_revision as number | null) ?? null,
    round: r.round as number,
    status: r.status as VerificationStatus,
    checks: JSON.parse((r.checks_json as string) || "[]") as CheckRecord[],
    fingerprint: (r.fingerprint as string | null) ?? null,
    repair: r.repair_json ? (JSON.parse(r.repair_json as string) as RepairRecord) : null,
    createdAt: r.created_at as string,
  };
}

export function listVerifications(intakeId: string): VerificationRow[] {
  return (getDb().prepare(`SELECT * FROM agent_verifications WHERE intake_id = ? ORDER BY round`).all(intakeId) as Array<Record<string, unknown>>).map(mapRow);
}

export function latestVerification(intakeId: string): VerificationRow | null {
  const r = getDb().prepare(`SELECT * FROM agent_verifications WHERE intake_id = ? ORDER BY round DESC LIMIT 1`).get(intakeId) as Record<string, unknown> | undefined;
  return r ? mapRow(r) : null;
}

/** 修正执行完后补记每一步的结果（修正决定本身在执行前已落库） */
export function recordRepairOutcome(id: string, repair: RepairRecord): void {
  getDb().prepare(`UPDATE agent_verifications SET repair_json = ? WHERE id = ?`).run(JSON.stringify(repair), id);
}

/** 追加一轮；轮次在同一事务里取下一个号。有修正时同步累加目标的修正次数 */
export function appendVerification(input: { intakeId: string; goalId: string | null; goalRevision: number | null; status: VerificationStatus; checks: CheckRecord[]; fingerprint: string | null; repair: RepairRecord | null; at?: Date }): VerificationRow {
  const db = getDb();
  return db.transaction((): VerificationRow => {
    const round = ((db.prepare(`SELECT MAX(round) AS r FROM agent_verifications WHERE intake_id = ?`).get(input.intakeId) as { r: number | null }).r ?? -1) + 1;
    const id = crypto.randomUUID();
    db.prepare(`INSERT INTO agent_verifications (id, intake_id, goal_id, goal_revision, round, status, checks_json, fingerprint, repair_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      id, input.intakeId, input.goalId, input.goalRevision, round, input.status, JSON.stringify(input.checks.slice(0, 60)), input.fingerprint, input.repair ? JSON.stringify(input.repair) : null, (input.at ?? new Date()).toISOString(),
    );
    if (input.repair && input.goalId) db.prepare(`UPDATE agent_goals SET repair_count = repair_count + 1 WHERE id = ?`).run(input.goalId);
    return mapRow(db.prepare(`SELECT * FROM agent_verifications WHERE id = ?`).get(id) as Record<string, unknown>);
  })();
}
