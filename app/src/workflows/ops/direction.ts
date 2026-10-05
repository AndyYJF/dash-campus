import crypto from "node:crypto";
import { getDb } from "@/repositories/db";
import { bumpPlanningRevision } from "@/repositories/proposals";
import type { ChangeInput } from "@/repositories/journal";
import type { Command, CommandContext } from "@/contracts/commands";
import { addDays, instanceTimezone, localDateInTz } from "@/domain/time";
import { nowDate } from "@/domain/clock";
import { createGoal, getGoal, getProject, updateGoal, updateProject } from "@/repositories/planning";
import { getCandidate } from "@/repositories/exploration";
import { createResource, getResource } from "@/repositories/resources";
import { createProjectFromCandidate } from "@/workflows/candidates";
import { startExploration } from "@/workflows/exploration";
import { HttpError } from "@/workflows/http";

/**
 * 目标 / 项目 / 资料 操作（REPAIR-PLAN §5.3，AGENT-INTERFACE-CONTRACT §2）。
 * 试做 ≠ 报名或对外承诺；正式投入需要主人明确意图；资料的事实类型由主人纠正为准。
 */

type Cmd<N extends Command["command"]> = Extract<Command, { command: N }>;
const now = () => new Date().toISOString();

/** 新建或修改目标；primary=true 时它成为唯一的主要方向（其他目标降为普通） */
export function applyGoal(cmd: Cmd<"upsert_goal">, _ctx: CommandContext, changes: ChangeInput[]): string {
  const db = getDb();
  let goalId = cmd.goalId;
  let title: string;
  if (!goalId) {
    if (!cmd.title) throw new HttpError(422, "VALIDATION", "新目标需要名称");
    const g = createGoal({ title: cmd.title, reason: cmd.reason ?? "", horizon: cmd.horizon ?? "semester" });
    goalId = g.id;
    title = g.title;
    changes.push({ entityKind: "goal", entityId: g.id, action: "create", after: { title: g.title, horizon: g.horizon }, afterVersion: 1 });
  } else {
    const g = getGoal(goalId);
    if (!g || g.archivedAt) throw new HttpError(404, "NOT_FOUND", "目标不存在");
    title = g.title;
    const patch: Record<string, unknown> = {};
    const before: Record<string, unknown> = {};
    for (const key of ["title", "reason", "horizon", "status"] as const) {
      if (cmd[key] !== undefined && cmd[key] !== g[key]) {
        patch[key] = cmd[key];
        before[key] = g[key];
      }
    }
    if (Object.keys(patch).length) {
      const updated = updateGoal(goalId, patch, g.version);
      if (updated === "conflict" || updated === "not_found") throw new HttpError(409, "CONFLICT", "目标刚被修改，请重试");
      changes.push({ entityKind: "goal", entityId: goalId, action: "update", before, after: patch, beforeVersion: g.version, afterVersion: updated.version });
      title = updated.title;
    }
  }
  const parts: string[] = [];
  if (cmd.primary !== undefined) {
    const rows = db.prepare(`SELECT id, priority, version FROM goals WHERE archived_at IS NULL`).all() as Array<{ id: string; priority: number; version: number }>;
    for (const r of rows) {
      const next = r.id === goalId ? (cmd.primary ? 1 : 0) : cmd.primary ? 0 : r.priority;
      if (next === r.priority) continue;
      db.prepare(`UPDATE goals SET priority = ?, version = version + 1, updated_at = ? WHERE id = ?`).run(next, now(), r.id);
      changes.push({ entityKind: "goal", entityId: r.id, action: "update", before: { priority: r.priority }, after: { priority: next }, beforeVersion: r.version, afterVersion: r.version + 1 });
    }
    if (cmd.primary) parts.push(`「${title}」设为当前的主要方向（其他目标保留，只是不排最前）`);
  }
  if (!changes.length) return `目标「${title}」没有变化`;
  return parts.length ? parts.join("；") : `目标已更新：${title}`;
}

/**
 * 选一个候选开始：trial = 试做（默认两周），只建第一步；commit = 正式投入，建前几步。
 * 都只是在 Dash 里建项目和有限的行动，不代表报名、加入课题组或任何对外承诺。
 */
export function applySelectCandidate(cmd: Cmd<"select_candidate">, ctx: CommandContext, changes: ChangeInput[]): string {
  const db = getDb();
  const c = getCandidate(cmd.candidateId);
  if (!c) throw new HttpError(404, "NOT_FOUND", "这个候选不存在");
  if (c.projectId) return `「${c.title}」已经在做了，没有重复建项目`;
  const tasks = (cmd.mode === "trial" ? [c.firstTask] : [c.firstTask, ...c.initialTasks].slice(0, 3))
    .filter((t) => t.title)
    .map((t) => ({ title: t.title, description: [t.input && `需要：${t.input}`, t.output && `产出：${t.output}`].filter(Boolean).join("；"), estimateMinutes: t.estimateMinutes }));
  if (!tasks.length) tasks.push({ title: `${c.title}：先花 25 分钟看清第一步`, description: "", estimateMinutes: 25 });
  const r = createProjectFromCandidate(c.id, {
    expectedVersion: c.version,
    title: c.title,
    question: c.question,
    expectedOutcome: c.deliverable,
    prerequisites: c.requirements.map((x) => `${x.label}（${x.status === "met" ? "具备" : x.status === "unmet" ? "不具备" : "未知"}）`).join("；").slice(0, 2000),
    reviewQuestions: c.unknowns.join("；").slice(0, 2000),
    goalIds: cmd.goalId ? [cmd.goalId] : [],
    startInclination: "unsure",
    acceptUnknowns: true,
    confirmedRequirementIndexes: [],
    tasks,
  });
  if (r.kind === "exists") return `「${c.title}」已经在做了，没有重复建项目`;
  if (r.kind !== "created") throw new HttpError(409, "CONFLICT", "候选刚被修改，请刷新后再选");
  const tz = instanceTimezone();
  const trialUntil = cmd.mode === "trial" ? addDays(localDateInTz(ctx.now ?? nowDate(), tz), cmd.trialWeeks * 7) : null;
  db.prepare(`UPDATE projects SET engagement = ?, trial_until = ? WHERE id = ?`).run(cmd.mode === "trial" ? "trial" : "committed", trialUntil, r.projectId);
  changes.push({ entityKind: "project", entityId: r.projectId, action: "create", after: { title: c.title, engagement: cmd.mode, trialUntil }, afterVersion: 1 });
  for (const id of r.taskIds) changes.push({ entityKind: "task", entityId: id, action: "create", after: { projectId: r.projectId }, afterVersion: 1 });
  changes.push({ entityKind: "candidate", entityId: c.id, action: "update", before: { status: c.status, projectId: null, startedWithUnknowns: c.startedWithUnknowns ? 1 : 0 }, after: { status: "started", projectId: r.projectId }, beforeVersion: c.version, afterVersion: c.version + 1 });
  bumpPlanningRevision();
  const first = tasks[0]!;
  const unknowns = r.startedWithUnknowns ? `还有没确认的条件：${c.requirements.filter((x) => !(x.status === "met" && x.confirmedByOwner)).map((x) => x.label).slice(0, 3).join("、") || "来源只有摘要"}，做的过程中留意。` : "";
  return cmd.mode === "trial"
    ? `开始试做「${c.title}」到 ${trialUntil}：第一步「${first.title}」${first.estimateMinutes ? `（预计 ${first.estimateMinutes} 分钟）` : ""}会进入安排。这只是试一试，不等于报名或对外承诺。${unknowns}`
    : `「${c.title}」转为正式投入，前 ${tasks.length} 步会进入安排。${unknowns}`;
}

/** 项目状态：暂停（任务一起放一放）/ 恢复 / 结束 / 试做转正式投入 */
export function applyProjectState(cmd: Cmd<"update_project_state">, _ctx: CommandContext, changes: ChangeInput[]): string {
  const db = getDb();
  const p = getProject(cmd.projectId);
  if (!p || p.archivedAt) throw new HttpError(404, "NOT_FOUND", "项目不存在");
  const parts: string[] = [];
  if (cmd.status && cmd.status !== p.status) {
    const updated = updateProject(cmd.projectId, { status: cmd.status }, p.version);
    if (updated === "conflict" || updated === "not_found") throw new HttpError(409, "CONFLICT", "项目刚被修改，请重试");
    changes.push({ entityKind: "project", entityId: p.id, action: "update", before: { status: p.status }, after: { status: cmd.status }, beforeVersion: p.version, afterVersion: updated.version });
    const tasks = db.prepare(`SELECT id, paused_until, version FROM tasks WHERE project_id = ? AND status IN ('todo','doing') AND archived_at IS NULL`).all(p.id) as Array<{ id: string; paused_until: string | null; version: number }>;
    const pausedUntil = cmd.status === "active" ? null : "9999-12-31";
    for (const t of tasks) {
      if ((t.paused_until ?? null) === pausedUntil) continue;
      db.prepare(`UPDATE tasks SET paused_until = ?, version = version + 1, updated_at = ? WHERE id = ?`).run(pausedUntil, now(), t.id);
      changes.push({ entityKind: "task", entityId: t.id, action: "update", before: { pausedUntil: t.paused_until ?? null }, after: { pausedUntil }, beforeVersion: t.version, afterVersion: t.version + 1 });
      if (pausedUntil) {
        const pending = db.prepare(`SELECT id, status, version FROM plan_sessions WHERE task_id = ? AND status IN ('tentative','planned')`).all(t.id) as Array<{ id: string; status: string; version: number }>;
        for (const s of pending) {
          db.prepare(`UPDATE plan_sessions SET status = 'superseded', version = version + 1, updated_at = ? WHERE id = ?`).run(now(), s.id);
          changes.push({ entityKind: "plan_session", entityId: s.id, action: "update", before: { status: s.status }, after: { status: "superseded" }, beforeVersion: s.version, afterVersion: s.version + 1 });
        }
      }
    }
    parts.push(cmd.status === "paused" ? `「${p.title}」先暂停，它的 ${tasks.length} 个任务不再排时间（项目和记录都保留）` : cmd.status === "completed" ? `「${p.title}」标记为结束` : `「${p.title}」恢复，任务会重新安排`);
  }
  if (cmd.engagement) {
    const row = db.prepare(`SELECT engagement, trial_until, version FROM projects WHERE id = ?`).get(p.id) as { engagement: string; trial_until: string | null; version: number };
    if (row.engagement !== cmd.engagement) {
      db.prepare(`UPDATE projects SET engagement = ?, trial_until = ?, version = version + 1, updated_at = ? WHERE id = ?`).run(cmd.engagement, cmd.engagement === "committed" ? null : row.trial_until, now(), p.id);
      changes.push({ entityKind: "project", entityId: p.id, action: "update", before: { engagement: row.engagement, trialUntil: row.trial_until }, after: { engagement: cmd.engagement, trialUntil: cmd.engagement === "committed" ? null : row.trial_until }, beforeVersion: row.version, afterVersion: row.version + 1 });
      parts.push(cmd.engagement === "committed" ? `「${p.title}」由试做转为正式投入（这是你在 Dash 里的安排，对外报名等仍需你自己去做）` : `「${p.title}」改为试做`);
    }
  }
  if (!changes.length) return `「${p.title}」没有变化`;
  bumpPlanningRevision();
  return parts.join("；");
}

/** 找候选项目：走已有的探索流程（检索有来源的资料 → 最多 3 个候选）。需要模型；没有搜索服务时要先贴资料 */
export function applyRequestExploration(cmd: Cmd<"request_exploration">): { summary: string; effectBatchId: string; effects: Array<{ kind: string; id: string }> } {
  const r = startExploration({ query: cmd.query, topicId: null, projectId: null, background: cmd.background, materials: [], resourceIds: [] });
  if (!r.ok) throw new HttpError(r.code === "NOT_FOUND" ? 404 : 409, r.code, r.message);
  return { summary: `开始为「${cmd.query.slice(0, 40)}」找候选项目：会检索有出处的资料，最多给 3 个候选，完成后出现在「方向」页。不会替你报名或承诺投入。`, effectBatchId: "", effects: [{ kind: "exploration_run", id: r.run.id }, { kind: "job", id: r.jobId }] };
}

/** 资料入库并标明归属与事实类型；默认是参考资料，不当成你自己的成果 */
export function applyLinkResource(cmd: Cmd<"link_resource">, ctx: CommandContext, changes: ChangeInput[]): string {
  const db = getDb();
  let resourceId = cmd.resourceId;
  let title = cmd.title ?? "";
  if (!resourceId) {
    if (!cmd.body?.trim() && !cmd.url) throw new HttpError(422, "VALIDATION", "资料需要正文或链接");
    const res = createResource({ kind: cmd.url && !cmd.body?.trim() ? "url" : "text", title: (cmd.title || cmd.body || cmd.url || "资料").slice(0, 60), body: cmd.body ?? "", url: cmd.url ?? null, sourceYear: null, sourceKind: "user_supplied" });
    resourceId = res.id;
    title = res.title;
    changes.push({ entityKind: "resource", entityId: res.id, action: "create", after: { title: res.title }, afterVersion: 1 });
  } else {
    const res = getResource(resourceId);
    if (!res || res.archivedAt) throw new HttpError(404, "NOT_FOUND", "这份资料不存在");
    title = res.title;
  }
  let target = "";
  if (cmd.projectId) {
    const p = getProject(cmd.projectId);
    if (!p || p.archivedAt) throw new HttpError(422, "INVALID_REFERENCE", "要关联的项目不存在");
    target = p.title;
  }
  const existing = db.prepare(`SELECT id, entity_kind, entity_id, role, origin, version FROM resource_links WHERE resource_id = ? ORDER BY created_at LIMIT 1`).get(resourceId) as
    | { id: string; entity_kind: string; entity_id: string | null; role: string; origin: string; version: number }
    | undefined;
  const entityKind = cmd.projectId ? "project" : (existing?.entity_kind ?? "none");
  const entityId = cmd.projectId ?? existing?.entity_id ?? null;
  const role = cmd.role ?? existing?.role ?? "reference";
  const origin = cmd.origin;
  if (existing) {
    // 主人纠正过的归属/类型，不被之后的自动判断覆盖
    if (existing.origin === "user" && origin !== "user") return `「${title}」的归属你之前纠正过，保持不变`;
    if (existing.entity_kind === entityKind && existing.entity_id === entityId && existing.role === role && existing.origin === origin) return `「${title}」没有变化`;
    db.prepare(`UPDATE resource_links SET entity_kind = ?, entity_id = ?, role = ?, origin = ?, version = version + 1, updated_at = ? WHERE id = ?`).run(entityKind, entityId, role, origin, now(), existing.id);
    changes.push({ entityKind: "resource_link", entityId: existing.id, action: "update", before: { entityKind: existing.entity_kind, entityId: existing.entity_id, role: existing.role, origin: existing.origin }, after: { entityKind, entityId, role, origin }, beforeVersion: existing.version, afterVersion: existing.version + 1 });
  } else {
    const id = crypto.randomUUID();
    db.prepare(`INSERT INTO resource_links (id, resource_id, entity_kind, entity_id, role, origin, locator, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, resourceId, entityKind, entityId, role, origin, ctx.intakeId ? `intake:${ctx.intakeId}` : "", now(), now());
    changes.push({ entityKind: "resource_link", entityId: id, action: "create", after: { resourceId, entityKind, entityId, role }, afterVersion: 1 });
  }
  const ROLE: Record<string, string> = { reference: "参考资料", requirement: "别人的要求（不算你的成果）", achievement: "你完成的成果" };
  return `「${title}」已存为${ROLE[role]}${target ? `，归到项目「${target}」` : ""}；原文保留`;
}
