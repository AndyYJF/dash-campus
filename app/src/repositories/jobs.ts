import crypto from "node:crypto";
import { getDb } from "@/repositories/db";
import { JOB_LEASE_MS, type JobResult, type JobRow, type JobStatus } from "@/contracts/jobs";

/**
 * jobs repository（计划 v1.2 第 8.1 节 job fencing）。
 * 领取、续租、结果提交和终结都使用 token+generation 条件更新；
 * 旧执行者恢复后即使拿到模型结果也不能落业务数据。
 */

function now(): string {
  return new Date().toISOString();
}

function mapJob(r: Record<string, unknown>): JobRow {
  return {
    id: r.id as string,
    type: r.type as string,
    taskId: (r.task_id as string | null) ?? null,
    dedupeKey: r.dedupe_key as string,
    runAt: r.run_at as string,
    payload: JSON.parse(r.payload_json as string) as unknown,
    status: r.status as JobStatus,
    leaseToken: (r.lease_token as string | null) ?? null,
    leaseUntil: (r.lease_until as string | null) ?? null,
    attempt: r.attempt as number,
    generation: r.generation as number,
    cancelRequested: r.cancel_requested === 1,
    result: r.result_json ? (JSON.parse(r.result_json as string) as JobResult) : null,
    lastError: (r.last_error as string | null) ?? null,
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
  };
}

/**
 * 创建 job。dedupe_key 冲突时返回既有 job（提醒按 taskId+revision 去重，幂等）。
 * payload 由调用方保证已被 schema 校验。
 */
export function createJob(input: {
  type: string;
  taskId?: string | null;
  dedupeKey: string;
  runAt: string;
  payload: unknown;
}): JobRow {
  const db = getDb();
  const id = crypto.randomUUID();
  const t = now();
  try {
    db.prepare(
      `INSERT INTO jobs (id, type, task_id, dedupe_key, run_at, payload_json, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?)`,
    ).run(id, input.type, input.taskId ?? null, input.dedupeKey, input.runAt, JSON.stringify(input.payload), t, t);
  } catch (e) {
    if ((e as { code?: string }).code === "SQLITE_CONSTRAINT_UNIQUE") {
      const existing = db
        .prepare(`SELECT * FROM jobs WHERE dedupe_key = ?`)
        .get(input.dedupeKey) as Record<string, unknown> | undefined;
      if (existing) return mapJob(existing);
    }
    throw e;
  }
  return getJob(id)!;
}

export function getJob(id: string): JobRow | null {
  const db = getDb();
  const row = db.prepare(`SELECT * FROM jobs WHERE id = ?`).get(id) as
    | Record<string, unknown>
    | undefined;
  return row ? mapJob(row) : null;
}

export function listJobs(filter: { type?: string; status?: JobStatus; taskId?: string } = {}): JobRow[] {
  const db = getDb();
  const where: string[] = [];
  const vals: string[] = [];
  if (filter.type) {
    where.push("type = ?");
    vals.push(filter.type);
  }
  if (filter.status) {
    where.push("status = ?");
    vals.push(filter.status);
  }
  if (filter.taskId) {
    where.push("task_id = ?");
    vals.push(filter.taskId);
  }
  const rows = db
    .prepare(
      `SELECT * FROM jobs ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY run_at DESC LIMIT 200`,
    )
    .all(...vals) as Array<Record<string, unknown>>;
  return rows.map(mapJob);
}

/**
 * 领取到期 job：queued 且 run_at <= now；含租约过期的 running 重领（generation+1）。
 * 每次领取分配新的 lease_token，条件更新保证并发下同一 job 只被一个执行者持有。
 */
export function claimDueJobs(nowIso: string, limit = 5): JobRow[] {
  const db = getDb();
  const candidates = db
    .prepare(
      `SELECT id FROM jobs
       WHERE hold_state IS NULL
         AND ((status = 'queued' AND run_at <= ?)
          OR (status = 'running' AND (lease_until IS NULL OR lease_until < ?)))
       ORDER BY run_at LIMIT ?`,
    )
    .all(nowIso, nowIso, limit) as Array<{ id: string }>;
  const claimed: JobRow[] = [];
  for (const { id } of candidates) {
    const token = crypto.randomUUID();
    const leaseUntil = new Date(new Date(nowIso).getTime() + JOB_LEASE_MS).toISOString();
    const r = db
      .prepare(
        `UPDATE jobs SET status = 'running', lease_token = ?, lease_until = ?,
           attempt = attempt + 1, generation = generation + 1, updated_at = ?
         WHERE id = ? AND hold_state IS NULL
           AND ((status = 'queued' AND run_at <= ?)
             OR (status = 'running' AND (lease_until IS NULL OR lease_until < ?)))`,
      )
      .run(token, leaseUntil, now(), id, nowIso, nowIso);
    if (r.changes === 1) claimed.push(getJob(id)!);
  }
  return claimed;
}

/** 续租：token+generation 条件更新；失败说明租约已被夺走 */
export function renewLease(id: string, token: string, generation: number, nowIso: string): boolean {
  const db = getDb();
  const leaseUntil = new Date(new Date(nowIso).getTime() + JOB_LEASE_MS).toISOString();
  const r = db
    .prepare(
      `UPDATE jobs SET lease_until = ?, updated_at = ?
       WHERE id = ? AND lease_token = ? AND generation = ? AND status = 'running' AND lease_until > ?`,
    )
    .run(leaseUntil, now(), id, token, generation, nowIso);
  // 已过期的租约不能"续"回来（8.1：长期停顿不是继续拥有任务的依据）
  return r.changes === 1;
}

/** 仍持有租约且租约未过期（结果事务内的前置检查） */
export function leaseValid(id: string, token: string, generation: number, nowIso: string): boolean {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT 1 FROM jobs WHERE id = ? AND lease_token = ? AND generation = ? AND status = 'running' AND lease_until > ?`,
    )
    .get(id, token, generation, nowIso);
  return Boolean(row);
}

export function completeJob(
  id: string,
  token: string,
  generation: number,
  result: JobResult,
  nowIso: string,
): boolean {
  const db = getDb();
  if (!leaseValid(id, token, generation, nowIso)) return false;
  const r = db
    .prepare(
      `UPDATE jobs SET status = 'done', result_json = ?, updated_at = ?
       WHERE id = ? AND lease_token = ? AND generation = ? AND status = 'running'`,
    )
    .run(JSON.stringify(result), now(), id, token, generation);
  return r.changes === 1;
}

export function failJob(
  id: string,
  token: string,
  generation: number,
  error: string,
  nowIso: string,
): boolean {
  const db = getDb();
  if (!leaseValid(id, token, generation, nowIso)) return false;
  const r = db
    .prepare(
      `UPDATE jobs SET status = 'failed', last_error = ?, updated_at = ?
       WHERE id = ? AND lease_token = ? AND generation = ? AND status = 'running'`,
    )
    .run(error, now(), id, token, generation);
  return r.changes === 1;
}

/** 取消：queued 直接取消；running 记录取消请求，由执行者在外部调用前与业务发布前检查 */
export function requestCancel(id: string): "cancelled" | "cancel_requested" | "not_found" {
  const db = getDb();
  const r1 = db
    .prepare(`UPDATE jobs SET status = 'cancelled', updated_at = ? WHERE id = ? AND status = 'queued'`)
    .run(now(), id);
  if (r1.changes === 1) return "cancelled";
  const r2 = db
    .prepare(
      `UPDATE jobs SET cancel_requested = 1, updated_at = ? WHERE id = ? AND status = 'running' AND cancel_requested = 0`,
    )
    .run(now(), id);
  if (r2.changes === 1) return "cancel_requested";
  return "not_found";
}

/** 执行者确认取消：把 running job 落为 cancelled（条件更新仍要求持有租约） */
export function completeCancellation(id: string, token: string, generation: number, nowIso: string): boolean {
  const db = getDb();
  if (!leaseValid(id, token, generation, nowIso)) return false;
  const r = db
    .prepare(
      `UPDATE jobs SET status = 'cancelled', updated_at = ?
       WHERE id = ? AND lease_token = ? AND generation = ? AND status = 'running' AND cancel_requested = 1`,
    )
    .run(now(), id, token, generation);
  return r.changes === 1;
}

