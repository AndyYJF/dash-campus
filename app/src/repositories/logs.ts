import crypto from "node:crypto";
import { getDb } from "@/repositories/db";

/**
 * 日志与成果 repository（计划 v1.2 第 4.1、9 节）。
 * 日志用 client_entry_id 幂等：同 ID 同正文返回既有记录；同 ID 异正文 409。
 * 成果 URL 限 http/https，不执行内容。
 */

export type DailyLogRow = {
  id: string;
  clientEntryId: string;
  occurredOn: string;
  progress: string;
  blocker: string;
  taskId: string | null;
  projectId: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ArtifactRow = {
  id: string;
  projectId: string;
  logId: string | null;
  kind: "text" | "link";
  title: string;
  body: string;
  url: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
};

function now(): string {
  return new Date().toISOString();
}

export function createLog(input: {
  clientEntryId: string;
  occurredOn: string;
  progress: string;
  blocker: string;
  taskId: string | null;
  projectId: string | null;
}): { log: DailyLogRow; replayed: boolean } | "content_conflict" {
  const db = getDb();
  const existing = db
    .prepare(`SELECT * FROM daily_logs WHERE client_entry_id = ?`)
    .get(input.clientEntryId) as Record<string, unknown> | undefined;
  if (existing) {
    const sameContent =
      (existing.occurred_on as string) === input.occurredOn &&
      (existing.progress as string) === input.progress &&
      (existing.blocker as string) === input.blocker &&
      ((existing.task_id as string | null) ?? null) === input.taskId &&
      ((existing.project_id as string | null) ?? null) === input.projectId;
    if (!sameContent) return "content_conflict";
    return { log: mapLog(existing), replayed: true };
  }
  const id = crypto.randomUUID();
  const t = now();
  db.prepare(
    `INSERT INTO daily_logs (id, client_entry_id, occurred_on, progress, blocker, task_id, project_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, input.clientEntryId, input.occurredOn, input.progress, input.blocker, input.taskId, input.projectId, t, t);
  return { log: mapLog(getRawLog(id)!), replayed: false };
}

function getRawLog(id: string): Record<string, unknown> | undefined {
  const db = getDb();
  return db.prepare(`SELECT * FROM daily_logs WHERE id = ?`).get(id) as
    | Record<string, unknown>
    | undefined;
}

export function listLogs(filter: { projectId?: string; taskId?: string; limit?: number } = {}): DailyLogRow[] {
  const db = getDb();
  const where: string[] = [];
  const vals: string[] = [];
  if (filter.projectId) {
    where.push("project_id = ?");
    vals.push(filter.projectId);
  }
  if (filter.taskId) {
    where.push("task_id = ?");
    vals.push(filter.taskId);
  }
  const sql = `SELECT * FROM daily_logs ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY occurred_on DESC, created_at DESC${filter.limit ? ` LIMIT ${filter.limit}` : ""}`;
  const rows = db.prepare(sql).all(...vals) as Array<Record<string, unknown>>;
  return rows.map(mapLog);
}

export function listRecentLogs(limit: number): DailyLogRow[] {
  const db = getDb();
  const rows = db
    .prepare(`SELECT * FROM daily_logs ORDER BY occurred_on DESC, created_at DESC LIMIT ?`)
    .all(limit) as Array<Record<string, unknown>>;
  return rows.map(mapLog);
}

function mapLog(r: Record<string, unknown>): DailyLogRow {
  return {
    id: r.id as string,
    clientEntryId: r.client_entry_id as string,
    occurredOn: r.occurred_on as string,
    progress: r.progress as string,
    blocker: r.blocker as string,
    taskId: (r.task_id as string | null) ?? null,
    projectId: (r.project_id as string | null) ?? null,
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
  };
}

// ===== artifacts =====

export function createArtifact(input: {
  projectId: string;
  logId: string | null;
  kind: "text" | "link";
  title: string;
  body: string;
  url: string | null;
}): ArtifactRow | "invalid_url" {
  if (input.url !== null && !/^https?:\/\//.test(input.url)) return "invalid_url";
  const db = getDb();
  const id = crypto.randomUUID();
  const t = now();
  db.prepare(
    `INSERT INTO artifacts (id, project_id, log_id, kind, title, body, url, version, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
  ).run(id, input.projectId, input.logId, input.kind, input.title, input.body, input.url, t, t);
  return mapArtifact(getRawArtifact(id)!);
}

function getRawArtifact(id: string): Record<string, unknown> | undefined {
  const db = getDb();
  return db.prepare(`SELECT * FROM artifacts WHERE id = ?`).get(id) as
    | Record<string, unknown>
    | undefined;
}

export function listArtifacts(projectId: string): ArtifactRow[] {
  const db = getDb();
  const rows = db
    .prepare(`SELECT * FROM artifacts WHERE project_id = ? AND archived_at IS NULL ORDER BY created_at DESC`)
    .all(projectId) as Array<Record<string, unknown>>;
  return rows.map(mapArtifact);
}

export function archiveArtifact(id: string, expectedVersion: number): ArtifactRow | "conflict" | "not_found" {
  const db = getDb();
  const r = db
    .prepare(
      `UPDATE artifacts SET archived_at = ?, version = version + 1, updated_at = ?
       WHERE id = ? AND version = ? AND archived_at IS NULL`,
    )
    .run(now(), now(), id, expectedVersion);
  if (r.changes === 0) {
    return getRawArtifact(id) ? "conflict" : "not_found";
  }
  return mapArtifact(getRawArtifact(id)!);
}

function mapArtifact(r: Record<string, unknown>): ArtifactRow {
  return {
    id: r.id as string,
    projectId: r.project_id as string,
    logId: (r.log_id as string | null) ?? null,
    kind: r.kind as ArtifactRow["kind"],
    title: r.title as string,
    body: r.body as string,
    url: (r.url as string | null) ?? null,
    version: r.version as number,
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
    archivedAt: (r.archived_at as string | null) ?? null,
  };
}
