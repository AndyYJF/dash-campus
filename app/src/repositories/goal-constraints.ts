import crypto from "node:crypto";
import { getDb } from "./db";
import { constraintValueSchema, type AcceptedConstraint, type ConstraintRelease, type ConstraintSource, type ConstraintValue } from "@/domain/constraints";

/**
 * 目标约束（迁移 0033）：读出时逐行用 zod 判别联合校验，校验不过的行不参与执行判断。
 * 新的范围约束取代旧的；保护约束一直有效，直到主人解除。
 */

export type GoalConstraintRow = { id: string; goalId: string; revision: number; intakeId: string | null; value: ConstraintValue; excerpt: string; source: ConstraintSource; status: "accepted" | "released" | "superseded"; createdAt: string };

function mapRow(r: Record<string, unknown>): GoalConstraintRow | null {
  let raw: unknown;
  try {
    raw = JSON.parse(String(r.value_json));
  } catch {
    return null;
  }
  const value = constraintValueSchema.safeParse(raw);
  if (!value.success || value.data.kind !== r.kind) return null;
  return { id: r.id as string, goalId: r.goal_id as string, revision: r.revision as number, intakeId: (r.intake_id as string | null) ?? null, value: value.data, excerpt: r.excerpt as string, source: r.source as ConstraintSource, status: r.status as GoalConstraintRow["status"], createdAt: r.created_at as string };
}

export function listGoalConstraints(goalId: string, opts: { all?: boolean } = {}): GoalConstraintRow[] {
  const rows = getDb().prepare(`SELECT * FROM agent_goal_constraints WHERE goal_id = ? ${opts.all ? "" : "AND status = 'accepted'"} ORDER BY created_at, rowid`).all(goalId) as Array<Record<string, unknown>>;
  return rows.map(mapRow).filter((r): r is GoalConstraintRow => Boolean(r));
}

/**
 * 新目标沿用同一对话上一件事仍生效的保护约束；引用保持主人原话。必须在调用方事务里。
 * 只沿用只会拦住修改的保护类；范围和“几点后不排”会生成新规则，不替主人带进另一件事。
 */
export function inheritProtections(fromGoalId: string, toGoalId: string, intakeId: string | null, at: Date = new Date()): number {
  const inherited = listGoalConstraints(fromGoalId)
    .filter((c) => c.value.kind === "protect_days" || c.value.kind === "protect_dates" || c.value.kind === "protect_entity")
    .map((c) => ({ value: c.value, excerpt: c.excerpt, source: "inherited" as const }));
  return inherited.length ? recordGoalConstraints({ goalId: toGoalId, revision: 1, intakeId, accepted: inherited, releases: [], at }).added : 0;
}

/** 记下接受的约束与解除：同一内容已在生效的不重复；新范围取代旧范围。必须在调用方事务里 */
export function recordGoalConstraints(input: { goalId: string; revision: number; intakeId: string | null; accepted: AcceptedConstraint[]; releases: ConstraintRelease[]; at?: Date }): { added: number; released: number } {
  const db = getDb();
  const t = (input.at ?? new Date()).toISOString();
  const active = listGoalConstraints(input.goalId);
  let released = 0;
  for (const rel of input.releases) {
    for (const c of active) {
      // 只解除这一版及之前说过的：旧事项重放时不会把之后重新说的条件又解除掉
      if (c.value.kind !== rel.target || c.status !== "accepted" || c.revision > input.revision) continue;
      if (rel.days && c.value.kind === "protect_days" && c.value.days !== rel.days) continue;
      released += db.prepare(`UPDATE agent_goal_constraints SET status = 'released', released_revision = ? WHERE id = ? AND status = 'accepted'`).run(input.revision, c.id).changes;
    }
  }
  let added = 0;
  const current = listGoalConstraints(input.goalId);
  for (const a of input.accepted) {
    const key = JSON.stringify(a.value);
    if (current.some((c) => JSON.stringify(c.value) === key)) continue;
    // 同一份投递记过（之后可能已被解除）的不再写回
    if (db.prepare(`SELECT 1 FROM agent_goal_constraints WHERE goal_id = ? AND intake_id IS ? AND value_json = ?`).get(input.goalId, input.intakeId, JSON.stringify(a.value))) continue;
    if (a.value.kind === "date_scope") db.prepare(`UPDATE agent_goal_constraints SET status = 'superseded', released_revision = ? WHERE goal_id = ? AND kind = 'date_scope' AND status = 'accepted'`).run(input.revision, input.goalId);
    db.prepare(`INSERT INTO agent_goal_constraints (id, goal_id, revision, intake_id, kind, value_json, excerpt, source, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'accepted', ?)`).run(
      crypto.randomUUID(), input.goalId, input.revision, input.intakeId, a.value.kind, JSON.stringify(a.value), a.excerpt.slice(0, 200), a.source, t,
    );
    added++;
  }
  return { added, released };
}
