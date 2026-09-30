import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { getDb, getSchemaVersion } from "@/repositories/db";
import { getConfig } from "@/config";
import { getGoal, getProject, listTasks } from "@/repositories/planning";
import { listArtifacts, listLogs } from "@/repositories/logs";
import { getProjectExploration } from "@/workflows/candidates";
import {
  EXPORT_TTL_MS,
  FULL_JSON_SETTINGS_OMIT_KEYS,
  FULL_JSON_TABLES,
  REPORT_FIELD_LABEL,
  type ExportRequest,
  type ReportField,
  reportPreviewSchema,
} from "@/contracts/exports";
import pkg from "../../package.json";

/**
 * 导出（计划 9 节 /exports、F18）。
 * 文件写到实例私有目录（数据库同级 exports/），24 小时过期；下载只读已生成文件，不重新生成。
 * 生成是本地同步计算、无外部调用，因此 POST 直接完成并返回 202 + 状态 ready（语义与计划一致：202 不代表下载过）。
 */

export type ExportRow = {
  id: string;
  type: "project_markdown" | "full_json";
  selected: Record<string, unknown>;
  status: "ready" | "failed" | "expired" | "deleted";
  fileName: string;
  byteSize: number | null;
  expiresAt: string;
  error: string | null;
  createdAt: string;
};

export function exportsDir(): string {
  return path.join(path.dirname(path.resolve(getConfig().DATABASE_PATH)), "exports");
}

function mapExport(r: Record<string, unknown>): ExportRow {
  return {
    id: r.id as string,
    type: r.type as ExportRow["type"],
    selected: JSON.parse(r.selected_json as string) as Record<string, unknown>,
    status: r.status as ExportRow["status"],
    fileName: r.file_name as string,
    byteSize: (r.byte_size as number | null) ?? null,
    expiresAt: r.expires_at as string,
    error: (r.error as string | null) ?? null,
    createdAt: r.created_at as string,
  };
}

function rawExport(id: string): Record<string, unknown> | undefined {
  return getDb().prepare(`SELECT * FROM exports WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
}

export function getExport(id: string): ExportRow | null {
  const r = rawExport(id);
  return r ? mapExport(r) : null;
}

export function listExports(): ExportRow[] {
  return (
    getDb().prepare(`SELECT * FROM exports WHERE status != 'deleted' ORDER BY created_at DESC LIMIT 20`).all() as Array<
      Record<string, unknown>
    >
  ).map(mapExport);
}

// ===== 阶段报告 =====

export type ReportSelection = z.infer<typeof reportPreviewSchema>;

export type ReportPreview =
  | { ok: true; markdown: string; missing: ReportField[]; ignoredIds: string[] }
  | { ok: false; code: "NOT_FOUND" | "VALIDATION"; message: string };

const EMPTY = "（未填写）";

/** 只用主人选中的字段、记录与成果；不在库里的内容留空说明，不编造 */
export function buildProjectReport(sel: ReportSelection): ReportPreview {
  const project = getProject(sel.projectId);
  if (!project) return { ok: false, code: "NOT_FOUND", message: "项目不存在" };
  const logsById = new Map(listLogs({ projectId: project.id }).map((l) => [l.id, l]));
  const artsById = new Map(listArtifacts(project.id).map((a) => [a.id, a]));
  // 选中的 ID 必须属于该项目；不属于的忽略并告知
  const ignoredIds = [
    ...sel.selectedLogIds.filter((id) => !logsById.has(id)),
    ...sel.selectedArtifactIds.filter((id) => !artsById.has(id)),
  ];
  const logs = sel.selectedLogIds
    .map((id) => logsById.get(id))
    .filter((l): l is NonNullable<typeof l> => Boolean(l))
    .sort((a, b) => a.occurredOn.localeCompare(b.occurredOn));
  const arts = sel.selectedArtifactIds.map((id) => artsById.get(id)).filter((a): a is NonNullable<typeof a> => Boolean(a));
  const exploration = getProjectExploration(project.id);
  const missing: ReportField[] = [];
  const out: string[] = [`# ${project.title}`, ""];

  for (const f of sel.fields) {
    out.push(`## ${REPORT_FIELD_LABEL[f]}`, "");
    const lines: string[] = [];
    if (f === "goal") {
      for (const gid of project.goalIds) {
        const g = getGoal(gid);
        if (g && !g.archivedAt) lines.push(`- 目标：${g.title}${g.reason ? `（理由：${g.reason}）` : ""}`);
      }
      if (project.question) lines.push(`- 想验证的问题：${project.question}`);
      if (project.expectedOutcome) lines.push(`- 预期产出：${project.expectedOutcome}`);
    } else if (f === "actions") {
      for (const l of logs) if (l.progress) lines.push(`- ${l.occurredOn}：${l.progress}`);
    } else if (f === "artifacts") {
      for (const a of arts) {
        lines.push(a.url ? `- [${a.title}](${a.url})${a.body ? `：${a.body}` : ""}` : `- ${a.title}${a.body ? `：${a.body}` : ""}`);
      }
    } else if (f === "difficulties") {
      for (const l of logs) if (l.blocker) lines.push(`- ${l.occurredOn}：${l.blocker}`);
      if (exploration?.conclusionReason) lines.push(`- 结束判断的理由：${exploration.conclusionReason}`);
    } else if (f === "nextSteps") {
      for (const t of listTasks({ projectId: project.id })) {
        if (!t.archivedAt && ["todo", "doing", "blocked"].includes(t.status)) lines.push(`- ${t.title}`);
      }
    }
    if (lines.length === 0) {
      missing.push(f);
      out.push(EMPTY);
    } else {
      out.push(...lines);
    }
    out.push("");
  }
  return { ok: true, markdown: out.join("\n").trimEnd() + "\n", missing, ignoredIds };
}

// ===== 全量 JSON =====

export function buildFullJson(nowIso: string): string {
  const db = getDb();
  const tables: Record<string, unknown[]> = {};
  for (const [table, rule] of Object.entries(FULL_JSON_TABLES)) {
    let rows = db.prepare(`SELECT * FROM ${table}`).all() as Array<Record<string, unknown>>;
    if (table === "settings") rows = rows.filter((r) => !FULL_JSON_SETTINGS_OMIT_KEYS.includes(r.key as string));
    tables[table] = rows.map((r) => {
      const copy = { ...r };
      for (const c of rule.omit ?? []) delete copy[c];
      return copy;
    });
  }
  return JSON.stringify(
    {
      format: "dash-campus.full_json",
      formatVersion: 1,
      exportedAt: nowIso,
      appVersion: pkg.version,
      schemaVersion: getSchemaVersion(db),
      timezone: getConfig().APP_TIMEZONE,
      note: "个人业务数据导出，保留业务关系 ID；不含密码、会话、集成凭证、后台投递队列。不是可公开的报告。",
      tables,
    },
    null,
    2,
  );
}

// ===== 创建 / 下载 / 删除 =====

export type CreateExportResult =
  | { ok: true; export: ExportRow; missing?: ReportField[]; ignoredIds?: string[] }
  | { ok: false; status: number; code: string; message: string };

/** 同步：在调用方事务内写库；文件先写临时名再改名，失败时记录 failed */
export function createExport(req: ExportRequest, now = new Date()): CreateExportResult {
  const nowIso = now.toISOString();
  const id = crypto.randomUUID();
  let content: string;
  let fileName: string;
  let selected: Record<string, unknown>;
  let extra: { missing?: ReportField[]; ignoredIds?: string[] } = {};
  if (req.type === "project_markdown") {
    const r = buildProjectReport(req);
    if (!r.ok) return { ok: false, status: r.code === "NOT_FOUND" ? 404 : 422, code: r.code, message: r.message };
    content = req.editedMarkdown ?? r.markdown;
    fileName = `project-report-${nowIso.slice(0, 10)}.md`;
    selected = {
      projectId: req.projectId,
      fields: req.fields,
      selectedLogIds: req.selectedLogIds,
      selectedArtifactIds: req.selectedArtifactIds,
      edited: req.editedMarkdown !== null,
    };
    extra = { missing: r.missing, ignoredIds: r.ignoredIds };
  } else {
    content = buildFullJson(nowIso);
    fileName = `dash-campus-${nowIso.slice(0, 10)}.json`;
    selected = {};
  }

  const dir = exportsDir();
  const privatePath = path.join(dir, `${id}${req.type === "full_json" ? ".json" : ".md"}`);
  let status: ExportRow["status"] = "ready";
  let error: string | null = null;
  let size: number | null = null;
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmp = `${privatePath}.tmp`;
    fs.writeFileSync(tmp, content, { encoding: "utf8", mode: 0o600 });
    fs.renameSync(tmp, privatePath);
    size = Buffer.byteLength(content, "utf8");
  } catch (e) {
    status = "failed";
    error = e instanceof Error ? e.message : "写入导出文件失败";
  }
  getDb()
    .prepare(
      `INSERT INTO exports (id, type, selected_json, status, file_name, private_path, byte_size, expires_at, error, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      req.type,
      JSON.stringify(selected),
      status,
      fileName,
      status === "ready" ? privatePath : null,
      size,
      new Date(now.getTime() + EXPORT_TTL_MS).toISOString(),
      error,
      nowIso,
    );
  return { ok: true, export: getExport(id)!, ...extra };
}

export type DownloadResult =
  | { ok: true; fileName: string; contentType: string; body: Buffer }
  | { ok: false; status: 404 | 410; code: string; message: string };

export function readExportFile(id: string, now = new Date()): DownloadResult {
  const r = rawExport(id);
  if (!r || r.status === "deleted") return { ok: false, status: 404, code: "NOT_FOUND", message: "导出不存在" };
  const row = mapExport(r);
  // 只读：到期文件由 sweepExpiredExports 清理，GET 不改变状态
  if (row.status === "expired" || row.expiresAt <= now.toISOString()) {
    return { ok: false, status: 410, code: "GONE", message: "导出已过期（保存 24 小时），请重新导出" };
  }
  if (row.status !== "ready" || !r.private_path) {
    return { ok: false, status: 404, code: "NOT_FOUND", message: row.error ?? "导出文件不可用" };
  }
  try {
    return {
      ok: true,
      fileName: row.fileName,
      contentType: row.type === "full_json" ? "application/json; charset=utf-8" : "text/markdown; charset=utf-8",
      body: fs.readFileSync(r.private_path as string),
    };
  } catch {
    return { ok: false, status: 410, code: "GONE", message: "导出文件已被清理，请重新导出" };
  }
}

function removeFile(p: unknown): void {
  if (typeof p !== "string") return;
  // 只删除导出目录内的文件（路径来自库，仍做边界校验）
  const dir = exportsDir();
  const resolved = path.resolve(p);
  if (path.dirname(resolved) !== dir) return;
  fs.rmSync(resolved, { force: true });
}

function expireExport(id: string): void {
  const r = rawExport(id);
  if (!r) return;
  removeFile(r.private_path);
  getDb().prepare(`UPDATE exports SET status = 'expired', private_path = NULL WHERE id = ? AND status = 'ready'`).run(id);
}

export function deleteExport(id: string): boolean {
  const r = rawExport(id);
  if (!r || r.status === "deleted") return false;
  removeFile(r.private_path);
  getDb().prepare(`UPDATE exports SET status = 'deleted', private_path = NULL WHERE id = ?`).run(id);
  return true;
}

/** 清理过期导出文件（worker 每趟与列表读取时调用；幂等） */
export function sweepExpiredExports(now = new Date()): number {
  const rows = getDb()
    .prepare(`SELECT id FROM exports WHERE status = 'ready' AND expires_at <= ?`)
    .all(now.toISOString()) as Array<{ id: string }>;
  for (const r of rows) expireExport(r.id);
  return rows.length;
}
