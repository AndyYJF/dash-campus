import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { NextRequest } from "next/server";
import { migrateAll, getDb } from "./helpers";
import { createOwner, createSession, SESSION_COOKIE } from "@/domain/session";
import { hashPassword } from "@/domain/password";
import { setNowForTests } from "@/domain/clock";
import { setProvidersForTests } from "@/integrations";
import { ScriptedChatProvider } from "@/integrations/fake-model-provider";
import type { ChatMessage, RawCallResult } from "@/integrations/model-json";
import { POST } from "@/app/api/v2/intakes/route";
import { GET as goalsRoute } from "@/app/api/v2/goals/route";
import { POST as answerRoute } from "@/app/api/v2/questions/[id]/answers/route";
import { runDueJobsOnce } from "@/worker/runner";
import { intakeResultById } from "@/workflows/results";
import { executeOperation } from "@/workflows/commands";
import { receiveIntake } from "@/workflows/intake";
import { getGoal, listGoalRevisions } from "@/repositories/goals";
import { getIntake } from "@/repositories/intakes";
import { getQuestion } from "@/repositories/questions";
import { FULL_JSON_TABLES } from "@/contracts/exports";
import { INTAKE_JOB_TYPE } from "@/contracts/intake";

/**
 * Agent 增强 v1.1 P4：目标、修订与自然语言续办。
 * 全部走真实管线（POST 投递 → worker → 路由/决策 → 绑定 → 执行器）；模型换成脚本，目标、修订、作废与续答都是真实代码。
 */

const NOW = new Date("2026-10-05T08:00:00+08:00");
let token = "", csrf = "", seq = 0;
type Ctx = Record<string, unknown>;
let onRoute: (context: Ctx) => unknown = () => ({ items: [] });
let onDecide: (context: Ctx) => unknown = () => ({ kind: "ask", question: "?", reason: "?", options: [] });
let provider: ScriptedChatProvider;

const contextOf = (messages: ChatMessage[]) => (JSON.parse(String(messages[1]!.content)) as { context: Ctx }).context;
const final = (value: unknown): RawCallResult => ({ ok: true, text: JSON.stringify(value) });
const decideItem = (excerpt: string, continuesGoal = false) => ({ itemKey: "goal", excerpt, outcome: { kind: "decide", objective: excerpt, rationale: "要在几种安排里权衡" }, continuesGoal });
const replan = (dateFrom: string, dateTo: string) => ({ kind: "act", rationale: `按课程与预算重排 ${dateFrom} 至 ${dateTo}`, intents: [{ op: "replan", dateFrom, dateTo }] });

function request(url: string, body: unknown, key = `p4-${seq++}`) {
  return new NextRequest(url, { method: "POST", headers: { cookie: `${SESSION_COOKIE}=${token}`, "x-csrf-token": csrf, "content-type": "application/json", "idempotency-key": key }, body: JSON.stringify(body) });
}
async function drain() { for (let i = 0; i < 5; i++) await runDueJobsOnce(); }
async function post(text: string, extra: Record<string, unknown> = {}) {
  const res = await POST(request("http://localhost/api/v2/intakes", { text, ...extra }));
  return { status: res.status, body: (await res.json()) as { intakeId: string; goalId: string | null; goalRevision: number | null; conversationId: string; error?: { code: string } } };
}
async function say(text: string, extra: Record<string, unknown> = {}) {
  const r = await post(text, extra);
  assert.equal(r.status, 202, JSON.stringify(r.body));
  await drain();
  return intakeResultById(r.body.intakeId)!;
}
async function answer(q: { id: string; version: number }, text: string) {
  const res = await answerRoute(request("http://localhost/api/v2/intakes", { text, expectedVersion: q.version }), { params: Promise.resolve({ id: q.id }) });
  await drain();
  return res.status;
}
function op(command: Record<string, unknown>) {
  const r = executeOperation(command, { intakeId: null, itemId: null, itemKey: "", instanceEpoch: 0, evidence: "", explicit: true, now: NOW });
  assert.ok(r.result.ok, JSON.stringify(r));
  return r;
}
const routeCalls = () => provider.exchanges.filter((e) => e.workflow === "agent_route").length;
const facts = () => JSON.stringify([
  getDb().prepare(`SELECT id, status, version, priority, archived_at FROM tasks ORDER BY id`).all(),
  getDb().prepare(`SELECT id, start_utc, status, version FROM plan_sessions ORDER BY id`).all(),
  getDb().prepare(`SELECT * FROM planning_policy_rules ORDER BY rowid`).all(),
]);
const replanBatches = () => (getDb().prepare(`SELECT COUNT(*) AS n FROM agent_action_batches WHERE command = 'replan_window' OR reason LIKE '%重排%'`).get() as { n: number }).n;

before(() => {
  migrateAll();
  setNowForTests(NOW);
  createOwner(hashPassword("p4-test-pass"));
  const s = createSession(1);
  token = s.token;
  csrf = s.session.csrfToken;
  provider = new ScriptedChatProvider((req, messages) => {
    if (req.workflow === "agent_route") return final(onRoute(contextOf(messages)));
    if (req.workflow === "agent_decide") return final(onDecide(contextOf(messages)));
    if (req.workflow === INTAKE_JOB_TYPE) return final({ items: [] });
    return { ok: false, code: "HTTP_ERROR", message: `脚本没有处理 ${req.workflow}`, retryable: false };
  });
  setProvidersForTests({ model: { mode: "fixture", provider } });
  op({ command: "create_or_update_task", title: "数学复习", taskKind: "study", remainingMinutes: 180, estimateMinutes: 180 });
  op({ command: "create_or_update_task", title: "英语阅读", taskKind: "study", remainingMinutes: 120, estimateMinutes: 120 });
});
after(() => setNowForTests(null));

test("G02 改口：优化→追问→只回“数学”→改成下周；同一目标第 2 版沿用约束、按下周执行；回答不另立目标也不调路由", async () => {
  onRoute = (c) => {
    assert.equal(c.currentGoal ?? null, null, "第一次没有当前目标");
    return { items: [decideItem("帮我优化这周的学习安排")] };
  };
  onDecide = (c) => ((c.replies as unknown[]).length ? replan("2026-10-05", "2026-10-11") : { kind: "ask", question: "这周优先哪门课？", reason: "两门课争用有限时间", options: ["数学", "英语"] });
  const first = await say("帮我优化这周的学习安排");
  assert.equal(first.state, "needs_input", JSON.stringify(first));
  assert.ok(first.goal, "投递挂上目标");
  assert.equal(first.goal!.revision, 1);
  assert.equal(getGoal(first.goal!.id)!.state, "awaiting_input");

  const routes = routeCalls();
  const reply = await say("数学");
  assert.equal(routeCalls(), routes, "孤立短答直接作答，不花路由请求");
  assert.equal(reply.state, "answered", JSON.stringify(reply));
  assert.match(reply.summary, /这周优先哪门课/);
  assert.equal(reply.goal, null, "回答本身不另立目标");
  const done = intakeResultById(first.intakeId)!;
  assert.ok(["applied", "no_change"].includes(done.state), JSON.stringify(done));
  const goal = getGoal(first.goal!.id)!;
  assert.equal(goal.state, "completed");
  assert.ok(goal.summary.constraints?.some((c) => /数学/.test(c)), JSON.stringify(goal.summary));
  assert.deepEqual(goal.summary.scope, { dateFrom: "2026-10-05", dateTo: "2026-10-11" });

  let seen: Ctx | null = null;
  onRoute = (c) => {
    assert.equal((c.currentGoal as { objective: string }).objective, "帮我优化这周的学习安排", "路由看得到当前目标");
    return { items: [decideItem("改成下周", true)] };
  };
  onDecide = (c) => { seen = c; return replan("2026-10-12", "2026-10-18"); };
  const changed = await say("改成下周");
  assert.ok(["applied", "no_change"].includes(changed.state), JSON.stringify(changed));
  assert.equal(changed.goal!.id, first.goal!.id, "改口在同一目标上");
  assert.equal(changed.goal!.revision, 2);
  assert.equal(changed.goal!.current, true);
  assert.deepEqual((seen as unknown as Ctx).requestedScope, { dateFrom: "2026-10-12", dateTo: "2026-10-18", explicit: true });
  const prev = (seen as unknown as { goal: { previous: { intents: unknown[] }; constraints: string[] } }).goal;
  assert.match(JSON.stringify(prev.previous.intents), /2026-10-11/, "决策看得到上一版方案");
  assert.ok(prev.constraints.some((c) => /数学/.test(c)), "上一版回答过的约束带到第 2 版");
  assert.deepEqual(listGoalRevisions(first.goal!.id).map((r) => r.cause), ["initial", "revise"]);
  assert.deepEqual(getGoal(first.goal!.id)!.summary.scope, { dateFrom: "2026-10-12", dateTo: "2026-10-18" });
  const old = intakeResultById(first.intakeId)!;
  assert.equal(old.goal!.current, false, "旧一轮标为不是最新");
});

test("G02 等待中改口：旧一轮的待答问题作废、旧方案不执行；再答旧问题被拒，领域数据不变", async () => {
  onRoute = () => ({ items: [decideItem("把这周学习重新排一下")] });
  onDecide = (c) => ((c.replies as unknown[]).length ? replan("2026-10-05", "2026-10-11") : { kind: "ask", question: "这周晚上还能学吗？", reason: "晚上时间不确定", options: ["能", "不能"] });
  const first = await say("把这周学习重新排一下");
  assert.equal(first.state, "needs_input");
  const oldQ = first.questions[0]!;

  const snapshot = facts();
  onRoute = () => ({ items: [decideItem("算了，改成下周再排", true)] });
  onDecide = () => ({ kind: "ask", question: "下周哪几天课多？", reason: "需要知道下周负担", options: ["周一周二", "周四周五"] });
  const changed = await say("算了，改成下周再排");
  assert.equal(changed.goal!.revision, 2);
  assert.equal(changed.state, "needs_input");
  assert.equal(getQuestion(oldQ.id)!.status, "superseded", "旧问题作废");
  const old = intakeResultById(first.intakeId)!;
  assert.equal(old.state, "cancelled");
  assert.match(old.summary, /第 2 版/);
  assert.equal(await answer(oldQ, "能"), 409, "旧问题不能再答");
  assert.equal(facts(), snapshot, "旧方案没有执行");
  // 收尾：停掉这个目标，免得影响后面的“唯一问题”判断
  const stop = await say("先别做了");
  assert.equal(stop.state, "answered", JSON.stringify(stop));
});

test("三轮问答：第一个/选项原文/自由回答，都按原问题解析后恢复原投递；第三轮后执行", async () => {
  const asks = [
    { kind: "ask", question: "优先保证哪类任务？", reason: "预算有限", options: ["考试复习", "日常作业"] },
    { kind: "ask", question: "周末能学多久？", reason: "周末空档不确定", options: ["每天两小时", "只学半天"] },
    { kind: "ask", question: "晚上最晚学到几点？", reason: "作息不确定", options: [] },
  ];
  let last: Ctx | null = null;
  onRoute = () => ({ items: [decideItem("帮我把本周学习调合理")] });
  onDecide = (c) => { last = c; const n = (c.replies as unknown[]).length; return n < 3 ? asks[n] : replan("2026-10-05", "2026-10-11"); };
  const first = await say("帮我把本周学习调合理");
  assert.equal(first.questions[0]!.prompt, "优先保证哪类任务？");
  const r1 = await say("第一个");
  assert.equal(r1.state, "answered", JSON.stringify(r1));
  assert.match(r1.summary, /考试复习/);
  const q2 = intakeResultById(first.intakeId)!.questions[0]!;
  assert.equal(q2.prompt, "周末能学多久？");
  await say("只学半天");
  const q3 = intakeResultById(first.intakeId)!.questions[0]!;
  assert.equal(q3.prompt, "晚上最晚学到几点？");
  assert.equal(await answer(q3, "十点前结束"), 202);
  const done = intakeResultById(first.intakeId)!;
  assert.ok(["applied", "no_change"].includes(done.state), JSON.stringify(done));
  assert.deepEqual(((last as unknown as Ctx).replies as Array<{ answer: string }>).map((r) => r.answer), ["考试复习", "只学半天", "十点前结束"]);
});

test("G07 多个问题在等：一句“可以”先问是哪一个，选定后只答那一个；选“作为新的要求”不当回答", async () => {
  onRoute = (c) => ({ items: [decideItem(String(c.text))] });
  onDecide = (c) => String(c.text).includes("数学")
    ? { kind: "act", rationale: "建议长期每天最多学 150 分钟", intents: [{ op: "daily_limit", limitMinutes: 150 }] }
    : { kind: "ask", question: "英语阅读放到哪几天？", reason: "几种分法差别明显", options: ["工作日", "周末"] };
  const a = await say("数学的安排帮我理一理");
  const b = await say("英语怎么安排比较好");
  const qa = a.questions[0]!, qb = b.questions[0]!;
  assert.equal(qa.purpose, "confirm");
  assert.equal(qb.purpose, "agent_clarification");

  const snapshot = facts();
  const routes = routeCalls();
  const ambiguous = await say("可以");
  assert.equal(routeCalls(), routes);
  assert.equal(ambiguous.state, "needs_input", JSON.stringify(ambiguous));
  const locate = ambiguous.questions[0]!;
  assert.equal(locate.purpose, "locate");
  assert.deepEqual(locate.options, [qb.prompt, qa.prompt, "作为新的要求"], "最近的问题排在前面");
  assert.equal(getQuestion(qa.id)!.status, "open");
  assert.equal(getQuestion(qb.id)!.status, "open");
  assert.equal(facts(), snapshot, "定位之前不改任何数据");

  assert.equal(await answer(locate, "第二个"), 202);
  assert.equal(getQuestion(qa.id)!.status, "answered", "答的是选定的那个");
  assert.equal(getQuestion(qb.id)!.status, "open", "另一个原样等着");
  const located = intakeResultById(ambiguous.intakeId)!;
  assert.equal(located.state, "answered", JSON.stringify(located));
  const confirmed = intakeResultById(a.intakeId)!;
  assert.ok(["applied", "no_change"].includes(confirmed.state), JSON.stringify(confirmed));

  // 只剩一个在等：同样的短答直接落到它上面
  const direct = await say("周末");
  assert.equal(direct.state, "answered", JSON.stringify(direct));
  assert.equal(getQuestion(qb.id)!.status, "answered");
});

test("G07 选“作为新的要求”：不当作回答，交给决策重新理解", async () => {
  onRoute = (c) => ({ items: [decideItem(String(c.text))] });
  onDecide = (c) => String(c.text) === "不行"
    ? replan("2026-10-05", "2026-10-11")
    : { kind: "ask", question: `${String(c.text).slice(0, 4)}要怎么分？`, reason: "取舍明显", options: ["多一点", "少一点"] };
  const a = await say("项目时间理一下");
  const b = await say("阅读时间理一下");
  const ambiguous = await say("不行");
  const locate = ambiguous.questions[0]!;
  assert.equal(locate.purpose, "locate");
  assert.equal(await answer(locate, "作为新的要求"), 202);
  const r = intakeResultById(ambiguous.intakeId)!;
  assert.ok(["applied", "no_change"].includes(r.state), JSON.stringify(r));
  assert.equal(getQuestion(a.questions[0]!.id)!.status, "open");
  assert.equal(getQuestion(b.questions[0]!.id)!.status, "open");
  await say("先别做了");
  const ga = getGoal(a.goal!.id)!;
  assert.notEqual(ga.state, "cancelled", "“先别做”只停最近的目标");
  await answer(a.questions[0]!, "少一点");
  await answer(b.questions[0]!, "少一点");
});

test("跨设备 / 隔几小时继续：goalId+expectedGoalRevision 续到同一目标同一对话；版本过期 409、目标不存在 404，都不提交", async () => {
  onRoute = () => ({ items: [decideItem("下周的复习节奏帮我定一下")] });
  // NOW 是周一 10-05：主人说的“下周”是 10-12 至 10-18，续办沿用这个范围
  onDecide = (c) => ((c.goal as { revision?: number } | null)?.revision ?? 1) > 1 ? replan("2026-10-12", "2026-10-18") : { kind: "ask", question: "考试大概什么时候？", reason: "要按考试日倒排", options: ["很快", "还早"] };
  const first = await say("下周的复习节奏帮我定一下");
  const goalId = first.goal!.id;

  setNowForTests(new Date(NOW.getTime() + 7 * 3600_000));
  try {
    const list = (await (await goalsRoute(new NextRequest("http://localhost/api/v2/goals?open=1", { headers: { cookie: `${SESSION_COOKIE}=${token}` } }))).json()) as { goals: Array<{ id: string; revision: number; state: string }> };
    const g = list.goals.find((x) => x.id === goalId)!;
    assert.ok(g, "未完结目标可以从列表找回");
    assert.equal(g.state, "awaiting_input");

    const intakesBefore = (getDb().prepare(`SELECT COUNT(*) AS n FROM intakes`).get() as { n: number }).n;
    const stale = await post("考试定了，按这个排", { goalId, expectedGoalRevision: g.revision + 1 });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.error!.code, "STALE_GOAL_REVISION");
    const missing = await post("考试定了，按这个排", { goalId: "00000000-0000-4000-8000-000000000000", expectedGoalRevision: 1 });
    assert.equal(missing.status, 404);
    assert.equal((getDb().prepare(`SELECT COUNT(*) AS n FROM intakes`).get() as { n: number }).n, intakesBefore, "被拒的续办没有落库");

    onRoute = (c) => {
      assert.equal((c.currentGoal as { revision: number }).revision, g.revision + 1, "显式续办时当前目标就是这一版");
      return { items: [decideItem("考试定了，按这个排")] };
    };
    const cont = await post("考试定了，按这个排", { goalId, expectedGoalRevision: g.revision });
    assert.equal(cont.status, 202, JSON.stringify(cont.body));
    assert.equal(cont.body.goalId, goalId);
    assert.equal(cont.body.goalRevision, g.revision + 1);
    assert.equal(cont.body.conversationId, first.conversationId, "回到目标所在的对话");
    await drain();
    const r = intakeResultById(cont.body.intakeId)!;
    assert.ok(["applied", "no_change"].includes(r.state), JSON.stringify(r));
    assert.equal(intakeResultById(first.intakeId)!.state, "cancelled", "上一版的待答问题作废");
    assert.deepEqual(listGoalRevisions(goalId).map((x) => x.cause), ["initial", "continue"]);
  } finally {
    setNowForTests(NOW);
  }
});

test("G08 “先别做”与晚到响应：停止后旧推理返回的方案写不进来；如实说明停了什么、已生效的不自动撤回", async () => {
  onRoute = () => ({ items: [decideItem("帮我把这周数学多排一些")] });
  let stopId = "";
  onDecide = () => {
    // 模型还在思考时主人说“先别做了”
    stopId = getDb().transaction(() => receiveIntake({ channel: "web", text: "先别做了" }).intakeId).immediate();
    return replan("2026-10-05", "2026-10-11");
  };
  const snapshot = facts();
  const batches = replanBatches();
  const r = await post("帮我把这周数学多排一些");
  await drain();
  assert.equal(facts(), snapshot, "晚到的方案没有执行");
  assert.equal(replanBatches(), batches);
  const late = intakeResultById(r.body.intakeId)!;
  assert.equal(late.state, "cancelled", JSON.stringify(late));
  assert.equal(getGoal(getIntake(r.body.intakeId)!.goalId!)!.state, "cancelled");
  const stop = intakeResultById(stopId)!;
  assert.equal(stop.state, "answered");
  assert.match(stop.summary, /已停止/);
  assert.match(stop.summary, /之前没有生效的修改/);
  assert.equal(stop.undo.available, false);

  // 事务内核对：旧版本投递即便绕过调度直接执行，也被拒绝
  const direct = executeOperation({ command: "create_or_update_task", title: "不该出现" }, { intakeId: r.body.intakeId, itemId: null, itemKey: "x", instanceEpoch: 0, evidence: "", explicit: true, now: NOW });
  assert.equal(direct.result.ok, false);
  assert.equal((direct.result as { code: string }).code, "STALE_GOAL_REVISION");
});

test("G08 第 1 版已生效、第 2 版在等时说“先别做”：只停第 2 版，如实列出已生效的第 1 版和撤销入口；再说一次就是没有可停的", async () => {
  onRoute = () => ({ items: [decideItem("这周学习重新排")] });
  onDecide = () => replan("2026-10-05", "2026-10-11");
  const first = await say("这周学习重新排");
  assert.ok(["applied", "no_change"].includes(first.state), JSON.stringify(first));
  onRoute = () => ({ items: [decideItem("再把周末空出来", true)] });
  onDecide = () => ({ kind: "ask", question: "周末完全不学，还是只留一小时？", reason: "两种差别明显", options: ["完全不学", "留一小时"] });
  const second = await say("再把周末空出来");
  assert.equal(second.goal!.revision, 2);
  assert.equal(second.state, "needs_input");
  const snapshot = facts();
  const stop = await say("先别做");
  assert.match(stop.summary, /已停止「这周学习重新排」还没执行的 1 项/);
  assert.match(stop.summary, /已经生效的 \d+ 项不会自动撤回/);
  assert.equal(facts(), snapshot);
  assert.equal(intakeResultById(second.intakeId)!.state, "cancelled");
  assert.equal(intakeResultById(first.intakeId)!.undo.available, first.undo.available, "第 1 版的撤销入口还在");
  const again = await say("先别做");
  assert.match(again.summary, /现在没有进行中的事要停/);
  assert.equal(facts(), snapshot);
});

test("G04 待确认时改口：旧确认作废，确认旧方案被拒；新方案按新原话重新确认", async () => {
  onRoute = () => ({ items: [decideItem("最近太累了")] });
  onDecide = () => ({ kind: "act", rationale: "建议长期每天最多学 120 分钟", intents: [{ op: "daily_limit", limitMinutes: 120 }] });
  const first = await say("最近太累了");
  const oldConfirm = first.questions.find((q) => q.purpose === "confirm")!;
  assert.match(oldConfirm.prompt, /120/);
  assert.equal(getGoal(first.goal!.id)!.state, "awaiting_confirmation");

  const snapshot = facts();
  onRoute = () => ({ items: [decideItem("改成每天最多 90 分钟", true)] });
  onDecide = () => ({ kind: "act", rationale: "按你说的每天最多 90 分钟", intents: [{ op: "daily_limit", limitMinutes: 90 }] });
  const changed = await say("改成每天最多 90 分钟");
  assert.equal(changed.goal!.revision, 2);
  assert.equal(getQuestion(oldConfirm.id)!.status, "superseded");
  assert.equal(await answer(oldConfirm, "可以"), 409);
  assert.equal(facts(), snapshot, "旧确认没有让 120 分钟生效");
  const newConfirm = changed.questions.find((q) => q.purpose === "confirm")!;
  assert.match(newConfirm.prompt, /90/);
  assert.equal(await answer(newConfirm, "可以"), 202);
  const applied = intakeResultById(changed.intakeId)!;
  assert.equal(applied.state, "applied", JSON.stringify(applied));
  assert.match(applied.summary, /90/);
  assert.doesNotMatch(applied.summary, /120/);
});

test("目标表随业务导出；没有在等的问题时孤立短答如实说明且不改数据；时间调整仍直接执行", async () => {
  assert.ok("agent_goals" in FULL_JSON_TABLES && "agent_goal_revisions" in FULL_JSON_TABLES);

  getDb().prepare(`UPDATE clarification_questions SET status = 'superseded' WHERE status = 'open'`).run();
  const snapshot = facts();
  const lone = await say("可以");
  assert.equal(lone.state, "failed", JSON.stringify(lone));
  assert.match(lone.summary, /没有在等回答的问题/);
  assert.equal(facts(), snapshot);

  op({ command: "schedule_session", title: "物理实验报告", date: "2026-10-20", startLocalTime: "19:00", durationMinutes: 30 });
  onRoute = (c) => {
    const hint = (c.ruleHints as Array<{ clause: string; intents: unknown[] }>)[0]!;
    assert.equal((hint.intents[0] as { op: string }).op, "move_session");
    return { items: [{ itemKey: "mv", excerpt: hint.clause, outcome: { kind: "act", rationale: "按原话挪动", intents: hint.intents }, continuesGoal: false }] };
  };
  const moved = await say("把物理实验报告挪到10月21日晚上");
  assert.equal(moved.state, "applied", JSON.stringify(moved));
  assert.ok(moved.goal && moved.goal.revision === 1, "新要求立新目标");
  assert.equal(getIntake(moved.intakeId)!.goalRevision, 1);
});
