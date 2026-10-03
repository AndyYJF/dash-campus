import crypto from "node:crypto";
import { getDb } from "./db";

/** 命令 journal：agent_action_batches + agent_action_changes（MASTER-PLAN §5.3；撤销粒度 = batch） */

export type ChangeInput = {
  entityKind: string;
  entityId: string;
  action: "create" | "update" | "delete";
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  beforeVersion?: number | null;
  afterVersion?: number | null;
};

export type BatchRow = {
  id: string;
  command: string;
  intakeId: string | null;
  itemId: string | null;
  status: "applied" | "undone";
  createdAt: string;
  undoneAt: string | null;
};

export type ChangeRow = {
  id: string;
  batchId: string;
  entityKind: string;
  entityId: string;
  action: "create" | "update" | "delete";
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  beforeVersion: number | null;
  afterVersion: number | null;
};

function now(): string {
  return new Date().toISOString();
}

/** 必须在调用方事务内执行 */
export function createBatch(input: {
  command: string;
  reason: string;
  intakeId: string | null;
  itemId: string | null;
  policyVersion: string;
  instanceEpoch: number;
}): string {
  const id = crypto.randomUUID();
  getDb()
    .prepare(
      `INSERT INTO agent_action_batches (id, command, reason, intake_id, item_id, policy_version, instance_epoch, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'applied', ?)`,
    )
    .run(id, input.command, input.reason, input.intakeId, input.itemId, input.policyVersion, input.instanceEpoch, now());
  return id;
}

/** 必须在调用方事务内执行 */
export function addChange(batchId: string, c: ChangeInput): void {
  getDb()
    .prepare(
      `INSERT INTO agent_action_changes (id, batch_id, entity_kind, entity_id, action, before_json, after_json, before_version, after_version)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      crypto.randomUUID(),
      batchId,
      c.entityKind,
      c.entityId,
      c.action,
      c.before ? JSON.stringify(c.before) : null,
      c.after ? JSON.stringify(c.after) : null,
      c.beforeVersion ?? null,
      c.afterVersion ?? null,
    );
}

export function getBatch(id: string): BatchRow | null {
  const r = getDb().prepare(`SELECT * FROM agent_action_batches WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
  if (!r) return null;
  return {
    id: r.id as string,
    command: r.command as string,
    intakeId: (r.intake_id as string) ?? null,
    itemId: (r.item_id as string) ?? null,
    status: r.status as BatchRow["status"],
    createdAt: r.created_at as string,
    undoneAt: (r.undone_at as string) ?? null,
  };
}

export function listChanges(batchId: string): ChangeRow[] {
  const rows = getDb().prepare(`SELECT * FROM agent_action_changes WHERE batch_id = ? ORDER BY rowid`).all(batchId) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    id: r.id as string,
    batchId: r.batch_id as string,
    entityKind: r.entity_kind as string,
    entityId: r.entity_id as string,
    action: r.action as ChangeRow["action"],
    before: r.before_json ? JSON.parse(r.before_json as string) : null,
    after: r.after_json ? JSON.parse(r.after_json as string) : null,
    beforeVersion: (r.before_version as number) ?? null,
    afterVersion: (r.after_version as number) ?? null,
  }));
}

/** 必须在调用方事务内执行 */
export function markUndone(batchId: string): void {
  getDb().prepare(`UPDATE agent_action_batches SET status = 'undone', undone_at = ? WHERE id = ?`).run(now(), batchId);
}
