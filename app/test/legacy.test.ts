import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { before, test } from "node:test";
import { migrateAll, getDb } from "./helpers";
import { legacyPreviewRequestSchema, legacySnapshotSchema, type LegacyRequest } from "@/contracts/legacy";
import { previewLegacy, applyLegacy } from "@/workflows/legacy";
import { createProject, getTask, updateTask, getProject, archiveProject } from "@/repositories/planning";
import { projectSchema } from "@/contracts/planning";
import { createSource, getTaskLink, getMessage, getRevision, getDecisionByRevision } from "@/repositories/inbox";
import { campusTaskSchema, campusEnvelope, campusEvidenceText } from "@/domain/campus-bridge";
import { importCampusNotice } from "@/workflows/campus-bridge";
import { legacyInstant, redactLegacyText } from "@/domain/legacy";
import { readTodoSnapshot, writeTodoSnapshot } from "@/scripts/legacy-snapshot";
import { buildFullJson } from "@/workflows/exports";
import { HttpError } from "@/workflows/http";
import { readLegacyBody } from "@/workflows/legacy-http";
import { setProvidersForTests } from "@/integrations";
import { fixtureModelProvider } from "@/integrations/fixtures";
import { claimDueJobs } from "@/repositories/jobs";
import { runNoticeExtractionJob } from "@/workflows/notice-extraction";
import { NextRequest } from "next/server";
import { createOwner, createSession, SESSION_COOKIE } from "@/domain/session";
import { POST as previewRoute } from "@/app/api/v1/legacy/preview/route";
import { POST as applyRoute } from "@/app/api/v1/legacy/apply/route";
import { campusEvidenceOccurredAt } from "@/domain/campus-bridge";
import { resolveProfile } from "@/workflows/inbox";
import { evaluateCondition } from "@/domain/conditions";
import { factsMap } from "@/repositories/profile";
import { listMessagePage, setMessageStatus } from "@/repositories/inbox";
import { importVerifiedNotice } from "@/workflows/inbox";
import { GET as receiptDownloadRoute } from "@/app/api/v1/legacy/imports/[id]/download/route";

before(migrateAll);
test("入学年份与当前年级独立，缺失当前年级不由入学年份推算", () => {
  const leaf = { kind: "leaf" as const, field: "study_year", op: "eq" as const, value: "一年级", quote: "一年级" };
  assert.equal(evaluateCondition(leaf, { grade_year: "2026" }), "UNKNOWN");
  const out=resolveProfile([{field:"study_year",value:"一年级",expectedVersion:0}]);
  assert.deepEqual(out,{updated:1,conflicts:[]});
  assert.equal(evaluateCondition(leaf,factsMap()),"TRUE");
});
test("历史终态桥接保留待确认原文但不自动占用模型预算，后续活跃修订可提取", () => {
  setProvidersForTests({ model: { provider: fixtureModelProvider(), mode: "fixture" } });
  const { token } = createSource("terminal-history", "历史来源");
  const payload = { schemaVersion: 1 as const, source: "terminal-history", externalId: "terminal", revisionKey: "r1", revisionOrder: 1, occurredAt: "2026-10-03T00:00:00Z", text: "保留的历史原文" };
  const first = importCampusNotice(payload, token, payload.text, null, false);
  assert.ok(first.ok);
  assert.equal(getDecisionByRevision(first.revisionId)?.partition, "review");
  assert.equal(getRevision(first.revisionId)?.text, payload.text);
  assert.equal(getDb().prepare("SELECT job_id FROM notice_extractions WHERE revision_id=?").get(first.revisionId), undefined);
  const next = importCampusNotice({ ...payload, revisionKey: "r2", revisionOrder: 2, text: "新活跃原文" }, token, "新活跃原文");
  assert.ok(next.ok);
  assert.ok(getDb().prepare("SELECT job_id FROM notice_extractions WHERE revision_id=?").get(next.revisionId));
  setProvidersForTests({});
});
test("超过200条通知仍能完整分页与身份重评，同一更新时间游标不丢不重", () => {
  createSource("pagination", "分页来源");
  const ids:string[]=[];
  for(let n=0;n<205;n++){
    const out=importVerifiedNotice({schemaVersion:1,source:"pagination",externalId:String(n),revisionKey:"r1",revisionOrder:1,occurredAt:"2026-10-03T00:00:00Z",text:"面向一年级",structured:{noticeType:"教学",condition:{kind:"leaf",field:"study_year",op:"eq",value:"一年级",quote:"一年级"}}});
    assert.ok(out.ok);ids.push(out.messageId);setMessageStatus(out.messageId,"revision_conflict");
    getDb().prepare("UPDATE inbox_messages SET updated_at='2026-10-03T00:00:00.000Z' WHERE id=?").run(out.messageId);
  }
  let cursor:{updatedAt:string;id:string}|undefined;const seen:string[]=[];
  do { const page=listMessagePage({status:"revision_conflict",limit:73,cursor});assert.equal(page.total,205);seen.push(...page.messages.map(m=>m.id));cursor=page.next ?? undefined;}while(cursor);
  assert.equal(new Set(seen).size,205);assert.deepEqual(seen.slice().sort(),ids.slice().sort());
  assert.deepEqual(resolveProfile([{field:"study_year",value:"二年级",expectedVersion:1}]),{updated:1,conflicts:[]});
  const folded=listMessagePage({status:"revision_conflict",partition:"folded",limit:1});assert.equal(folded.total,205);assert.equal(folded.messages.length,1);
});
function request(sourceId: string, overrides: Record<string, unknown> = {}): LegacyRequest {
  return legacyPreviewRequestSchema.parse({ snapshot: { format: "todo-web.sqlite.v1", sourceId, timezone: "Asia/Shanghai", exportedAt: "2026-10-03T00:00:00Z",
    tasks: [{ id: 1, title: "旧任务", note: "备注 https://old.invalid/media/a.png?token=never-store-this&x=1", start_at: "2026-09-27 00:00", due_at: "2099-10-03 17:00",
      done: 0, done_at: null, priority: "high", project: "原分组", quick: 1, pinned: 1, created_at: "2026-09-27 10:00", updated_at: "2026-09-28 11:00", external_id: null, external_rev: null }],
    ...overrides } });
}
function apply(r: LegacyRequest) { const p = previewLegacy(r); return applyLegacy({ ...r, previewHash: p.previewHash, confirm: true }); }

test("预览无写入；独立项目映射、截止时区与历史完成日期保留；默认不建邮件 job", () => {
  const db = getDb(); createProject(projectSchema.parse({ title: "原分组" }));
  const r = request("preview"), before = db.prepare("SELECT count(*) AS n FROM tasks").get();
  const p = previewLegacy(r);
  assert.deepEqual(db.prepare("SELECT count(*) AS n FROM tasks").get(), before);
  assert.equal(p.counts.create, 2); assert.equal(p.items[1].mapped?.due, "2099-10-03T09:00:00.000Z");
  const receipt = apply(r), id = receipt.created.find((i) => i.kind === "task")!.targetId, task = getTask(id)!;
  assert.equal(task.title, "旧任务"); assert.equal(task.status, "todo"); assert.equal(task.priority, "high");
  assert.equal(task.scheduledStart, null); assert.equal(task.plannedWeek, null);
  assert.equal(task.createdAt, "2026-09-27T02:00:00.000Z");
  assert.equal(task.updatedAt, "2026-09-28T03:00:00.000Z");
  assert.ok(task.projectId); assert.notEqual(task.projectId, (db.prepare("SELECT id FROM projects WHERE title='原分组' ORDER BY rowid LIMIT 1").get() as { id: string }).id);
  assert.equal((db.prepare("SELECT count(*) AS n FROM jobs WHERE task_id=?").get(id) as { n: number }).n, 0);
  assert.equal(task.description.includes("never-store-this"), false);
  assert.equal(JSON.stringify(db.prepare("SELECT * FROM legacy_mappings").all()).includes("never-store-this"), false);
  assert.equal(buildFullJson(new Date().toISOString()).includes("never-store-this"), false);
});

test("重导幂等、保留主人修改；来源变化报告冲突；预览过期整批回滚", () => {
  const r = request("repeat"), first = apply(r), taskId = first.created.find((i) => i.kind === "task")!.targetId;
  const old = getTask(taskId)!; updateTask(taskId, { title: "我的修改" }, old.version);
  assert.equal(apply(r).created.length, 0); assert.equal(getTask(taskId)!.title, "我的修改");
  const changed = { ...r, snapshot: { ...r.snapshot, tasks: [{ ...r.snapshot.tasks[0], title: "上游新标题" }] } };
  assert.equal(previewLegacy(changed).counts.conflict, 1); assert.equal(apply(changed).created.length, 0);
  const p = previewLegacy(r); updateTask(taskId, { description: "再次修改" }, getTask(taskId)!.version);
  const count = getDb().prepare("SELECT count(*) AS n FROM legacy_imports").get();
  assert.throws(() => applyLegacy({ ...r, previewHash: p.previewHash, confirm: true }), (e) => e instanceof HttpError && e.code === "PREVIEW_STALE");
  assert.deepEqual(getDb().prepare("SELECT count(*) AS n FROM legacy_imports").get(), count);
  assert.equal(getTask(taskId)!.title, "我的修改");
});

test("完成记录不伪造本周成果；无效日期保留原值；低优先级明确提示", () => {
  const r = request("done"); r.snapshot.tasks[0] = { ...r.snapshot.tasks[0], done: 1, done_at: "2026-09-28 10:00", due_at: "2026-02-30 10:00", priority: "low" };
  const p = previewLegacy(r); assert.equal(p.items[1].mapped?.due, null); assert.ok(p.items[1].warnings.some((w) => w.includes("日期无效")));
  const receipt = apply(r), task = getTask(receipt.created.find((i) => i.kind === "task")!.targetId)!;
  assert.equal(task.completedAt, "2026-09-28T02:00:00.000Z"); assert.equal(task.priority, "normal");
  r.snapshot.sourceId = "done-without-time"; r.snapshot.tasks[0].done_at = null;
  const second = apply(r); assert.equal(getTask(second.created.find((i) => i.kind === "task")!.targetId)!.completedAt, null);
});

test("勾选提醒只建立未来提醒，不给过去截止或完成任务补发", () => {
  const r = request("reminders"); r.enableFutureReminders = true;
  r.snapshot.tasks.push({ ...r.snapshot.tasks[0], id: 2, due_at: "2020-01-01 10:00" }, { ...r.snapshot.tasks[0], id: 3, done: 1 });
  const out = apply(r), ids = out.created.filter((i) => i.kind === "task").map((i) => i.targetId);
  assert.deepEqual(ids.map((id) => (getDb().prepare("SELECT count(*) AS n FROM jobs WHERE task_id=?").get(id) as { n: number }).n), [1, 0, 0]);
});

test("旧实例时区/校园绑定不可暗改；目标删除不自动再造", () => {
  const r = request("stable"); const out = apply(r), id = out.created.find((i) => i.kind === "task")!.targetId;
  assert.throws(() => previewLegacy({ ...r, snapshot: { ...r.snapshot, timezone: "UTC" } }), (e) => e instanceof HttpError && e.code === "LEGACY_SOURCE_CHANGED");
  getDb().prepare("DELETE FROM tasks WHERE id=?").run(id);
  assert.equal(previewLegacy(r).counts.conflict, 1); assert.equal(apply(r).created.length, 0);
});

test("主人已归档原项目时，新增旧任务不会被导入该项目", () => {
  const r = request("archived-parent"); const first = apply(r);
  const projectId = first.created.find((i) => i.kind === "project")!.targetId;
  archiveProject(projectId, getProject(projectId)!.version);
  r.snapshot.tasks.push({ ...r.snapshot.tasks[0], id: 2 });
  const p = previewLegacy(r); assert.equal(p.items.find((i) => i.kind === "task" && i.sourceId === "2")!.action, "conflict");
  assert.equal(apply(r).created.length, 0);
});

test("SQLite 快照一致读取真实旧字段，兼容缺少后加列；旧库字节不变且导出脱敏", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-todo-")), file = path.join(dir, "old.db");
  const db = new Database(file);
  db.exec("CREATE TABLE tasks(id INTEGER PRIMARY KEY,title TEXT,note TEXT,start_at TEXT,due_at TEXT,done INTEGER,done_at TEXT,priority TEXT,project TEXT,quick INTEGER,created_at TEXT,updated_at TEXT)");
  db.prepare("INSERT INTO tasks VALUES(1,'旧任务',?,NULL,NULL,0,NULL,'normal','',0,'2026-09-28 10:00','2026-09-28 10:00')").run("https://x.invalid/a?token=private-key"); db.close();
  const before = fs.readFileSync(file); const snapshot = readTodoSnapshot(file, "old-db", "Asia/Shanghai");
  assert.deepEqual(fs.readFileSync(file), before); assert.equal(snapshot.tasks.length, 1); assert.equal(snapshot.tasks[0].external_id, null); assert.equal(snapshot.tasks[0].pinned, 0);
  const out = path.join(dir, "export", "todo.snapshot.json"); writeTodoSnapshot(out, snapshot);
  assert.equal(fs.readFileSync(out, "utf8").includes("private-key"), false); assert.equal(legacySnapshotSchema.parse(JSON.parse(fs.readFileSync(out, "utf8"))).tasks.length, 1);
  assert.throws(() => readTodoSnapshot(path.join(dir, "missing.db"), "old", "UTC")); assert.equal(fs.existsSync(path.join(dir, "missing.db")), false);
});

test("桥接修订关联迁移任务，重复不建任务，新源状态不覆盖主人，资格只读原文节选", () => {
  const source = createSource("legacy-campus", "旧校园");
  const r = request("campus"); r.campusSourceId = source.source.id; r.snapshot.tasks[0].external_id = "item-a";
  const receipt = apply(r), id = receipt.created.find((i) => i.kind === "task")!.targetId;
  const task = campusTaskSchema.parse({ task_id: "item-a", revision: 1, title: "旧 AI 推断：所有新生必须参加", description: "推断资格不是证据", status: "open", updated_at: "2026-10-03T00:00:00Z", sources: [{ text: "面向研究生的讲座，10月5日前报名。", media: ["https://x.invalid/a?token=upstream-secret"] }] });
  const envelope = campusEnvelope(task, source.source.id), result = importCampusNotice(envelope, source.token, campusEvidenceText(task));
  assert.ok(result.ok); if (!result.ok) return;
  assert.equal(result.linked, true); assert.equal(getTaskLink(result.messageId, "primary")!.taskId, id);
  assert.equal(getDecisionByRevision(result.revisionId)!.partition, "review");
  const raw = getDb().prepare("SELECT extraction_text FROM inbox_revisions WHERE id=?").get(result.revisionId) as { extraction_text: string };
  assert.equal(raw.extraction_text, "面向研究生的讲座，10月5日前报名。");
  assert.equal(getRevision(result.revisionId)!.text.includes("upstream-secret"), false);
  const replay = importCampusNotice(envelope, source.token, campusEvidenceText(task)); assert.ok(replay.ok); assert.equal(replay.kind, "replay");
  const secondTask = { ...task, revision: 2, status: "cancelled" as const };
  const second = importCampusNotice(campusEnvelope(secondTask, source.source.id), source.token, campusEvidenceText(secondTask));
  assert.ok(second.ok); assert.equal(getTask(id)!.status, "todo");
  assert.equal((getDb().prepare("SELECT count(*) AS n FROM tasks WHERE id=?").get(id) as { n: number }).n, 1);
  const history = importCampusNotice(envelope, source.token, campusEvidenceText(task)); assert.ok(history.ok);
  assert.equal(getMessage(result.messageId)!.currentRevisionId, second.ok ? second.revisionId : "");
  const collision = importCampusNotice({ ...campusEnvelope(secondTask, source.source.id), text: "不同内容" }, source.token, "不同内容"); assert.deepEqual(collision, { ok: false, error: "revision_collision" });
  assert.deepEqual(importCampusNotice(envelope, "wrong-token", ""), { ok: false, error: "source_forbidden" });
});

test("来源绑定禁止一对多", () => {
  const source = createSource("legacy-campus-two", "校园二");
  const r = request("campus-two"); r.campusSourceId = source.source.id; r.snapshot.tasks[0].external_id = "item-b";
  apply(r);
  const another = request("campus-three"); another.campusSourceId = source.source.id;
  assert.throws(() => previewLegacy(another), (e) => e instanceof HttpError && e.code === "SOURCE_ALREADY_BOUND");
});

test("桥接提取仅看到原文，使用原消息时间；没有原文不会调用模型", async () => {
  let captured: Record<string, unknown> = {}; let calls = 0;
  setProvidersForTests({ search: null, model: { mode: "fixture", provider: { protocol: "fake", async call(req) {
    captured = req.context as Record<string, unknown>; calls++; return fixtureModelProvider().call(req);
  } } } });
  const source = createSource("evidence-only", "证据测试");
  const task = campusTaskSchema.parse({ task_id: "evidence-a", revision: 1, title: "推断所有新生都有资格", description: "不是证据的旧模型结果", status: "open", updated_at: "2026-10-03T00:00:00Z", sources: [{ text: "面向本科生，请提交报名表。", sent_at: "2026-09-28T00:00:00Z" }] });
  const result = importCampusNotice(campusEnvelope(task, source.source.id), source.token, campusEvidenceText(task), campusEvidenceOccurredAt(task)); assert.ok(result.ok);
  const job = claimDueJobs(new Date().toISOString(), 50).find((j) => (j.payload as { revisionId?: string }).revisionId === result.revisionId)!;
  assert.ok(job); assert.equal((await runNoticeExtractionJob(job)).kind, "done");
  assert.equal(captured.text, "面向本科生，请提交报名表。"); assert.equal(captured.occurredAt, "2026-09-28T00:00:00.000Z");
  assert.equal(JSON.stringify(captured).includes("推断所有新生"), false);
  const empty = { ...task, task_id: "evidence-empty", sources: [] };
  const emptyResult = importCampusNotice(campusEnvelope(empty, source.source.id), source.token, ""); assert.ok(emptyResult.ok);
  const emptyJob = claimDueJobs(new Date().toISOString(), 50).find((j) => (j.payload as { revisionId?: string }).revisionId === emptyResult.revisionId)!;
  assert.equal((await runNoticeExtractionJob(emptyJob)).kind, "failed"); assert.equal(calls, 1);
  assert.equal(campusEvidenceOccurredAt(campusTaskSchema.parse({ ...task, sources: [{ text: "明天报名", sent_at: "2026-09-28T00:00:00Z" }, { text: "明天补交", sent_at: "2026-09-29T00:00:00Z" }] })), null);
  setProvidersForTests({ model: null, search: null });
});

test("主人迁移 API 强制登录、CSRF、确认及幂等键；响应丢失重试返回同一结果", async () => {
  createOwner("test-only-unused-hash"); const { session, token } = createSession();
  const r = request("http-import"), body = { ...r, previewHash: previewLegacy(r).previewHash, confirm: true };
  const req = (url: string, payload: unknown, key?: string, csrf = session.csrfToken) => new NextRequest(`http://localhost${url}`, { method: "POST", headers: { cookie: `${SESSION_COOKIE}=${token}`, "x-csrf-token": csrf, "content-type": "application/json", ...(key ? { "idempotency-key": key } : {}) }, body: JSON.stringify(payload) });
  assert.equal((await previewRoute(new NextRequest("http://localhost/api/v1/legacy/preview", { method: "POST", body: JSON.stringify(r) }))).status, 401);
  assert.equal((await previewRoute(req("/api/v1/legacy/preview", r, undefined, "wrong"))).status, 403);
  assert.equal((await applyRoute(req("/api/v1/legacy/apply", body))).status, 422);
  assert.equal((await applyRoute(req("/api/v1/legacy/apply", { ...body, confirm: false }, "confirm"))).status, 422);
  const first = await applyRoute(req("/api/v1/legacy/apply", body, "idem")); assert.equal(first.status, 201);
  const receipt = await first.json(); const second = await applyRoute(req("/api/v1/legacy/apply", body, "idem"));
  assert.equal(second.status, 201); assert.deepEqual(await second.json(), receipt);
  assert.equal((await applyRoute(req("/api/v1/legacy/apply", { ...body, enableFutureReminders: true }, "idem"))).status, 409);
  const stale = await applyRoute(req("/api/v1/legacy/apply", body, "other")); assert.equal(stale.status, 409);
  const params = { params: Promise.resolve({ id: receipt.receipt.id }) };
  assert.equal((await receiptDownloadRoute(new NextRequest("http://localhost/download"), params)).status, 401);
  const download = await receiptDownloadRoute(new NextRequest("http://localhost/download", { headers: { cookie: `${SESSION_COOKIE}=${token}` } }), params);
  assert.match(download.headers.get("content-disposition")!, /attachment; filename="todo-import-/);
  assert.equal(download.headers.get("cache-control"), "private, no-store"); assert.deepEqual(await download.json(), receipt.receipt);
});

test("日期格式/DST歧义拒绝猜测；凭证变体脱敏；重复来源 ID 和超限请求不进入导入", async () => {
  const warnings: string[] = [];
  assert.equal(legacyInstant("2026-11-01 01:30", "America/New_York", "截止", warnings), null);
  assert.equal(legacyInstant("2026-03-08 02:30", "America/New_York", "截止", warnings), null);
  assert.equal(legacyInstant("2026-10-03 24:00", "UTC", "截止", warnings), null);
  const secret = redactLegacyText('https://u:pass@x.invalid/a?API_KEY=secret1&ok=1 Authorization: Bearer secret2 token="secret3" password=secret4');
  for (const value of ["pass@", "secret1", "secret2", "secret3", "secret4"]) assert.equal(secret.includes(value), false);
  const r = request("duplicate"); r.snapshot.tasks.push(r.snapshot.tasks[0]); assert.equal(legacySnapshotSchema.safeParse(r.snapshot).success, false);
  const body = new Request("http://localhost/import", { method: "POST", body: "x".repeat(10 * 1024 * 1024 + 1) });
  await assert.rejects(readLegacyBody(body), (e) => e instanceof HttpError && e.status === 413);
});
