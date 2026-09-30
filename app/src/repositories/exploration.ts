import crypto from "node:crypto";
import { getDb } from "@/repositories/db";
import type { EvidenceStatus, RunStatus } from "@/contracts/exploration";

/**
 * 探索 repository（计划 v1.2 第 4.2、7 节）：topics / runs / search_hits / evidence / candidates / templates。
 * 证据只插入不更新（原文版本不可变）。
 */

function now(): string {
  return new Date().toISOString();
}

const j = (v: unknown) => JSON.stringify(v);
const pj = <T>(v: unknown, fallback: T): T => (typeof v === "string" ? (JSON.parse(v) as T) : fallback);

// ===== topics =====

export type TopicRow = {
  id: string;
  title: string;
  purpose: string;
  sourcePreference: string;
  enabled: boolean;
  weekday: number;
  localTime: string;
  timezone: string;
  nextRunAt: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
};

function mapTopic(r: Record<string, unknown>): TopicRow {
  return {
    id: r.id as string,
    title: r.title as string,
    purpose: r.purpose as string,
    sourcePreference: r.source_preference as string,
    enabled: r.enabled === 1,
    weekday: r.weekday as number,
    localTime: r.local_time as string,
    timezone: r.timezone as string,
    nextRunAt: (r.next_run_at as string | null) ?? null,
    version: r.version as number,
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
    archivedAt: (r.archived_at as string | null) ?? null,
  };
}

export function listTopics(): TopicRow[] {
  return (
    getDb().prepare(`SELECT * FROM exploration_topics WHERE archived_at IS NULL ORDER BY created_at DESC`).all() as Array<
      Record<string, unknown>
    >
  ).map(mapTopic);
}

export function getTopic(id: string): TopicRow | null {
  const row = getDb().prepare(`SELECT * FROM exploration_topics WHERE id = ?`).get(id) as
    | Record<string, unknown>
    | undefined;
  return row ? mapTopic(row) : null;
}

export function insertTopic(input: {
  title: string;
  purpose: string;
  sourcePreference: string;
  enabled: boolean;
  weekday: number;
  localTime: string;
  timezone: string;
  nextRunAt: string | null;
}): TopicRow {
  const id = crypto.randomUUID();
  const t = now();
  getDb()
    .prepare(
      `INSERT INTO exploration_topics (id, title, purpose, source_preference, enabled, weekday, local_time, timezone,
         next_run_at, version, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
    )
    .run(
      id,
      input.title,
      input.purpose,
      input.sourcePreference,
      input.enabled ? 1 : 0,
      input.weekday,
      input.localTime,
      input.timezone,
      input.nextRunAt,
      t,
      t,
    );
  return getTopic(id)!;
}

/** 条件更新：version 匹配才写，version+1；返回 null 表示冲突 */
export function updateTopicRow(
  id: string,
  expectedVersion: number,
  fields: Partial<{
    title: string;
    purpose: string;
    sourcePreference: string;
    enabled: boolean;
    weekday: number;
    localTime: string;
    nextRunAt: string | null;
    archivedAt: string;
  }>,
): TopicRow | null {
  const map: Record<string, string> = {
    title: "title",
    purpose: "purpose",
    sourcePreference: "source_preference",
    enabled: "enabled",
    weekday: "weekday",
    localTime: "local_time",
    nextRunAt: "next_run_at",
    archivedAt: "archived_at",
  };
  const sets: string[] = [];
  const vals: Array<string | number | null> = [];
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined) continue;
    sets.push(`${map[k]} = ?`);
    vals.push(typeof v === "boolean" ? (v ? 1 : 0) : (v as string | number | null));
  }
  sets.push("version = version + 1", "updated_at = ?");
  vals.push(now(), id, expectedVersion);
  const r = getDb()
    .prepare(`UPDATE exploration_topics SET ${sets.join(", ")} WHERE id = ? AND version = ? AND archived_at IS NULL`)
    .run(...vals);
  return r.changes === 1 ? getTopic(id) : null;
}

export function listDueTopics(nowIso: string): TopicRow[] {
  return (
    getDb()
      .prepare(
        `SELECT * FROM exploration_topics
         WHERE enabled = 1 AND archived_at IS NULL AND next_run_at IS NOT NULL AND next_run_at <= ?`,
      )
      .all(nowIso) as Array<Record<string, unknown>>
  ).map(mapTopic);
}

/** 调度推进 next_run_at：条件为 next_run_at 仍是读到的值，防止重复入队 */
export function advanceTopicNextRun(id: string, expectedNextRunAt: string, nextRunAt: string): boolean {
  const r = getDb()
    .prepare(`UPDATE exploration_topics SET next_run_at = ?, updated_at = ? WHERE id = ? AND next_run_at = ?`)
    .run(nextRunAt, now(), id, expectedNextRunAt);
  return r.changes === 1;
}

// ===== runs =====

export type Diagnostic = { at: string; stage: string; message: string };

export type RunRow = {
  id: string;
  kind: "on_demand" | "scheduled";
  topicId: string | null;
  topicVersion: number | null;
  projectId: string | null;
  query: string;
  status: RunStatus;
  integrationMode: "real" | "fixture" | "materials_only";
  jobId: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  budget: Record<string, number>;
  diagnostics: Diagnostic[];
  background: string;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

function mapRun(r: Record<string, unknown>): RunRow {
  const materials = pj<{ background?: string }>(r.materials_json, {});
  return {
    id: r.id as string,
    kind: r.kind as RunRow["kind"],
    topicId: (r.topic_id as string | null) ?? null,
    topicVersion: (r.topic_version as number | null) ?? null,
    projectId: (r.project_id as string | null) ?? null,
    query: r.query as string,
    status: r.status as RunStatus,
    integrationMode: r.integration_mode as RunRow["integrationMode"],
    jobId: (r.job_id as string | null) ?? null,
    errorCode: (r.error_code as string | null) ?? null,
    errorMessage: (r.error_message as string | null) ?? null,
    budget: pj(r.budget_json, {}),
    diagnostics: pj(r.diagnostics_json, []),
    background: Array.isArray(materials) ? "" : (materials.background ?? ""),
    startedAt: (r.started_at as string | null) ?? null,
    finishedAt: (r.finished_at as string | null) ?? null,
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
  };
}

export function insertRun(input: {
  kind: RunRow["kind"];
  topicId: string | null;
  topicVersion: number | null;
  projectId: string | null;
  query: string;
  integrationMode: RunRow["integrationMode"];
  background: string;
}): RunRow {
  const id = crypto.randomUUID();
  const t = now();
  getDb()
    .prepare(
      `INSERT INTO exploration_runs (id, kind, topic_id, topic_version, project_id, query, status, integration_mode,
         materials_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?)`,
    )
    .run(
      id,
      input.kind,
      input.topicId,
      input.topicVersion,
      input.projectId,
      input.query,
      input.integrationMode,
      j({ background: input.background }),
      t,
      t,
    );
  return getRun(id)!;
}

export function setRunJob(runId: string, jobId: string): void {
  getDb().prepare(`UPDATE exploration_runs SET job_id = ? WHERE id = ?`).run(jobId, runId);
}

export function getRun(id: string): RunRow | null {
  const row = getDb().prepare(`SELECT * FROM exploration_runs WHERE id = ?`).get(id) as
    | Record<string, unknown>
    | undefined;
  return row ? mapRun(row) : null;
}

export function listRuns(limit = 20): RunRow[] {
  return (
    getDb().prepare(`SELECT * FROM exploration_runs ORDER BY created_at DESC LIMIT ?`).all(limit) as Array<
      Record<string, unknown>
    >
  ).map(mapRun);
}

const TERMINAL = ["done", "failed", "cancelled"];

/** 推进阶段：只对未终结 run 生效 */
export function setRunStage(id: string, status: RunStatus, extra: { startedAt?: string } = {}): boolean {
  const r = getDb()
    .prepare(
      `UPDATE exploration_runs SET status = ?, started_at = COALESCE(started_at, ?), updated_at = ?
       WHERE id = ? AND status NOT IN (${TERMINAL.map(() => "?").join(",")})`,
    )
    .run(status, extra.startedAt ?? null, now(), id, ...TERMINAL);
  return r.changes === 1;
}

export function finishRun(
  id: string,
  status: "done" | "failed" | "cancelled",
  args: { errorCode?: string | null; errorMessage?: string | null; budget?: Record<string, number>; diagnostics?: Diagnostic[] } = {},
): boolean {
  const t = now();
  const r = getDb()
    .prepare(
      `UPDATE exploration_runs SET status = ?, error_code = ?, error_message = ?,
         budget_json = COALESCE(?, budget_json), diagnostics_json = COALESCE(?, diagnostics_json),
         finished_at = ?, updated_at = ?
       WHERE id = ? AND status NOT IN (${TERMINAL.map(() => "?").join(",")})`,
    )
    .run(
      status,
      args.errorCode ?? null,
      args.errorMessage ?? null,
      args.budget ? j(args.budget) : null,
      args.diagnostics ? j(args.diagnostics) : null,
      t,
      t,
      id,
      ...TERMINAL,
    );
  return r.changes === 1;
}

/** 已终结 run 追加诊断（取消后可保留运行诊断，F16） */
export function saveRunDiagnostics(id: string, budget: Record<string, number>, diagnostics: Diagnostic[]): void {
  getDb()
    .prepare(`UPDATE exploration_runs SET budget_json = ?, diagnostics_json = ?, updated_at = ? WHERE id = ?`)
    .run(j(budget), j(diagnostics), now(), id);
}

export function listQueuedRunsForTopic(topicId: string): RunRow[] {
  return (
    getDb()
      .prepare(`SELECT * FROM exploration_runs WHERE topic_id = ? AND status NOT IN ('done','failed','cancelled')`)
      .all(topicId) as Array<Record<string, unknown>>
  ).map(mapRun);
}

// ===== hits & evidence =====

export type EvidenceRow = {
  id: string;
  runId: string;
  hitId: string | null;
  url: string | null;
  canonicalUrl: string | null;
  title: string;
  text: string;
  status: EvidenceStatus;
  contentHash: string;
  publishedAt: string | null;
  retrievedAt: string;
};

export function insertHit(runId: string, h: { id: string; query: string; title: string; url: string; snippet: string | null; publishedAt: string | null }): void {
  getDb()
    .prepare(
      `INSERT INTO search_hits (id, run_id, query, title, url, snippet, published_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(h.id, runId, h.query, h.title, h.url, h.snippet, h.publishedAt, now());
}

export function listHits(runId: string): Array<{ id: string; query: string; title: string; url: string; snippet: string | null }> {
  return getDb()
    .prepare(`SELECT id, query, title, url, snippet FROM search_hits WHERE run_id = ? ORDER BY created_at`)
    .all(runId) as Array<{ id: string; query: string; title: string; url: string; snippet: string | null }>;
}

export function insertEvidence(e: Omit<EvidenceRow, "id"> & { id?: string }): EvidenceRow {
  const id = e.id ?? crypto.randomUUID();
  getDb()
    .prepare(
      `INSERT INTO evidence_documents (id, run_id, hit_id, url, canonical_url, title, text, status, content_hash, published_at, retrieved_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, e.runId, e.hitId, e.url, e.canonicalUrl, e.title, e.text, e.status, e.contentHash, e.publishedAt, e.retrievedAt);
  return { ...e, id };
}

function mapEvidence(r: Record<string, unknown>): EvidenceRow {
  return {
    id: r.id as string,
    runId: r.run_id as string,
    hitId: (r.hit_id as string | null) ?? null,
    url: (r.url as string | null) ?? null,
    canonicalUrl: (r.canonical_url as string | null) ?? null,
    title: r.title as string,
    text: r.text as string,
    status: r.status as EvidenceStatus,
    contentHash: r.content_hash as string,
    publishedAt: (r.published_at as string | null) ?? null,
    retrievedAt: r.retrieved_at as string,
  };
}

export function listEvidence(runId: string): EvidenceRow[] {
  return (
    getDb().prepare(`SELECT * FROM evidence_documents WHERE run_id = ? ORDER BY retrieved_at`).all(runId) as Array<
      Record<string, unknown>
    >
  ).map(mapEvidence);
}

export function getEvidenceByIds(ids: string[]): EvidenceRow[] {
  if (ids.length === 0) return [];
  return (
    getDb()
      .prepare(`SELECT * FROM evidence_documents WHERE id IN (${ids.map(() => "?").join(",")})`)
      .all(...ids) as Array<Record<string, unknown>>
  ).map(mapEvidence);
}

// ===== candidates =====

export type RequirementRow = {
  label: string;
  status: "met" | "unmet" | "unknown";
  basis: string;
  /** met 只能来自主人确认 */
  confirmedByOwner: boolean;
};

export type CandidateTask = { title: string; input: string; output: string; estimateMinutes: number | null };

export type CandidateRow = {
  id: string;
  runId: string;
  topicId: string | null;
  title: string;
  question: string;
  activities: string[];
  deliverable: string;
  firstTask: CandidateTask;
  initialTasks: CandidateTask[];
  estimatedMinutesRange: { min: number; max: number } | null;
  requirements: RequirementRow[];
  unknowns: string[];
  fitReason: string;
  sourceRefs: Array<{ evidenceId: string; quote: string }>;
  evidenceStatus: EvidenceStatus;
  canonicalUrl: string | null;
  evidenceHash: string;
  supersedesId: string | null;
  status: "proposed" | "idea" | "started" | "dismissed";
  feedback: string | null;
  projectId: string | null;
  startedWithUnknowns: boolean;
  version: number;
  createdAt: string;
  updatedAt: string;
};

function mapCandidate(r: Record<string, unknown>): CandidateRow {
  const min = r.estimated_minutes_min as number | null;
  const max = r.estimated_minutes_max as number | null;
  return {
    id: r.id as string,
    runId: r.run_id as string,
    topicId: (r.topic_id as string | null) ?? null,
    title: r.title as string,
    question: r.question as string,
    activities: pj(r.activities_json, []),
    deliverable: r.deliverable as string,
    firstTask: pj(r.first_task_json, { title: "", input: "", output: "", estimateMinutes: null }),
    initialTasks: pj(r.initial_tasks_json, []),
    estimatedMinutesRange: min !== null && max !== null ? { min, max } : null,
    requirements: pj(r.requirements_json, []),
    unknowns: pj(r.unknowns_json, []),
    fitReason: r.fit_reason as string,
    sourceRefs: pj(r.source_refs_json, []),
    evidenceStatus: r.evidence_status as EvidenceStatus,
    canonicalUrl: (r.canonical_url as string | null) ?? null,
    evidenceHash: r.evidence_hash as string,
    supersedesId: (r.supersedes_id as string | null) ?? null,
    status: r.status as CandidateRow["status"],
    feedback: (r.feedback as string | null) ?? null,
    projectId: (r.project_id as string | null) ?? null,
    startedWithUnknowns: r.started_with_unknowns === 1,
    version: r.version as number,
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
  };
}

export function insertCandidate(
  c: Omit<CandidateRow, "id" | "status" | "feedback" | "projectId" | "startedWithUnknowns" | "version" | "createdAt" | "updatedAt">,
): CandidateRow {
  const id = crypto.randomUUID();
  const t = now();
  getDb()
    .prepare(
      `INSERT INTO candidates (id, run_id, topic_id, title, question, activities_json, deliverable, first_task_json,
         initial_tasks_json, estimated_minutes_min, estimated_minutes_max, requirements_json, unknowns_json, fit_reason,
         source_refs_json, evidence_status, canonical_url, evidence_hash, supersedes_id, status, version, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'proposed', 1, ?, ?)`,
    )
    .run(
      id,
      c.runId,
      c.topicId,
      c.title,
      c.question,
      j(c.activities),
      c.deliverable,
      j(c.firstTask),
      j(c.initialTasks),
      c.estimatedMinutesRange?.min ?? null,
      c.estimatedMinutesRange?.max ?? null,
      j(c.requirements),
      j(c.unknowns),
      c.fitReason,
      j(c.sourceRefs),
      c.evidenceStatus,
      c.canonicalUrl,
      c.evidenceHash,
      c.supersedesId,
      t,
      t,
    );
  return getCandidate(id)!;
}

export function getCandidate(id: string): CandidateRow | null {
  const row = getDb().prepare(`SELECT * FROM candidates WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
  return row ? mapCandidate(row) : null;
}

export function listCandidatesByRun(runId: string): CandidateRow[] {
  return (
    getDb().prepare(`SELECT * FROM candidates WHERE run_id = ? ORDER BY created_at`).all(runId) as Array<
      Record<string, unknown>
    >
  ).map(mapCandidate);
}

/** 最近一个同 topic+canonical URL 的候选（去重，7.2） */
export function latestCandidateFor(topicId: string, canonical: string): CandidateRow | null {
  const row = getDb()
    .prepare(`SELECT * FROM candidates WHERE topic_id = ? AND canonical_url = ? ORDER BY created_at DESC LIMIT 1`)
    .get(topicId, canonical) as Record<string, unknown> | undefined;
  return row ? mapCandidate(row) : null;
}

export function listSavedCandidates(): CandidateRow[] {
  return (
    getDb()
      .prepare(`SELECT * FROM candidates WHERE status IN ('idea','started') ORDER BY updated_at DESC LIMIT 50`)
      .all() as Array<Record<string, unknown>>
  ).map(mapCandidate);
}

export function updateCandidateRow(
  id: string,
  expectedVersion: number,
  fields: Partial<{
    status: CandidateRow["status"];
    feedback: string | null;
    projectId: string;
    startedWithUnknowns: boolean;
    requirements: RequirementRow[];
  }>,
): CandidateRow | null {
  const sets: string[] = [];
  const vals: Array<string | number | null> = [];
  const cols: Array<[string, string | number | null | undefined]> = [
    ["status", fields.status],
    ["feedback", fields.feedback],
    ["project_id", fields.projectId],
    ["started_with_unknowns", fields.startedWithUnknowns === undefined ? undefined : fields.startedWithUnknowns ? 1 : 0],
    ["requirements_json", fields.requirements === undefined ? undefined : j(fields.requirements)],
  ];
  for (const [col, v] of cols) {
    if (v === undefined) continue;
    sets.push(`${col} = ?`);
    vals.push(v);
  }
  sets.push("version = version + 1", "updated_at = ?");
  vals.push(now(), id, expectedVersion);
  const r = getDb().prepare(`UPDATE candidates SET ${sets.join(", ")} WHERE id = ? AND version = ?`).run(...vals);
  return r.changes === 1 ? getCandidate(id) : null;
}

// ===== practice templates =====

export type TemplateRow = {
  id: string;
  version: number;
  status: "draft" | "ready";
  direction: string;
  question: string;
  activities: string[];
  prerequisites: string[];
  requiredResources: string[];
  estimatedMinutesRange: { min: number; max: number } | null;
  deliverables: string[];
  firstStep: string;
  initialTasks: Array<{ title: string; estimateMinutes: number | null }>;
  reviewQuestions: string[];
  sourceLinks: Array<{ title: string; url: string; license: string }>;
  updatedAt: string;
};

function mapTemplate(r: Record<string, unknown>): TemplateRow {
  const min = r.estimated_minutes_min as number | null;
  const max = r.estimated_minutes_max as number | null;
  return {
    id: r.id as string,
    version: r.version as number,
    status: r.status as TemplateRow["status"],
    direction: r.direction as string,
    question: r.question as string,
    activities: pj(r.activities_json, []),
    prerequisites: pj(r.prerequisites_json, []),
    requiredResources: pj(r.required_resources_json, []),
    estimatedMinutesRange: min !== null && max !== null ? { min, max } : null,
    deliverables: pj(r.deliverables_json, []),
    firstStep: r.first_step as string,
    initialTasks: pj(r.initial_tasks_json, []),
    reviewQuestions: pj(r.review_questions_json, []),
    sourceLinks: pj(r.source_links_json, []),
    updatedAt: r.updated_at as string,
  };
}

export function listTemplates(): TemplateRow[] {
  return (getDb().prepare(`SELECT * FROM practice_templates ORDER BY id`).all() as Array<Record<string, unknown>>).map(
    mapTemplate,
  );
}

export function getTemplate(id: string): TemplateRow | null {
  const row = getDb().prepare(`SELECT * FROM practice_templates WHERE id = ?`).get(id) as
    | Record<string, unknown>
    | undefined;
  return row ? mapTemplate(row) : null;
}

export function updateTemplateRow(
  id: string,
  expectedVersion: number,
  fields: Partial<{
    status: "draft" | "ready";
    question: string;
    activities: string[];
    prerequisites: string[];
    requiredResources: string[];
    deliverables: string[];
    firstStep: string;
    reviewQuestions: string[];
    sourceLinks: TemplateRow["sourceLinks"];
  }>,
): TemplateRow | null {
  const cols: Record<string, [string, (v: never) => string]> = {
    status: ["status", (v) => v],
    question: ["question", (v) => v],
    activities: ["activities_json", (v) => j(v)],
    prerequisites: ["prerequisites_json", (v) => j(v)],
    requiredResources: ["required_resources_json", (v) => j(v)],
    deliverables: ["deliverables_json", (v) => j(v)],
    firstStep: ["first_step", (v) => v],
    reviewQuestions: ["review_questions_json", (v) => j(v)],
    sourceLinks: ["source_links_json", (v) => j(v)],
  };
  const sets: string[] = [];
  const vals: string[] = [];
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined) continue;
    const [col, enc] = cols[k];
    sets.push(`${col} = ?`);
    vals.push(enc(v as never));
  }
  sets.push("version = version + 1", "updated_at = ?");
  const r = getDb()
    .prepare(`UPDATE practice_templates SET ${sets.join(", ")} WHERE id = ? AND version = ?`)
    .run(...vals, now(), id, expectedVersion);
  return r.changes === 1 ? getTemplate(id) : null;
}
