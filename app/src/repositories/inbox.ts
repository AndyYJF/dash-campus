import crypto from "node:crypto";
import { getDb } from "@/repositories/db";
import type { NoticeStructured, Partition, Tri } from "@/contracts/inbox";

/**
 * 收件箱 repository（计划 v1.2 第 4.2、5.1 节）。
 * (source, external_id) 唯一逻辑消息；(message_id, revision_key) 唯一版本，原文不可变。
 */

export type InboxSourceRow = {
  id: string;
  title: string;
  createdAt: string;
  enabled: boolean;
  version: number;
};

export type InboxRevisionRow = {
  id: string;
  messageId: string;
  revisionKey: string;
  revisionOrder: number | null;
  occurredAt: string;
  text: string;
  sourceUrl: string | null;
  structured: NoticeStructured | null;
  createdAt: string;
  legacyTitle: string | null;
  legacyStatus: "open" | "completed" | "cancelled" | null;
};

export type InboxDecisionRow = {
  id: string;
  messageId: string;
  revisionId: string;
  applicability: Tri | null;
  basePartition: Partition;
  matchedRuleId: string | null;
  matchedRuleVersion: number | null;
  manualPartition: Partition | null;
  partition: Partition;
  version: number;
  createdAt: string;
  updatedAt: string;
};

export type InboxMessageRow = {
  id: string;
  sourceId: string;
  externalId: string;
  currentRevisionId: string | null;
  status: "active" | "revision_conflict";
  createdAt: string;
  updatedAt: string;
};

function now(): string {
  return new Date().toISOString();
}

// ===== sources =====

export function listSources(): InboxSourceRow[] {
  const db = getDb();
  return (
    db.prepare(`SELECT id, title, created_at,enabled,version FROM inbox_sources ORDER BY created_at`).all() as Array<
      Record<string, unknown>
    >
  ).map((r) => ({
    id: r.id as string,
    title: r.title as string,
    createdAt: r.created_at as string,
    enabled: r.enabled === 1, version: r.version as number,
  }));
}

export function getSource(id: string): InboxSourceRow | null {
  const db = getDb();
  const r = db
    .prepare(`SELECT id, title, created_at,enabled,version FROM inbox_sources WHERE id = ?`)
    .get(id) as Record<string, unknown> | undefined;
  return r ? { id: r.id as string, title: r.title as string, createdAt: r.created_at as string, enabled: r.enabled === 1, version: r.version as number } : null;
}

export function sourceTokenMatches(id: string, token: string): boolean {
  const db = getDb();
  const digest = crypto.createHash("sha256").update(token).digest("hex");
  const r = db
    .prepare(`SELECT 1 FROM inbox_sources WHERE id = ? AND enabled = 1 AND token_digest = ?`)
    .get(id, digest);
  return Boolean(r);
}

/** 创建来源；返回 token 明文（仅此一次） */
export function createSource(id: string, title: string): { source: InboxSourceRow; token: string } {
  const db = getDb();
  const token = crypto.randomBytes(24).toString("hex");
  const digest = crypto.createHash("sha256").update(token).digest("hex");
  const t = now();
  db.prepare(
    `INSERT INTO inbox_sources (id, title, token_digest, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
  ).run(id, title, digest, t, t);
  return { source: getSource(id)!, token };
}

export function deleteSource(id: string): boolean {
  const db = getDb();
  const r = db.prepare(`DELETE FROM inbox_sources WHERE id = ?`).run(id);
  return r.changes === 1;
}

// ===== messages =====

export function getMessage(id: string): InboxMessageRow | null {
  const db = getDb();
  const row = db.prepare(`SELECT * FROM inbox_messages WHERE id = ?`).get(id) as
    | Record<string, unknown>
    | undefined;
  return row ? mapMessage(row) : null;
}

export function getMessageByExternalId(sourceId: string, externalId: string): InboxMessageRow | null {
  const db = getDb();
  const row = db
    .prepare(`SELECT * FROM inbox_messages WHERE source_id = ? AND external_id = ?`)
    .get(sourceId, externalId) as Record<string, unknown> | undefined;
  return row ? mapMessage(row) : null;
}

export function listMessages(filter: { status?: string } = {}): InboxMessageRow[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT * FROM inbox_messages ${filter.status ? "WHERE status = ?" : ""} ORDER BY updated_at DESC,id DESC`,
    )
    .all(...(filter.status ? [filter.status] : [])) as Array<Record<string, unknown>>;
  return rows.map(mapMessage);
}

/** Public lists are bounded; internal identity reevaluation must cover every current revision. */
export function listMessagePage(filter: { status?: string; partition?: string; cursor?: { updatedAt: string; id: string }; limit?: number } = {}) {
  const db = getDb(), limit = Math.min(200, Math.max(1, filter.limit ?? 100));
  const conditions: string[] = [], values: string[] = [];
  if (filter.status) { conditions.push("m.status=?"); values.push(filter.status); }
  if (filter.partition) { conditions.push("d.partition=?"); values.push(filter.partition); }
  const join = "FROM inbox_messages m LEFT JOIN inbox_decisions d ON d.revision_id=m.current_revision_id";
  const where = () => conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  return db.transaction(() => {
    const total = (db.prepare(`SELECT COUNT(*) AS n ${join} ${where()}`).get(...values) as { n: number }).n;
    if (filter.cursor) { conditions.push("(m.updated_at<? OR (m.updated_at=? AND m.id<?))"); values.push(filter.cursor.updatedAt, filter.cursor.updatedAt, filter.cursor.id); }
    const rows = db.prepare(`SELECT m.* ${join} ${where()} ORDER BY m.updated_at DESC,m.id DESC LIMIT ?`).all(...values, limit + 1) as Array<Record<string, unknown>>;
    const messages = rows.slice(0, limit).map(mapMessage), last = messages.at(-1);
    return { messages, total, next: rows.length > limit && last ? { updatedAt: last.updatedAt, id: last.id } : null };
  })();
}

function mapMessage(r: Record<string, unknown>): InboxMessageRow {
  return {
    id: r.id as string,
    sourceId: r.source_id as string,
    externalId: r.external_id as string,
    currentRevisionId: (r.current_revision_id as string | null) ?? null,
    status: r.status as "active" | "revision_conflict",
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
  };
}

export function createMessage(sourceId: string, externalId: string, currentRevisionId: string): InboxMessageRow {
  const db = getDb();
  const id = crypto.randomUUID();
  const t = now();
  db.prepare(
    `INSERT INTO inbox_messages (id, source_id, external_id, current_revision_id, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'active', ?, ?)`,
  ).run(id, sourceId, externalId, currentRevisionId, t, t);
  return getMessage(id)!;
}

export function setMessageCurrent(messageId: string, revisionId: string, status?: "active" | "revision_conflict"): void {
  const db = getDb();
  db.prepare(
    `UPDATE inbox_messages SET current_revision_id = ?, ${status ? "status = ?," : ""} updated_at = ? WHERE id = ?`,
  ).run(...(status ? [revisionId, status, now(), messageId] : [revisionId, now(), messageId]));
}

export function setMessageStatus(messageId: string, status: "active" | "revision_conflict"): void {
  const db = getDb();
  db.prepare(`UPDATE inbox_messages SET status = ?, updated_at = ? WHERE id = ?`).run(status, now(), messageId);
}

// ===== revisions =====

export function getRevision(id: string): InboxRevisionRow | null {
  const db = getDb();
  const row = db.prepare(`SELECT * FROM inbox_revisions WHERE id = ?`).get(id) as
    | Record<string, unknown>
    | undefined;
  return row ? mapRevision(row) : null;
}

export function getRevisionByKey(messageId: string, revisionKey: string): InboxRevisionRow | null {
  const db = getDb();
  const row = db
    .prepare(`SELECT * FROM inbox_revisions WHERE message_id = ? AND revision_key = ?`)
    .get(messageId, revisionKey) as Record<string, unknown> | undefined;
  return row ? mapRevision(row) : null;
}

export function listRevisions(messageId: string): InboxRevisionRow[] {
  const db = getDb();
  const rows = db
    .prepare(`SELECT * FROM inbox_revisions WHERE message_id = ? ORDER BY created_at`)
    .all(messageId) as Array<Record<string, unknown>>;
  return rows.map(mapRevision);
}

export function createRevision(input: {
  messageId: string;
  revisionKey: string;
  revisionOrder: number | null;
  occurredAt: string;
  text: string;
  sourceUrl: string | null;
  structured: NoticeStructured | null;
}): InboxRevisionRow {
  const db = getDb();
  const id = crypto.randomUUID();
  db.prepare(
    `INSERT INTO inbox_revisions (id, message_id, revision_key, revision_order, occurred_at, text, source_url, structured_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.messageId,
    input.revisionKey,
    input.revisionOrder,
    input.occurredAt,
    input.text,
    input.sourceUrl,
    input.structured ? JSON.stringify(input.structured) : null,
    now(),
  );
  return getRevision(id)!;
}

function mapRevision(r: Record<string, unknown>): InboxRevisionRow {
  const text = r.text as string;
  const bridged = r.extraction_text !== null && r.extraction_text !== undefined && text.startsWith("【旧校园插件桥接】");
  const upstream = bridged ? /^上游状态：(open|completed|cancelled)$/m.exec(text)?.[1] : null;
  return {
    id: r.id as string,
    messageId: r.message_id as string,
    revisionKey: r.revision_key as string,
    revisionOrder: (r.revision_order as number | null) ?? null,
    occurredAt: r.occurred_at as string,
    text: r.text as string,
    sourceUrl: (r.source_url as string | null) ?? null,
    structured: r.structured_json
      ? (JSON.parse(r.structured_json as string) as NoticeStructured)
      : null,
    createdAt: r.created_at as string,
    legacyTitle: bridged ? /^上游标题：(.*)$/m.exec(text)?.[1]?.slice(0, 200) ?? null : null,
    legacyStatus: upstream === "open" || upstream === "completed" || upstream === "cancelled" ? upstream : null,
  };
}

// ===== decisions =====

export function getDecisionByRevision(revisionId: string): InboxDecisionRow | null {
  const db = getDb();
  const row = db.prepare(`SELECT * FROM inbox_decisions WHERE revision_id = ?`).get(revisionId) as
    | Record<string, unknown>
    | undefined;
  return row ? mapDecision(row) : null;
}

export function listDecisions(filter: { partition?: string } = {}): InboxDecisionRow[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT * FROM inbox_decisions ${filter.partition ? "WHERE partition = ?" : ""} ORDER BY updated_at DESC,id DESC`,
    )
    .all(...(filter.partition ? [filter.partition] : [])) as Array<Record<string, unknown>>;
  return rows.map(mapDecision);
}

/** 写入/更新决策（同 revision 的决策 upsert）；返回决策行 */
export function upsertDecision(input: {
  messageId: string;
  revisionId: string;
  applicability: Tri | null;
  basePartition: Partition;
  matchedRuleId: string | null;
  matchedRuleVersion: number | null;
  manualPartition: Partition | null;
  partition: Partition;
}): InboxDecisionRow {
  const db = getDb();
  const existing = getDecisionByRevision(input.revisionId);
  if (existing) {
    db.prepare(
      `UPDATE inbox_decisions SET applicability = ?, base_partition = ?, matched_rule_id = ?, matched_rule_version = ?,
         manual_partition = ?, partition = ?, version = version + 1, updated_at = ?
       WHERE revision_id = ?`,
    ).run(
      input.applicability,
      input.basePartition,
      input.matchedRuleId,
      input.matchedRuleVersion,
      input.manualPartition,
      input.partition,
      now(),
      input.revisionId,
    );
    return getDecisionByRevision(input.revisionId)!;
  }
  const id = crypto.randomUUID();
  const t = now();
  db.prepare(
    `INSERT INTO inbox_decisions (id, message_id, revision_id, applicability, base_partition, matched_rule_id, matched_rule_version, manual_partition, partition, version, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
  ).run(
    id,
    input.messageId,
    input.revisionId,
    input.applicability,
    input.basePartition,
    input.matchedRuleId,
    input.matchedRuleVersion,
    input.manualPartition,
    input.partition,
    t,
    t,
  );
  return getDecisionByRevision(input.revisionId)!;
}

function mapDecision(r: Record<string, unknown>): InboxDecisionRow {
  return {
    id: r.id as string,
    messageId: r.message_id as string,
    revisionId: r.revision_id as string,
    applicability: (r.applicability as Tri | null) ?? null,
    basePartition: r.base_partition as Partition,
    matchedRuleId: (r.matched_rule_id as string | null) ?? null,
    matchedRuleVersion: (r.matched_rule_version as number | null) ?? null,
    manualPartition: (r.manual_partition as Partition | null) ?? null,
    partition: r.partition as Partition,
    version: r.version as number,
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
  };
}

// ===== task links =====

export type InboxTaskLinkRow = {
  id: string;
  messageId: string;
  actionKey: string;
  taskId: string;
  revisionId: string;
  createdAt: string;
};

export function getTaskLink(messageId: string, actionKey: string): InboxTaskLinkRow | null {
  const db = getDb();
  const row = db
    .prepare(`SELECT * FROM inbox_task_links WHERE message_id = ? AND action_key = ?`)
    .get(messageId, actionKey) as Record<string, unknown> | undefined;
  return row ? mapTaskLink(row) : null;
}

export function listTaskLinks(messageId: string): InboxTaskLinkRow[] {
  const db = getDb();
  const rows = db
    .prepare(`SELECT * FROM inbox_task_links WHERE message_id = ?`)
    .all(messageId) as Array<Record<string, unknown>>;
  return rows.map(mapTaskLink);
}

/** (message_id, action_key) 唯一：同一行动只建一次任务关联（F5 不复制任务） */
export function createTaskLink(input: {
  messageId: string;
  actionKey: string;
  taskId: string;
  revisionId: string;
}): InboxTaskLinkRow {
  const db = getDb();
  const id = crypto.randomUUID();
  db.prepare(
    `INSERT INTO inbox_task_links (id, message_id, action_key, task_id, revision_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, input.messageId, input.actionKey, input.taskId, input.revisionId, now());
  return getTaskLink(input.messageId, input.actionKey)!;
}

function mapTaskLink(r: Record<string, unknown>): InboxTaskLinkRow {
  return {
    id: r.id as string,
    messageId: r.message_id as string,
    actionKey: r.action_key as string,
    taskId: r.task_id as string,
    revisionId: r.revision_id as string,
    createdAt: r.created_at as string,
  };
}

