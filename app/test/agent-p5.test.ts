import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { NextRequest } from "next/server";
import { migrateAll, getDb } from "./helpers";
import { createSession, SESSION_COOKIE } from "@/domain/session";
import { setNowForTests } from "@/domain/clock";
import { setProvidersForTests } from "@/integrations";
import { ScriptedChatProvider } from "@/integrations/fake-model-provider";
import type { RawCallResult } from "@/integrations/model-json";
import { POST } from "@/app/api/v2/intakes/route";
import { POST as answerRoute } from "@/app/api/v2/questions/[id]/answers/route";
import { runDueJobsOnce } from "@/worker/runner";
import { intakeResultById, type IntakeResultView } from "@/workflows/results";
import { executeCommand, executeOperation } from "@/workflows/commands";
import { getGoal } from "@/repositories/goals";
import { listItems, setIntakeStatus, updateItem } from "@/repositories/intakes";
import { createJob } from "@/repositories/jobs";
import { appendVerification, listVerifications } from "@/repositories/agent-runs";
import { FULL_JSON_TABLES } from "@/contracts/exports";
import { INTAKE_JOB_TYPE } from "@/contracts/intake";
import { FIXTURE_NOW, seedFixture } from "./corpus/fixtures";

/**
 * Agent 增强 v1.1 P5：Execute–Observe–Verify–Repair。
 * 真实管线（POST 投递 → worker → 路由 → 绑定 → 执行器 → 核验/修正），模型换成脚本；
 * 种子是语料评测用的合成一周（课表、任务、学习块、科研项目）。故障用测试库里的临时触发器模拟。
 */

const NOW = new Date(FIXTURE_NOW);
let token = "", csrf = "", seq = 0;
let onRoute: () => unknown = () => ({ items: [] });
let provider: ScriptedChatProvider;

const final = (value: unknown): RawCallResult => ({ ok: true, text: JSON.stringify(value) });
const named = (text: string) => ({ kind: "named", text, date: null, part: "any" });
const act = (excerpt: string, intents: unknown[], rationale = "按原话执行") => ({ items: [{ itemKey: "act", excerpt, outcome: { kind: "act", intents, rationale }, continuesGoal: false }] });

function request(url: string, body: unknown, key = `p5-${seq++}`) {
  return new NextRequest(url, { method: "POST", headers: { cookie: `${SESSION_COOKIE}=${token}`, "x-csrf-token": csrf, "content-type": "application/json", "idempotency-key": key }, body: JSON.stringify(body) });
}
async function drain() { for (let i = 0; i < 6; i++) await runDueJobsOnce(); }
async function say(text: string): Promise<IntakeResultView> {
  const res = await POST(request("http://localhost/api/v2/intakes", { text }));
  const body = (await res.json()) as { intakeId: string };
  assert.equal(res.status, 202, JSON.stringify(body));
  await drain();
  return intakeResultById(body.intakeId)!;
}
async function answer(q: { id: string; version: number }, text: string) {
  const res = await answerRoute(request("http://localhost/api/v2/questions", { text, expectedVersion: q.version }), { params: Promise.resolve({ id: q.id }) });
  assert.ok(res.status < 300, `回答 ${res.status}`);
  await drain();
}
/** 推断的修改先确认：逐个回答“可以” */
async function confirmAll(intakeId: string): Promise<IntakeResultView> {
  for (let n = 0; n < 4; n++) {
    const q = intakeResultById(intakeId)!.questions.find((x) => x.purpose === "confirm");
    if (!q) break;
    await answer(q, "可以");
  }
  return intakeResultById(intakeId)!;
}
function op(command: Record<string, unknown>) {
  const r = executeOperation(command, { intakeId: null, itemId: null, itemKey: "", instanceEpoch: 0, evidence: "", explicit: true, now: NOW });
  assert.ok(r.result.ok, JSON.stringify(r));
  return r;
}
const db = () => getDb();
const taskRow = (title: string) => db().prepare(`SELECT * FROM tasks WHERE title = ?`).get(title) as Record<string, unknown>;
const batchesOf = (intakeId: string) => (db().prepare(`SELECT COUNT(*) AS n FROM agent_action_batches WHERE intake_id = ?`).get(intakeId) as { n: number }).n;
const routeCalls = () => provider.exchanges.filter((e) => e.workflow === "agent_route").length;
const facts = () => JSON.stringify([
  db().prepare(`SELECT id, status, version, priority, paused_until, due_local_date FROM tasks ORDER BY id`).all(),
  db().prepare(`SELECT id, start_utc, status, version, locked FROM plan_sessions ORDER BY id`).all(),
  db().prepare(`SELECT id, status, version FROM planning_policy_rules ORDER BY id`).all(),
  db().prepare(`SELECT id, version FROM planning_preferences`).all(),
]);
const courses = () => JSON.stringify(db().prepare(`SELECT * FROM courses ORDER BY id`).all());

before(() => {
  migrateAll();
  seedFixture("week-basic");
  setNowForTests(NOW);
  const s = createSession(1);
  token = s.token;
  csrf = s.session.csrfToken;
  provider = new ScriptedChatProvider((req) => {
    if (req.workflow === "agent_route") return final(onRoute());
    if (req.workflow === INTAKE_JOB_TYPE) return final({ items: [] });
    return { ok: false, code: "HTTP_ERROR", message: `脚本没有处理 ${req.workflow}`, retryable: false };
  });
  setProvidersForTests({ model: { mode: "fixture", provider } });
});
after(() => setNowForTests(null));

test("G01 两轮只读：核验为只读、没有任何业务批次与撤销，任务和学习块逐行不变", async () => {
  const before = facts();
  onRoute = () => act("看一下目前每天的安排", [{ op: "inspect", query: "目前每天的安排" }], "查看每天安排");
  const first = await say("看一下目前每天的安排");
  onRoute = () => act("为什么周三排得少", [{ op: "inspect", query: "为什么周三排得少" }], "解释周三安排");
  const second = await say("为什么周三排得少");
  for (const r of [first, second]) {
    assert.equal(r.state, "answered", JSON.stringify(r));
    assert.equal(r.verification?.status, "verified", JSON.stringify(r.verification));
    assert.ok(r.verification!.checks.length && r.verification!.checks.every((c) => c.kind === "read_only" && c.ok === true));
    assert.match(r.verification!.label, /没有改动/);
    assert.equal(r.undo.available, false);
    assert.equal(batchesOf(r.intakeId), 0);
  }
  assert.equal(facts(), before, "两轮查看后业务事实逐行不变");
});

test("G06 提交后、标记前崩溃：恢复后按 journal 认领原批次，不重记实践、不新增批次、不重新路由，核验通过", async () => {
  onRoute = () => act("今天跑步跑了30分钟", [{ op: "practice", occurredOn: "2026-10-12", actualMinutes: 30, note: "跑步", category: "other" }], "记录跑步");
  const r = await say("今天跑步跑了30分钟");
  assert.equal(r.state, "applied", JSON.stringify(r));
  assert.equal(r.verification?.status, "verified", JSON.stringify(r.verification));
  assert.ok(r.verification!.checks.some((c) => c.kind === "practice_not_duplicated" && c.ok));
  const practice = () => (db().prepare(`SELECT COUNT(*) AS n FROM practice_entries`).get() as { n: number }).n;
  const ledger = () => (db().prepare(`SELECT COUNT(*) AS n FROM ai_request_ledger WHERE intake_id = ?`).get(r.intakeId) as { n: number }).n;
  const count = practice();
  const item = listItems(r.intakeId).find((i) => i.state === "applied")!;
  const batchId = (item.payload.applied as { batchId: string }).batchId;

  // 崩溃现场：领域事务已提交（批次在），事项还停在 ready
  const payload = { ...item.payload };
  delete payload.applied;
  delete payload.followUps;
  updateItem(item.id, { state: "ready", payload });
  setIntakeStatus(r.intakeId, "processing");
  createJob({ type: INTAKE_JOB_TYPE, dedupeKey: `intake:${r.intakeId}:recover`, runAt: new Date().toISOString(), payload: { intakeId: r.intakeId, cause: "recover" } });
  const routes = routeCalls();
  const used = ledger();
  await drain();

  assert.equal(practice(), count, "实践没有重记");
  assert.equal((db().prepare(`SELECT COUNT(*) AS n FROM agent_action_batches WHERE item_id = ?`).get(item.id) as { n: number }).n, 1, "这一步只有一个批次");
  const recovered = listItems(r.intakeId).find((i) => i.id === item.id)!;
  assert.equal(recovered.state, "applied");
  assert.equal((recovered.payload.applied as { batchId: string }).batchId, batchId, "认领的是原批次");
  assert.equal(routeCalls(), routes, "恢复不重新路由");
  assert.equal(ledger(), used, "请求计数不重置也不重复");
  assert.equal(intakeResultById(r.intakeId)!.verification?.status, "verified");

  // 执行器层面：同一事项再执行一次直接返回原批次
  const again = executeCommand(item.payload.command, { intakeId: r.intakeId, itemId: item.id, itemKey: item.stableItemKey, instanceEpoch: 0, evidence: "", explicit: true });
  assert.ok(again.ok && again.batchId === batchId && again.replayed === true, JSON.stringify(again));
  assert.equal(practice(), count);
});

test("G03 两步依赖：暂停科研项目再把时间给数学；确认后两步都落实并逐项核验（项目/任务状态、未开始块已让出、优先级）", async () => {
  const text = "暂停科研项目，再把空出的时间用于数学";
  onRoute = () => act(text, [{ op: "project_state", ref: named("分类基线（科研项目）"), status: "paused" }, { op: "prioritize", ref: named("微积分习题集") }], "暂停项目，优先微积分");
  const first = await say(text);
  assert.ok(first.questions.some((q) => q.purpose === "confirm"), JSON.stringify(first));
  const done = await confirmAll(first.intakeId);
  assert.equal((db().prepare(`SELECT status FROM projects WHERE title = ?`).get("分类基线（科研项目）") as { status: string }).status, "paused");
  const baseline = taskRow("整理基线代码");
  assert.ok(baseline.paused_until, "项目下任务暂停");
  assert.equal((db().prepare(`SELECT COUNT(*) AS n FROM plan_sessions WHERE task_id = ? AND status IN ('tentative','planned')`).get(baseline.id) as { n: number }).n, 0, "未开始的块已让出");
  assert.equal(taskRow("微积分习题集").priority, "high");
  assert.equal(done.state, "applied", JSON.stringify(done));
  assert.equal(done.verification?.status, "verified", JSON.stringify(done.verification));
  const kinds = done.verification!.checks.map((c) => `${c.kind}:${c.ok}`);
  assert.ok(kinds.includes("dependent_steps_completed:true"), kinds.join(","));
  assert.ok(kinds.includes("entity_state_matches:true"), kinds.join(","));
  assert.equal(getGoal(done.goal!.id)!.state, "completed");
});

test("G03 第二步失败：不显示全部完成，核验记为部分完成并说明哪一步没做成，已完成的第一步保留", async () => {
  const text = "先把读论文停一下，物理竞赛题截止改到20号";
  onRoute = () => act(text, [{ op: "pause_task", ref: named("读论文"), until: null }, { op: "set_due", ref: named("物理竞赛题"), dueLocalDate: "2026-10-20", dueLocalTime: null }], "暂停读论文，改物理竞赛题截止");
  const first = await say(text);
  const done = await confirmAll(first.intakeId);
  assert.ok(taskRow("读论文").paused_until, "第一步保留");
  assert.equal(done.state, "partly_applied", JSON.stringify(done));
  assert.equal(done.verification?.status, "partial", JSON.stringify(done.verification));
  const step = done.verification!.checks.find((c) => c.kind === "dependent_steps_completed")!;
  assert.equal(step.ok, false);
  assert.match(step.detail, /没有完成/);
  assert.equal(getGoal(done.goal!.id)!.state, "partial");
});

test("G05 截止前仍缺时间：给出具体取舍问题，不改截止、不动课程与学习预算，目标等你决定", async () => {
  op({ command: "create_or_update_task", title: "概率论大作业", taskKind: "study", estimateMinutes: 900, dueLocalDate: "2026-10-13" });
  const text = "概率论大作业优先";
  onRoute = () => act(text, [{ op: "prioritize", ref: named("概率论大作业") }], "优先概率论大作业");
  const first = await say(text);
  const courseFacts = courses();
  const rules = JSON.stringify(db().prepare(`SELECT * FROM planning_policy_rules ORDER BY id`).all());
  const prefs = JSON.stringify(db().prepare(`SELECT * FROM planning_preferences`).all());
  const done = await confirmAll(first.intakeId);
  assert.equal(taskRow("概率论大作业").priority, "high");
  assert.equal(done.verification?.status, "needs_action", JSON.stringify(done.verification));
  assert.equal(done.state, "needs_input", "取舍问题还开着时不显示已更新");
  const gap = done.verification!.checks.find((c) => c.kind === "demand_covered")!;
  assert.equal(gap.ok, false);
  assert.match(gap.detail, /还缺 \d+ 分钟/);
  const tradeoff = done.questions.find((q) => q.purpose === "tradeoff");
  assert.ok(tradeoff && tradeoff.options.length >= 2, JSON.stringify(done.questions));
  assert.equal(taskRow("概率论大作业").due_local_date, "2026-10-13", "截止没有被改");
  assert.equal(courses(), courseFacts, "课程没动");
  assert.equal(JSON.stringify(db().prepare(`SELECT * FROM planning_policy_rules ORDER BY id`).all()), rules, "规则没动");
  assert.equal(JSON.stringify(db().prepare(`SELECT * FROM planning_preferences`).all()), prefs, "学习预算没提高");
  assert.equal(getGoal(done.goal!.id)!.state, "awaiting_input");
  assert.match(done.summary, /需要你决定/);
});

test("G09 调课撞上锁定块：保留课程调整与锁定块，修正一次后同样失败即停（不循环），受阻并给出冲突问题", async () => {
  const sessionId = (db().prepare(`SELECT s.id FROM plan_sessions s JOIN tasks t ON t.id = s.task_id WHERE t.title = '数据结构作业' AND s.status = 'planned' ORDER BY s.start_utc LIMIT 1`).get() as { id: string }).id;
  op({ command: "set_session_state", sessionId, action: "lock" });
  const locked = db().prepare(`SELECT start_utc, end_utc, locked FROM plan_sessions WHERE id = ?`).get(sessionId);
  const text = "明天的高等数学改到上午十点";
  onRoute = () => act(text, [{ op: "course_move", courseName: "高等数学", sourceDate: "2026-10-13", targetDate: "2026-10-13", startLocalTime: "10:00" }], "把明天的高等数学挪到十点");
  const first = await say(text);
  const done = await confirmAll(first.intakeId);
  assert.ok(db().prepare(`SELECT 1 FROM teaching_day_overrides WHERE target_date = '2026-10-13'`).get(), "课程调整保留");
  assert.deepEqual(db().prepare(`SELECT start_utc, end_utc, locked FROM plan_sessions WHERE id = ?`).get(sessionId), locked, "锁定块没被挪动");
  assert.equal(done.verification?.status, "blocked", JSON.stringify(done.verification));
  assert.equal(done.verification!.repairs.length, 1, "同样的失败只修一次");
  assert.ok(done.verification!.checks.some((c) => c.kind === "repair_limit" && /同样的问题/.test(c.detail)));
  assert.ok(done.verification!.checks.some((c) => c.kind === "plan_consistent" && c.ok === false && /锁定/.test(c.detail)));
  assert.equal(done.state, "partly_applied");
  assert.ok(done.questions.some((q) => q.purpose === "conflict"), JSON.stringify(done.questions));
  const goal = getGoal(done.goal!.id)!;
  assert.equal(goal.state, "blocked");
  assert.equal(goal.repairCount, 1);
});

test("有限修正：重排一时失败 → 原授权内重跑重排一次后通过；修正原因与结果记在核验里", async () => {
  db().exec(`CREATE TABLE p5_fail (x INTEGER); INSERT INTO p5_fail VALUES (1);
    CREATE TRIGGER p5_plan_fail BEFORE INSERT ON agent_action_batches WHEN NEW.command = 'plan_sessions' AND EXISTS (SELECT 1 FROM p5_fail) BEGIN SELECT RAISE(ABORT, '模拟重排写入失败'); END;
    CREATE TRIGGER p5_clear AFTER INSERT ON agent_verifications BEGIN DELETE FROM p5_fail; END;`);
  try {
    const text = "新建统计作业，大概两小时";
    onRoute = () => act(text, [{ op: "create_task", title: "统计作业", taskKind: "study", estimateMinutes: 120 }], "新建统计作业");
    const r = await say(text);
    const rounds = listVerifications(r.intakeId);
    assert.equal(rounds.length, 2, JSON.stringify(rounds));
    assert.equal(rounds[0]!.status, "partial");
    assert.ok(rounds[0]!.checks.some((c) => c.kind === "plan_consistent" && c.ok === false && c.repair === "replan"));
    assert.equal(rounds[0]!.repair!.steps[0]!.kind, "replan");
    assert.match(rounds[0]!.repair!.steps[0]!.detail, /学习安排/);
    assert.equal(rounds[1]!.status, "verified", JSON.stringify(rounds[1]));
    assert.equal(r.verification?.status, "verified");
    assert.equal(r.verification!.repairs.length, 1);
    assert.ok((db().prepare(`SELECT COUNT(*) AS n FROM plan_sessions s JOIN tasks t ON t.id = s.task_id WHERE t.title = '统计作业' AND s.status = 'planned'`).get() as { n: number }).n > 0, "修正后排上了");
  } finally {
    db().exec(`DROP TRIGGER IF EXISTS p5_plan_fail; DROP TRIGGER IF EXISTS p5_clear; DROP TABLE IF EXISTS p5_fail;`);
  }
});

test("修正上限：持续失败只修一次就停；已修过 2 次的投递不再修正；已完成的写入保留", async () => {
  db().exec(`CREATE TRIGGER p5_plan_fail BEFORE INSERT ON agent_action_batches WHEN NEW.command = 'plan_sessions' BEGIN SELECT RAISE(ABORT, '模拟重排写入失败'); END;`);
  try {
    const text = "新建毛概论文，大概三小时";
    onRoute = () => act(text, [{ op: "create_task", title: "毛概论文", taskKind: "study", estimateMinutes: 180 }], "新建毛概论文");
    const r = await say(text);
    assert.ok(taskRow("毛概论文"), "任务保留");
    assert.equal(r.verification?.status, "blocked", JSON.stringify(r.verification));
    assert.equal(r.verification!.repairs.length, 1);
    assert.equal(r.state, "partly_applied");

    const res = await POST(request("http://localhost/api/v2/intakes", { text: "新建近代史读书笔记，大概两小时" }));
    const id = ((await res.json()) as { intakeId: string }).intakeId;
    for (let n = 0; n < 2; n++) appendVerification({ intakeId: id, goalId: null, goalRevision: null, status: "partial", checks: [], fingerprint: `old-${n}`, repair: { reason: "之前的修正", steps: [], fingerprint: `old-${n}` } });
    onRoute = () => act("新建近代史读书笔记，大概两小时", [{ op: "create_task", title: "近代史读书笔记", taskKind: "study", estimateMinutes: 120 }], "新建读书笔记");
    await drain();
    const capped = intakeResultById(id)!;
    assert.equal(capped.verification?.status, "blocked");
    assert.equal(capped.verification!.repairs.length, 2, "没有第三次修正");
    assert.ok(capped.verification!.checks.some((c) => c.kind === "repair_limit" && /2 次/.test(c.detail)));
  } finally {
    db().exec(`DROP TRIGGER IF EXISTS p5_plan_fail;`);
  }
});

test("核验记录随业务导出", () => {
  assert.ok("agent_verifications" in FULL_JSON_TABLES);
});
