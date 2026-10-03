import crypto from "node:crypto";
import { getDb } from "@/repositories/db";
import { HttpError } from "@/workflows/http";

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
  version: number;
  archivedAt: string | null;
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
  return getDb().transaction((): ReturnType<typeof createLog> => {
  const db = getDb();
  const existing = db
    .prepare(`SELECT * FROM daily_logs WHERE client_entry_id = ?`)
    .get(input.clientEntryId) as Record<string, unknown> | undefined;
  if (existing) {
    const original = db.prepare("SELECT snapshot_json FROM daily_log_revisions WHERE log_id=? AND version=1").get(existing.id) as { snapshot_json: string };
    const first = JSON.parse(original.snapshot_json);
    const sameContent = first.occurredOn === input.occurredOn && first.progress === input.progress && first.blocker === input.blocker && first.taskId === input.taskId && first.projectId === input.projectId;
    if (!sameContent) return "content_conflict";
    return { log: mapLog(existing), replayed: true };
  }
  const id = crypto.randomUUID();
  const t = now();
  db.prepare(
    `INSERT INTO daily_logs (id, client_entry_id, occurred_on, progress, blocker, task_id, project_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, input.clientEntryId, input.occurredOn, input.progress, input.blocker, input.taskId, input.projectId, t, t);
  saveLogRevision(id);
  return { log: mapLog(getRawLog(id)!), replayed: false };
  }).immediate();
}

function getRawLog(id: string): Record<string, unknown> | undefined {
  const db = getDb();
  return db.prepare(`SELECT * FROM daily_logs WHERE id = ?`).get(id) as
    | Record<string, unknown>
    | undefined;
}

export function listLogs(filter: { projectId?: string; taskId?: string; limit?: number } = {}): DailyLogRow[] {
  const db = getDb();
  const where: string[] = ["archived_at IS NULL"];
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
    .prepare(`SELECT * FROM daily_logs WHERE archived_at IS NULL ORDER BY occurred_on DESC, created_at DESC LIMIT ?`)
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
    version: r.version as number,
    archivedAt: (r.archived_at as string | null) ?? null,
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
  return getDb().transaction((): ReturnType<typeof createArtifact> => {
  const db = getDb();
  const id = crypto.randomUUID();
  const t = now();
  db.prepare(
    `INSERT INTO artifacts (id, project_id, log_id, kind, title, body, url, version, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
  ).run(id, input.projectId, input.logId, input.kind, input.title, input.body, input.url, t, t);
  saveArtifactRevision(id);
  return mapArtifact(getRawArtifact(id)!);
  }).immediate();
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
  return getDb().transaction((): ReturnType<typeof archiveArtifact> => {
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
  saveArtifactRevision(id);
  return mapArtifact(getRawArtifact(id)!);
  }).immediate();
}

export function getLog(id: string): DailyLogRow | null { const r = getRawLog(id); return r ? mapLog(r) : null; }
export function getArtifact(id: string): ArtifactRow | null { const r = getRawArtifact(id); return r ? mapArtifact(r) : null; }
export function recordRevisions(kind: "log" | "artifact", id: string) {
  const table = kind === "log" ? "daily_log_revisions" : "artifact_revisions", col = kind === "log" ? "log_id" : "artifact_id";
  return (getDb().prepare(`SELECT version,snapshot_json,created_at FROM ${table} WHERE ${col}=? ORDER BY version DESC`).all(id) as Array<{version: number; snapshot_json: string; created_at: string}>).map((r) => ({ version: r.version, snapshot: JSON.parse(r.snapshot_json), createdAt: r.created_at }));
}
function saveLogRevision(id: string) {
  const log = getLog(id)!;
  getDb().prepare("INSERT INTO daily_log_revisions(log_id,version,snapshot_json,created_at) VALUES(?,?,?,?)").run(id, log.version,
    JSON.stringify({ occurredOn: log.occurredOn, progress: log.progress, blocker: log.blocker, taskId: log.taskId, projectId: log.projectId, archivedAt: log.archivedAt }), log.updatedAt);
}
function saveArtifactRevision(id: string) {
  const a = getArtifact(id)!;
  getDb().prepare("INSERT INTO artifact_revisions(artifact_id,version,snapshot_json,created_at) VALUES(?,?,?,?)").run(id, a.version,
    JSON.stringify({ projectId: a.projectId, logId: a.logId, kind: a.kind, title: a.title, body: a.body, url: a.url, archivedAt: a.archivedAt }), a.updatedAt);
}

export function updateLog(id: string, patch: Partial<Pick<DailyLogRow,"occurredOn"|"progress"|"blocker"|"taskId"|"projectId">>, expectedVersion: number, archive = false): DailyLogRow | "not_found" | "conflict" {
  return getDb().transaction(() => {
    const current = getLog(id); if (!current || current.archivedAt) return "not_found" as const;
    if (current.version !== expectedVersion) return "conflict" as const;
    const next = { ...current, ...patch };
    if (!next.progress.trim() && !next.blocker.trim()) throw new HttpError(422,"VALIDATION","进展与卡点至少一项非空");
    if (!archive && Object.keys(patch).every((key) => current[key as keyof DailyLogRow] === next[key as keyof DailyLogRow])) return current;
    const at = now();
    getDb().prepare("UPDATE daily_logs SET occurred_on=?,progress=?,blocker=?,task_id=?,project_id=?,version=version+1,updated_at=?,archived_at=? WHERE id=? AND version=?").run(next.occurredOn,next.progress,next.blocker,next.taskId,next.projectId,at,archive?at:null,id,expectedVersion);
    saveLogRevision(id); return getLog(id)!;
  }).immediate();
}

export function updateArtifact(id: string, patch: Partial<Pick<ArtifactRow,"projectId"|"logId"|"kind"|"title"|"body"|"url">>, expectedVersion: number): ArtifactRow | "not_found" | "conflict" {
  return getDb().transaction(() => {
    const current = getArtifact(id); if (!current || current.archivedAt) return "not_found" as const;
    if (current.version !== expectedVersion) return "conflict" as const;
    const next = { ...current, ...patch };
    if (next.kind === "link" && !next.url) throw new HttpError(422,"VALIDATION","链接成果需要URL");
    if (next.url && !/^https?:\/\//.test(next.url)) throw new HttpError(422,"VALIDATION","URL只允许http/https");
    if (Object.keys(patch).every((key) => current[key as keyof ArtifactRow] === next[key as keyof ArtifactRow])) return current;
    getDb().prepare("UPDATE artifacts SET project_id=?,log_id=?,kind=?,title=?,body=?,url=?,version=version+1,updated_at=? WHERE id=? AND version=?").run(next.projectId,next.logId,next.kind,next.title,next.body,next.url,now(),id,expectedVersion);
    saveArtifactRevision(id); return getArtifact(id)!;
  }).immediate();
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
