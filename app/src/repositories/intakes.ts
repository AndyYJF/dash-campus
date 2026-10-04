import crypto from "node:crypto";
import { getDb } from "@/repositories/db";
import type { IntakeItemKind, IntakeItemState, IntakeStatus } from "@/contracts/intake";

/**
 * intake / extracted_documents / intake_items 仓储（MASTER-PLAN §5.1）。
 * 只封装 SQL；状态推进与恢复语义在 src/workflows/intake.ts。
 */

export type IntakeRow = {
  id: string;
  channel: string;
  text: string;
  referenceDate: string;
  timezone: string;
  status: IntakeStatus;
  version: number;
  instanceEpoch: number;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
  conversationId: string | null;
  /** 投递时附带的上下文：回答的问题、从哪张卡片/哪个空档发起 */
  context: Record<string, unknown>;
  /** 属于哪个 Agent 目标的哪一版（迁移 0031）；不是当前版的投递不能再写入 */
  goalId: string | null;
  goalRevision: number | null;
};

export type IntakeItemRow = {
  id: string;
  intakeId: string;
  stableItemKey: string;
  kind: IntakeItemKind;
  payload: Record<string, unknown>;
  state: IntakeItemState;
  evidence: Record<string, unknown> | null;
  waitingQuestionId: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
};

const now = () => new Date().toISOString();

function mapIntake(r: Record<string, unknown>): IntakeRow {
  return {
    id: r.id as string,
    channel: r.channel as string,
    text: r.text as string,
    referenceDate: r.reference_date as string,
    timezone: r.timezone as string,
    status: r.status as IntakeStatus,
    version: r.version as number,
    instanceEpoch: r.instance_epoch as number,
    lastError: (r.last_error as string | null) ?? null,
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
    conversationId: (r.conversation_id as string | null) ?? null,
    context: r.context_json ? (JSON.parse(r.context_json as string) as Record<string, unknown>) : {},
    goalId: (r.goal_id as string | null) ?? null,
    goalRevision: (r.goal_revision as number | null) ?? null,
  };
}

function mapItem(r: Record<string, unknown>): IntakeItemRow {
  return {
    id: r.id as string,
    intakeId: r.intake_id as string,
    stableItemKey: r.stable_item_key as string,
    kind: r.kind as IntakeItemKind,
    payload: JSON.parse(r.payload_json as string) as Record<string, unknown>,
    state: r.state as IntakeItemState,
    evidence: r.evidence_json ? (JSON.parse(r.evidence_json as string) as Record<string, unknown>) : null,
    waitingQuestionId: (r.waiting_question_id as string | null) ?? null,
    version: r.version as number,
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
  };
}

export function createIntake(input: {
  channel: string;
  text: string;
  referenceDate: string;
  timezone: string;
  instanceEpoch: number;
  conversationId?: string | null;
  context?: Record<string, unknown>;
}): IntakeRow {
  const db = getDb();
  const id = crypto.randomUUID();
  const t = now();
  db.prepare(
    `INSERT INTO intakes (id, channel, text, reference_date, timezone, status, instance_epoch, conversation_id, context_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'received', ?, ?, ?, ?, ?)`,
  ).run(id, input.channel, input.text, input.referenceDate, input.timezone, input.instanceEpoch, input.conversationId ?? null, JSON.stringify(input.context ?? {}), t, t);
  return getIntake(id)!;
}

/** 服务端历史：按接收时间倒序分页（游标 = 上一页最后一条的 createdAt|id） */
export function listIntakes(opts: { limit?: number; cursor?: string | null; status?: string | null } = {}): { intakes: IntakeRow[]; nextCursor: string | null } {
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 50);
  const [cAt, cId] = (opts.cursor ?? "").split("|");
  const where: string[] = [];
  const vals: unknown[] = [];
  if (cAt && cId) {
    where.push(`(created_at < ? OR (created_at = ? AND id < ?))`);
    vals.push(cAt, cAt, cId);
  }
  if (opts.status) {
    where.push(`status = ?`);
    vals.push(opts.status);
  }
  const rows = getDb()
    .prepare(`SELECT * FROM intakes ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC, id DESC LIMIT ?`)
    .all(...vals, limit + 1) as Array<Record<string, unknown>>;
  const page = rows.slice(0, limit).map(mapIntake);
  const last = page[page.length - 1];
  return { intakes: page, nextCursor: rows.length > limit && last ? `${last.createdAt}|${last.id}` : null };
}

export function getIntake(id: string): IntakeRow | null {
  const row = getDb().prepare(`SELECT * FROM intakes WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
  return row ? mapIntake(row) : null;
}

/** 文本材料的提取证据（P4 附件复用同表） */
export function createExtractedDocument(input: {
  intakeId: string;
  sourceKind: string;
  extractorVersion: string;
  contentText: string;
}): { id: string; contentHash: string } {
  const db = getDb();
  const id = crypto.randomUUID();
  const contentHash = crypto.createHash("sha256").update(input.contentText, "utf8").digest("hex");
  db.prepare(
    `INSERT INTO extracted_documents (id, intake_id, source_kind, extractor_version, content_text, content_hash, locator, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, NULL, 'done', ?)`,
  ).run(id, input.intakeId, input.sourceKind, input.extractorVersion, input.contentText, contentHash, now());
  return { id, contentHash };
}

export function listExtractedDocuments(intakeId: string): Array<{ id: string; sourceKind: string; contentHash: string; status: string }> {
  const rows = getDb()
    .prepare(`SELECT id, source_kind, content_hash, status FROM extracted_documents WHERE intake_id = ? ORDER BY created_at`)
    .all(intakeId) as Array<Record<string, unknown>>;
  return rows.map((r) => ({ id: r.id as string, sourceKind: r.source_kind as string, contentHash: r.content_hash as string, status: r.status as string }));
}

/** 同一 (intake, stableItemKey) 已存在时不重复创建（重跑安全），返回既有事项 */
export function createItem(input: {
  intakeId: string;
  stableItemKey: string;
  kind: IntakeItemKind;
  payload: Record<string, unknown>;
  evidence?: Record<string, unknown> | null;
}): { item: IntakeItemRow; created: boolean } {
  const db = getDb();
  const id = crypto.randomUUID();
  const t = now();
  try {
    db.prepare(
      `INSERT INTO intake_items (id, intake_id, stable_item_key, kind, payload_json, state, evidence_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'extracted', ?, ?, ?)`,
    ).run(id, input.intakeId, input.stableItemKey, input.kind, JSON.stringify(input.payload), input.evidence ? JSON.stringify(input.evidence) : null, t, t);
    return { item: getItem(id)!, created: true };
  } catch (e) {
    if ((e as { code?: string }).code === "SQLITE_CONSTRAINT_UNIQUE" || (e as { code?: string }).code === "SQLITE_CONSTRAINT") {
      const existing = db
        .prepare(`SELECT * FROM intake_items WHERE intake_id = ? AND stable_item_key = ?`)
        .get(input.intakeId, input.stableItemKey) as Record<string, unknown> | undefined;
      if (existing) return { item: mapItem(existing), created: false };
    }
    throw e;
  }
}

export function getItem(id: string): IntakeItemRow | null {
  const row = getDb().prepare(`SELECT * FROM intake_items WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
  return row ? mapItem(row) : null;
}

/** 删除事项（P2 retry：删掉失败的分类占位事项让管线重跑）。须在调用方事务内使用 */
export function deleteItem(id: string): void {
  getDb().prepare(`DELETE FROM intake_items WHERE id = ?`).run(id);
}

export function listItems(intakeId: string): IntakeItemRow[] {
  const rows = getDb()
    .prepare(`SELECT * FROM intake_items WHERE intake_id = ? ORDER BY created_at, stable_item_key`)
    .all(intakeId) as Array<Record<string, unknown>>;
  return rows.map(mapItem);
}

/** 等待某问题的事项（回答后恢复用） */
export function listItemsWaitingOn(questionId: string): IntakeItemRow[] {
  const rows = getDb()
    .prepare(`SELECT * FROM intake_items WHERE waiting_question_id = ? AND state = 'awaiting_input'`)
    .all(questionId) as Array<Record<string, unknown>>;
  return rows.map(mapItem);
}

export function updateItem(
  id: string,
  patch: {
    state?: IntakeItemState;
    payload?: Record<string, unknown>;
    evidence?: Record<string, unknown> | null;
    waitingQuestionId?: string | null;
  },
): void {
  const db = getDb();
  const current = getItem(id);
  if (!current) return;
  db.prepare(
    `UPDATE intake_items SET state = ?, payload_json = ?, evidence_json = ?, waiting_question_id = ?, version = version + 1, updated_at = ? WHERE id = ?`,
  ).run(
    patch.state ?? current.state,
    JSON.stringify(patch.payload ?? current.payload),
    patch.evidence !== undefined ? (patch.evidence ? JSON.stringify(patch.evidence) : null) : current.evidence ? JSON.stringify(current.evidence) : null,
    patch.waitingQuestionId !== undefined ? patch.waitingQuestionId : current.waitingQuestionId,
    now(),
    id,
  );
}

export function setIntakeStatus(id: string, status: IntakeStatus, lastError?: string | null): void {
  getDb()
    .prepare(`UPDATE intakes SET status = ?, last_error = ?, version = version + 1, updated_at = ? WHERE id = ?`)
    .run(status, lastError === undefined ? null : lastError, now(), id);
}

/** 由事项状态推导整份 intake 的状态（§4.1：partially_applied = 有独立完成、有待答/失败） */
export function deriveIntakeStatus(items: IntakeItemRow[]): IntakeStatus {
  if (!items.length) return "processing";
  if (items.some((i) => i.state === "awaiting_input")) return "waiting_input";
  if (items.some((i) => i.state === "extracted" || i.state === "resolving")) return "processing";
  const done = items.filter((i) => i.state === "ready" || i.state === "applied" || i.state === "ignored").length;
  const failed = items.filter((i) => i.state === "failed").length;
  if (failed && done) return "partially_applied";
  if (failed) return "failed";
  return "completed";
}
