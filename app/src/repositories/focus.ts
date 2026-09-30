import crypto from "node:crypto";
import { getDb } from "@/repositories/db";

/** 每周重点：每周最多一项；(local_monday, timezone) 唯一；goal/project 至多一个 */

export type WeeklyFocusRow = {
  id: string;
  localMonday: string;
  timezone: string;
  title: string;
  goalId: string | null;
  projectId: string | null;
  confirmedAt: string;
  version: number;
};

export function getFocus(localMonday: string, timezone: string): WeeklyFocusRow | null {
  const db = getDb();
  const row = db
    .prepare(`SELECT * FROM weekly_focus WHERE local_monday = ? AND timezone = ?`)
    .get(localMonday, timezone) as Record<string, unknown> | undefined;
  return row ? mapFocus(row) : null;
}

export function upsertFocus(args: {
  localMonday: string;
  timezone: string;
  title: string;
  goalId: string | null;
  projectId: string | null;
  expectedVersion?: number;
}): WeeklyFocusRow | "conflict" {
  const db = getDb();
  const existing = getFocus(args.localMonday, args.timezone);
  const t = new Date().toISOString();
  if (existing) {
    if (args.expectedVersion === undefined || args.expectedVersion !== existing.version) {
      return "conflict";
    }
    db.prepare(
      `UPDATE weekly_focus SET title = ?, goal_id = ?, project_id = ?, confirmed_at = ?, version = version + 1
       WHERE id = ?`,
    ).run(args.title, args.goalId, args.projectId, t, existing.id);
    return getFocus(args.localMonday, args.timezone)!;
  }
  const id = crypto.randomUUID();
  db.prepare(
    `INSERT INTO weekly_focus (id, local_monday, timezone, title, goal_id, project_id, confirmed_at, version)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
  ).run(id, args.localMonday, args.timezone, args.title, args.goalId, args.projectId, t);
  return getFocus(args.localMonday, args.timezone)!;
}

export function deleteFocus(
  localMonday: string,
  timezone: string,
  expectedVersion: number,
): boolean {
  const db = getDb();
  const existing = getFocus(localMonday, timezone);
  if (!existing || existing.version !== expectedVersion) return false;
  db.prepare(`DELETE FROM weekly_focus WHERE id = ?`).run(existing.id);
  return true;
}

function mapFocus(r: Record<string, unknown>): WeeklyFocusRow {
  return {
    id: r.id as string,
    localMonday: r.local_monday as string,
    timezone: r.timezone as string,
    title: r.title as string,
    goalId: (r.goal_id as string | null) ?? null,
    projectId: (r.project_id as string | null) ?? null,
    confirmedAt: r.confirmed_at as string,
    version: r.version as number,
  };
}
