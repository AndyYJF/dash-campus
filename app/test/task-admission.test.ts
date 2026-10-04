import assert from "node:assert/strict";
import crypto from "node:crypto";
import { before, beforeEach, after, test } from "node:test";
import { NextRequest } from "next/server";
import { migrateAll, getDb } from "./helpers";
import { setNowForTests } from "@/domain/clock";
import { createOwner, createSession, SESSION_COOKIE } from "@/domain/session";
import { hashPassword } from "@/domain/password";
import { resolveTaskKind } from "@/domain/task-admission";
import { createBatch } from "@/repositories/journal";
import { insertSession, getSession } from "@/repositories/plan";
import { pendingTasks } from "@/repositories/task-admission";
import { listOpenQuestions } from "@/repositories/questions";
import { rebuildPlan } from "@/workflows/plan";
import { raisePlanQuestions } from "@/workflows/agent";
import { dashboardSnapshot, weekSnapshot } from "@/workflows/snapshot";
import { runDueJobsOnce } from "@/worker/runner";
import { executeOperation, undoWithFollowUps } from "@/workflows/commands";
import { POST as intakeRoute } from "@/app/api/v2/intakes/route";
import { POST as answerRoute } from "@/app/api/v2/questions/[id]/answers/route";

const NOW = new Date("2026-10-04T08:00:00+08:00");
const TZ = "Asia/Shanghai";
const CTX = { intakeId: null, itemId: null, itemKey: "", instanceEpoch: 0, evidence: "", explicit: true, now: NOW };
const TITLES = ["2026第六届OceanBase数据库大赛报名", "导入朋友生日", "买红笔芯", "买miniUPS", "财务系统绑定酬金银行卡通知", "教授开放日初步安排及参与通知", "学院迎新晚会节目准备通知"];
let token = "", csrf = "", seq = 0;
function req(url: string, body: unknown) {
  return new NextRequest(`http://localhost${url}`, { method: "POST", headers: { cookie: `${SESSION_COOKIE}=${token}`, "x-csrf-token": csrf, "content-type": "application/json", "idempotency-key": `admission-${seq++}` }, body: JSON.stringify(body) });
}
function add(title: string, estimate: number | null = null, kind = "auto"): string {
  const id = crypto.randomUUID();
  getDb().prepare(`INSERT INTO tasks (id,title,description,status,priority,estimate_minutes,due_kind,task_kind,created_at,updated_at) VALUES (?,?,'','todo','normal',?,'none',?,?,?)`).run(id, title, estimate, kind, NOW.toISOString(), NOW.toISOString());
  return id;
}
const blocks = (id: string) => getDb().prepare("SELECT id FROM plan_sessions WHERE task_id = ? AND status IN ('planned','tentative','in_progress')").all(id);
async function drain() { for (let i = 0; i < 4; i++) await runDueJobsOnce(); }
before(() => {
  migrateAll(); setNowForTests(NOW); createOwner(hashPassword("admission-test-pass"));
  const created = createSession(1); token = created.token; csrf = created.session.csrfToken;
});
beforeEach(() => {
  getDb().exec("UPDATE plan_sessions SET status='superseded'; UPDATE tasks SET status='cancelled'; UPDATE clarification_questions SET status='superseded' WHERE status='open';");
});
after(() => setNowForTests(null));

test("截图七项按业务语义分开；通知中的学习词、截止和估时不构成学习准入", () => {
  assert.deepEqual(TITLES.map((title) => resolveTaskKind({ title })), ["decision", "todo", "todo", "todo", "notice", "notice", "notice"]);
  assert.equal(resolveTaskKind({ title: "深度学习大赛报名通知" }), "notice");
  assert.equal(resolveTaskKind({ title: "复现分类基线" }), "study");
  assert.equal(resolveTaskKind({ title: "处理一下那件事" }), "unknown");
  assert.equal(resolveTaskKind({ title: "买miniUPS", taskKind: "study" }), "study", "主人可纠正分类，例如研究UPS实验");
});

test("七条错误自动块即使24小时内也撤回，原事项与提醒保留；重排不再生成起步块", () => {
  const ids = TITLES.map((t, i) => add(t, i % 2 ? 60 : null));
  const batch = createBatch({ command: "plan_sessions", reason: "old planner", intakeId: null, itemId: null, policyVersion: "test", instanceEpoch: 0 });
  const old = ids.map((taskId, i) => insertSession({ taskId, batchId: batch, timezone: TZ, startUtc: new Date(NOW.getTime() + (60 + 35 * i) * 60000).toISOString(), endUtc: new Date(NOW.getTime() + (85 + 35 * i) * 60000).toISOString() }));
  const before = ids.map((id) => getDb().prepare("SELECT * FROM tasks WHERE id=?").get(id));
  const first = rebuildPlan(NOW);
  assert.equal(first.superseded, 7);
  assert.equal(first.placed, 0);
  assert.deepEqual(ids.map((id) => getDb().prepare("SELECT * FROM tasks WHERE id=?").get(id)), before, "不取消、不暂停、不删除源事项");
  assert.ok(old.every((id) => getSession(id)?.status === "superseded"));
  assert.equal(rebuildPlan(NOW).changed, false, "重复重排不会再生错误块");
  const snap = dashboardSnapshot("2026-10-04", NOW);
  assert.equal(snap.pendingItems.length, 7);
  assert.equal(snap.nextActions.length, 0);
  assert.equal(weekSnapshot("2026-09-28", NOW).unscheduled.length, 0);
});

test("学习准入不取消主人指定、锁定或已经开始的块", () => {
  const id = add("买miniUPS");
  const batchId = createBatch({ command: "plan_sessions", reason: "protected", intakeId: null, itemId: null, policyVersion: "test", instanceEpoch: 0 });
  const mk = (start: string, end: string, origin: "agent" | "user" = "agent") => insertSession({ taskId: id, batchId, timezone: TZ, startUtc: start, endUtc: end, origin });
  const manual = mk("2026-10-04T01:00:00.000Z", "2026-10-04T01:25:00.000Z", "user");
  const locked = mk("2026-10-04T02:00:00.000Z", "2026-10-04T02:25:00.000Z");
  getDb().prepare("UPDATE plan_sessions SET locked=1 WHERE id=?").run(locked);
  const started = mk("2026-10-03T23:50:00.000Z", "2026-10-04T00:15:00.000Z");
  getDb().prepare("UPDATE plan_sessions SET status='in_progress' WHERE id=?").run(started);
  rebuildPlan(NOW);
  assert.equal(getSession(manual)?.status, "planned");
  assert.equal(getSession(locked)?.status, "planned");
  assert.equal(getSession(started)?.status, "in_progress");
});

test("未知事项先提问；HTTP否定回答含学习一词仍不排；肯定回答才安排，GET不写问题", async () => {
  const id = add("处理那个材料", 60);
  const before = (getDb().prepare("SELECT COUNT(*) n FROM clarification_questions").get() as { n: number }).n;
  dashboardSnapshot("2026-10-04", NOW); weekSnapshot("2026-09-28", NOW);
  assert.equal((getDb().prepare("SELECT COUNT(*) n FROM clarification_questions").get() as { n: number }).n, before);
  raisePlanQuestions(rebuildPlan(NOW), { conversationId: null, tz: TZ });
  const q = listOpenQuestions().find((q) => q.context.taskId === id)!;
  assert.equal(q.purpose, "task_kind"); assert.equal(blocks(id).length, 0);
  const res = await answerRoute(req(`/api/v2/questions/${q.id}/answers`, { text: "不要安排学习时间，只记待办", expectedVersion: q.version }), { params: Promise.resolve({ id: q.id }) });
  assert.equal(res.status, 202, await res.clone().text()); await drain();
  assert.equal(blocks(id).length, 0);
  assert.equal(pendingTasks().find((t) => t.taskId === id)?.kind, "todo");
  const id2 = add("处理另一份材料", 60);
  raisePlanQuestions(rebuildPlan(NOW), { conversationId: null, tz: TZ });
  const q2 = listOpenQuestions().find((q) => q.context.taskId === id2)!;
  assert.equal((await answerRoute(req(`/api/v2/questions/${q2.id}/answers`, { text: "作为学习任务安排", expectedVersion: q2.version }), { params: Promise.resolve({ id: q2.id }) })).status, 202);
  await drain(); assert.ok(blocks(id2).length > 0);
});

test("自然语言从卡片确认/纠正同一事项，不创建副本；撤销分类后未来自动块再次撤回", async () => {
  const id = add("买miniUPS", 60);
  const count = (getDb().prepare("SELECT COUNT(*) n FROM tasks").get() as { n: number }).n;
  const res = await intakeRoute(req("/api/v2/intakes", { text: "把这个作为学习任务安排", selectedEntityRef: { kind: "task", id } }));
  assert.equal(res.status, 202, await res.clone().text()); await drain();
  assert.ok(blocks(id).length > 0);
  assert.equal((getDb().prepare("SELECT COUNT(*) n FROM tasks").get() as { n: number }).n, count);
  const back = await intakeRoute(req("/api/v2/intakes", { text: "这条只提醒，不安排学习时间", selectedEntityRef: { kind: "task", id } }));
  assert.equal(back.status, 202); await drain(); assert.equal(blocks(id).length, 0);
  const result = executeOperation({ command: "create_or_update_task", taskId: id, taskKind: "study" }, CTX);
  assert.ok(result.result.ok);
  assert.ok(blocks(id).length > 0);
  if (!result.result.ok) return;
  assert.equal(undoWithFollowUps(result.result.batchId!).kind, "undone");
  assert.equal(blocks(id).length, 0);
});
