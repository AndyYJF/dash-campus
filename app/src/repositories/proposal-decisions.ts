import { getDb } from "@/repositories/db";

/**
 * 提案拒绝与暂缓。snooze 与 pending 分开保存，暂缓不等于拒绝。
 * 拒绝记录原因：冷却按 evidence_fingerprint + decided_at 计算（第 6 节）。
 * expectedVersion 可选：给出时不匹配返回 conflict（13.2）。
 */

type Outcome = "not_found" | "invalid_state" | "conflict" | "ok";

function check(id: string, expectedVersion?: number): Outcome | null {
  const row = getDb().prepare(`SELECT status, version FROM proposals WHERE id = ?`).get(id) as
    | { status: string; version: number }
    | undefined;
  if (!row) return "not_found";
  if (row.status !== "pending") return "invalid_state";
  if (expectedVersion !== undefined && row.version !== expectedVersion) return "conflict";
  return null;
}

export function rejectProposal(id: string, reason: string | null = null, expectedVersion?: number): Outcome {
  const db = getDb();
  const tx = db.transaction((): Outcome => {
    const bad = check(id, expectedVersion);
    if (bad) return bad;
    const t = new Date().toISOString();
    db.prepare(
      `UPDATE proposals SET status = 'rejected', rejection_reason = ?, decided_at = ?, updated_at = ?, version = version + 1
       WHERE id = ?`,
    ).run(reason, t, t, id);
    return "ok";
  });
  return tx();
}

export function snoozeProposal(id: string, snoozeUntil: string, expectedVersion?: number): Outcome {
  const db = getDb();
  const tx = db.transaction((): Outcome => {
    const bad = check(id, expectedVersion);
    if (bad) return bad;
    db.prepare(`UPDATE proposals SET snooze_until = ?, updated_at = ?, version = version + 1 WHERE id = ?`).run(
      snoozeUntil,
      new Date().toISOString(),
      id,
    );
    return "ok";
  });
  return tx();
}
