import crypto from "node:crypto";
import { getDb } from "@/repositories/db";

/**
 * 身份事实与人工规则 repository（计划 v1.2 第 4.2、5.2 节）。
 * 事实：一个字段一个当前值，主人确认；规则：主人显式启用，保存 scope 与 version。
 */

export type ProfileFactRow = {
  id: string;
  field: string;
  value: string;
  source: string;
  version: number;
  createdAt: string;
  updatedAt: string;
};

export type ProfileRuleRow = {
  id: string;
  source: string;
  noticeType: string;
  condition: unknown;
  outputPartition: string;
  priority: number;
  enabled: boolean;
  version: number;
  createdAt: string;
  updatedAt: string;
};

function now(): string {
  return new Date().toISOString();
}

// ===== profile facts =====

export function listFacts(): ProfileFactRow[] {
  const db = getDb();
  const rows = db.prepare(`SELECT * FROM profile_facts ORDER BY field`).all() as Array<
    Record<string, unknown>
  >;
  return rows.map(mapFact);
}

export function factsMap(): Record<string, string> {
  const map: Record<string, string> = {};
  for (const f of listFacts()) map[f.field] = f.value;
  return map;
}

export function getFactByField(field: string): ProfileFactRow | null {
  const db = getDb();
  const row = db.prepare(`SELECT * FROM profile_facts WHERE field = ?`).get(field) as
    | Record<string, unknown>
    | undefined;
  return row ? mapFact(row) : null;
}

/** upsert 事实：expectedVersion 0 创建，否则乐观锁；返回冲突 */
export function upsertFact(
  field: string,
  value: string,
  expectedVersion: number,
): ProfileFactRow | "conflict" {
  const db = getDb();
  const existing = getFactByField(field);
  if (!existing) {
    if (expectedVersion !== 0) return "conflict";
    db.prepare(
      `INSERT INTO profile_facts (id, field, value, version, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)`,
    ).run(crypto.randomUUID(), field, value, now(), now());
    return getFactByField(field)!;
  }
  if (existing.version !== expectedVersion) return "conflict";
  const r = db
    .prepare(
      `UPDATE profile_facts SET value = ?, version = version + 1, updated_at = ? WHERE field = ? AND version = ?`,
    )
    .run(value, now(), field, expectedVersion);
  if (r.changes === 0) return "conflict";
  return getFactByField(field)!;
}

function mapFact(r: Record<string, unknown>): ProfileFactRow {
  return {
    id: r.id as string,
    field: r.field as string,
    value: r.value as string,
    source: r.source as string,
    version: r.version as number,
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
  };
}

// ===== profile rules =====

export function listRules(filter: { enabledOnly?: boolean } = {}): ProfileRuleRow[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT * FROM profile_rules ${filter.enabledOnly ? "WHERE enabled = 1" : ""} ORDER BY priority DESC, created_at DESC`,
    )
    .all() as Array<Record<string, unknown>>;
  return rows.map(mapRule);
}

export function getRule(id: string): ProfileRuleRow | null {
  const db = getDb();
  const row = db.prepare(`SELECT * FROM profile_rules WHERE id = ?`).get(id) as
    | Record<string, unknown>
    | undefined;
  return row ? mapRule(row) : null;
}

/** 创建规则（默认未启用；预览影响后由主人启用） */
export function createRule(input: {
  source: string;
  noticeType: string;
  condition: unknown;
  outputPartition: string;
  priority: number;
}): ProfileRuleRow {
  const db = getDb();
  const id = crypto.randomUUID();
  const t = now();
  db.prepare(
    `INSERT INTO profile_rules (id, source, notice_type, condition_json, output_partition, priority, enabled, version, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 0, 1, ?, ?)`,
  ).run(
    id,
    input.source,
    input.noticeType,
    JSON.stringify(input.condition),
    input.outputPartition,
    input.priority,
    t,
    t,
  );
  return getRule(id)!;
}

export function updateRule(
  id: string,
  patch: { enabled?: boolean; priority?: number; outputPartition?: string },
  expectedVersion: number,
): ProfileRuleRow | "conflict" | "not_found" {
  const db = getDb();
  const current = getRule(id);
  if (!current) return "not_found";
  const sets: string[] = [];
  const vals: Array<string | number> = [];
  if (patch.enabled !== undefined) {
    sets.push("enabled = ?");
    vals.push(patch.enabled ? 1 : 0);
  }
  if (patch.priority !== undefined) {
    sets.push("priority = ?");
    vals.push(patch.priority);
  }
  if (patch.outputPartition !== undefined) {
    sets.push("output_partition = ?");
    vals.push(patch.outputPartition);
  }
  if (sets.length === 0) return current;
  sets.push("version = version + 1", "updated_at = ?");
  vals.push(now(), id, expectedVersion);
  const r = db
    .prepare(`UPDATE profile_rules SET ${sets.join(", ")} WHERE id = ? AND version = ?`)
    .run(...vals);
  if (r.changes === 0) return "conflict";
  return getRule(id)!;
}

export function deleteRule(id: string): boolean {
  const db = getDb();
  const r = db.prepare(`DELETE FROM profile_rules WHERE id = ?`).run(id);
  return r.changes === 1;
}

function mapRule(r: Record<string, unknown>): ProfileRuleRow {
  return {
    id: r.id as string,
    source: r.source as string,
    noticeType: r.notice_type as string,
    condition: JSON.parse(r.condition_json as string) as unknown,
    outputPartition: r.output_partition as string,
    priority: r.priority as number,
    enabled: r.enabled === 1,
    version: r.version as number,
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
  };
}
