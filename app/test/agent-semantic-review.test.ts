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
import { gateCommand } from "@/workflows/agent-gate";
import { verifyIntake } from "@/workflows/agent-verify";
import { listGoalConstraints, recordGoalConstraints } from "@/repositories/goal-constraints";
import { getGoal } from "@/repositories/goals";
import { INTAKE_JOB_TYPE } from "@/contracts/intake";
import { FIXTURE_NOW, seedFixture } from "./corpus/fixtures";

/**
 * 语义修复复审（2026-10-05）独立复现的四个缺口：真实管线，模型换成脚本，故意给出越界或曲解的输出。
 * 证明服务端守住主人的条件，不代表真实模型常犯这些错误。
 */

const NOW = new Date(FIXTURE_NOW);
let token = "", csrf = "", seq = 0, conv = "";
let onRoute: () => unknown = () => ({ items: [] });
const decisions: unknown[] = [];
let provider: ScriptedChatProvider;
let lastTimeoutMs: number | undefined;

const final = (value: unknown): RawCallResult => ({ ok: true, text: JSON.stringify(value) });
const act = (excerpt: string, intents: unknown[], constraints: unknown[] = [], continuesGoal = false) => ({ items: [{ itemKey: "act", excerpt, outcome: { kind: "act", intents, rationale: "按原话执行", constraints }, continuesGoal }] });

function request(url: string, body: unknown) {
  return new NextRequest(url, { method: "POST", headers: { cookie: `${SESSION_COOKIE}=${token}`, "x-csrf-token": csrf, "content-type": "application/json", "idempotency-key": `sr-${seq++}` }, body: JSON.stringify(body) });
}
async function drain(n = 8) { for (let i = 0; i < n; i++) await runDueJobsOnce(); }
async function say(text: string, opts: { once?: boolean } = {}): Promise<IntakeResultView> {
  const res = await POST(request("http://localhost/api/v2/intakes", { text, ...(conv ? { conversationId: conv } : {}) }));
  const body = (await res.json()) as { intakeId: string; conversationId: string };
  assert.equal(res.status, 202, JSON.stringify(body));
  conv = body.conversationId;
  if (opts.once) await runDueJobsOnce();
  else await drain();
  return intakeResultById(body.intakeId)!;
}
/** 只投递、不处理：用来在 worker 处理前摆好前置状态 */
async function postOnly(text: string): Promise<string> {
  const res = await POST(request("http://localhost/api/v2/intakes", { text, ...(conv ? { conversationId: conv } : {}) }));
  const body = (await res.json()) as { intakeId: string; conversationId: string };
  assert.equal(res.status, 202, JSON.stringify(body));
  conv = body.conversationId;
  return body.intakeId;
}
async function answer(q: { id: string; version: number }, text: string) {
  const res = await answerRoute(request("http://localhost/api/v2/questions", { text, expectedVersion: q.version }), { params: Promise.resolve({ id: q.id }) });
  assert.ok(res.status < 300, `回答 ${res.status} ${await res.text()}`);
  await drain();
}
const confirmQ = (id: string) => intakeResultById(id)!.questions.find((q) => q.purpose === "confirm");
const db = () => getDb();
function op(command: Record<string, unknown>) {
  const r = executeOperation(command, { intakeId: null, itemId: null, itemKey: "", instanceEpoch: 0, evidence: "", explicit: true, now: NOW });
  assert.ok(r.result.ok, JSON.stringify(r));
  return r;
}
const batchesOf = (intakeId: string) => (db().prepare(`SELECT COUNT(*) AS n FROM agent_action_batches WHERE intake_id = ? AND command != 'plan_sessions'`).get(intakeId) as { n: number }).n;
const daysSnapshot = (from: string, to: string) => JSON.stringify([
  db().prepare(`SELECT weekend_start, weekend_end FROM planning_preferences WHERE id = 1`).get(),
  db().prepare(`SELECT kind, date_from, date_to, value_json FROM planning_policy_rules WHERE status = 'active' AND date_from IS NOT NULL AND date_to >= ? AND date_from <= ? ORDER BY id`).all(from, to),
  db().prepare(`SELECT id, start_utc, end_utc, status FROM plan_sessions WHERE status IN ('tentative','planned') AND date(start_utc, '+8 hours') BETWEEN ? AND ? ORDER BY id`).all(from, to),
]);
/** 新对话：每个用例互不沿用前一个用例里说过的保护 */
/** 前面用例的重排会占满每日学习预算：放宽上限，让用例只考范围与收工条件 */
const roomyBudget = () => op({ command: "update_planning_policy", base: { dailyLimitMinutes: 720 }, rules: [], revokeRuleIds: [], confirm: true });
const newConversation = () => {
  conv = "";
  db().prepare(`UPDATE conversations SET status = 'closed' WHERE status = 'open'`).run();
};

before(() => {
  migrateAll();
  seedFixture("week-basic");
  setNowForTests(NOW);
  const s = createSession(1);
  token = s.token;
  csrf = s.session.csrfToken;
  provider = new ScriptedChatProvider((req) => {
    lastTimeoutMs = req.timeoutMs;
    if (req.workflow === "agent_route") return final(onRoute());
    if (req.workflow === "agent_decide") {
      const next = decisions.shift();
      return next ? final(next) : { ok: false, code: "HTTP_ERROR", message: "脚本里没有准备决策", retryable: false };
    }
    if (req.workflow === INTAKE_JOB_TYPE) return final({ items: [] });
    return { ok: false, code: "HTTP_ERROR", message: `脚本没有处理 ${req.workflow}`, retryable: false };
  });
  setProvidersForTests({ model: { mode: "fixture", provider }, search: { mode: "fixture", provider: fixtureSearchProvider() } });
  op({ command: "schedule_session", title: "英语阅读", date: "2026-10-17", startLocalTime: "10:00", durationMinutes: 60 });
});
after(() => setNowForTests(null));

test("复审 P1-2 解除约束要单独授权：引用是主人原话但不含解除意思时，不改 accepted、不动周末，先问；“先不要”后保护仍在", async () => {
  newConversation();
  const t1 = "重新安排本周学习，周末别动";
  onRoute = () => act(t1, [{ op: "replan", dateFrom: "2026-10-12", dateTo: "2026-10-18" }], [{ kind: "protect_days", days: "weekend", excerpt: "周末别动" }]);
  const r1 = await say(t1);
  const q1 = confirmQ(r1.intakeId);
  if (q1) await answer(q1, "可以");
  const goalId = intakeResultById(r1.intakeId)!.goal!.id;
  const weekend = daysSnapshot("2026-10-17", "2026-10-18");
  assert.deepEqual(listGoalConstraints(goalId).map((c) => c.value), [{ kind: "protect_days", days: "weekend" }]);

  const t2 = "再优化一下";
  onRoute = () => act(t2, [{ op: "replan", dateFrom: "2026-10-17", dateTo: "2026-10-18" }], [{ kind: "release", target: "protect_days", days: "weekend", excerpt: "再优化一下" }], true);
  const r2 = await say(t2);
  assert.equal(r2.goal?.id, goalId, "前提：续同一目标");
  assert.deepEqual(listGoalConstraints(goalId).map((c) => c.value), [{ kind: "protect_days", days: "weekend" }], "确认前保护仍然生效");
  assert.equal(daysSnapshot("2026-10-17", "2026-10-18"), weekend, "确认前周末没动");
  assert.equal(batchesOf(r2.intakeId), 0);
  const q2 = confirmQ(r2.intakeId);
  assert.ok(q2, `解除之前说过的条件要先问：${JSON.stringify(r2)}`);
  assert.match(q2.prompt, /解除你之前说的“周末别动”/, q2.prompt);
  await answer(q2, "先不要");
  assert.deepEqual(listGoalConstraints(goalId).map((c) => c.value), [{ kind: "protect_days", days: "weekend" }], "拒绝后保护仍在");
  assert.equal(daysSnapshot("2026-10-17", "2026-10-18"), weekend, "拒绝后周末没动");
  assert.equal(batchesOf(r2.intakeId), 0);
});

test("复审 P1-2 解除按指定约束：两条“某天不动”只解除点名的那条；确认后才生效，另一条仍守着", async () => {
  newConversation();
  const t1 = "这周重新排一下，周三和周四都别动";
  onRoute = () => act(t1, [{ op: "replan", dateFrom: "2026-10-13", dateTo: "2026-10-16" }], [
    { kind: "protect_dates", dateFrom: "2026-10-14", dateTo: "2026-10-14", excerpt: "周三" },
    { kind: "protect_dates", dateFrom: "2026-10-15", dateTo: "2026-10-15", excerpt: "周四都别动" },
  ]);
  const r1 = await say(t1);
  const q1 = confirmQ(r1.intakeId);
  if (q1) await answer(q1, "可以");
  const goalId = intakeResultById(r1.intakeId)!.goal!.id;
  assert.equal(listGoalConstraints(goalId).length, 2);
  const wed = daysSnapshot("2026-10-14", "2026-10-14");

  const t2 = "周四可以动了，把周四重新排一下";
  onRoute = () => act(t2, [{ op: "replan", dateFrom: "2026-10-15", dateTo: "2026-10-15" }], [{ kind: "release", target: "protect_dates", dateFrom: "2026-10-15", dateTo: "2026-10-15", excerpt: "周四可以动了" }], true);
  const r2 = await say(t2);
  const q2 = confirmQ(r2.intakeId);
  assert.ok(q2, JSON.stringify(r2));
  assert.match(q2.prompt, /解除你之前说的“周四都别动”/, q2.prompt);
  assert.doesNotMatch(q2.prompt, /解除你之前说的“周三”/, "只点名要解除的那一条");
  assert.equal(listGoalConstraints(goalId).length, 2, "确认前两条都还在");
  await answer(q2, "可以");
  const left = listGoalConstraints(goalId).map((c) => c.value);
  assert.deepEqual(left, [{ kind: "protect_dates", dateFrom: "2026-10-14", dateTo: "2026-10-14" }], "只解除了周四那条");
  assert.ok(db().prepare(`SELECT 1 FROM planning_policy_rules WHERE status = 'active' AND kind = 'auto_reschedule' AND date_from = '2026-10-15'`).get(), "周四按要求重新安排");
  assert.equal(daysSnapshot("2026-10-14", "2026-10-14"), wed, "周三仍不动");
});

test("复审 P1-1 具体学习块不能绕过主人说的日期范围和收工时间：范围外、收工后、跨过收工点都不写入，也不报核验通过", async () => {
  newConversation();
  roomyBudget();
  const text = "只安排明天，晚上九点以后不排学习";
  const constraints = [{ kind: "date_scope", dateFrom: "2026-10-13", dateTo: "2026-10-13", excerpt: "只安排明天" }, { kind: "no_study_after", time: "21:00", days: "all", excerpt: "晚上九点以后不排学习" }];
  const sessions = (title: string) => db().prepare(`SELECT s.start_utc FROM plan_sessions s JOIN tasks t ON t.id = s.task_id WHERE t.title = ? AND s.status IN ('tentative','planned')`).all(title);
  const tryAdd = async (title: string, date: string, start: string, minutes: number) => {
    onRoute = () => act(text, [{ op: "schedule_at", taskRef: null, title, date, startLocalTime: start, durationMinutes: minutes }], constraints);
    const r = await say(text);
    const q = confirmQ(r.intakeId);
    if (q) await answer(q, "可以");
    return intakeResultById(r.intakeId)!;
  };

  const outside = await tryAdd("范围外晚间学习", "2026-10-19", "22:00", 30);
  assert.deepEqual(sessions("范围外晚间学习"), [], `范围外不写入：${JSON.stringify(outside)}`);
  assert.notEqual(outside.verification?.status, "verified");
  assert.match(outside.summary, /超出了你说的范围/, outside.summary);

  const late = await tryAdd("收工后学习", "2026-10-13", "22:00", 30);
  assert.deepEqual(sessions("收工后学习"), [], `收工后不写入：${JSON.stringify(late)}`);
  assert.match(late.summary, /21:00/, late.summary);

  const across = await tryAdd("跨过收工点", "2026-10-13", "19:00", 150);
  assert.deepEqual(sessions("跨过收工点"), [], `结束时间越过收工点也不写入：${JSON.stringify(across)}`);

  const ok = await tryAdd("范围内学习", "2026-10-13", "19:00", 30);
  assert.equal(sessions("范围内学习").length, 1, `范围内照常执行：${JSON.stringify(ok)}`);
  assert.equal(ok.verification?.status, "verified", JSON.stringify(ok.verification));

  // 挪动：把明天的块挪到范围外的周三 → 不执行
  const move = "只动明天的，数据结构作业挪到周三晚上八点";
  const before0 = JSON.stringify(sessions("数据结构作业"));
  onRoute = () => act(move, [{ op: "move_session", ref: { kind: "named", text: "数据结构作业", date: "2026-10-13", part: "any" }, targetDate: "2026-10-14", startLocalTime: "20:00" }], [{ kind: "date_scope", dateFrom: "2026-10-13", dateTo: "2026-10-13", excerpt: "只动明天的" }]);
  const m = await say(move);
  const mq = confirmQ(m.intakeId);
  if (mq) await answer(mq, "可以");
  assert.equal(JSON.stringify(sessions("数据结构作业")), before0, `挪到范围外不执行：${JSON.stringify(intakeResultById(m.intakeId))}`);
});

test("复审 P1-1 核验从目标上生效的条件读回事实：写入后才知道的收工条件，核验不报通过", async () => {
  newConversation();
  roomyBudget();
  const text = "后天晚上六点四十加一刻钟背单词";
  onRoute = () => act(text, [{ op: "schedule_at", taskRef: null, title: "背单词", date: "2026-10-14", startLocalTime: "18:40", durationMinutes: 15 }]);
  const r = await say(text);
  const q = confirmQ(r.intakeId);
  if (q) await answer(q, "可以");
  assert.equal(intakeResultById(r.intakeId)!.verification?.status, "verified", JSON.stringify(intakeResultById(r.intakeId)));
  const goalId = intakeResultById(r.intakeId)!.goal!.id;
  db().transaction(() => recordGoalConstraints({ goalId, revision: getGoal(goalId)!.revision, intakeId: null, accepted: [{ value: { kind: "no_study_after", time: "18:30", days: "all" }, excerpt: "六点半以后不学", source: "owner_text" }] }))();
  const v = verifyIntake(r.intakeId, NOW)!;
  assert.notEqual(v.status, "verified", JSON.stringify(v));
  assert.ok(v.checks.some((c) => c.ok === false && /18:30/.test(c.detail)), JSON.stringify(v.checks));
});

test("复审 P1-3 归档按对象版本确认：确认后对象被改过，旧回答不归档，重新确认；受保护的对象不能被归档绕过", async () => {
  newConversation();
  const task = db().prepare(`SELECT id, title FROM tasks WHERE title = '线代作业'`).get() as { id: string; title: string };
  const text = "归档线代作业";
  onRoute = () => act(text, [{ op: "archive", entityKind: "task", ref: { kind: "named", text: "线代作业", date: null, part: "any" } }]);
  const r = await say(text);
  const q = confirmQ(r.intakeId);
  assert.ok(q, JSON.stringify(r));
  assert.match(q.prompt, /归档任务「线代作业」/, q.prompt);
  // 确认期间主人在别处把这项任务改了（定了截止、版本加一），名字没变，按名字仍能找到同一个对象
  db().prepare(`UPDATE tasks SET due_local_date = '2026-10-30', version = version + 1 WHERE id = ?`).run(task.id);
  await answer(q, "可以");
  const row = db().prepare(`SELECT archived_at FROM tasks WHERE id = ?`).get(task.id) as { archived_at: string | null };
  assert.equal(row.archived_at, null, `旧确认不能归档已改动的对象：${JSON.stringify(intakeResultById(r.intakeId))}`);
  const again = confirmQ(r.intakeId);
  assert.ok(again && again.id !== q.id, "按新事实重新确认");
  assert.match(again.prompt, /已经变了|被改过/, again.prompt);
  assert.match(again.prompt, /归档任务「线代作业」/, again.prompt);
  await answer(again, "先不要");
  assert.equal((db().prepare(`SELECT archived_at FROM tasks WHERE id = ?`).get(task.id) as { archived_at: string | null }).archived_at, null);

  // 统一门：受保护的对象（按 ID 或名称）归档一律拒绝
  const ctx = (ref: unknown) => ({ today: "2026-10-12", scope: null, constraints: [{ kind: "protect_entity" as const, ref: ref as never }] });
  const archive = { command: "archive_entity", entityKind: "task", entityId: task.id };
  assert.equal(gateCommand(archive, [], ctx({ kind: "id", entityKind: "task", id: task.id })).kind, "reject");
  assert.equal(gateCommand(archive, [], ctx({ kind: "named", text: "线代作业", date: null, part: "any" })).kind, "reject");
  const goal = db().prepare(`SELECT id FROM goals LIMIT 1`).get() as { id: string };
  assert.equal(gateCommand({ command: "archive_entity", entityKind: "goal", entityId: goal.id }, [], ctx({ kind: "id", entityKind: "goal", id: goal.id })).kind, "reject");

  // 管线：同一句里说了“别动”的对象，归档不执行
  const t2 = "把整理基线代码归档，不过线代那个别动";
  onRoute = () => act(t2, [{ op: "archive", entityKind: "task", ref: { kind: "named", text: "线代作业", date: null, part: "any" } }], [{ kind: "protect_entity", ref: { kind: "named", text: "线代作业", date: null, part: "any" }, excerpt: "线代那个别动" }]);
  const r2 = await say(t2);
  const q2 = confirmQ(r2.intakeId);
  if (q2) await answer(q2, "可以");
  assert.equal((db().prepare(`SELECT archived_at FROM tasks WHERE id = ?`).get(task.id) as { archived_at: string | null }).archived_at, null, JSON.stringify(intakeResultById(r2.intakeId)));
});

test("复审 规格差距 指代：带条件的回答说某个对象别动、理解出的对象却不在方案里——先请主人从方案对象里指认；指认后不动它，“先不要”不改，选“都不是”才照做", async () => {
  roomyBudget();
  op({ command: "schedule_session", title: "高数复习", date: "2026-10-18", startLocalTime: "15:00", durationMinutes: 60 });
  const move = { kind: "act", rationale: "挪到 19:00", intents: [{ op: "move_session", ref: { kind: "named", text: "高数复习", date: "2026-10-18", part: "any" }, targetDate: "2026-10-18", startLocalTime: "19:00" }] };
  const misread = { ...move, constraints: [{ kind: "protect_entity", ref: { kind: "named", text: "微积分复习" }, excerpt: "那节课不要动" }] };
  const decide = (text: string) => ({ items: [{ itemKey: "goal", excerpt: text, outcome: { kind: "decide", objective: text, rationale: "需要权衡" }, continuesGoal: false }] });
  const sunday = () => daysSnapshot("2026-10-18", "2026-10-18");

  async function toReferentQuestion() {
    newConversation();
    const t = "高数复习改到晚上七点";
    onRoute = () => decide(t);
    decisions.push(move, misread);
    const r = await say(t);
    const q = confirmQ(r.intakeId);
    assert.ok(q && /高数复习/.test(q.prompt), `先确认挪高数复习：${JSON.stringify(r.questions)}`);
    await answer(q, "行，但是那节课不要动");
    const view = intakeResultById(r.intakeId)!;
    const ref = view.questions.find((x) => x.purpose === "tradeoff");
    assert.ok(ref, `所指对不上时问指认，而不是再问一次同样的确认：${JSON.stringify(view.questions)}`);
    assert.ok(!view.questions.some((x) => x.purpose === "confirm"), "不再拿同一份方案问“是否采用”");
    assert.match(ref.prompt, /微积分复习/, "说出理解成了什么");
    assert.match(ref.options![0]!, /高数复习/, "选项是方案实际要动的对象");
    return { id: r.intakeId, q: ref };
  }

  // 指认方案里的对象：这一步不做，什么都没改；这个对象记成这件事的保护
  const before = sunday();
  const a = await toReferentQuestion();
  await answer(a.q, a.q.options![0]!);
  assert.equal(sunday(), before, "高数复习没有被挪");
  assert.equal(batchesOf(a.id), 0);
  const goalA = intakeResultById(a.id)!.goal!.id;
  assert.ok(listGoalConstraints(goalA).some((c) => c.value.kind === "protect_entity" && c.value.ref.kind === "id" && c.value.ref.entityKind === "plan_session"), JSON.stringify(listGoalConstraints(goalA).map((c) => c.value)));

  // 先不要：什么都不改
  const c = await toReferentQuestion();
  await answer(c.q, "先不要，什么都不改");
  assert.equal(sunday(), before);
  assert.equal(batchesOf(c.id), 0);

  // 都不是：主人看过方案要改的每一项后选择照做，才挪
  const b = await toReferentQuestion();
  await answer(b.q, "都不是，其余照这份方案执行");
  assert.notEqual(sunday(), before, "选了照做才挪");
  assert.ok(batchesOf(b.id) >= 1);
});

test("复审 规格差距 主动执行预算：计入 worker 实际处理时间、不计等主人的时间；用完后不再请求模型；每次调用的超时不超过剩余时间", async () => {
  newConversation();
  roomyBudget();
  const activeOf = (id: string) => (db().prepare(`SELECT active_ms FROM intakes WHERE id = ?`).get(id) as { active_ms: number }).active_ms;
  const requestsOf = (id: string) => (db().prepare(`SELECT COUNT(*) AS n FROM ai_request_ledger WHERE intake_id = ? AND status <> 'released'`).get(id) as { n: number }).n;

  // 1) 处理过的投递有主动执行时间；等主人回答的那段不计入
  const t1 = "后天下午四点加半小时背单词";
  onRoute = () => act(t1, [{ op: "schedule_at", taskRef: null, title: "背单词二", date: "2026-10-14", startLocalTime: "16:00", durationMinutes: 30 }]);
  const r1 = await say(t1);
  const afterFirst = activeOf(r1.intakeId);
  assert.ok(afterFirst > 0, "处理过就有记录");
  const q1 = intakeResultById(r1.intakeId)!.questions[0];
  assert.ok(q1, `需要一个问题来制造等待：${JSON.stringify(r1)}`);
  const waitMs = 1500;
  await new Promise((r) => setTimeout(r, waitMs));
  await answer(q1, "可以");
  const afterAnswer = activeOf(r1.intakeId);
  assert.ok(afterAnswer > afterFirst, "回答后的处理也计入");
  assert.ok(afterAnswer - afterFirst < waitMs, `等你回答的 ${waitMs}ms 不计入：${afterFirst} → ${afterAnswer}`);

  // 2) 已累计到上限（没有一次模型请求）：不再请求模型，已收到的原话保留并说明
  const t2 = "再加一段英语听力";
  onRoute = () => act(t2, [{ op: "schedule_at", taskRef: null, title: "英语听力二", date: "2026-10-14", startLocalTime: "17:00", durationMinutes: 30 }]);
  const id2 = await postOnly(t2);
  db().prepare(`UPDATE intakes SET active_ms = 180000 WHERE id = ?`).run(id2);
  await drain();
  assert.equal(requestsOf(id2), 0, "主动执行时间用完就不发模型请求，即使模型时间还是 0");
  assert.match(JSON.stringify(intakeResultById(id2)), /180 秒/, JSON.stringify(intakeResultById(id2)));

  // 3) 剩 8 秒：这次调用的超时不超过 8 秒
  const id3 = await postOnly(t2);
  db().prepare(`UPDATE intakes SET active_ms = 172000 WHERE id = ?`).run(id3);
  lastTimeoutMs = undefined;
  await drain();
  assert.ok(requestsOf(id3) >= 1, "还有剩余时间就照常请求");
  assert.ok(lastTimeoutMs !== undefined && lastTimeoutMs <= 8_000, `超时按剩余时间收紧：${lastTimeoutMs}`);
});

test("复审 P2 异步：复盘还在排队时目标与结果都是“进行中/后台处理中”，不显示已完成；后台结束后才转为完成", async () => {
  newConversation();
  const text = "帮我复盘一下上周";
  onRoute = () => act(text, [{ op: "review", week: "last" }]);
  const r = await say(text, { once: true });
  assert.equal(r.verification?.status, "pending", JSON.stringify(r.verification));
  assert.notEqual(r.goal?.state, "completed", "后台没结束，目标不是已完成");
  assert.equal(r.goal?.state, "active");
  assert.equal(r.state, "in_background", "结果主状态是后台处理中，不是已更新");
  assert.match(r.verification!.label, /后台/, r.verification!.label);
  assert.doesNotMatch(r.verification!.label, /在等你/, "等后台不说成等你");
  await drain();
  const done = intakeResultById(r.intakeId)!;
  assert.notEqual(done.verification?.status, "pending", JSON.stringify(done.verification));
  assert.ok(["completed", "partial", "blocked"].includes(done.goal!.state), JSON.stringify(done.goal));
  assert.ok(["applied", "partly_applied"].includes(done.state), done.state);
  assert.equal(done.goal!.state === "completed", done.verification!.status === "verified", "目标状态与核验结论一致");
});
