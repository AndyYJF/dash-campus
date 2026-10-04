import { getDb } from "@/repositories/db";
import { getBatch, listChanges, markUndone, type ChangeRow } from "@/repositories/journal";
import { addTombstone } from "@/repositories/calendar-facts";

/**
 * 撤销（MASTER-PLAN §5.3）：粒度 = batch；逐项要求当前版本 == afterVersion，
 * 有冲突整体不动并返回具体冲突，不强行覆盖、不半撤、版本不倒退。
 */

/** entity_kind → 表名；带版本列的表做冲突检查；idColumn 缺省为 id */
const KIND_TABLE: Record<string, { table: string; versioned: boolean; idColumn?: string }> = {
  semester: { table: "semesters", versioned: true },
  course_set: { table: "course_sets", versioned: true },
  course: { table: "courses", versioned: true },
  course_meeting: { table: "course_meetings", versioned: true },
  projection: { table: "course_meeting_projections", versioned: false },
  fixed_event: { table: "fixed_events", versioned: false },
  practice_entry: { table: "practice_entries", versioned: true },
  task: { table: "tasks", versioned: true },
  plan_session: { table: "plan_sessions", versioned: true },
  course_exception: { table: "course_event_exceptions", versioned: false },
  goal: { table: "goals", versioned: true },
  holiday_dataset: { table: "holiday_datasets", versioned: true },
  holiday_day: { table: "holiday_days", versioned: false },
  academic_calendar: { table: "academic_calendars", versioned: true },
  academic_calendar_event: { table: "academic_calendar_events", versioned: true },
  teaching_override: { table: "teaching_day_overrides", versioned: true },
  policy_rule: { table: "planning_policy_rules", versioned: true },
  planning_preferences: { table: "planning_preferences", versioned: true },
  setting: { table: "settings", versioned: true, idColumn: "key" },
  profile_fact: { table: "profile_facts", versioned: true },
  project: { table: "projects", versioned: true },
  candidate: { table: "candidates", versioned: true },
  resource: { table: "resources", versioned: true },
  resource_link: { table: "resource_links", versioned: true },
  inbox_task_link: { table: "inbox_task_links", versioned: false },
  inbox_decision: { table: "inbox_decisions", versioned: true },
};

export type UndoResult =
  | { kind: "undone" }
  | { kind: "already_undone" }
  | { kind: "not_found" }
  | { kind: "conflict"; conflicts: string[] };

export function undoBatch(batchId: string): UndoResult {
  const batch = getBatch(batchId);
  if (!batch) return { kind: "not_found" };
  if (batch.status === "undone") return { kind: "already_undone" };
  const changes = listChanges(batchId);
  return getDb()
    .transaction((): UndoResult => {
      const conflicts = collectConflicts(changes);
      if (conflicts.length) return { kind: "conflict", conflicts };
      for (const c of [...changes].reverse()) revertOne(c);
      markUndone(batchId);
      return { kind: "undone" };
    })
    .immediate();
}

function collectConflicts(changes: ChangeRow[]): string[] {
  const conflicts: string[] = [];
  for (const c of changes) {
    const meta = KIND_TABLE[c.entityKind];
    if (!meta) conflicts.push(`未知实体类型 ${c.entityKind}`);
    else if (c.action !== "delete" && meta.versioned) {
      const row = getDb().prepare(`SELECT version FROM ${meta.table} WHERE ${meta.idColumn ?? "id"} = ?`).get(c.entityId) as { version: number } | undefined;
      if (!row) conflicts.push(`${c.entityKind} ${c.entityId} 已被删除`);
      else if (c.afterVersion !== null && row.version !== c.afterVersion)
        conflicts.push(`${c.entityKind} ${c.entityId} 当前版本 ${row.version} ≠ 批次后版本 ${c.afterVersion}（之后有新修改）`);
    }
  }
  return conflicts;
}

function revertOne(c: ChangeRow): void {
  const meta = KIND_TABLE[c.entityKind]!;
  const db = getDb();
  const idColumn = meta.idColumn ?? "id";
  if (c.action === "create") {
    // 任务被撤销删除时，其学习块（排程衍生数据，可重建）一并删除，否则 FK 阻止
    if (c.entityKind === "task") db.prepare(`DELETE FROM plan_sessions WHERE task_id = ?`).run(c.entityId);
    // 项目/资料连带的关联行、修订快照是衍生数据，随主体一并撤掉
    if (c.entityKind === "project") db.prepare(`DELETE FROM project_goals WHERE project_id = ?`).run(c.entityId);
    if (c.entityKind === "resource") db.prepare(`DELETE FROM resource_revisions WHERE resource_id = ?`).run(c.entityId);
    leaveTombstone(c);
    db.prepare(`DELETE FROM ${meta.table} WHERE ${idColumn} = ?`).run(c.entityId);
    return;
  }
  if (c.action === "delete") {
    restoreRow(meta.table, c.before!);
    return;
  }
  restoreFields(meta, c);
}

/** 撤销来源带来的日历事实时留下墓碑：同一修订不会被下一次同步重新套用（§4.2） */
function leaveTombstone(c: ChangeRow): void {
  const db = getDb();
  if (c.entityKind === "holiday_dataset") {
    const r = db.prepare(`SELECT region, year, revision_hash FROM holiday_datasets WHERE id = ?`).get(c.entityId) as { region: string; year: number; revision_hash: string } | undefined;
    if (r) addTombstone("holiday", `${r.region}:${r.year}`, r.revision_hash);
  } else if (c.entityKind === "academic_calendar") {
    const r = db.prepare(`SELECT school, academic_year, term_label, source_revision, origin FROM academic_calendars WHERE id = ?`).get(c.entityId) as
      | { school: string; academic_year: string; term_label: string; source_revision: string; origin: string }
      | undefined;
    if (r && r.source_revision && r.origin === "source") addTombstone("academic", `${r.school}|${r.academic_year}|${r.term_label}`, r.source_revision);
  }
}

/** update 撤销：恢复字段值，版本前进（不倒退） */
function restoreFields(meta: { table: string; idColumn?: string }, c: ChangeRow): void {
  const db = getDb();
  const sets = Object.keys(c.before ?? {}).map((k) => `${toSnake(k)} = ?`);
  db.prepare(`UPDATE ${meta.table} SET ${sets.join(", ")}, version = version + 1, updated_at = ? WHERE ${meta.idColumn ?? "id"} = ?`).run(
    ...Object.values(c.before ?? {}),
    new Date().toISOString(),
    c.entityId,
  );
}

/** delete 撤销：按 before 快照整行恢复（fixed_events 无版本列，直接按列名还原） */
function restoreRow(table: string, before: Record<string, unknown>): void {
  const db = getDb();
  const cols = Object.keys(before);
  db.prepare(`INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`).run(...Object.values(before));
}

function toSnake(k: string): string {
  return k.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`);
}
