import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getConfig } from "@/config";
import { LEGACY_MAX_BYTES, legacySnapshotSchema, type LegacyRequest, type LegacyApplyRequest, type LegacyItem, type LegacyPreview, type LegacyReceipt, type LegacyTask } from "@/contracts/legacy";
import { taskSchema, projectSchema } from "@/contracts/planning";
import { legacyHash, legacyInstant, legacyProjectKey, sanitizeLegacyTask } from "@/domain/legacy";
import { getDb } from "@/repositories/db";
import { createProject, createTask, getProject, getTask } from "@/repositories/planning";
import { createTaskLink, getMessageByExternalId, getSource, getTaskLink, listTaskLinks } from "@/repositories/inbox";
import { HttpError } from "@/workflows/http";

type Mapping = { source_id: string; kind: "project" | "task"; external_id: string; target_id: string; source_hash: string; source_json: string; upstream_external_id: string | null };

function rows(source: string): Mapping[] {
  return getDb().prepare("SELECT * FROM legacy_mappings WHERE source_id=? ORDER BY kind,external_id").all(source) as Mapping[];
}
function instance(source: string) {
  return getDb().prepare("SELECT timezone,campus_source_id FROM legacy_instances WHERE source_id=?").get(source) as { timezone: string; campus_source_id: string | null } | undefined;
}
function cleanTasks(request: LegacyRequest): LegacyTask[] {
  return request.snapshot.tasks.map(sanitizeLegacyTask).sort((a, b) => a.id - b.id);
}
function taskMapping(task: LegacyTask, timezone: string) {
  const warnings: string[] = [];
  const dueAt = legacyInstant(task.due_at, timezone, "截止时间", warnings);
  const completedAt = task.done ? legacyInstant(task.done_at, timezone, "完成时间", warnings) : null;
  const createdAt = legacyInstant(task.created_at, timezone, "创建时间", warnings);
  const updatedAt = legacyInstant(task.updated_at, timezone, "更新时间", warnings);
  if (task.start_at) warnings.push(`旧开始时间 ${task.start_at} 是时间窗口，保留来源记录；不作为执行排程`);
  if (task.done && !completedAt) warnings.push("旧完成记录无可靠完成时刻，完成时刻留空");
  if (task.done && task.external_id) warnings.push("旧同步将完成和取消都记为完成，本次沿用完成；上游状态需另行核对");
  if (task.priority === "low") warnings.push("低优先级映射为普通；原级别保留来源记录");
  if (task.quick || task.pinned) warnings.push("快速／置顶标记保留来源记录，新平台不生成置顶状态");
  if (task.title.length > 200 || task.note.length > 5000) warnings.push("标题或说明超出新平台长度，展示字段截短；完整脱敏内容保留来源记录");
  if (task.project.length > 200) warnings.push("项目展示名称截短，按原分组生成独立来源映射");
  return { warnings, dueAt, completedAt, createdAt, updatedAt };
}

/** 无写入；来源快照、策略、已有映射和目标版本共同构成确认指纹。 */
export function previewLegacy(request: LegacyRequest): LegacyPreview {
  const source = request.snapshot.sourceId, timezone = request.snapshot.timezone;
  if (request.campusSourceId && !getSource(request.campusSourceId)) throw new HttpError(422, "INVALID_SOURCE", "校园收件箱来源不存在");
  const priorInstance = instance(source);
  if (priorInstance && (priorInstance.timezone !== timezone || priorInstance.campus_source_id !== request.campusSourceId)) {
    throw new HttpError(409, "LEGACY_SOURCE_CHANGED", "同一旧实例的时区和校园来源绑定不能改写；请沿用首次导入配置");
  }
  const bound = request.campusSourceId ? getDb().prepare("SELECT source_id FROM legacy_instances WHERE campus_source_id=? AND source_id<>?").get(request.campusSourceId, source) : null;
  if (bound) throw new HttpError(409, "SOURCE_ALREADY_BOUND", "此校园来源已绑定另一旧实例");
  const tasks = cleanTasks(request);
  const upstreamIds = tasks.map((t) => t.external_id).filter((x): x is string => x !== null && x !== "");
  if (new Set(upstreamIds).size !== upstreamIds.length) throw new HttpError(422, "DUPLICATE_UPSTREAM", "快照含重复校园事项 ID，无法建立可靠关联");
  const mappings = rows(source), byKey = new Map(mappings.map((m) => [`${m.kind}:${m.external_id}`, m]));
  const items: LegacyItem[] = [];
  const targetStates: unknown[] = [];
  const evaluate = (kind: LegacyItem["kind"], externalId: string, title: string, raw: unknown, warnings: string[], mapped?: LegacyItem["mapped"]) => {
    const mapping = byKey.get(`${kind}:${externalId}`);
    const target = mapping ? kind === "task" ? getTask(mapping.target_id) : getProject(mapping.target_id) : null;
    targetStates.push([kind, externalId, target?.id ?? null, target?.version ?? null, target?.archivedAt ?? null]);
    const action = !mapping ? "create" : !target ? "conflict" : mapping.source_hash !== legacyHash(raw) ? "conflict" : "skip";
    const reason = !mapping ? "新来源记录" : !target ? "对应新记录已删除，不自动重建" : action === "conflict" ? "旧来源发生变化，保留新平台记录" : "此前已导入，保留当前记录及主人修改";
    const item: LegacyItem = { kind, sourceId: externalId, title, targetId: mapping?.target_id ?? null, action, reason, mapped, warnings };
    if (target) item.current = { title: target.title, status: target.status, archived: !!target.archivedAt,
      due: "due" in target ? target.due.kind === "instant" ? target.due.at : target.due.kind === "date" ? target.due.localDate : null : null };
    items.push(item);
    return item;
  };
  for (const name of [...new Set(tasks.map((t) => t.project).filter(Boolean))].sort()) {
    evaluate("project", legacyProjectKey(name), name.trim().slice(0, 200), { name }, name.length > 200 ? ["名称展示截短，原分组完整保留"] : []);
  }
  for (const task of tasks) {
    const map = taskMapping(task, timezone);
    const original = request.snapshot.tasks.find((t) => t.id === task.id)!;
    if (JSON.stringify(original) !== JSON.stringify(task)) map.warnings.push("检测到链接或文本凭证，导入前已移除；受保护图片需在原系统查看");
    const item = evaluate("task", String(task.id), task.title.trim().slice(0, 200), task, map.warnings, {
      status: task.done ? "done" : "todo", priority: task.priority === "high" ? "high" : "normal",
      project: task.project, due: map.dueAt, completedAt: map.completedAt,
    });
    if (item.action === "create" && task.project) {
      const project = items.find((i) => i.kind === "project" && i.sourceId === legacyProjectKey(task.project));
      const existingProject = project?.targetId ? getProject(project.targetId) : null;
      if ((project?.targetId && !existingProject) || existingProject?.archivedAt) {
        item.action = "conflict"; item.reason = "原项目对应的新项目已删除或归档，暂不创建子任务";
      }
    }
    if (request.campusSourceId && task.external_id) {
      const message = getMessageByExternalId(request.campusSourceId, task.external_id);
      const links = message ? listTaskLinks(message.id) : [];
      targetStates.push(["campus", task.external_id, message?.currentRevisionId ?? null, links]);
      if (item.action === "create" && links.length) {
        item.action = "conflict"; item.reason = "此校园事项已关联新平台任务，暂不创建重复任务";
      }
    }
  }
  const previewHash = legacyHash({ source, timezone, campusSourceId: request.campusSourceId, reminders: request.enableFutureReminders, tasks, mappings, priorInstance: priorInstance ?? null, targetStates });
  return { previewHash, sourceId: source, timezone, campusSourceId: request.campusSourceId, enableFutureReminders: request.enableFutureReminders, items,
    counts: { projects: items.filter((i) => i.kind === "project").length, tasks: tasks.length,
      create: items.filter((i) => i.action === "create").length, skip: items.filter((i) => i.action === "skip").length,
      conflict: items.filter((i) => i.action === "conflict").length, warnings: items.filter((i) => i.warnings.length).length } };
}

export function applyLegacy(request: LegacyApplyRequest): LegacyReceipt {
  const db = getDb();
  return db.transaction(() => {
    const preview = previewLegacy(request);
    if (preview.previewHash !== request.previewHash) throw new HttpError(409, "PREVIEW_STALE", "来源、策略或目标记录已变化，请重新预览后确认");
    const now = new Date().toISOString(), source = request.snapshot.sourceId;
    db.prepare("INSERT OR IGNORE INTO legacy_instances(source_id,timezone,campus_source_id,created_at) VALUES(?,?,?,?)").run(source, request.snapshot.timezone, request.campusSourceId, now);
    const created: LegacyReceipt["created"] = [];
    const writeMapping = (kind: "project" | "task", externalId: string, targetId: string, raw: unknown, upstreamId: string | null = null) => {
      db.prepare("INSERT INTO legacy_mappings(source_id,kind,external_id,target_id,source_hash,source_json,upstream_external_id,created_at) VALUES(?,?,?,?,?,?,?,?)")
        .run(source, kind, externalId, targetId, legacyHash(raw), JSON.stringify(raw), upstreamId, now);
      created.push({ kind, sourceId: externalId, targetId });
    };
    const tasks = cleanTasks(request);
    for (const item of preview.items.filter((i) => i.kind === "project" && i.action === "create")) {
      const name = tasks.find((t) => legacyProjectKey(t.project) === item.sourceId)!.project;
      const project = createProject(projectSchema.parse({ title: item.title }));
      writeMapping("project", item.sourceId, project.id, { name });
    }
    const projects = new Map(rows(source).filter((m) => m.kind === "project").map((m) => [m.external_id, m.target_id]));
    for (const item of preview.items.filter((i) => i.kind === "task" && i.action === "create")) {
      const raw = tasks.find((t) => String(t.id) === item.sourceId)!;
      const mapped = taskMapping(raw, request.snapshot.timezone);
      const task = createTask(taskSchema.parse({ title: item.title, description: raw.note.slice(0, 5000),
        status: raw.done ? "done" : "todo", priority: raw.priority === "high" ? "high" : "normal",
        projectId: raw.project ? projects.get(legacyProjectKey(raw.project)) ?? null : null,
        due: mapped.dueAt ? { kind: "instant", at: mapped.dueAt, timezone: request.snapshot.timezone } : { kind: "none" },
      }), { scheduleReminders: request.enableFutureReminders });
      // 不把导入日伪装成历史完成日；不会改写已存在任务。
      db.prepare("UPDATE tasks SET created_at=?,updated_at=?,completed_at=? WHERE id=?")
        .run(mapped.createdAt ?? now, mapped.updatedAt ?? now, mapped.completedAt, task.id);
      writeMapping("task", String(raw.id), task.id, raw, raw.external_id);
      if (request.campusSourceId && raw.external_id) {
        const message = getMessageByExternalId(request.campusSourceId, raw.external_id);
        if (message?.currentRevisionId) linkLegacyCampusTask(request.campusSourceId, raw.external_id, message.id, message.currentRevisionId);
      }
    }
    const receipt: LegacyReceipt = { id: crypto.randomUUID(), sourceId: source, createdAt: now, preview, created };
    db.prepare("INSERT INTO legacy_imports(id,source_id,preview_hash,report_json,created_at) VALUES(?,?,?,?,?)").run(receipt.id, source, preview.previewHash, JSON.stringify(receipt), now);
    return receipt;
  }).immediate();
}

/** 主人导入时明确绑定的 source，token 只能为该 source 追加关联；绝不改任务正文或状态。 */
export function linkLegacyCampusTask(sourceId: string, upstreamId: string, messageId: string, revisionId: string): boolean {
  const mappings = getDb().prepare(`SELECT m.* FROM legacy_mappings m JOIN legacy_instances i ON i.source_id=m.source_id
    WHERE i.campus_source_id=? AND m.kind='task' AND m.upstream_external_id=?`).all(sourceId, upstreamId) as Mapping[];
  if (mappings.length !== 1 || !getTask(mappings[0].target_id)) return false;
  if (getTaskLink(messageId, "primary")) return false;
  createTaskLink({ messageId, actionKey: "primary", taskId: mappings[0].target_id, revisionId });
  return true;
}

export function listLegacyReceipts(): LegacyReceipt[] {
  return (getDb().prepare("SELECT report_json FROM legacy_imports ORDER BY created_at DESC,id DESC LIMIT 10").all() as { report_json: string }[]).map((r) => JSON.parse(r.report_json));
}
export function getLegacyReceipt(id: string): LegacyReceipt | null {
  const row = getDb().prepare("SELECT report_json FROM legacy_imports WHERE id=?").get(id) as { report_json: string } | undefined;
  return row ? JSON.parse(row.report_json) : null;
}
export function listLegacyInstances(): Array<{ sourceId: string; timezone: string; campusSourceId: string | null }> {
  return getDb().prepare("SELECT source_id AS sourceId,timezone,campus_source_id AS campusSourceId FROM legacy_instances ORDER BY source_id").all() as Array<{ sourceId: string; timezone: string; campusSourceId: string | null }>;
}
export function serverLegacySnapshot() {
  const file = path.join(path.dirname(path.resolve(getConfig().DATABASE_PATH)), "legacy", "todo.snapshot.json");
  try {
    if (fs.statSync(file).size > LEGACY_MAX_BYTES) throw new HttpError(413, "TOO_LARGE", "服务器快照超过 10 MiB");
    const parsed = legacySnapshotSchema.safeParse(JSON.parse(fs.readFileSync(file, "utf8")));
    if (!parsed.success) throw new HttpError(422, "INVALID_SNAPSHOT", "服务器快照格式不兼容，请重新生成");
    return { ...parsed.data, tasks: parsed.data.tasks.map(sanitizeLegacyTask) };
  } catch (e) {
    if (e instanceof HttpError) throw e;
    if ((e as NodeJS.ErrnoException).code === "ENOENT") throw new HttpError(404, "SNAPSHOT_NOT_FOUND", "尚未生成服务器快照，请按迁移说明运行只读快照工具");
    throw new HttpError(422, "INVALID_SNAPSHOT", "服务器快照不可读取，请检查格式和文件权限");
  }
}
