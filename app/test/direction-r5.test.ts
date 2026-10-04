import assert from "node:assert/strict";
import crypto from "node:crypto";
import { after, before, test } from "node:test";
import { NextRequest } from "next/server";
import { migrateAll, getDb } from "./helpers";
import { createOwner, createSession, SESSION_COOKIE } from "@/domain/session";
import { hashPassword } from "@/domain/password";
import { setNowForTests } from "@/domain/clock";
import { setProvidersForTests } from "@/integrations";
import { FakeModelProvider } from "@/integrations/fake-model-provider";
import { runDueJobsOnce } from "@/worker/runner";
import { executeCommand, undoWithFollowUps } from "@/workflows/commands";
import { rebuildPlan, dayLedger } from "@/workflows/plan";
import { getPrefs } from "@/repositories/plan";
import { POST as createIntakeRoute } from "@/app/api/v2/intakes/route";
import { GET as getIntakeRoute } from "@/app/api/v2/intakes/[id]/route";
import { GET as directionRoute } from "@/app/api/v2/direction/route";
import { GET as dashboardRoute } from "@/app/api/v2/dashboard/route";
import { POST as focusStartRoute } from "@/app/api/v2/focus/route";
import { POST as focusActionRoute } from "@/app/api/v2/focus/[id]/[action]/route";

/**
 * R2 反馈与 R5 方向闭环（REPAIR-PLAN §5.2/§5.3；E13、E20、E21、E31、E32 的隔离行为）。
 * 候选项目是直接写入的合成数据（不代表真实检索结果）；选择、试做、实践证据、建议、资料归属都走真实实现。
 */

const NOW = new Date("2026-10-12T09:00:00+08:00");
/** 计时测试单独一天的中午：回拨几小时不跨日，也不和前面用例的记录同一天 */
const FOCUS_NOW = new Date("2026-10-14T12:00:00+08:00");
const CTX = { intakeId: null, itemId: null, itemKey: "", instanceEpoch: 0, evidence: "" };
let sessionToken = "";
let csrfToken = "";
let seq = 0;

function req(url: string, method: string, body?: unknown): NextRequest {
  return new NextRequest(`http://localhost${url}`, {
    method,
    headers: { cookie: `${SESSION_COOKIE}=${sessionToken}`, "x-csrf-token": csrfToken, "content-type": "application/json", ...(method === "POST" ? { "idempotency-key": `dir-${seq++}` } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}
type Result = { state: string; summary: string; nextActions: string[]; undo: { available: boolean; batchIds: string[] }; items: Array<{ kind: string; state: string; error: string | null }> };
async function say(text: string) {
  const res = await createIntakeRoute(req("/api/v2/intakes", "POST", { text }));
  assert.equal(res.status, 202);
  const { intakeId } = (await res.json()) as { intakeId: string };
  for (let i = 0; i < 4; i++) await runDueJobsOnce();
  const detail = await getIntakeRoute(req(`/api/v2/intakes/${intakeId}`, "GET"), { params: Promise.resolve({ id: intakeId }) });
  return ((await detail.json()) as { result: Result }).result;
}
type Direction = {
  mainGoal: { id: string; title: string } | null;
  projects: Array<{ id: string; title: string; engagement: string; trialUntil: string | null; openTasks: Array<{ title: string }>; nextSessions: Array<{ title: string }>; evidence: Array<{ note: string; blocker: string; actualMinutes: number | null }>; requirements: string[]; achievements: string[]; suggestion: string }>;
  candidates: Array<{ id: string; title: string; fitReason: string; canonicalUrl: string | null; firstStep: { title: string } | null; requirements: Array<{ label: string; status: string }>; unknowns: string[] }>;
  honesty: string;
};
async function direction(): Promise<Direction> {
  return (await (await directionRoute(req("/api/v2/direction", "GET"))).json()) as Direction;
}
function addCandidate(title: string, first: string, minutes: number, updatedAt: string): string {
  const db = getDb();
  const runId = crypto.randomUUID();
  db.prepare(`INSERT INTO exploration_runs (id, kind, query, status, integration_mode, created_at, updated_at) VALUES (?, 'on_demand', '合成', 'done', 'fixture', ?, ?)`).run(runId, updatedAt, updatedAt);
  const id = crypto.randomUUID();
  db.prepare(
    `INSERT INTO candidates (id, run_id, title, question, activities_json, deliverable, first_task_json, initial_tasks_json, requirements_json, unknowns_json, fit_reason, source_refs_json, evidence_status, canonical_url, evidence_hash, created_at, updated_at)
     VALUES (?, ?, ?, ?, '[]', ?, ?, ?, ?, ?, ?, '[]', 'retrieved', ?, ?, ?, ?)`,
  ).run(
    id, runId, title, `做一遍${title}，看看自己喜不喜欢这类工作`, "一页实践记录",
    JSON.stringify({ title: first, input: "一台普通电脑", output: "跑通的脚本", estimateMinutes: minutes }),
    JSON.stringify([{ title: "整理错分样本", input: "", output: "", estimateMinutes: 60 }, { title: "写一页小结", input: "", output: "", estimateMinutes: 45 }]),
    JSON.stringify([{ label: "会写基础 Python", status: "unknown", basis: "", confirmedByOwner: false }]),
    JSON.stringify(["数据集是否需要申请"]),
    "不需要 GPU，一两周能有结果", `https://example.org/${id}`, crypto.randomUUID(), updatedAt, updatedAt,
  );
  return id;
}
const params = (id: string, action: string) => ({ params: Promise.resolve({ id, action }) });

before(() => {
  migrateAll();
  setNowForTests(NOW);
  createOwner(hashPassword("dir-test-pass"));
  const { token, session } = createSession(1);
  sessionToken = token;
  csrfToken = session.csrfToken;
  setProvidersForTests({
    model: {
      mode: "fixture",
      provider: new FakeModelProvider((r) => {
        const text = (r.context as { text: string }).text.trim();
        const kind = /学了|跑了|做了|打了/.test(text) ? "practice" : /论文|摘要|资料|要求/.test(text) ? "note" : "task";
        return { ok: true, validatedResult: { items: [{ itemKey: "item-1", kind, summary: text.slice(0, 40), excerpt: text.slice(0, 200) }] } };
      }),
    },
  });
});
after(() => setNowForTests(null));

test("E31：“这学期先打好数学基础”成为主方向；候选最多 2–3 个且各有来源/理由/前置/第一步；“试做第一个”建有限的第一步，不等于对外承诺", async () => {
  const goal = await say("这学期先打好数学基础");
  assert.equal(goal.state, "applied", JSON.stringify(goal.items));
  assert.match(goal.summary, /「打好数学基础」设为当前的主要方向/);
  addCandidate("小型分类基线", "跑通逻辑回归基线", 60, "2026-10-11T02:00:00.000Z");
  addCandidate("读一篇综述并做笔记", "读完摘要和引言", 40, "2026-10-11T01:00:00.000Z");
  addCandidate("复现一个课程作业", "搭好环境", 30, "2026-10-11T00:00:00.000Z");
  addCandidate("第四个候选", "x", 30, "2026-10-10T00:00:00.000Z");
  const d0 = await direction();
  assert.equal(d0.mainGoal?.title, "打好数学基础");
  assert.equal(d0.candidates.length, 3, "没有进行中的项目时最多 3 个候选");
  const c = d0.candidates[0]!;
  assert.deepEqual([c.title, c.firstStep?.title, c.fitReason, c.requirements[0]!.status, c.unknowns[0]], ["小型分类基线", "跑通逻辑回归基线", "不需要 GPU，一两周能有结果", "unknown", "数据集是否需要申请"]);
  assert.ok(c.canonicalUrl, "候选带来源");
  assert.match(d0.honesty, /还没有实践记录/);

  const pick = await say("试做第一个");
  assert.equal(pick.state, "applied", JSON.stringify(pick.items));
  assert.match(pick.summary, /开始试做「小型分类基线」到 2026-10-26/);
  assert.match(pick.summary, /不等于报名或对外承诺/);
  assert.match(pick.summary, /还有没确认的条件：会写基础 Python/);
  const d1 = await direction();
  assert.equal(d1.projects.length, 1);
  const p = d1.projects[0]!;
  assert.deepEqual([p.title, p.engagement, p.trialUntil], ["小型分类基线", "trial", "2026-10-26"]);
  assert.deepEqual(p.openTasks.map((t) => t.title), ["跑通逻辑回归基线"], "试做只建第一步，不把整个计划都压上来");
  assert.equal(p.nextSessions.length, 1, "第一步已进入安排");
  assert.equal(d1.candidates.length, 2, "有进行中的项目时最多再展示 2 个候选");
  assert.ok(!d1.candidates.some((x) => x.title === "小型分类基线"));
  const goalLink = getDb().prepare(`SELECT COUNT(*) AS n FROM project_goals WHERE project_id = ?`).get(p.id) as { n: number };
  assert.equal(goalLink.n, 1, "项目关联到主方向");
  assert.match(p.suggestion, /还没有这个项目的实践记录，现在判断不了适不适合/);
});

test("E21/E13：做一次尝试并反馈卡点 → 记录关联到项目，建议引用这条记录；之后只排一个最小排障步骤，做过没反馈就不再续排", async () => {
  const r = await say("跑通逻辑回归基线做了40分钟，环境一直报错");
  assert.equal(r.state, "applied", JSON.stringify(r.items));
  assert.match(r.summary, /卡点已记下/);
  const d = await direction();
  const p = d.projects[0]!;
  assert.deepEqual(p.evidence.map((e) => [e.actualMinutes, e.blocker]), [[40, "环境一直报错"]], "实践证据关联到项目");
  assert.match(p.suggestion, /记录了 1 次、共 40 分钟；最近一次卡在“环境一直报错”。下一步先用一小段时间处理这个卡点/);
  assert.doesNotMatch(JSON.stringify([d.projects, d.candidates]), /评分|概率|掌握程度|\d+\s*%/, "建议里没有能力评分或概率");

  const taskId = (getDb().prepare(`SELECT id FROM tasks WHERE title = '跑通逻辑回归基线'`).get() as { id: string }).id;
  const blocks = () => getDb().prepare(`SELECT id, reason, (julianday(end_utc) - julianday(start_utc)) * 1440 AS m FROM plan_sessions WHERE task_id = ? AND status IN ('planned','tentative') ORDER BY start_utc`).all(taskId) as Array<{ id: string; reason: string; m: number }>;
  const now1 = blocks();
  assert.equal(now1.length, 1, "卡住时不再追加新的块");
  assert.equal(now1[0]!.id, p.nextSessions.length ? now1[0]!.id : "", "今天已有的那一段在 24 小时内，不被擅自改动");
  const dash = (await (await dashboardRoute(req("/api/v2/dashboard", "GET"))).json()) as { today: { sessions: Array<{ id: string; reason: string }> } };
  assert.match(dash.today.sessions.find((x) => x.id === now1[0]!.id)!.reason, /上次卡在“环境一直报错”，这一段先处理卡点/, "但说明这一段该先处理卡点，不伪装成照常推进");

  getDb().prepare(`UPDATE plan_sessions SET status = 'completed', updated_at = ? WHERE id = ?`).run(new Date(NOW.getTime() + 1000).toISOString(), now1[0]!.id);
  const plan = rebuildPlan(new Date("2026-10-13T09:00:00+08:00"));
  assert.equal(blocks().length, 0, "排障块做完没有新反馈：不无限续排");
  assert.deepEqual(plan.unscheduled.filter((u) => u.taskId === taskId).map((u) => u.reason), ["needs_remaining_estimate"]);
});

test("E31：试做转正式投入要主人明确说；撤销“试做”把项目和第一步一起撤掉，候选回到列表", async () => {
  const commit = await say("小型分类基线正式投入");
  assert.equal(commit.state, "applied", JSON.stringify(commit.items));
  assert.match(commit.summary, /由试做转为正式投入/);
  assert.match(commit.summary, /对外报名等仍需你自己去做/);
  assert.equal((await direction()).projects[0]!.engagement, "committed");

  // 另一个候选：试做后撤销
  const before1 = await direction();
  const other = executeCommand({ command: "select_candidate", candidateId: before1.candidates[0]!.id, mode: "trial", trialWeeks: 1 }, CTX);
  assert.ok(other.ok, other.ok ? "" : other.error);
  assert.equal((await direction()).projects.length, 2);
  assert.equal(undoWithFollowUps(other.ok ? other.batchId! : "").kind, "undone");
  const after1 = await direction();
  assert.equal(after1.projects.length, 1);
  assert.deepEqual(getDb().prepare(`SELECT status, project_id FROM candidates WHERE id = ?`).get(before1.candidates[0]!.id), { status: "proposed", project_id: null }, "候选回到未开始状态");
  assert.equal((getDb().prepare(`SELECT COUNT(*) AS n FROM tasks WHERE title = '读完摘要和引言'`).get() as { n: number }).n, 0);
});

test("E32：给项目贴资料 → 存为参考资料；纠正“这是老师的要求，不是我的成果” → 类型以主人为准，之后的自动判断不覆盖；复盘不当成个人成果", async () => {
  const pasted = await say("基线论文摘要：本文提出一种简单的分类基线，要求复现时报告准确率与错分样本。");
  assert.equal(pasted.state, "applied", JSON.stringify(pasted.items));
  assert.match(pasted.summary, /已存为参考资料；原文保留/);
  const link = await say("这篇资料归到小型分类基线项目");
  assert.equal(link.state, "applied", JSON.stringify(link.items));
  assert.match(link.summary, /归到项目「小型分类基线」/);
  const fix = await say("这段是老师的要求，不是我完成的成果");
  assert.equal(fix.state, "applied", JSON.stringify(fix.items));
  assert.match(fix.summary, /别人的要求（不算你的成果）/);
  const row = getDb().prepare(`SELECT l.id, l.role, l.origin, l.resource_id, r.body FROM resource_links l JOIN resources r ON r.id = l.resource_id`).get() as { id: string; role: string; origin: string; resource_id: string; body: string };
  assert.deepEqual([row.role, row.origin], ["requirement", "user"]);
  assert.match(row.body, /基线论文摘要/, "原文与定位保留");

  const auto = executeCommand({ command: "link_resource", resourceId: row.resource_id, role: "achievement", origin: "assumed" }, CTX);
  assert.ok(auto.ok && auto.noChange, "来源/模型的后续判断不覆盖主人的纠正");
  const p = (await direction()).projects[0]!;
  assert.equal(p.requirements.length, 1);
  assert.deepEqual(p.achievements, [], "老师的要求不算个人成果");
});

test("E20：数学 40 分钟与羽毛球计时 38 分钟不合并，运动不占学习预算；长计时先核对，可修正或放弃；从行动卡计时与学习块关联", async (t) => {
  setNowForTests(FOCUS_NOW);
  t.after(() => setNowForTests(NOW));
  const db = getDb();
  const today = "2026-10-14";
  executeCommand({ command: "record_practice", occurredOn: today, actualMinutes: 40, note: "学数学" }, CTX);
  const start = async (body: unknown) => focusStartRoute(req("/api/v2/focus", "POST", body));
  const stop = async (id: string, body: unknown) => focusActionRoute(req(`/api/v2/focus/${id}/stop`, "POST", body), params(id, "stop"));
  const current = () => db.prepare(`SELECT id, version FROM focus_sessions WHERE status = 'in_progress'`).get() as { id: string; version: number };

  assert.equal((await start({ note: "打羽毛球" })).status, 201);
  let f = current();
  db.prepare(`UPDATE focus_sessions SET started_at = ? WHERE id = ?`).run(new Date(FOCUS_NOW.getTime() - 38 * 60000).toISOString(), f.id);
  const r1 = (await (await stop(f.id, { expectedVersion: f.version })).json()) as { merged: boolean; minutes: number };
  assert.equal(r1.merged, false, "分钟接近但不是同一件事：不合并");
  const rows = db.prepare(`SELECT note, actual_minutes, category FROM practice_entries WHERE occurred_on = ? ORDER BY created_at`).all(today);
  assert.deepEqual(rows, [{ note: "学数学", actual_minutes: 40, category: "study" }, { note: "打羽毛球", actual_minutes: 38, category: "other" }]);
  assert.equal(dayLedger(today, FOCUS_NOW, getPrefs(), "Asia/Shanghai").actualMinutes, 40, "运动不冒充学习消耗");

  // 长计时：先给具体时段和候选分钟；修正为实际分钟
  await start({ note: "写论文" });
  f = current();
  db.prepare(`UPDATE focus_sessions SET started_at = ? WHERE id = ?`).run(new Date(FOCUS_NOW.getTime() - 5 * 3600_000).toISOString(), f.id);
  const need = await stop(f.id, { expectedVersion: f.version });
  assert.equal(need.status, 409);
  const detail = ((await need.json()) as { error: { code: string; details: { minutes: number; reason: string } } }).error;
  assert.deepEqual([detail.code, detail.details.minutes, detail.details.reason], ["NEEDS_CONFIRMATION", 300, "long"]);
  assert.equal((await stop(f.id, { expectedVersion: f.version, minutes: 999 })).status, 422, "修正值不能超过计时时长");
  const fixed = (await (await stop(f.id, { expectedVersion: f.version, minutes: 90 })).json()) as { minutes: number };
  assert.equal(fixed.minutes, 90);
  assert.equal((db.prepare(`SELECT actual_minutes FROM practice_entries WHERE note = '写论文'`).get() as { actual_minutes: number }).actual_minutes, 90);

  // 放弃：不计入、不丢其他活动
  await start({ note: "误开的计时" });
  f = current();
  db.prepare(`UPDATE focus_sessions SET started_at = ? WHERE id = ?`).run(new Date(FOCUS_NOW.getTime() - 6 * 3600_000).toISOString(), f.id);
  assert.equal(((await (await stop(f.id, { expectedVersion: f.version, discard: true })).json()) as { discarded: boolean }).discarded, true);
  assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM practice_entries WHERE note = '误开的计时'`).get() as { n: number }).n, 0);
  assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM practice_entries WHERE occurred_on = ?`).get(today) as { n: number }).n, 3, "已有记录都还在");

  // 从行动卡开始：块进入进行中；停止后块完成、记录关联任务与块
  const taskId = crypto.randomUUID();
  db.prepare(`INSERT INTO tasks (id, title, description, status, priority, estimate_minutes, due_kind, created_at, updated_at) VALUES (?, '线代作业', '', 'todo', 'normal', 60, 'none', 'x', 'x')`).run(taskId);
  const sessionId = crypto.randomUUID();
  db.prepare(`INSERT INTO plan_sessions (id, task_id, start_utc, end_utc, timezone, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'Asia/Shanghai', 'planned', 'x', 'x')`).run(sessionId, taskId, new Date(FOCUS_NOW.getTime() - 600_000).toISOString(), new Date(FOCUS_NOW.getTime() + 3000_000).toISOString());
  assert.equal((await start({ sessionId })).status, 201);
  assert.equal((db.prepare(`SELECT status FROM plan_sessions WHERE id = ?`).get(sessionId) as { status: string }).status, "in_progress");
  f = current();
  db.prepare(`UPDATE focus_sessions SET started_at = ? WHERE id = ?`).run(new Date(FOCUS_NOW.getTime() - 30 * 60000).toISOString(), f.id);
  await stop(f.id, { expectedVersion: f.version });
  assert.equal((db.prepare(`SELECT status FROM plan_sessions WHERE id = ?`).get(sessionId) as { status: string }).status, "completed");
  assert.deepEqual(db.prepare(`SELECT task_id, plan_session_id, actual_minutes FROM practice_entries WHERE note = '线代作业'`).get(), { task_id: taskId, plan_session_id: sessionId, actual_minutes: 30 });
  assert.equal((db.prepare(`SELECT status FROM tasks WHERE id = ?`).get(taskId) as { status: string }).status, "todo", "停止计时不等于完成任务");
});

test("A08/E07：同一活动的手动记录与计时合并只算一次；说“不是同一次”可以再分开", async (t) => {
  setNowForTests(FOCUS_NOW);
  t.after(() => setNowForTests(NOW));
  const db = getDb();
  const today = "2026-10-14";
  executeCommand({ command: "record_practice", occurredOn: today, actualMinutes: 50, note: "背单词" }, CTX);
  assert.equal((await focusStartRoute(req("/api/v2/focus", "POST", { note: "背单词" }))).status, 201);
  const f = db.prepare(`SELECT id, version FROM focus_sessions WHERE status = 'in_progress'`).get() as { id: string; version: number };
  db.prepare(`UPDATE focus_sessions SET started_at = ? WHERE id = ?`).run(new Date(FOCUS_NOW.getTime() - 47 * 60000).toISOString(), f.id);
  const r = (await (await focusActionRoute(req(`/api/v2/focus/${f.id}/stop`, "POST", { expectedVersion: f.version }), params(f.id, "stop"))).json()) as { merged: boolean; mergedNote: string };
  assert.deepEqual([r.merged, r.mergedNote], [true, "背单词"], "同样的活动说明 + 分钟接近：视为同一次，并告诉主人合并到了哪条");
  assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM practice_entries WHERE note LIKE '背单词%'`).get() as { n: number }).n, 1);
  const split = await focusActionRoute(req(`/api/v2/focus/${f.id}/split`, "POST", { expectedVersion: 1 }), params(f.id, "split"));
  assert.equal(split.status, 200);
  const rows = db.prepare(`SELECT note, actual_minutes, minutes_origin FROM practice_entries WHERE note LIKE '背单词%' ORDER BY created_at`).all();
  assert.deepEqual(rows, [{ note: "背单词", actual_minutes: 50, minutes_origin: "user_reported" }, { note: "背单词", actual_minutes: 47, minutes_origin: "timer" }]);
});
