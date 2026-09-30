import crypto from "node:crypto";
import { getDb } from "@/repositories/db";

/**
 * 复盘与助手请求 repository（计划 v1.2 第 4.2 节 reviews / review_edits）。
 * 事实快照（facts_json）与 AI 草案（ai_draft_json）与主人修订（owner_*）三处分开存；
 * 主人每次修订另记一条 review_edits，原事实引用保留。
 */

function now(): string {
  return new Date().toISOString();
}
const pj = <T>(v: unknown, fb: T): T => (typeof v === "string" ? (JSON.parse(v) as T) : fb);

export type ReviewStatus = "queued" | "generating" | "ready" | "insufficient" | "failed" | "cancelled";

export type ReviewRow = {
  id: string;
  kind: "weekly";
  localMonday: string;
  timezone: string;
  trigger: "manual" | "scheduled";
  status: ReviewStatus;
  jobId: string | null;
  facts: unknown;
  aiDraft: unknown;
  aiSkippedReason: string | null;
  integrationMode: "real" | "fixture" | "none" | null;
  errorCode: string | null;
  errorMessage: string | null;
  ownerSummary: string;
  ownerNextWeek: string;
  version: number;
  generatedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

function mapReview(r: Record<string, unknown>): ReviewRow {
  return {
    id: r.id as string,
    kind: "weekly",
    localMonday: r.local_monday as string,
    timezone: r.timezone as string,
    trigger: r.trigger as ReviewRow["trigger"],
    status: r.status as ReviewStatus,
    jobId: (r.job_id as string | null) ?? null,
    facts: pj(r.facts_json, null),
    aiDraft: pj(r.ai_draft_json, null),
    aiSkippedReason: (r.ai_skipped_reason as string | null) ?? null,
    integrationMode: (r.integration_mode as ReviewRow["integrationMode"]) ?? null,
    errorCode: (r.error_code as string | null) ?? null,
    errorMessage: (r.error_message as string | null) ?? null,
    ownerSummary: r.owner_summary as string,
    ownerNextWeek: r.owner_next_week as string,
    version: r.version as number,
    generatedAt: (r.generated_at as string | null) ?? null,
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
  };
}

export function insertReview(input: { localMonday: string; timezone: string; trigger: ReviewRow["trigger"] }): ReviewRow {
  const id = crypto.randomUUID();
  const t = now();
  getDb()
    .prepare(
      `INSERT INTO reviews (id, kind, local_monday, timezone, trigger, status, version, created_at, updated_at)
       VALUES (?, 'weekly', ?, ?, ?, 'queued', 1, ?, ?)`,
    )
    .run(id, input.localMonday, input.timezone, input.trigger, t, t);
  return getReview(id)!;
}

export function getReview(id: string): ReviewRow | null {
  const row = getDb().prepare(`SELECT * FROM reviews WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
  return row ? mapReview(row) : null;
}

export function listReviews(limit = 20): ReviewRow[] {
  return (
    getDb().prepare(`SELECT * FROM reviews ORDER BY local_monday DESC, created_at DESC LIMIT ?`).all(limit) as Array<
      Record<string, unknown>
    >
  ).map(mapReview);
}

/** 同周最近一份复盘（同周期允许修订：再次生成是新的草案，旧的保留） */
export function latestReviewForWeek(localMonday: string, timezone: string): ReviewRow | null {
  const row = getDb()
    .prepare(`SELECT * FROM reviews WHERE local_monday = ? AND timezone = ? ORDER BY created_at DESC LIMIT 1`)
    .get(localMonday, timezone) as Record<string, unknown> | undefined;
  return row ? mapReview(row) : null;
}

export function setReviewJob(id: string, jobId: string): void {
  getDb().prepare(`UPDATE reviews SET job_id = ? WHERE id = ?`).run(jobId, id);
}

const OPEN = ["queued", "generating"];

export function setReviewGenerating(id: string): boolean {
  return (
    getDb()
      .prepare(`UPDATE reviews SET status = 'generating', updated_at = ? WHERE id = ? AND status IN ('queued','generating')`)
      .run(now(), id).changes === 1
  );
}

/** 结果落库（生成器专用；不碰 owner_*） */
export function finishReview(
  id: string,
  args: {
    status: "ready" | "insufficient" | "failed" | "cancelled";
    facts?: unknown;
    aiDraft?: unknown;
    aiSkippedReason?: string | null;
    integrationMode?: ReviewRow["integrationMode"];
    errorCode?: string | null;
    errorMessage?: string | null;
  },
): boolean {
  const t = now();
  const r = getDb()
    .prepare(
      `UPDATE reviews SET status = ?, facts_json = COALESCE(?, facts_json), ai_draft_json = ?, ai_skipped_reason = ?,
         integration_mode = ?, error_code = ?, error_message = ?, generated_at = ?, updated_at = ?
       WHERE id = ? AND status IN (${OPEN.map(() => "?").join(",")})`,
    )
    .run(
      args.status,
      args.facts === undefined ? null : JSON.stringify(args.facts),
      args.aiDraft === undefined || args.aiDraft === null ? null : JSON.stringify(args.aiDraft),
      args.aiSkippedReason ?? null,
      args.integrationMode ?? null,
      args.errorCode ?? null,
      args.errorMessage ?? null,
      t,
      t,
      id,
      ...OPEN,
    );
  return r.changes === 1;
}

/** 主人修订：乐观锁 + 记 review_edits */
export function updateOwnerFields(
  id: string,
  expectedVersion: number,
  fields: { ownerSummary?: string; ownerNextWeek?: string },
): ReviewRow | "conflict" | "not_found" {
  const db = getDb();
  const tx = db.transaction(() => {
    const cur = getReview(id);
    if (!cur) return "not_found" as const;
    if (cur.version !== expectedVersion) return "conflict" as const;
    const t = now();
    const sets: string[] = [];
    const vals: string[] = [];
    const edits: Array<[string, string]> = [];
    if (fields.ownerSummary !== undefined && fields.ownerSummary !== cur.ownerSummary) {
      sets.push("owner_summary = ?");
      vals.push(fields.ownerSummary);
      edits.push(["owner_summary", fields.ownerSummary]);
    }
    if (fields.ownerNextWeek !== undefined && fields.ownerNextWeek !== cur.ownerNextWeek) {
      sets.push("owner_next_week = ?");
      vals.push(fields.ownerNextWeek);
      edits.push(["owner_next_week", fields.ownerNextWeek]);
    }
    if (sets.length === 0) return cur;
    db.prepare(`UPDATE reviews SET ${sets.join(", ")}, version = version + 1, updated_at = ? WHERE id = ? AND version = ?`).run(
      ...vals,
      t,
      id,
      expectedVersion,
    );
    for (const [field, value] of edits) {
      db.prepare(
        `INSERT INTO review_edits (id, review_id, field, value, review_version, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(crypto.randomUUID(), id, field, value, expectedVersion + 1, t);
    }
    return getReview(id)!;
  });
  return tx();
}

export function listReviewEdits(reviewId: string): Array<{ field: string; value: string; reviewVersion: number; createdAt: string }> {
  return (
    getDb()
      .prepare(`SELECT field, value, review_version, created_at FROM review_edits WHERE review_id = ? ORDER BY created_at`)
      .all(reviewId) as Array<Record<string, unknown>>
  ).map((r) => ({
    field: r.field as string,
    value: r.value as string,
    reviewVersion: r.review_version as number,
    createdAt: r.created_at as string,
  }));
}

// ===== assistant requests =====

export type AssistantStatus = "queued" | "running" | "done" | "insufficient" | "failed" | "cancelled";

export type AssistantRequestRow = {
  id: string;
  scopeType: "project" | "week";
  scopeId: string;
  question: string;
  logId: string | null;
  rerun: boolean;
  status: AssistantStatus;
  jobId: string | null;
  result: unknown;
  integrationMode: "real" | "fixture" | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
};

function mapAssistant(r: Record<string, unknown>): AssistantRequestRow {
  return {
    id: r.id as string,
    scopeType: r.scope_type as AssistantRequestRow["scopeType"],
    scopeId: r.scope_id as string,
    question: r.question as string,
    logId: (r.log_id as string | null) ?? null,
    rerun: r.rerun === 1,
    status: r.status as AssistantStatus,
    jobId: (r.job_id as string | null) ?? null,
    result: pj(r.result_json, null),
    integrationMode: (r.integration_mode as AssistantRequestRow["integrationMode"]) ?? null,
    errorCode: (r.error_code as string | null) ?? null,
    errorMessage: (r.error_message as string | null) ?? null,
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
  };
}

export function insertAssistantRequest(input: {
  scopeType: AssistantRequestRow["scopeType"];
  scopeId: string;
  question: string;
  logId: string | null;
  rerun: boolean;
  integrationMode: "real" | "fixture";
}): AssistantRequestRow {
  const id = crypto.randomUUID();
  const t = now();
  getDb()
    .prepare(
      `INSERT INTO assistant_requests (id, scope_type, scope_id, question, log_id, rerun, status, integration_mode, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?)`,
    )
    .run(id, input.scopeType, input.scopeId, input.question, input.logId, input.rerun ? 1 : 0, input.integrationMode, t, t);
  return getAssistantRequest(id)!;
}

export function getAssistantRequest(id: string): AssistantRequestRow | null {
  const row = getDb().prepare(`SELECT * FROM assistant_requests WHERE id = ?`).get(id) as
    | Record<string, unknown>
    | undefined;
  return row ? mapAssistant(row) : null;
}

export function listAssistantRequestsForLog(logId: string): AssistantRequestRow[] {
  return (
    getDb().prepare(`SELECT * FROM assistant_requests WHERE log_id = ? ORDER BY created_at DESC`).all(logId) as Array<
      Record<string, unknown>
    >
  ).map(mapAssistant);
}

export function setAssistantJob(id: string, jobId: string): void {
  getDb().prepare(`UPDATE assistant_requests SET job_id = ? WHERE id = ?`).run(jobId, id);
}

export function setAssistantRunning(id: string): void {
  getDb().prepare(`UPDATE assistant_requests SET status = 'running', updated_at = ? WHERE id = ? AND status = 'queued'`).run(now(), id);
}

export function finishAssistant(
  id: string,
  args: { status: "done" | "insufficient" | "failed" | "cancelled"; result?: unknown; errorCode?: string | null; errorMessage?: string | null },
): boolean {
  const r = getDb()
    .prepare(
      `UPDATE assistant_requests SET status = ?, result_json = ?, error_code = ?, error_message = ?, updated_at = ?
       WHERE id = ? AND status IN ('queued','running')`,
    )
    .run(args.status, args.result === undefined ? null : JSON.stringify(args.result), args.errorCode ?? null, args.errorMessage ?? null, now(), id);
  return r.changes === 1;
}
