import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { NextRequest } from "next/server";
import { migrateAll, getDb } from "./helpers";
import { createSession, SESSION_COOKIE } from "@/domain/session";
import { setNowForTests } from "@/domain/clock";
import { setProvidersForTests } from "@/integrations";
import { ScriptedChatProvider } from "@/integrations/fake-model-provider";
import { fixtureSearchProvider } from "@/integrations/fixtures";
import type { RawCallResult } from "@/integrations/model-json";
import { POST } from "@/app/api/v2/intakes/route";
import { POST as answerRoute } from "@/app/api/v2/questions/[id]/answers/route";
import { runDueJobsOnce } from "@/worker/runner";
import { intakeResultById, type IntakeResultView } from "@/workflows/results";
import { executeOperation } from "@/workflows/commands";
import { getGoal } from "@/repositories/goals";
import { listItems, setIntakeStatus, updateItem } from "@/repositories/intakes";
import { createJob } from "@/repositories/jobs";
import { INTAKE_JOB_TYPE } from "@/contracts/intake";
import { FIXTURE_NOW, seedFixture } from "./corpus/fixtures";

/**
 * 语义修复（AGENT-SEMANTIC-REPAIR 2026-10-05）R01–R08 的复现与回归。
 * 真实管线（POST 投递 → worker → 路由/决策 → 绑定 → Gate → 执行器 → 核验/修正），模型换成脚本，
 * 脚本故意给出“忘了条件”的输出，验证服务端靠结构化约束与统一 Gate 守住主人的话，而不是靠提示词。
 */

const NOW = new Date(FIXTURE_NOW);
let token = "", csrf = "", seq = 0;
let onRoute: () => unknown = () => ({ items: [] });
let decisions: unknown[] = [];
let provider: ScriptedChatProvider;

const final = (value: unknown): RawCallResult => ({ ok: true, text: JSON.stringify(value) });
const act = (excerpt: string, intents: unknown[], rationale = "按原话执行", constraints: unknown[] = []) => ({ items: [{ itemKey: "act", excerpt, outcome: { kind: "act", intents, rationale, constraints }, continuesGoal: false }] });
const decide = (excerpt: string, continuesGoal = false) => ({ items: [{ itemKey: "adjust", excerpt, outcome: { kind: "decide", objective: excerpt, rationale: "需要结合事实权衡" }, continuesGoal }] });

function request(url: string, body: unknown, key = `sr-${seq++}`) {
  return new NextRequest(url, { method: "POST", headers: { cookie: `${SESSION_COOKIE}=${token}`, "x-csrf-token": csrf, "content-type": "application/json", "idempotency-key": key }, body: JSON.stringify(body) });
}
async function drain(n = 8) { for (let i = 0; i < n; i++) await runDueJobsOnce(); }
async function post(text: string): Promise<string> {
  const res = await POST(request("http://localhost/api/v2/intakes", { text }));
  const body = (await res.json()) as { intakeId: string };
  assert.equal(res.status, 202, JSON.stringify(body));
  return body.intakeId;
}
async function say(text: string): Promise<IntakeResultView> {
  const id = await post(text);
  await drain();
  return intakeResultById(id)!;
}
async function answer(q: { id: string; version: number }, text: string) {
  const res = await answerRoute(request("http://localhost/api/v2/questions", { text, expectedVersion: q.version }), { params: Promise.resolve({ id: q.id }) });
  assert.ok(res.status < 300, `回答 ${res.status} ${await res.text()}`);
  await drain();
}
const confirmQ = (id: string) => intakeResultById(id)!.questions.find((q) => q.purpose === "confirm");
function op(command: Record<string, unknown>) {
  const r = executeOperation(command, { intakeId: null, itemId: null, itemKey: "", instanceEpoch: 0, evidence: "", explicit: true, now: NOW });
  assert.ok(r.result.ok, JSON.stringify(r));
  return r;
}
const db = () => getDb();
const prefs = () => db().prepare(`SELECT workday_end AS workdayEnd, weekend_end AS weekendEnd, workday_start AS workdayStart, weekend_start AS weekendStart FROM planning_preferences WHERE id = 1`).get() as Record<string, string>;
const resetPrefs = () => op({ command: "update_planning_policy", base: { workdayEnd: "23:00", weekendEnd: "23:00", workdayStart: "08:00", weekendStart: "08:00" }, rules: [], revokeRuleIds: [], confirm: true });
const batchesOf = (intakeId: string) => (db().prepare(`SELECT COUNT(*) AS n FROM agent_action_batches WHERE intake_id = ? AND command != 'plan_sessions'`).get(intakeId) as { n: number }).n;
const decideCalls = () => provider.exchanges.filter((e) => e.workflow === "agent_decide").length;
/** 周末（10/17–10/18）的规则与未开始学习块：保护对象的完整快照 */
const weekend = () => JSON.stringify([
  db().prepare(`SELECT weekend_start, weekend_end FROM planning_preferences WHERE id = 1`).get(),
  db().prepare(`SELECT kind, date_from, date_to, value_json FROM planning_policy_rules WHERE status = 'active' AND (date_from IS NULL OR date_to >= '2026-10-17') AND (date_from IS NULL OR date_from <= '2026-10-18') ORDER BY id`).all(),
  db().prepare(`SELECT id, start_utc, end_utc, status FROM plan_sessions WHERE status IN ('tentative','planned') AND date(start_utc, '+8 hours') BETWEEN '2026-10-17' AND '2026-10-18' ORDER BY id`).all(),
]);
const autoSessionsOn = (date: string) => (db().prepare(`SELECT id FROM plan_sessions WHERE status IN ('tentative','planned') AND origin != 'user' AND locked = 0 AND date(start_utc, '+8 hours') = ?`).all(date) as Array<{ id: string }>).map((r) => r.id);

before(() => {
  migrateAll();
  seedFixture("week-basic");
  setNowForTests(NOW);
  const s = createSession(1);
  token = s.token;
  csrf = s.session.csrfToken;
  provider = new ScriptedChatProvider((req) => {
    if (req.workflow === "agent_route") return final(onRoute());
    if (req.workflow === "agent_decide") {
      const next = decisions.shift();
      return next ? final(next) : { ok: false, code: "HTTP_ERROR", message: "脚本里没有准备决策", retryable: false };
    }
    if (req.workflow === INTAKE_JOB_TYPE) return final({ items: [] });
    return { ok: false, code: "HTTP_ERROR", message: `脚本没有处理 ${req.workflow}`, retryable: false };
  });
  setProvidersForTests({ model: { mode: "fixture", provider }, search: { mode: "fixture", provider: fixtureSearchProvider() } });
  // 周末有一段主人亲自放的学习块：保护对象不是空的
  op({ command: "schedule_session", title: "英语阅读", date: "2026-10-17", startLocalTime: "10:00", durationMinutes: 60 });
});
after(() => setNowForTests(null));

test("R01 工作日/周末能力：工作日收工时间改动不连带周末；保护约束把“全天”方案收窄到工作日", async () => {
  resetPrefs();
  // (a) 模型直接表达“只工作日”
  const text = "工作日晚上九点半收工";
  onRoute = () => act(text, [{ op: "window_end", time: "21:30", days: "workday" }], "工作日 21:30 收工");
  const a = await say(text);
  const q = confirmQ(a.intakeId);
  if (q) await answer(q, "可以");
  assert.deepEqual([prefs().workdayEnd, prefs().weekendEnd], ["21:30", "23:00"], "只改了工作日");

  // (b) 模型给了全天，但带着主人原话里的“周末别动”约束：服务端收窄，而不是照写
  resetPrefs();
  const before = weekend();
  const text2 = "晚上太满了，平时早点收工，周末别动";
  onRoute = () => decide(text2);
  decisions = [{ kind: "act", rationale: "晚上 21:30 收工", intents: [{ op: "window_end", time: "21:30" }], constraints: [{ kind: "protect_days", days: "weekend", excerpt: "周末别动" }] }];
  const b = await say(text2);
  const q2 = confirmQ(b.intakeId);
  assert.ok(q2, `需要确认：${JSON.stringify(intakeResultById(b.intakeId))}`);
  assert.match(q2.prompt, /周末/, "确认里说清楚周末不动");
  await answer(q2, "可以");
  assert.equal(prefs().workdayEnd, "21:30", "工作日的修改确实做了");
  assert.equal(weekend(), before, "周末作息、规则与未开始学习块都没动");
});

test("R02 规则无变化但必需的重排失败：不能核验为通过", async () => {
  resetPrefs();
  op({ command: "update_planning_policy", rules: [{ kind: "auto_reschedule", dateFrom: "2026-10-13", dateTo: "2026-10-13", scope: "temporary", value: {} }], revokeRuleIds: [], confirm: false });
  assert.ok(autoSessionsOn("2026-10-13").length, "前提：明天有自动安排的块");
  db().exec(`CREATE TRIGGER sr_plan_fail BEFORE INSERT ON agent_action_batches WHEN NEW.command = 'plan_sessions' BEGIN SELECT RAISE(ABORT, '模拟重排写入失败'); END;`);
  try {
    const text = "重新安排明天";
    onRoute = () => act(text, [{ op: "replan", dateFrom: "2026-10-13", dateTo: "2026-10-13" }], "重新安排明天");
    const r = await say(text);
    assert.notEqual(r.verification?.status, "verified", JSON.stringify(r.verification));
    assert.ok(r.verification!.checks.some((c) => c.kind === "plan_consistent" && c.ok === false), JSON.stringify(r.verification!.checks));
    assert.notEqual(r.state, "applied");
  } finally {
    db().exec(`DROP TRIGGER IF EXISTS sr_plan_fail;`);
  }
});

test("R03 异步副作用：复盘任务还在排队时核验是等待中；任务失败后核验跟着变成未达成", async () => {
  const text = "帮我复盘一下上周";
  onRoute = () => act(text, [{ op: "review", week: "last" }], "复盘上周");
  const id = await post(text);
  await runDueJobsOnce(); // 只跑投递本身，复盘任务还在队列里
  const waiting = intakeResultById(id)!;
  assert.equal(waiting.verification?.status, "pending", JSON.stringify(waiting.verification));
  assert.ok(waiting.verification!.checks.some((c) => c.kind === "side_effect_status" && c.ok === null && /排队|进行/.test(c.detail)));
  await drain(); // 复盘任务执行：记录太少 → insufficient（只列事实），核验跟着结果走，不再是“等待中”
  const done = intakeResultById(id)!;
  const status = (db().prepare(`SELECT status FROM reviews ORDER BY created_at DESC LIMIT 1`).get() as { status: string }).status;
  assert.equal(status, "insufficient");
  assert.ok(done.verification!.checks.some((c) => c.kind === "side_effect_status" && c.ok === true && /记录太少/.test(c.detail)), JSON.stringify(done.verification));

  // 异步任务真的失败（找候选项目：脚本模型不处理探索工作流 → 探索失败）：核验变成未达成，不是“已核对”
  const text2 = "帮我找找数据库方向的练手项目";
  onRoute = () => act(text2, [{ op: "explore", query: "数据库练手项目" }], "找候选项目");
  const id2 = await post(text2);
  await runDueJobsOnce();
  const q = confirmQ(id2);
  if (q) {
    const res = await answerRoute(request("http://localhost/api/v2/questions", { text: "可以", expectedVersion: q.version }), { params: Promise.resolve({ id: q.id }) });
    assert.ok(res.status < 300);
    await runDueJobsOnce();
  }
  assert.equal(intakeResultById(id2)!.verification?.status, "pending", "探索在排队：等待中");
  await drain();
  const run = db().prepare(`SELECT status FROM exploration_runs ORDER BY created_at DESC, rowid DESC LIMIT 1`).get() as { status: string };
  assert.equal(run.status, "failed");
  const failed = intakeResultById(id2)!;
  assert.notEqual(failed.verification?.status, "verified", JSON.stringify(failed.verification));
  assert.ok(failed.verification!.checks.some((c) => c.kind === "side_effect_status" && c.ok === false), JSON.stringify(failed.verification!.checks));
});

test("R04 直接执行也受主人日期范围约束：只重排今天，模型给下周 → 拒绝或追问，不写入", async () => {
  const rules = () => (db().prepare(`SELECT COUNT(*) AS n FROM planning_policy_rules`).get() as { n: number }).n;
  const n = rules();
  const text = "只重新安排今天的学习时间";
  onRoute = () => act(text, [{ op: "replan", dateFrom: "2026-10-19", dateTo: "2026-10-25" }], "重新安排");
  const r = await say(text);
  assert.equal(batchesOf(r.intakeId), 0, JSON.stringify(r));
  assert.equal(rules(), n, "没有新的重排授权");
  assert.ok(["failed", "needs_input"].includes(r.state), r.state);
  assert.notEqual(r.verification?.status, "verified");
});

test("R05 带条件的“可以”不走前缀快路径：按整句修订方案，周末作息不被改", async () => {
  resetPrefs();
  const text = "晚上太满了";
  onRoute = () => decide(text);
  decisions = [
    { kind: "act", rationale: "晚上 21:00 收工", intents: [{ op: "window_end", time: "21:00" }], constraints: [] },
    { kind: "act", rationale: "只把工作日改成 21:00 收工，周末维持原样", intents: [{ op: "window_end", time: "21:00", days: "workday" }], constraints: [{ kind: "protect_days", days: "weekend", excerpt: "周末别动" }] },
  ];
  const r = await say(text);
  const goalBefore = getGoal(r.goal!.id)!.revision;
  const q = confirmQ(r.intakeId)!;
  assert.ok(q);
  const calls = decideCalls();
  await answer(q, "可以，但只能改工作日，周末别动");
  assert.equal(decideCalls(), calls + 1, "带条件的回答按整句重新决策");
  const again = confirmQ(r.intakeId);
  if (again) await answer(again, "可以");
  assert.deepEqual([prefs().workdayEnd, prefs().weekendEnd], ["21:00", "23:00"]);
  assert.ok(getGoal(r.goal!.id)!.revision > goalBefore, "条件回答修订了同一个目标");

  // 犹豫/反问不是同意
  resetPrefs();
  onRoute = () => decide("晚上排得太晚了");
  decisions = [
    { kind: "act", rationale: "晚上 21:00 收工", intents: [{ op: "window_end", time: "21:00" }], constraints: [] },
    { kind: "ask", question: "要不要先只试一周？", reason: "你还在考虑", options: ["先试一周", "先不改"] },
  ];
  const h = await say("晚上排得太晚了");
  await answer(confirmQ(h.intakeId)!, "可以吗？我还没想好");
  assert.equal(batchesOf(h.intakeId), 0, "犹豫不执行");
  assert.deepEqual([prefs().workdayEnd, prefs().weekendEnd], ["23:00", "23:00"]);

  // 完整无条件的“可以。”仍走零模型快路径
  onRoute = () => decide("晚上收得太晚");
  decisions = [{ kind: "act", rationale: "晚上 22:00 收工", intents: [{ op: "window_end", time: "22:00" }], constraints: [] }];
  const y = await say("晚上收得太晚");
  const before = decideCalls();
  await answer(confirmQ(y.intakeId)!, "可以。");
  assert.equal(decideCalls(), before, "无条件同意不再调用模型");
  assert.equal(prefs().workdayEnd, "22:00");
});

test("R06 确认期间相关设置被改：旧确认作废并说明差异；无关变化不重问", async () => {
  resetPrefs();
  onRoute = () => decide("晚上太满了");
  decisions = [{ kind: "act", rationale: "工作日 21:00 收工", intents: [{ op: "window_end", time: "21:00", days: "workday" }], constraints: [] }];
  const r = await say("晚上太满了");
  const q = confirmQ(r.intakeId)!;
  op({ command: "update_planning_policy", base: { workdayEnd: "22:00" }, rules: [], revokeRuleIds: [], confirm: true });
  await answer(q, "可以");
  assert.equal(prefs().workdayEnd, "22:00", "旧确认没有覆盖新设置");
  const again = confirmQ(r.intakeId);
  assert.ok(again && again.id !== q.id, "按现在的事实重新问");
  assert.match(again.prompt, /变|作废/);

  // 无关变化（改一个任务的优先级）不让确认失效
  resetPrefs();
  onRoute = () => decide("晚上还是太满");
  decisions = [{ kind: "act", rationale: "工作日 21:00 收工", intents: [{ op: "window_end", time: "21:00", days: "workday" }], constraints: [] }];
  const u = await say("晚上还是太满");
  const uq = confirmQ(u.intakeId)!;
  const task = db().prepare(`SELECT id FROM tasks WHERE title = '读论文'`).get() as { id: string };
  op({ command: "create_or_update_task", taskId: task.id, priority: "high" });
  await answer(uq, "可以");
  assert.equal(prefs().workdayEnd, "21:00", "无关变化后确认照样生效");
  assert.equal(confirmQ(u.intakeId), undefined);
});

test("R07 找候选项目：提交后、标记前崩溃再恢复，只有一次探索与一个任务", async () => {
  const runs = () => (db().prepare(`SELECT COUNT(*) AS n FROM exploration_runs`).get() as { n: number }).n;
  const jobs = () => (db().prepare(`SELECT COUNT(*) AS n FROM jobs WHERE type = 'exploration'`).get() as { n: number }).n;
  const [r0, j0] = [runs(), jobs()];
  const text = "帮我找找机器学习的练手项目";
  onRoute = () => act(text, [{ op: "explore", query: "机器学习练手项目" }], "找候选项目");
  const id = await post(text);
  await runDueJobsOnce();
  const q = confirmQ(id);
  if (q) await answer(q, "可以");
  const item = listItems(id).find((i) => i.state === "applied")!;
  assert.ok(item, JSON.stringify(listItems(id)));
  assert.equal(runs(), r0 + 1);
  const payload = { ...item.payload };
  delete payload.applied;
  delete payload.followUps;
  updateItem(item.id, { state: "ready", payload });
  setIntakeStatus(id, "processing");
  createJob({ type: INTAKE_JOB_TYPE, dedupeKey: `intake:${id}:recover`, runAt: new Date().toISOString(), payload: { intakeId: id, cause: "recover" } });
  await drain();
  assert.equal(runs(), r0 + 1, "恢复后没有第二次探索");
  assert.equal(jobs(), j0 + 1, "只有一个探索任务");
});

test("R08 修正沿用原日期：重新安排明天首次写入失败，修正仍只重排明天并替换旧的自动块", async () => {
  resetPrefs();
  op({ command: "update_planning_policy", rules: [], revokeRuleIds: (db().prepare(`SELECT id FROM planning_policy_rules WHERE status='active' AND kind='auto_reschedule'`).all() as Array<{ id: string }>).map((x) => x.id), confirm: false });
  const old = autoSessionsOn("2026-10-14");
  assert.ok(old.length, "前提：后天有自动安排的块");
  db().exec(`CREATE TABLE sr_fail (x INTEGER); INSERT INTO sr_fail VALUES (1);
    CREATE TRIGGER sr_plan_fail BEFORE INSERT ON agent_action_batches WHEN NEW.command = 'plan_sessions' AND EXISTS (SELECT 1 FROM sr_fail) BEGIN SELECT RAISE(ABORT, '模拟重排写入失败'); END;
    CREATE TRIGGER sr_clear AFTER INSERT ON agent_verifications BEGIN DELETE FROM sr_fail; END;`);
  try {
    const text = "重新安排后天的学习";
    onRoute = () => act(text, [{ op: "replan", dateFrom: "2026-10-14", dateTo: "2026-10-14" }], "重新安排后天");
    const r = await say(text);
    assert.equal(r.verification!.repairs.length, 1, JSON.stringify(r.verification));
    const still = old.filter((id) => (db().prepare(`SELECT status FROM plan_sessions WHERE id = ?`).get(id) as { status: string }).status !== "superseded");
    assert.deepEqual(still, [], "修正按原来的日期重排，旧的自动块都被替换");
  } finally {
    db().exec(`DROP TRIGGER IF EXISTS sr_plan_fail; DROP TRIGGER IF EXISTS sr_clear; DROP TABLE IF EXISTS sr_fail;`);
  }
});

/**
 * 截止日被读成范围（真实模型 g05 的失败：“概率论大作业明天就要交了，帮我优先安排”）。
 * 原话里唯一的日期是截止日，服务端的日期解析和模型的范围约束都把它读成“只涉及明天”，
 * 于是从今天起的重排被统一门拒绝。同一个日期两种理解都说得通：先问一次，回答前什么都不改，按回答落实。
 */
const scopeQ = (id: string) => intakeResultById(id)!.questions.find((q) => q.purpose === "tradeoff" && q.prompt.includes("截止日"));
const dueTask = (title: string) => op({ command: "create_or_update_task", title, taskKind: "study", estimateMinutes: 600, dueLocalDate: "2026-10-13" });
const deadlineAct = (text: string, title: string) =>
  act(text, [{ op: "set_due", ref: { kind: "named", text: title, date: null, part: "any" }, dueLocalDate: "2026-10-13", dueLocalTime: null }, { op: "prioritize", ref: { kind: "named", text: title, date: null, part: "any" } }, { op: "replan", dateFrom: "2026-10-12", dateTo: "2026-10-13" }], "截止在明天，优先安排", [{ kind: "date_scope", dateFrom: "2026-10-13", dateTo: "2026-10-13", excerpt: "明天" }]);
const replanFromToday = () => (db().prepare(`SELECT COUNT(*) AS n FROM planning_policy_rules WHERE kind = 'auto_reschedule' AND status = 'active' AND date_from = '2026-10-12' AND date_to = '2026-10-13'`).get() as { n: number }).n;

test("截止日被读成范围：先问截止还是只动那一天；答“截止前都可以排”后从今天起重排，不记成范围", async () => {
  resetPrefs();
  dueTask("概率论大作业");
  const rules0 = replanFromToday();
  const text = "概率论大作业明天就要交了，帮我优先安排";
  onRoute = () => deadlineAct(text, "概率论大作业");
  const r = await say(text);
  const q = scopeQ(r.intakeId);
  assert.ok(q, `应先问截止还是范围：${JSON.stringify(r)}`);
  assert.equal(batchesOf(r.intakeId), 0, "回答前什么都不改");
  assert.deepEqual(q!.options, ["从今天到截止前都可以排", "只调整 10/13 那一天", "先不要，什么都不改"]);

  await answer(q!, "从今天到截止前都可以排");
  const done = intakeResultById(r.intakeId)!;
  assert.ok(!JSON.stringify(done).includes("超出了你说的范围"), JSON.stringify(done));
  assert.ok(batchesOf(r.intakeId) > 0, `回答后执行：${JSON.stringify(done)}`);
  assert.ok(replanFromToday() > rules0, "从今天到截止的重排授权写入了");
  const goalScopes = done.goal ? (db().prepare(`SELECT value_json FROM agent_goal_constraints WHERE goal_id = ? AND kind = 'date_scope' AND status = 'accepted'`).all(done.goal.id) as Array<{ value_json: string }>) : [];
  assert.deepEqual(goalScopes, [], "截止日没有被记成这件事的范围");
});

test("截止日被读成范围：答“只调整那一天”就只动 10/13，今天的安排不动；答“先不要”什么都不改", async () => {
  resetPrefs();
  dueTask("数理统计作业");
  const today = autoSessionsOn("2026-10-12");
  const text = "数理统计作业明天就要交了，帮我优先安排";
  onRoute = () => deadlineAct(text, "数理统计作业");
  const r = await say(text);
  await answer(scopeQ(r.intakeId)!, "只调整 10/13 那一天");
  assert.deepEqual(autoSessionsOn("2026-10-12"), today, "只动截止那一天：今天的自动安排没有被替换");

  dueTask("运筹学作业");
  const text2 = "运筹学作业明天就要交了，帮我优先安排";
  onRoute = () => deadlineAct(text2, "运筹学作业");
  const k = await say(text2);
  await answer(scopeQ(k.intakeId)!, "先不要，什么都不改");
  assert.equal(batchesOf(k.intakeId), 0);
  assert.equal(scopeQ(k.intakeId), undefined, "问题已答完，没有再问");
  assert.equal(intakeResultById(k.intakeId)!.questions.length, 0);
});

test("截止日被读成范围：不问的情况——范围覆盖今天、没有截止、或主人明说只动别的日子", async () => {
  resetPrefs();
  dueTask("实变函数作业");
  const text = "实变函数作业明天交，今天和明天都帮我排一下";
  onRoute = () => act(text, [{ op: "prioritize", ref: { kind: "named", text: "实变函数作业", date: null, part: "any" } }, { op: "replan", dateFrom: "2026-10-12", dateTo: "2026-10-13" }], "今天和明天", [{ kind: "date_scope", dateFrom: "2026-10-12", dateTo: "2026-10-13", excerpt: "今天和明天" }]);
  const a = await say(text);
  assert.equal(scopeQ(a.intakeId), undefined, "范围本来就从今天起，不问");

  const text2 = "重新安排明天的学习";
  onRoute = () => act(text2, [{ op: "replan", dateFrom: "2026-10-13", dateTo: "2026-10-13" }], "重新安排明天");
  const b = await say(text2);
  assert.equal(scopeQ(b.intakeId), undefined, "没有截止，“明天”就是范围");
  assert.ok(batchesOf(b.intakeId) > 0);

  // R04 不受影响：只重排今天，模型给下周 → 仍拒绝
  const text3 = "只重新安排今天的学习时间";
  onRoute = () => act(text3, [{ op: "replan", dateFrom: "2026-10-19", dateTo: "2026-10-25" }], "重新安排");
  const c = await say(text3);
  assert.equal(batchesOf(c.intakeId), 0);
  assert.equal(scopeQ(c.intakeId), undefined);
});

test("截止日被读成范围（决策路径）：方案确认前先问；答“截止前都可以排”后重新决策，不带那一天的范围", async () => {
  resetPrefs();
  dueTask("复变函数作业");
  const text = "复变函数作业明天就要交了，帮我看着安排";
  onRoute = () => decide(text);
  const plan = { kind: "act", rationale: "截止在明天，从今天起优先安排", intents: [{ op: "prioritize", ref: { kind: "named", text: "复变函数作业", date: null, part: "any" } }, { op: "replan", dateFrom: "2026-10-12", dateTo: "2026-10-13" }], constraints: [{ kind: "date_scope", dateFrom: "2026-10-13", dateTo: "2026-10-13", excerpt: "明天" }] };
  decisions = [plan, plan];
  const r = await say(text);
  const q = scopeQ(r.intakeId);
  assert.ok(q, `决策路径也先问：${JSON.stringify(r)}`);
  assert.equal(confirmQ(r.intakeId), undefined, "还没到确认方案");
  assert.equal(batchesOf(r.intakeId), 0);
  const calls = decideCalls();
  await answer(q!, "从今天到截止前都可以排");
  assert.equal(decideCalls(), calls + 1, "按回答重新决策");
  const c = confirmQ(r.intakeId);
  if (c) await answer(c, "可以");
  const done = intakeResultById(r.intakeId)!;
  assert.ok(!JSON.stringify(done).includes("超出了你说的范围"), JSON.stringify(done));
  assert.ok(batchesOf(r.intakeId) > 0, `执行了：${JSON.stringify(done)}`);
});
