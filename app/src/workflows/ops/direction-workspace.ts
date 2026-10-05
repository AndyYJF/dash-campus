import crypto from "node:crypto";
import { getDb } from "@/repositories/db";
import type { ChangeInput } from "@/repositories/journal";
import type { Command, CommandContext } from "@/contracts/commands";
import { instanceTimezone, localDateInTz } from "@/domain/time";
import { nowDate } from "@/domain/clock";
import { PATH_KEYS, PATH_LABEL, stageTemplate, trackTemplate, type PathKey, type StageKey } from "@/content/direction";
import { HttpError } from "@/workflows/http";

/**
 * 方向工作区操作（方向页打磨 §7.2/§8.2）：只保存主人明确说的阶段、去向、关注方向、采用的阶段项、项目关联和原话感受。
 * 采用模板不顺带建目标或任务；“先不看了”只改关注状态，不动关联项目；感受不另记分钟数、不据此判断适不适合。
 */

type Cmd<N extends Command["command"]> = Extract<Command, { command: N }>;
const now = () => new Date().toISOString();

type ProfileRow = { id: number; confirmed_stage: string | null; stage_source: string; entry_year: number | null; path_preferences_json: string; version: number };
type TrackRow = { id: string; template_key: string | null; title: string; status: string; owner_notes: string; version: number };
type RoadmapRow = { id: string; stage_key: string; title: string; purpose: string; goal_id: string | null; track_id: string | null; status: string; version: number };
type LinkRow = { id: string; project_id: string; track_id: string; roadmap_item_id: string | null; version: number; created_at: string; updated_at: string };

const TRACK_STATUS: Record<string, string> = { exploring: "在了解", following: "持续关注", paused: "先不看" };
const ROADMAP_STATUS: Record<string, string> = { adopted: "采用", completed: "完成", paused: "先放下" };

function stale(what: string): never {
  throw new HttpError(409, "STALE_VERSION", `${what}刚被修改过，请刷新后再改`);
}

export function getTrack(id: string): TrackRow | undefined {
  return getDb().prepare(`SELECT id, template_key, title, status, owner_notes, version FROM direction_tracks WHERE id = ?`).get(id) as TrackRow | undefined;
}

function requireTrack(id: string): TrackRow {
  const t = getTrack(id);
  if (!t) throw new HttpError(422, "INVALID_REFERENCE", "这个关注方向不存在");
  return t;
}

function requireRoadmapItem(id: string): RoadmapRow {
  const r = getDb().prepare(`SELECT id, stage_key, title, purpose, goal_id, track_id, status, version FROM roadmap_items WHERE id = ?`).get(id) as RoadmapRow | undefined;
  if (!r) throw new HttpError(422, "INVALID_REFERENCE", "这个阶段项不存在");
  return r;
}

function requireProject(id: string): { id: string; title: string } {
  const p = getDb().prepare(`SELECT id, title FROM projects WHERE id = ? AND archived_at IS NULL`).get(id) as { id: string; title: string } | undefined;
  if (!p) throw new HttpError(422, "INVALID_REFERENCE", "要关联的项目不存在");
  return p;
}

function requireGoal(id: string): void {
  if (!getDb().prepare(`SELECT 1 FROM goals WHERE id = ? AND archived_at IS NULL`).get(id)) throw new HttpError(422, "INVALID_REFERENCE", "引用的目标不存在");
}

function normalizePaths(paths: PathKey[]): PathKey[] {
  const set = new Set(paths);
  if (set.size > 1) set.delete("undecided");
  return PATH_KEYS.filter((k) => set.has(k));
}

function pathText(json: string): string {
  const keys = JSON.parse(json) as PathKey[];
  return keys.length ? keys.map((k) => PATH_LABEL[k]).join("、") : "未选";
}

/** 当前阶段与去向：阶段来自主人本人（页面或原话），不推算；去向可多选并存 */
export function applyDirectionProfile(cmd: Cmd<"update_direction_profile">, ctx: CommandContext, changes: ChangeInput[]): string {
  if (cmd.confirmedStage === undefined && cmd.entryYear === undefined && cmd.pathPreferences === undefined) throw new HttpError(422, "VALIDATION", "没有要改的阶段、入学年或去向");
  const db = getDb();
  const row = db.prepare(`SELECT id, confirmed_stage, stage_source, entry_year, path_preferences_json, version FROM direction_profile WHERE id = 1`).get() as ProfileRow | undefined;
  if (cmd.expectedVersion !== null && (row?.version ?? 0) !== cmd.expectedVersion) stale("阶段与去向");
  const source = ctx.intakeId ? `intake:${ctx.intakeId}` : "owner";
  const next: Record<string, unknown> = {};
  if (cmd.confirmedStage !== undefined) {
    next.confirmedStage = cmd.confirmedStage;
    next.stageSource = cmd.confirmedStage ? source : "";
  }
  if (cmd.entryYear !== undefined) next.entryYear = cmd.entryYear;
  if (cmd.pathPreferences !== undefined) next.pathPreferencesJson = JSON.stringify(normalizePaths(cmd.pathPreferences));
  if (!row) {
    const v = { confirmedStage: null, stageSource: "", entryYear: null, pathPreferencesJson: "[]", ...next };
    db.prepare(`INSERT INTO direction_profile (id, confirmed_stage, stage_source, entry_year, path_preferences_json, created_at, updated_at) VALUES (1, ?, ?, ?, ?, ?, ?)`).run(v.confirmedStage, v.stageSource, v.entryYear, v.pathPreferencesJson, now(), now());
    changes.push({ entityKind: "direction_profile", entityId: "1", action: "create", after: v, afterVersion: 1 });
  } else {
    const current: Record<string, unknown> = { confirmedStage: row.confirmed_stage, stageSource: row.stage_source, entryYear: row.entry_year, pathPreferencesJson: row.path_preferences_json };
    const before: Record<string, unknown> = {};
    const after: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(next)) {
      if (current[k] === v) continue;
      before[k] = current[k];
      after[k] = v;
    }
    if (!Object.keys(after).length) return "阶段与去向没有变化";
    const cols = Object.keys(after).map((k) => `${k.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`)} = ?`);
    db.prepare(`UPDATE direction_profile SET ${cols.join(", ")}, version = version + 1, updated_at = ? WHERE id = 1`).run(...Object.values(after), now());
    changes.push({ entityKind: "direction_profile", entityId: "1", action: "update", before, after, beforeVersion: row.version, afterVersion: row.version + 1 });
  }
  const parts: string[] = [];
  if (cmd.confirmedStage !== undefined) parts.push(cmd.confirmedStage ? `当前阶段记为${stageTemplate(cmd.confirmedStage as StageKey).label}` : "当前阶段改回未确认");
  if (cmd.entryYear !== undefined) parts.push(cmd.entryYear ? `入学年 ${cmd.entryYear}` : "入学年改回未知");
  if (cmd.pathPreferences !== undefined) parts.push(`去向偏好：${pathText(next.pathPreferencesJson as string)}（可以并存，随时能改；没选的不代表排除）`);
  return `${parts.join("；")}。没有生成目标或任务。`;
}

/** 关注方向：同一工作样本只建一个；改状态不动关联项目 */
export function applyDirectionTrack(cmd: Cmd<"upsert_direction_track">, _ctx: CommandContext, changes: ChangeInput[]): string {
  const db = getDb();
  let row: TrackRow | undefined;
  if (cmd.trackId) {
    row = getTrack(cmd.trackId);
    if (!row) throw new HttpError(404, "NOT_FOUND", "这个关注方向不存在");
    if (cmd.expectedVersion !== null && row.version !== cmd.expectedVersion) stale(`「${row.title}」`);
  } else {
    if (cmd.templateKey && !trackTemplate(cmd.templateKey)) throw new HttpError(422, "INVALID_REFERENCE", "没有这个工作样本");
    if (cmd.templateKey) row = db.prepare(`SELECT id, template_key, title, status, owner_notes, version FROM direction_tracks WHERE template_key = ?`).get(cmd.templateKey) as TrackRow | undefined;
    if (!row) {
      const title = cmd.title ?? (cmd.templateKey ? trackTemplate(cmd.templateKey)!.title : undefined);
      if (!title) throw new HttpError(422, "VALIDATION", "新的关注方向需要名称或工作样本");
      const dup = db.prepare(`SELECT id FROM direction_tracks WHERE title = ? AND template_key IS ?`).get(title, cmd.templateKey ?? null) as { id: string } | undefined;
      if (dup) row = getTrack(dup.id);
      else {
        const id = crypto.randomUUID();
        const status = cmd.status ?? "exploring";
        const ownerNotes = cmd.ownerNotes ?? "";
        db.prepare(`INSERT INTO direction_tracks (id, template_key, title, status, owner_notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(id, cmd.templateKey ?? null, title, status, ownerNotes, now(), now());
        changes.push({ entityKind: "direction_track", entityId: id, action: "create", after: { templateKey: cmd.templateKey ?? null, title, status, ownerNotes }, afterVersion: 1 });
        return `开始关注「${title}」（${TRACK_STATUS[status]}）。只是记下来，没有建项目或任务。`;
      }
    }
  }
  const t = row!;
  const before: Record<string, unknown> = {};
  const after: Record<string, unknown> = {};
  const current: Record<string, unknown> = { title: t.title, status: t.status, ownerNotes: t.owner_notes };
  for (const k of ["title", "status", "ownerNotes"] as const) {
    if (cmd[k] === undefined || cmd[k] === current[k]) continue;
    before[k] = current[k];
    after[k] = cmd[k];
  }
  if (!Object.keys(after).length) return `「${t.title}」已经在关注（${TRACK_STATUS[t.status]}），没有变化`;
  const cols = Object.keys(after).map((k) => `${k === "ownerNotes" ? "owner_notes" : k} = ?`);
  db.prepare(`UPDATE direction_tracks SET ${cols.join(", ")}, version = version + 1, updated_at = ? WHERE id = ?`).run(...Object.values(after), now(), t.id);
  changes.push({ entityKind: "direction_track", entityId: t.id, action: "update", before, after, beforeVersion: t.version, afterVersion: t.version + 1 });
  const title = (after.title as string | undefined) ?? t.title;
  const parts: string[] = [];
  if (after.status) {
    const linked = (db.prepare(`SELECT COUNT(*) AS n FROM direction_project_links WHERE track_id = ?`).get(t.id) as { n: number }).n;
    parts.push(after.status === "paused" ? `「${title}」先不看了${linked ? `；关联的 ${linked} 个项目和记录都保留，没有暂停项目` : "；之前的记录都保留"}` : `「${title}」改为${TRACK_STATUS[after.status as string]}`);
  }
  if (after.title && !after.status) parts.push(`关注方向改名为「${title}」`);
  if (after.ownerNotes !== undefined) parts.push(`「${title}」的备注已更新`);
  return parts.join("；");
}

/** 阶段项：主人采用或修订；不建任务，完成只按主人确认 */
export function applyRoadmapItem(cmd: Cmd<"update_roadmap_item">, ctx: CommandContext, changes: ChangeInput[]): string {
  const db = getDb();
  if (cmd.goalId) requireGoal(cmd.goalId);
  if (cmd.trackId) requireTrack(cmd.trackId);
  if (!cmd.roadmapItemId) {
    if (!cmd.stageKey || !cmd.title) throw new HttpError(422, "VALIDATION", "采用阶段项需要阶段和标题");
    const label = stageTemplate(cmd.stageKey).label;
    const dup = db.prepare(`SELECT id FROM roadmap_items WHERE stage_key = ? AND title = ?`).get(cmd.stageKey, cmd.title) as { id: string } | undefined;
    if (dup) return `${label}的「${cmd.title}」已经采用过，没有重复添加`;
    const id = crypto.randomUUID();
    const v = { stageKey: cmd.stageKey, title: cmd.title, purpose: cmd.purpose ?? "", goalId: cmd.goalId ?? null, trackId: cmd.trackId ?? null, status: cmd.status ?? "adopted", basisRefsJson: JSON.stringify(ctx.intakeId ? [`intake:${ctx.intakeId}`] : []) };
    db.prepare(`INSERT INTO roadmap_items (id, stage_key, title, purpose, goal_id, track_id, status, basis_refs_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, v.stageKey, v.title, v.purpose, v.goalId, v.trackId, v.status, v.basisRefsJson, now(), now());
    changes.push({ entityKind: "roadmap_item", entityId: id, action: "create", after: v, afterVersion: 1 });
    return `${ROADMAP_STATUS[v.status]}了${label}阶段项「${v.title}」。没有生成任务；要开始做时再说具体第一步。`;
  }
  const r = db.prepare(`SELECT id, stage_key, title, purpose, goal_id, track_id, status, version FROM roadmap_items WHERE id = ?`).get(cmd.roadmapItemId) as RoadmapRow | undefined;
  if (!r) throw new HttpError(404, "NOT_FOUND", "这个阶段项不存在");
  if (cmd.expectedVersion !== null && r.version !== cmd.expectedVersion) stale(`「${r.title}」`);
  const current: Record<string, unknown> = { stageKey: r.stage_key, title: r.title, purpose: r.purpose, goalId: r.goal_id, trackId: r.track_id, status: r.status };
  const before: Record<string, unknown> = {};
  const after: Record<string, unknown> = {};
  for (const k of ["stageKey", "title", "purpose", "goalId", "trackId", "status"] as const) {
    if (cmd[k] === undefined || cmd[k] === current[k]) continue;
    before[k] = current[k];
    after[k] = cmd[k];
  }
  if (!Object.keys(after).length) return `「${r.title}」没有变化`;
  const cols = Object.keys(after).map((k) => `${k.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`)} = ?`);
  db.prepare(`UPDATE roadmap_items SET ${cols.join(", ")}, version = version + 1, updated_at = ? WHERE id = ?`).run(...Object.values(after), now(), r.id);
  changes.push({ entityKind: "roadmap_item", entityId: r.id, action: "update", before, after, beforeVersion: r.version, afterVersion: r.version + 1 });
  const title = (after.title as string | undefined) ?? r.title;
  if (after.status) return `阶段项「${title}」标为${ROADMAP_STATUS[after.status as string]}${after.status === "completed" ? "（按你的确认）" : ""}`;
  return `阶段项「${title}」已修订`;
}

/** 写一条项目—方向关联（select_candidate 也复用）；已有就按需要更新阶段项 */
export function linkProjectToTrack(projectId: string, trackId: string, roadmapItemId: string | null | undefined, changes: ChangeInput[]): "created" | "updated" | "unchanged" {
  const db = getDb();
  const existing = db.prepare(`SELECT * FROM direction_project_links WHERE project_id = ? AND track_id = ?`).get(projectId, trackId) as LinkRow | undefined;
  if (!existing) {
    const id = crypto.randomUUID();
    db.prepare(`INSERT INTO direction_project_links (id, project_id, track_id, roadmap_item_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`).run(id, projectId, trackId, roadmapItemId ?? null, now(), now());
    changes.push({ entityKind: "direction_project_link", entityId: id, action: "create", after: { projectId, trackId, roadmapItemId: roadmapItemId ?? null }, afterVersion: 1 });
    return "created";
  }
  if (roadmapItemId === undefined || roadmapItemId === existing.roadmap_item_id) return "unchanged";
  db.prepare(`UPDATE direction_project_links SET roadmap_item_id = ?, version = version + 1, updated_at = ? WHERE id = ?`).run(roadmapItemId, now(), existing.id);
  changes.push({ entityKind: "direction_project_link", entityId: existing.id, action: "update", before: { roadmapItemId: existing.roadmap_item_id }, after: { roadmapItemId }, beforeVersion: existing.version, afterVersion: existing.version + 1 });
  return "updated";
}

/** 项目关联到关注方向；解除关联不动项目本身 */
export function applyLinkDirectionProject(cmd: Cmd<"link_direction_project">, _ctx: CommandContext, changes: ChangeInput[]): string {
  const db = getDb();
  const p = requireProject(cmd.projectId);
  const t = requireTrack(cmd.trackId);
  if (cmd.roadmapItemId) requireRoadmapItem(cmd.roadmapItemId);
  if (cmd.remove) {
    const existing = db.prepare(`SELECT * FROM direction_project_links WHERE project_id = ? AND track_id = ?`).get(p.id, t.id) as LinkRow | undefined;
    if (!existing) return `「${p.title}」本来就没有关联到「${t.title}」`;
    db.prepare(`DELETE FROM direction_project_links WHERE id = ?`).run(existing.id);
    changes.push({ entityKind: "direction_project_link", entityId: existing.id, action: "delete", before: { ...existing }, beforeVersion: existing.version });
    return `「${p.title}」不再关联到「${t.title}」；项目和它的安排、记录都没变`;
  }
  const r = linkProjectToTrack(p.id, t.id, cmd.roadmapItemId, changes);
  if (r === "unchanged") return `「${p.title}」已经关联到「${t.title}」`;
  return r === "created" ? `「${p.title}」关联到关注方向「${t.title}」；项目的安排不变` : `「${p.title}」在「${t.title}」下对应的阶段项已更新`;
}

/** 主人的实践感受：原话照存；同一段话重试不重复存 */
export function applyDirectionReflection(cmd: Cmd<"record_direction_reflection">, ctx: CommandContext, changes: ChangeInput[]): string {
  if (!cmd.projectId && !cmd.trackId && !cmd.practiceEntryId) throw new HttpError(422, "VALIDATION", "这段感受要关联到项目、关注方向或某次实践记录");
  const db = getDb();
  const names: string[] = [];
  if (cmd.projectId) names.push(`项目「${requireProject(cmd.projectId).title}」`);
  if (cmd.trackId) names.push(`方向「${requireTrack(cmd.trackId).title}」`);
  if (cmd.practiceEntryId) {
    const pe = db.prepare(`SELECT occurred_on FROM practice_entries WHERE id = ?`).get(cmd.practiceEntryId) as { occurred_on: string } | undefined;
    if (!pe) throw new HttpError(422, "INVALID_REFERENCE", "要关联的实践记录不存在");
    names.push(`${pe.occurred_on} 的实践记录`);
  }
  const today = localDateInTz(ctx.now ?? nowDate(), instanceTimezone());
  const occurredOn = cmd.occurredOn ?? today;
  if (occurredOn > today) throw new HttpError(422, "VALIDATION", "感受只记已经发生的实践");
  const dup = db.prepare(`SELECT id FROM direction_reflections WHERE original_text = ? AND occurred_on = ? AND project_id IS ? AND track_id IS ? AND practice_entry_id IS ?`).get(cmd.text, occurredOn, cmd.projectId, cmd.trackId, cmd.practiceEntryId) as { id: string } | undefined;
  if (dup) return "这段话已经记过了，没有重复保存";
  const id = crypto.randomUUID();
  db.prepare(`INSERT INTO direction_reflections (id, original_text, occurred_on, project_id, track_id, practice_entry_id, source_intake_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, cmd.text, occurredOn, cmd.projectId, cmd.trackId, cmd.practiceEntryId, ctx.intakeId, now(), now());
  changes.push({ entityKind: "direction_reflection", entityId: id, action: "create", after: { originalText: cmd.text, occurredOn, projectId: cmd.projectId, trackId: cmd.trackId, practiceEntryId: cmd.practiceEntryId }, afterVersion: 1 });
  return `记下了你的原话（${occurredOn}），关联到${names.join("、")}。只是保存你的感受，没有据此判断你适不适合这个方向，也没有另记用时。`;
}
