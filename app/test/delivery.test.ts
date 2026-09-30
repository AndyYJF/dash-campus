import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test, before } from "node:test";
import { migrateAll, getDb } from "./helpers";
import { EXPECTED_SCHEMA_VERSION, schemaProblem } from "@/repositories/db";
import { listMigrations } from "@/scripts/migrate-lib";
import { createProject, createTask, updateTask, getTask } from "@/repositories/planning";
import { createArtifact, createLog } from "@/repositories/logs";
import { createOwner, createSession } from "@/domain/session";
import { hashPassword } from "@/domain/password";
import { setMailerForTests, type Mailer, type MailPayload } from "@/integrations/mailer";
import { setProvidersForTests } from "@/integrations";
import { fixtureModelProvider } from "@/integrations/fixtures";
import { claimDueJobs, getJob, listJobs } from "@/repositories/jobs";
import { runDueJobsOnce } from "@/worker/runner";
import { applyRestoreHold, restoreStatus, resumeAfterRestore } from "@/workflows/restore";
import { isRestoredHold } from "@/repositories/instance";
import { startAssistant, startReview } from "@/workflows/review";
import { startExploration } from "@/workflows/exploration";
import { buildFullJson, buildProjectReport, createExport, deleteExport, readExportFile, sweepExpiredExports } from "@/workflows/exports";
import { FULL_JSON_EXCLUDED, FULL_JSON_TABLES } from "@/contracts/exports";
import { REMINDER_JOB_TYPE } from "@/contracts/jobs";

before(migrateAll);

class CaptureMailer implements Mailer {
  sent: MailPayload[] = [];
  async send(m: MailPayload) {
    this.sent.push(m);
    return { ok: true as const, response: "250 ok" };
  }
}

function project(title = "阶段项目") {
  return createProject({ title, question: "能不能做出一个小工具", expectedOutcome: "可演示的原型", prerequisites: "", reviewQuestions: "", goalIds: [] });
}

function task(title: string, dueInHours: number | null, projectId: string | null = null) {
  return createTask({
    title,
    description: "",
    projectId,
    goalId: null,
    status: "todo",
    priority: "normal",
    estimateMinutes: 30,
    plannedWeek: null,
    scheduledStart: null,
    scheduledEnd: null,
    due:
      dueInHours === null
        ? { kind: "none" }
        : { kind: "instant", at: new Date(Date.now() + dueInHours * 3600_000).toISOString(), timezone: "UTC" },
  });
}

let logSeq = 0;
function log(projectId: string, progress: string, blocker = "") {
  const r = createLog({
    clientEntryId: `00000000-0000-4000-8000-${String(++logSeq).padStart(12, "0")}`,
    occurredOn: `2026-09-${String(10 + logSeq).padStart(2, "0")}`,
    progress,
    blocker,
    taskId: null,
    projectId,
  });
  assert.ok(r !== "content_conflict");
  return r.log;
}

test("schema：应用要求版本 = 最新迁移编号，库版本一致时无问题", () => {
  const latest = listMigrations().at(-1)!.version;
  assert.equal(EXPECTED_SCHEMA_VERSION, latest);
  assert.equal(schemaProblem(), null);
  getDb().prepare(`UPDATE schema_version SET version = ? WHERE id = 1`).run(latest - 1);
  assert.match(schemaProblem()!, /低于应用要求/);
  getDb().prepare(`UPDATE schema_version SET version = ? WHERE id = 1`).run(latest + 1);
  assert.match(schemaProblem()!, /高于应用支持/);
  getDb().prepare(`UPDATE schema_version SET version = ? WHERE id = 1`).run(latest);
});

test("F18 阶段报告：只含选中的记录与成果，缺失字段留空不编造", () => {
  const p = project();
  const l1 = log(p.id, "搭好了项目骨架");
  log(p.id, "未选中的记录：不该出现");
  const l3 = log(p.id, "", "接口文档看不懂");
  const a1 = createArtifact({ projectId: p.id, logId: null, kind: "link", title: "原型仓库", body: "", url: "https://example.org/repo" });
  assert.ok(a1 !== "invalid_url");
  createArtifact({ projectId: p.id, logId: null, kind: "text", title: "未选成果", body: "x", url: null });
  const other = project("别的项目");
  const foreign = log(other.id, "别的项目的记录");

  const r = buildProjectReport({
    projectId: p.id,
    fields: ["goal", "actions", "artifacts", "difficulties", "nextSteps"],
    selectedLogIds: [l1.id, l3.id, foreign.id],
    selectedArtifactIds: [a1.id],
  });
  assert.ok(r.ok);
  assert.match(r.markdown, /搭好了项目骨架/);
  assert.match(r.markdown, /接口文档看不懂/);
  assert.match(r.markdown, /\[原型仓库\]\(https:\/\/example\.org\/repo\)/);
  assert.doesNotMatch(r.markdown, /未选中的记录|未选成果|别的项目的记录/);
  assert.deepEqual(r.ignoredIds, [foreign.id], "不属于该项目的 ID 被忽略并告知");
  assert.deepEqual(r.missing, ["nextSteps"], "没有未完成任务：下一步留空");
  assert.match(r.markdown, /## 下一步\n\n（未填写）/);

  // 不选记录：行动与困难留空
  const empty = buildProjectReport({ projectId: p.id, fields: ["actions", "difficulties"], selectedLogIds: [], selectedArtifactIds: [] });
  assert.ok(empty.ok);
  assert.deepEqual(empty.missing, ["actions", "difficulties"]);
});

test("F18 full_json：不含凭证、会话与投递队列，保留业务 ID", () => {
  createOwner(hashPassword("export-pass-123"));
  const { token } = createSession(1);
  const p = project("导出项目");
  const t = task("导出任务", 48, p.id);
  const json = buildFullJson(new Date().toISOString());
  const data = JSON.parse(json) as { tables: Record<string, Array<Record<string, unknown>>> };
  for (const name of FULL_JSON_EXCLUDED) assert.equal(data.tables[name], undefined, `${name} 不导出`);
  assert.ok(data.tables.tasks.some((x) => x.id === t.id && x.project_id === p.id), "业务关系 ID 保留");
  assert.equal(json.includes(token), false, "会话 token 不出现");
  assert.doesNotMatch(json, /password_hash|token_hash|csrf_token|lease_token|token_digest/);
  // 白名单覆盖所有表：新增表必须显式决定导出还是排除
  const all = (getDb().prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`).all() as Array<{ name: string }>).map((r) => r.name);
  const classified = new Set([...Object.keys(FULL_JSON_TABLES), ...FULL_JSON_EXCLUDED]);
  assert.deepEqual(all.filter((n) => !classified.has(n)), []);
});

test("F18 导出文件：下载只读已生成文件；过期 410；删除后 404", () => {
  const p = project("文件项目");
  const now = new Date();
  const r = createExport({ type: "project_markdown", projectId: p.id, fields: ["goal"], selectedLogIds: [], selectedArtifactIds: [], editedMarkdown: "# 我改过的报告\n" }, now);
  assert.ok(r.ok);
  assert.equal(r.export.status, "ready");
  const d = readExportFile(r.export.id, now);
  assert.ok(d.ok);
  assert.equal(d.body.toString("utf8"), "# 我改过的报告\n", "主人编辑过的正文原样导出");

  // 到期：410，且 GET 不改变状态；清理后文件被删
  const later = new Date(now.getTime() + 25 * 3600_000);
  const gone = readExportFile(r.export.id, later);
  assert.ok(!gone.ok && gone.status === 410);
  const row = getDb().prepare(`SELECT status, private_path FROM exports WHERE id = ?`).get(r.export.id) as { status: string; private_path: string };
  assert.equal(row.status, "ready");
  assert.equal(sweepExpiredExports(later), 1);
  assert.equal(fs.existsSync(row.private_path), false);
  const after = readExportFile(r.export.id, later);
  assert.ok(!after.ok && after.status === 410);

  const r2 = createExport({ type: "full_json" }, now);
  assert.ok(r2.ok);
  const p2 = (getDb().prepare(`SELECT private_path FROM exports WHERE id = ?`).get(r2.export.id) as { private_path: string }).private_path;
  assert.equal(path.basename(path.dirname(p2)), "exports");
  assert.ok(deleteExport(r2.export.id));
  assert.equal(fs.existsSync(p2), false);
  const del = readExportFile(r2.export.id, now);
  assert.ok(!del.ok && del.status === 404);
});

test("F14 恢复旧备份：hold 期间无任何外部请求；确认后只重建未来提醒", async () => {
  const mailer = new CaptureMailer();
  setMailerForTests(mailer);
  setProvidersForTests({ model: { provider: fixtureModelProvider(), mode: "fixture" }, search: undefined });
  process.env.MAIL_TO = "owner@example.org";

  // 备份时的状态：一条已到期待发的提醒（备份后其实已发送过）、一条未来提醒、一条 submitting 投递
  const sentAfterBackup = task("备份后已发的提醒", 30); // 触发点 = 截止前 24h = 6 小时后
  const future = task("未来提醒", 72);
  const noDue = task("无截止", null);
  const dueJob = listJobs({ type: REMINDER_JOB_TYPE, taskId: sentAfterBackup.id })[0];
  getDb().prepare(`UPDATE jobs SET run_at = ? WHERE id = ?`).run("2020-01-01T00:00:00.000Z", dueJob.id);
  getDb()
    .prepare(
      `INSERT INTO deliveries (id, job_id, task_id, request_id, lease_token, reminder_revision, recipient, subject, snapshot_json, status, attempt, created_at, updated_at)
       VALUES ('d-submitting', ?, ?, 'req-x', 'tok', 0, 'owner@example.org', 's', '{}', 'submitting', 1, ?, ?)`,
    )
    .run(dueJob.id, sentAfterBackup.id, new Date().toISOString(), new Date().toISOString());

  // restore 命令：进程启动前写入 hold
  const h = applyRestoreHold(getDb(), "/backups/test", new Date().toISOString());
  assert.ok(isRestoredHold());
  assert.ok(h.heldJobs >= 2);
  assert.equal(h.deploymentEpoch, 1);
  assert.equal(
    (getDb().prepare(`SELECT status FROM deliveries WHERE id = 'd-submitting'`).get() as { status: string }).status,
    "unknown",
    "submitting 统一为 unknown",
  );

  // hold：worker 不领取、不发送；Web 入口拒绝外部动作
  const stats = await runDueJobsOnce(5);
  assert.equal(stats.claimed, 0);
  assert.equal(stats.held, true);
  assert.equal(claimDueJobs("2099-01-01T00:00:00.000Z", 50).length, 0, "挂起的旧 job 不可领取");
  assert.equal(mailer.sent.length, 0, "hold 状态无邮件请求");
  const a = startAssistant({ scopeType: "week", scopeId: null, question: "q", logId: null, rerun: false });
  assert.ok(!a.ok && a.code === "RESTORED_HOLD");
  const rv = startReview(null);
  assert.ok(!rv.ok && rv.code === "RESTORED_HOLD");
  const ex = startExploration({ query: "q", topicId: null, projectId: null, background: "", materials: [{ title: "m", text: "t", url: null }] } as never);
  assert.ok(!ex.ok && ex.code === "RESTORED_HOLD");

  const st = restoreStatus();
  assert.ok(st.hold);
  assert.ok(st.heldJobs.some((j) => j.id === dueJob.id));

  // 主人确认后 resume：旧 job 取消；未来提醒按当前任务重建；过去的不补发
  const r = resumeAfterRestore();
  assert.ok(r.ok);
  assert.equal(isRestoredHold(), false);
  assert.equal(getJob(dueJob.id)!.status, "cancelled");
  const fresh = listJobs({ type: REMINDER_JOB_TYPE, status: "queued" });
  assert.ok(fresh.some((j) => j.taskId === future.id && j.runAt > new Date().toISOString()), "未来提醒已重建");
  assert.ok(fresh.some((j) => j.taskId === sentAfterBackup.id && j.runAt > new Date().toISOString()), "触发点仍在未来的按当前任务重建");
  assert.ok(!fresh.some((j) => j.taskId === noDue.id));
  assert.ok(fresh.every((j) => j.runAt > new Date().toISOString()), "只有触发时间晚于恢复启用时点的提醒");
  assert.equal(
    (getDb().prepare(`SELECT status FROM deliveries WHERE id = 'd-submitting'`).get() as { status: string }).status,
    "unknown",
    "不从旧备份推断是否已送达",
  );

  // resume 后 worker 恢复正常；到期前不发
  await runDueJobsOnce(5);
  assert.equal(mailer.sent.length, 0);
  // 再次 resume 为无操作
  assert.deepEqual(resumeAfterRestore(), { ok: false, reason: "not_on_hold" });
  setMailerForTests(null);
});

test("F14 hold 期间主人改期：resume 保留新 revision 的提醒，不重复建", () => {
  const t = task("hold 期间改期", 96);
  applyRestoreHold(getDb(), "/backups/test2");
  const moved = updateTask(t.id, { due: { kind: "instant", at: new Date(Date.now() + 120 * 3600_000).toISOString(), timezone: "UTC" } }, t.version);
  assert.ok(typeof moved === "object");
  const r = resumeAfterRestore();
  assert.ok(r.ok);
  const cur = getTask(t.id)!;
  const q = listJobs({ type: REMINDER_JOB_TYPE, taskId: t.id, status: "queued" });
  assert.equal(q.length, 1);
  assert.equal((q[0].payload as { reminderRevision: number }).reminderRevision, cur.reminderRevision);
});
