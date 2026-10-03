import { getDb } from "@/repositories/db";
import { getBatch, listChanges, markUndone, type ChangeRow } from "@/repositories/journal";

/**
 * 撤销（MASTER-PLAN §5.3）：粒度 = batch；逐项要求当前版本 == afterVersion，
 * 有冲突整体不动并返回具体冲突，不强行覆盖、不半撤、版本不倒退。
 */

/** entity_kind → 表名；带版本列的表做冲突检查 */
const KIND_TABLE: Record<string, { table: string; versioned: boolean }> = {
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
      const row = getDb().prepare(`SELECT version FROM ${meta.table} WHERE id = ?`).get(c.entityId) as { version: number } | undefined;
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
  if (c.action === "create") {
    // 任务被撤销删除时，其学习块（排程衍生数据，可重建）一并删除，否则 FK 阻止
    if (c.entityKind === "task") db.prepare(`DELETE FROM plan_sessions WHERE task_id = ?`).run(c.entityId);
    db.prepare(`DELETE FROM ${meta.table} WHERE id = ?`).run(c.entityId);
    return;
  }
  if (c.action === "delete") {
    restoreRow(meta.table, c.before!);
    return;
  }
  restoreFields(meta, c);
}

/** update 撤销：恢复字段值，版本前进（不倒退） */
function restoreFields(meta: { table: string }, c: ChangeRow): void {
  const db = getDb();
  const sets = Object.keys(c.before ?? {}).map((k) => `${toSnake(k)} = ?`);
  db.prepare(`UPDATE ${meta.table} SET ${sets.join(", ")}, version = version + 1, updated_at = ? WHERE id = ?`).run(
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
