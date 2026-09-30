import crypto from "node:crypto";
import { getDb } from "@/repositories/db";

/**
 * 提案 repository（计划 v1.2 第 6 节）。
 * V1 不做提案内半选：每份 proposal 原子全量应用，中间失败全部回滚。
 */

export type ProposalOperationInput =
  | {
      kind: "create_task";
      clientRef: string;
      input: {
        title: string;
        description: string;
        projectId: string | null;
        goalId: string | null;
        status: "todo" | "doing" | "blocked" | "done" | "cancelled";
        priority: "normal" | "high";
        estimateMinutes: number | null;
        plannedWeek: { localMonday: string; timezone: string } | null;
        scheduledStart: string | null;
        scheduledEnd: string | null;
        due:
          | { kind: "none" }
          | { kind: "date"; localDate: string; timezone: string }
          | { kind: "instant"; at: string; timezone: string };
      };
    }
  | {
      kind: "reschedule_task";
      taskId: string;
      expectedVersion: number;
      scheduledStart: string | null;
      scheduledEnd: string | null;
    }
  | {
      kind: "set_task_status";
      taskId: string;
      expectedVersion: number;
      status: "todo" | "doing" | "blocked" | "done" | "cancelled";
    };

export type ProposalRow = {
  id: string;
  groupId: string;
  contextRefs: string[];
  inputVersions: Record<string, number>;
  planningRevision: number;
  operations: ProposalOperationInput[];
  reason: string;
  reasonCode: string | null;
  status: "pending" | "applied" | "rejected" | "snoozed";
  snoozeUntil: string | null;
  evidenceFingerprint: string | null;
  resultRefs: { taskIds?: string[] } | null;
  sourceKind: "manual" | "assistant" | "review";
  sourceId: string | null;
  projectId: string | null;
  version: number;
  rejectionReason: string | null;
  decidedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export function createProposal(args: {
  groupId?: string;
  groupTitle?: string;
  contextRefs: string[];
  inputVersions: Record<string, number>;
  operations: ProposalOperationInput[];
  reason: string;
  reasonCode?: string;
  evidenceFingerprint?: string;
  sourceKind?: ProposalRow["sourceKind"];
  sourceId?: string | null;
  projectId?: string | null;
}): ProposalRow {
  const db = getDb();
  const id = crypto.randomUUID();
  const groupId = args.groupId ?? crypto.randomUUID();
  const t = now();
  const planningRevision = getPlanningRevision();
  const tx = db.transaction(() => {
    // group 只是展示集合：同一次复盘的多份提案共用一个 group
    db.prepare(`INSERT OR IGNORE INTO proposal_groups (id, title, created_at) VALUES (?, ?, ?)`).run(
      groupId,
      args.groupTitle ?? "",
      t,
    );
    db.prepare(
      `INSERT INTO proposals
         (id, group_id, context_refs, input_versions_json, planning_revision,
          operations, reason, reason_code, evidence_fingerprint, source_kind, source_id, project_id,
          status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
    ).run(
      id,
      groupId,
      JSON.stringify(args.contextRefs),
      JSON.stringify(args.inputVersions),
      planningRevision,
      JSON.stringify(args.operations),
      args.reason,
      args.reasonCode ?? null,
      args.evidenceFingerprint ?? null,
      args.sourceKind ?? "manual",
      args.sourceId ?? null,
      args.projectId ?? null,
      t,
      t,
    );
    args.operations.forEach((op, i) => {
      db.prepare(
        `INSERT INTO proposal_operations (id, proposal_id, seq, kind, payload)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(crypto.randomUUID(), id, i, op.kind, JSON.stringify(op));
    });
  });
  tx();
  return getProposal(id)!;
}

export function getProposal(id: string): ProposalRow | null {
  const db = getDb();
  const row = db.prepare(`SELECT * FROM proposals WHERE id = ?`).get(id) as
    | Record<string, unknown>
    | undefined;
  return row ? mapProposal(row) : null;
}

export function listProposals(
  filter: { status?: string; sourceKind?: string; sourceId?: string } = {},
): ProposalRow[] {
  const db = getDb();
  const where: string[] = [];
  const vals: string[] = [];
  for (const [col, v] of [
    ["status", filter.status],
    ["source_kind", filter.sourceKind],
    ["source_id", filter.sourceId],
  ] as const) {
    if (!v) continue;
    where.push(`${col} = ?`);
    vals.push(v);
  }
  const rows = db
    .prepare(`SELECT * FROM proposals ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC`)
    .all(...vals) as Array<Record<string, unknown>>;
  return rows.map(mapProposal);
}

/**
 * 冷却（第 6 节）：同项目同操作类型同证据的建议被拒绝后 N 天内不自动重复。
 * evidenceFingerprint 已包含项目、操作类型与证据集合。
 */
export function rejectedRecently(evidenceFingerprint: string, sinceIso: string): boolean {
  const row = getDb()
    .prepare(
      `SELECT 1 FROM proposals WHERE evidence_fingerprint = ? AND status = 'rejected' AND decided_at >= ? LIMIT 1`,
    )
    .get(evidenceFingerprint, sinceIso);
  return Boolean(row);
}

/** 同指纹已有待处理的建议：不重复生成 */
export function pendingWithFingerprint(evidenceFingerprint: string): boolean {
  return Boolean(
    getDb().prepare(`SELECT 1 FROM proposals WHERE evidence_fingerprint = ? AND status = 'pending' LIMIT 1`).get(evidenceFingerprint),
  );
}

function mapProposal(r: Record<string, unknown>): ProposalRow {
  return {
    id: r.id as string,
    groupId: r.group_id as string,
    contextRefs: JSON.parse(r.context_refs as string) as string[],
    inputVersions: JSON.parse(r.input_versions_json as string) as Record<string, number>,
    planningRevision: r.planning_revision as number,
    operations: JSON.parse(r.operations as string) as ProposalOperationInput[],
    reason: r.reason as string,
    reasonCode: (r.reason_code as string | null) ?? null,
    status: r.status as ProposalRow["status"],
    snoozeUntil: (r.snooze_until as string | null) ?? null,
    evidenceFingerprint: (r.evidence_fingerprint as string | null) ?? null,
    resultRefs: r.result_refs_json ? (JSON.parse(r.result_refs_json as string) as ProposalRow["resultRefs"]) : null,
    sourceKind: (r.source_kind as ProposalRow["sourceKind"]) ?? "manual",
    sourceId: (r.source_id as string | null) ?? null,
    projectId: (r.project_id as string | null) ?? null,
    version: (r.version as number) ?? 1,
    rejectionReason: (r.rejection_reason as string | null) ?? null,
    decidedAt: (r.decided_at as string | null) ?? null,
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
  };
}

// ===== planning revision（单行计数） =====

export function getPlanningRevision(): number {
  const db = getDb();
  const row = db.prepare(`SELECT planning_revision FROM planning_state WHERE id = 1`).get() as {
    planning_revision: number;
  };
  return row.planning_revision;
}

/** 课程、可用时间或任务计划时间变化时递增，使排程草案保守失效 */
export function bumpPlanningRevision(): void {
  const db = getDb();
  db.prepare(
    `UPDATE planning_state SET planning_revision = planning_revision + 1 WHERE id = 1`,
  ).run();
}

function now(): string {
  return new Date().toISOString();
}
