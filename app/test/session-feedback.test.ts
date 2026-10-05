import assert from "node:assert/strict";
import crypto from "node:crypto";
import { after, before, beforeEach, test } from "node:test";
import { migrateAll, getDb } from "./helpers";
import { setNowForTests } from "@/domain/clock";
import { executeOperation } from "@/workflows/commands";
import { dayLedger, rebuildPlan } from "@/workflows/plan";
import { askSessionFeedback, parseAnswerByPurpose, raisePlanQuestions } from "@/workflows/agent";
import { submitAnswer } from "@/workflows/intake";
import { getPrefs } from "@/repositories/plan";
import { listOpenQuestions, type QuestionRow } from "@/repositories/questions";
import { dashboardSnapshot } from "@/workflows/snapshot";
import { recoverOnStartup, runDueJobsOnce } from "@/worker/runner";
import { NextRequest } from "next/server";
import { createOwner, createSession, SESSION_COOKIE } from "@/domain/session";
import { hashPassword } from "@/domain/password";
import { POST as createIntakeRoute } from "@/app/api/v2/intakes/route";

/**
 * 过期未反馈的学习块（生产问题复现：用户指定 08:00–09:00 的一小时块过去后没有反馈，
 * 之后一次“取消课程”的重排又给同一任务补排了完整一小时）。
 * 要求：未知执行情况既不当成完成，也不当成没做而整段补排；每段一个持久问题，回答落实成现有操作。
 * 独立临时库，规划时钟固定；任务/课程直接落真实表，排程、提问、回答、执行都走真实实现。
 */

const TZ = "Asia/Shanghai";
const at = (local: string) => new Date(`${local}:00+08:00`);
let now = at("2026-10-13T07:00");
const ctx = () => ({ intakeId: null, itemId: null, itemKey: "", instanceEpoch: 0, evidence: "", explicit: true, now });
function clock(local: string) {
  now = at(local);
  setNowForTests(now);
}

type Session = { id: string; task_id: string; start_utc: string; end_utc: string; status: string; origin: string; version: number; reason: string };
const minutes = (s: Session) => (Date.parse(s.end_utc) - Date.parse(s.start_utc)) / 60000;
const total = (rows: Session[]) => rows.reduce((a, s) => a + minutes(s), 0);
const sessions = (taskId: string, statuses = ["planned", "tentative", "in_progress"]) =>
  (getDb().prepare(`SELECT * FROM plan_sessions WHERE task_id = ? ORDER BY start_utc, id`).all(taskId) as Session[]).filter((s) => statuses.includes(s.status));
const future = (taskId: string) => sessions(taskId).filter((s) => Date.parse(s.end_utc) > now.getTime());
const practice = (taskId: string) => getDb().prepare(`SELECT actual_minutes, plan_session_id FROM practice_entries WHERE task_id = ?`).all(taskId) as Array<{ actual_minutes: number; plan_session_id: string | null }>;
const taskRow = (taskId: string) => getDb().prepare(`SELECT status, remaining_minutes FROM tasks WHERE id = ?`).get(taskId) as { status: string; remaining_minutes: number | null };
const feedback = (taskId?: string) => listOpenQuestions().filter((q) => q.purpose === "session_feedback" && (!taskId || q.context.taskId === taskId));
const everAsked = (sessionId: string) => (getDb().prepare(`SELECT COUNT(*) AS n FROM clarification_questions WHERE question_key LIKE ?`).get(`session.feedback:${sessionId}:%`) as { n: number }).n;
const batches = () => (getDb().prepare(`SELECT COUNT(*) AS n FROM agent_action_batches`).get() as { n: number }).n;

function addTask(title: string, estimate: number | null, extra: { dueDate?: string } = {}): string {
  const id = crypto.randomUUID();
  getDb()
    .prepare(
      `INSERT INTO tasks (id, title, description, status, priority, estimate_minutes, due_kind, due_local_date, due_timezone, task_kind, created_at, updated_at)
       VALUES (?, ?, '', 'todo', 'normal', ?, ?, ?, ?, 'study', '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z')`,
    )
    .run(id, title, estimate, extra.dueDate ? "date" : "none", extra.dueDate ?? null, extra.dueDate ? TZ : null);
  return id;
}
function addFixed(title: string, date: string, start: string, end: string): string {
  const id = crypto.randomUUID();
  const weekday = ((new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7) + 1;
  getDb().prepare(`INSERT INTO fixed_events (id, title, weekday, local_start, local_end, timezone, event_date) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(id, title, weekday, start, end, TZ, date);
  return id;
}
/** 主人指定“这段时间做这件事” */
function own(taskId: string, date: string, time: string, duration: number): Session {
  const out = executeOperation({ command: "schedule_session", taskId, date, startLocalTime: time, durationMinutes: duration }, ctx());
  assert.ok(out.result.ok, JSON.stringify(out.result));
  return sessions(taskId).find((s) => s.origin === "user" && s.start_utc === at(`${date}T${time}`).toISOString())!;
}
function replan() {
  const plan = rebuildPlan(now);
  raisePlanQuestions(plan, { conversationId: null, tz: TZ });
  return plan;
}
function answer(q: QuestionRow, text: string) {
  return submitAnswer({ questionId: q.id, expectedVersion: q.version, text, now });
}

let cookie = "";
let csrfToken = "";
let seq = 0;
before(() => {
  migrateAll();
  createOwner(hashPassword("feedback-test-pass"));
  const { token, session } = createSession(1);
  cookie = `${SESSION_COOKIE}=${token}`;
  csrfToken = session.csrfToken;
});
/** 页面输入框里点“回答”后发出的同一个请求 */
async function answerInBar(q: QuestionRow, text: string) {
  const res = await createIntakeRoute(
    new NextRequest("http://localhost/api/v2/intakes", {
      method: "POST",
      headers: { cookie, "x-csrf-token": csrfToken, "content-type": "application/json", "idempotency-key": `fb-${seq++}` },
      body: JSON.stringify({ text, questionId: q.id, questionVersion: q.version }),
    }),
  );
  return { status: res.status, body: (await res.json()) as { answered?: boolean; results?: Array<{ summary: string }>; note?: string } };
}
after(() => setNowForTests(null));
beforeEach(() => {
  const db = getDb();
  for (const t of ["clarification_answers", "clarification_questions", "agent_action_changes", "agent_action_batches", "plan_sessions", "practice_entries", "fixed_event_exceptions", "fixed_events", "planning_policy_rules", "tasks"]) db.prepare(`DELETE FROM ${t}`).run();
  clock("2026-10-13T07:00");
});

test("复现：用户指定的 08:00–09:00 过去后没有反馈，取消课程/改规则/反复重排都不再整段补排，也不把它当完成", () => {
  const task = addTask("微积分作业", 60);
  const block = own(task, "2026-10-13", "08:00", 60);
  assert.equal(sessions(task).length, 1);

  // 过了结束时间、没有任何反馈；主人取消了今天下午的课 → 触发重排
  clock("2026-10-13T10:19");
  const course = addFixed("线性代数", "2026-10-13", "14:00", "15:40");
  replan();
  getDb().prepare(`DELETE FROM fixed_events WHERE id = ?`).run(course);
  const afterCancel = replan();
  assert.deepEqual(sessions(task).map((s) => s.id), [block.id], "不得在旧块之外再生成一小时的自动块");
  assert.ok(afterCancel.unscheduled.some((u) => u.taskId === task && u.reason === "awaiting_feedback"), "排程说明这部分在等反馈");

  // 改规则后再重排、重复重排：仍然只有那一段
  const rule = executeOperation({ command: "update_planning_policy", base: { dailyLimitMinutes: getPrefs().dailyLimitMinutes + 30 }, confirm: true }, ctx());
  assert.ok(rule.result.ok, JSON.stringify(rule.result));
  replan();
  const again = rebuildPlan(now);
  assert.equal(again.changed, false, "重复重排没有新变化");
  assert.deepEqual(sessions(task).map((s) => s.id), [block.id]);

  // 未知情况不冒充完成：块仍是计划状态、没有实践记录、任务没完成；账本只把已过去的部分算作暂占
  assert.equal(sessions(task)[0]!.status, "planned");
  assert.deepEqual(practice(task), []);
  assert.equal(taskRow(task).status, "todo");
  const ledger = dayLedger("2026-10-13", now, getPrefs(), TZ);
  assert.equal(ledger.actualMinutes, 0);
  assert.equal(ledger.provisionalMinutes, 60);
  const view = dashboardSnapshot("2026-10-13", now).today.sessions.find((s) => s.id === block.id)!;
  assert.equal(view.awaitingFeedback, true, "页面标为待反馈，不是待执行");

  // 每段一个持久问题：刷新/重排/重试都复用同一个
  const qs = feedback(task);
  assert.equal(qs.length, 1);
  assert.match(qs[0]!.prompt, /10\/13 08:00–09:00.*这段做了吗，还剩多少/);
  assert.equal(qs[0]!.context.sessionId, block.id);
  replan();
  askSessionFeedback({ conversationId: null, tz: TZ });
  assert.deepEqual(feedback(task).map((q) => q.id), [qs[0]!.id]);
  assert.equal(everAsked(block.id), 1);
});

test("回答“做完了，这件事也完了”：这段记完成、任务完成，不再排；没说时长就不编实践记录", () => {
  const task = addTask("微积分作业", 60);
  own(task, "2026-10-13", "08:00", 60);
  clock("2026-10-13T10:19");
  replan();
  const r = answer(feedback(task)[0]!, "做完了，这件事也完了");
  assert.equal(r.kind, "answered");
  assert.equal(sessions(task, ["completed"]).length, 1);
  assert.equal(taskRow(task).status, "done");
  assert.deepEqual(future(task), []);
  assert.deepEqual(practice(task), [], "没说做了多久，不写虚构的实践分钟");
  assert.deepEqual(feedback(task), []);
});

test("同一任务两段都过去了（生产形态）：挂住不新排；主人说整件事完成后另一段不再问、不再显示待反馈", () => {
  const task = addTask("微积分作业", 60);
  const first = own(task, "2026-10-13", "08:00", 60);
  getDb().prepare(`UPDATE tasks SET estimate_minutes = 120 WHERE id = ?`).run(task);
  const second = own(task, "2026-10-13", "10:20", 60);
  getDb().prepare(`UPDATE tasks SET estimate_minutes = 60 WHERE id = ?`).run(task);
  clock("2026-10-13T14:00");
  replan();
  assert.deepEqual(sessions(task).map((s) => s.id), [first.id, second.id], "两段都挂着，没有第三段");
  assert.equal(feedback(task).length, 1);
  const r = answer(feedback(task)[0]!, "做完了，这件事也完了");
  assert.equal(r.kind, "answered");
  assert.equal(taskRow(task).status, "done");
  assert.deepEqual(feedback(task), [], "整件事完成：另一段不再问");
  assert.equal(everAsked(second.id), 0);
  const view = dashboardSnapshot("2026-10-13", now).today.sessions.find((s) => s.id === second.id);
  assert.notEqual(view?.awaitingFeedback, true, "页面不再把它显示为待反馈");
  assert.deepEqual(practice(task), []);
});

test("回答“没做”：这段保留为未执行，按原需求只再排一次", () => {
  const task = addTask("微积分作业", 60);
  const block = own(task, "2026-10-13", "08:00", 60);
  clock("2026-10-13T10:19");
  replan();
  const r = answer(feedback(task)[0]!, "没做，忘了");
  assert.equal(r.kind, "answered");
  assert.deepEqual(sessions(task, ["skipped"]).map((s) => s.id), [block.id], "历史保留，标为没执行");
  assert.equal(total(future(task)), 60, "重新安排一次完整的 60 分钟");
  replan();
  replan();
  assert.equal(total(future(task)), 60, "重复重排不会再多排");
  assert.deepEqual(practice(task), []);
  assert.equal(taskRow(task).status, "todo");
});

test("回答部分完成（做了多久 + 还剩多少）：记下实际分钟和剩余，只排剩下的", () => {
  const a = addTask("微积分作业", 60);
  own(a, "2026-10-13", "08:00", 60);
  clock("2026-10-13T10:19");
  replan();
  const r = answer(feedback(a)[0]!, "做了40分钟，还剩30分钟");
  assert.equal(r.kind, "answered", JSON.stringify(r));
  assert.deepEqual(practice(a).map((p) => p.actual_minutes), [40]);
  assert.equal(taskRow(a).remaining_minutes, 30);
  assert.equal(total(future(a)), 30, "只排剩下的 30 分钟，不是 60，也不是 60−40−30");
  assert.equal(taskRow(a).status, "todo");
  replan();
  assert.equal(total(future(a)), 30);
});

test("部分完成：规划时钟落后于写入时钟时，同一次回答记下的实际分钟不从报告的剩余里再扣，也不再追问剩余", () => {
  // 生产里规划时刻在批次开始取、学习记录在之后几毫秒写入；固定在过去的规划时钟把这个先后放大成确定的复现
  clock("2025-03-03T07:00");
  const a = addTask("微积分作业", 60);
  own(a, "2025-03-03", "08:00", 60);
  clock("2025-03-03T10:19");
  replan();
  const r = answer(feedback(a)[0]!, "做了40分钟，还剩30分钟");
  assert.equal(r.kind, "answered", JSON.stringify(r));
  assert.deepEqual(practice(a).map((p) => p.actual_minutes), [40]);
  assert.equal(taskRow(a).remaining_minutes, 30);
  assert.equal(total(future(a)), 30, "报告的 30 就是剩余，不是 30−40");
  const plan = replan();
  assert.equal(total(future(a)), 30);
  assert.ok(!plan.unscheduled.some((u) => u.taskId === a && u.reason === "needs_remaining_estimate"));
  assert.deepEqual(listOpenQuestions().filter((q) => q.purpose === "remaining" && q.context.taskId === a), [], "刚说过还剩多少，不再问");
});

test("回答部分完成（只说做了多久）：按估时扣掉实际分钟；只说“没做完”就追问，不猜", () => {
  const b = addTask("概率论作业", 90);
  own(b, "2026-10-13", "08:00", 90);
  clock("2026-10-13T10:00");
  replan();
  const rb = answer(feedback(b)[0]!, "学了半小时");
  assert.equal(rb.kind, "answered", JSON.stringify(rb));
  assert.deepEqual(practice(b).map((p) => p.actual_minutes), [30]);
  assert.equal(total(future(b)), 60, "90 − 实际 30");

  const c = addTask("英语阅读", 60);
  clock("2026-10-14T07:00");
  own(c, "2026-10-14", "08:00", 60);
  clock("2026-10-14T10:00");
  replan();
  const unclear = answer(feedback(c)[0]!, "没做完");
  assert.equal(unclear.kind, "unparseable", "只说没做完：问做了多久、还剩多少，不猜");
  assert.equal(feedback(c).length, 1, "问题还在");
  assert.equal(sessions(c, ["planned"]).length, 1);
});

test("大任务：这段做完、事情没完 → 只记这一段，剩余照常拆分跨天；只说“做完了”不把整件事标完成", () => {
  executeOperation({ command: "update_planning_policy", base: { dailyLimitMinutes: 150 }, confirm: true }, ctx());
  const big = addTask("课程论文", 300, { dueDate: "2026-10-20" });
  own(big, "2026-10-13", "08:00", 60);
  replan();
  const planned = sessions(big);
  const placed = total(planned);
  assert.ok(planned.length >= 3, "300 分钟仍拆成多段");
  assert.ok(new Set(planned.map((s) => s.start_utc.slice(0, 10))).size >= 2, "跨天安排");
  assert.ok(placed > 60 && placed <= 300);

  clock("2026-10-13T10:00");
  replan();
  const ahead = total(future(big));
  assert.ok(ahead >= placed - 60 && ahead <= 240, "过期块挂住 60：未来最多排剩下的 240，不重复补排那 60");
  assert.equal(total(sessions(big)), 60 + ahead);
  const r = answer(feedback(big)[0]!, "做完了");
  assert.equal(r.kind, "answered");
  assert.equal(taskRow(big).status, "todo", "还有别的段和剩余需求：只说“做完了”只算这一段");
  assert.equal(sessions(big, ["completed"]).length, 1);
  assert.equal(total(future(big)), ahead, "这段记完成后剩余需求 240，未来安排不变");
  assert.deepEqual(practice(big), [], "没说时长，不编实践记录");
});

test("主人在旧块待反馈时另加一段：结果说清旧块仍等反馈，两段合计不超估时、不再自动补排", () => {
  const other = addTask("物理实验报告", 60);
  own(other, "2026-10-13", "08:00", 60);
  getDb().prepare(`UPDATE tasks SET estimate_minutes = 120 WHERE id = ?`).run(other);
  clock("2026-10-13T12:30");
  const extra = executeOperation({ command: "schedule_session", taskId: other, date: "2026-10-13", startLocalTime: "19:00", durationMinutes: 60 }, ctx());
  assert.ok(extra.result.ok, JSON.stringify(extra.result));
  assert.match(extra.result.ok ? extra.result.summary : "", /08:00–09:00 那段还没记录做没做，仍等你反馈，这段是另加的/);
  replan();
  assert.equal(total(sessions(other)), 120, "旧块 60 挂着 + 主人另加 60 = 估时 120，不再自动补排");
  assert.equal(sessions(other).filter((s) => s.origin === "agent").length, 0);
});

test("不重复计算：进行中未结束、完成但没填时长、完成后再报告剩余", () => {
  const live = addTask("线代复习", 60);
  const liveBlock = own(live, "2026-10-13", "08:00", 60);
  clock("2026-10-13T08:20");
  executeOperation({ command: "set_session_state", sessionId: liveBlock.id, action: "start", expectedVersion: null }, ctx());
  replan();
  assert.equal(sessions(live).length, 1, "进行中的块原样保留，不另排");
  assert.deepEqual(feedback(live), [], "还没结束不问");

  clock("2026-10-14T07:00");
  const done = addTask("数分作业", 60);
  const doneBlock = own(done, "2026-10-14", "08:00", 60);
  clock("2026-10-14T09:05");
  executeOperation({ command: "set_session_state", sessionId: doneBlock.id, action: "complete", expectedVersion: null }, ctx());
  replan();
  assert.deepEqual(future(done), [], "完成但没填时长：按块长算投入，不再排");
  assert.deepEqual(practice(done), []);
  assert.deepEqual(feedback(done), []);

  clock("2026-10-15T07:00");
  const later = addTask("编程作业", 60);
  const laterBlock = own(later, "2026-10-15", "08:00", 60);
  clock("2026-10-15T09:10");
  executeOperation({ command: "set_session_state", sessionId: laterBlock.id, action: "complete", expectedVersion: null }, ctx());
  const reached = replan();
  assert.ok(reached.unscheduled.some((u) => u.taskId === later && u.reason === "needs_remaining_estimate"), "投入到了估时还没完成：问剩余，不自动补排");
  assert.deepEqual(future(later), []);
  executeOperation({ command: "create_or_update_task", taskId: later, remainingMinutes: 30 }, ctx());
  replan();
  assert.equal(total(future(later)), 30, "报告的剩余就是剩余，不再扣之前那段");
  assert.deepEqual(feedback(later), []);
});

test("多轮与恢复：同一段只问一次、回答只落实一次；同一任务下一段等上一段答完再问", () => {
  const task = addTask("微积分作业", 60);
  const first = own(task, "2026-10-13", "08:00", 60);
  getDb().prepare(`UPDATE tasks SET estimate_minutes = 120 WHERE id = ?`).run(task);
  const second = own(task, "2026-10-13", "10:00", 60);
  clock("2026-10-13T11:30");
  replan();
  const qs = feedback(task);
  assert.equal(qs.length, 1, "同一任务一次只问一段");
  assert.equal(qs[0]!.context.sessionId, first.id);

  const r = answer(qs[0]!, "这段做完了，事情还没完");
  assert.equal(r.kind, "answered");
  const writes = batches();
  const retry = answer(qs[0]!, "这段做完了，事情还没完");
  assert.notEqual(retry.kind, "answered", "重试同一个回答不再落实");
  assert.equal(batches(), writes, "没有新的写入");
  assert.equal(sessions(task, ["completed"]).length, 1);

  const next = feedback(task);
  assert.equal(next.length, 1);
  assert.equal(next[0]!.context.sessionId, second.id, "上一段答完后才问下一段");
  replan();
  askSessionFeedback({ conversationId: null, tz: TZ });
  recoverOnStartup();
  assert.deepEqual(feedback(task).map((q) => q.id), [next[0]!.id]);
  assert.equal(everAsked(first.id), 1);
  assert.equal(everAsked(second.id), 1);
});

test("页面输入框里用自然语言回答：走统一入口，落实一次，重复提交不再写", async () => {
  const task = addTask("微积分作业", 60);
  own(task, "2026-10-13", "08:00", 60);
  clock("2026-10-13T10:19");
  replan();
  const q = feedback(task)[0]!;
  const first = await answerInBar(q, "写了四十分钟，还差半小时");
  assert.equal(first.status, 202, JSON.stringify(first.body));
  assert.equal(first.body.answered, true);
  assert.match(first.body.results!.map((r) => r.summary).join("\n"), /这一段已完成，实际 40 分钟/);
  assert.deepEqual(practice(task).map((p) => p.actual_minutes), [40]);
  assert.equal(total(future(task)), 30);
  const writes = batches();
  const again = await answerInBar(q, "写了四十分钟，还差半小时");
  assert.notEqual(again.body.answered, true, "问题已答，不再落实");
  assert.equal(batches(), writes);
  assert.deepEqual(practice(task).map((p) => p.actual_minutes), [40]);
});

test("自然语言回答：只按主人说出口的内容落结果，说不清的追问", () => {
  const q = { purpose: "session_feedback", options: ["做完了，这件事也完了", "这段做完了，事情还没完", "没做，帮我另排"], context: { plannedMinutes: 60 } } as unknown as QuestionRow;
  const env = { referenceDate: "2026-10-13", now, tz: TZ };
  const parse = (text: string) => {
    const r = parseAnswerByPurpose(q, text, env);
    return r.ok ? r.structured : "ASK";
  };
  assert.deepEqual(parse("2"), { outcome: "session_done" });
  assert.deepEqual(parse("没做，帮我另排"), { outcome: "skipped" });
  assert.deepEqual(parse("没时间，没动"), { outcome: "skipped" });
  assert.deepEqual(parse("没做，还剩一小时"), { outcome: "skipped", remainingMinutes: 60 });
  assert.deepEqual(parse("做了40分钟，还剩30分钟"), { outcome: "partial", actualMinutes: 40, remainingMinutes: 30 });
  assert.deepEqual(parse("做了20分钟就没时间了"), { outcome: "partial", actualMinutes: 20 });
  assert.deepEqual(parse("完成了一半"), { outcome: "partial", actualMinutes: 30 });
  assert.deepEqual(parse("还差半小时"), { outcome: "partial", remainingMinutes: 30 });
  assert.deepEqual(parse("做完了，花了一小时"), { outcome: "done", actualMinutes: 60 });
  assert.deepEqual(parse("这段做完了，作业还没写完"), { outcome: "session_done" });
  assert.deepEqual(parse("作业都写完了"), { outcome: "task_done" });
  assert.deepEqual(parse("做了一小时，还剩0分钟"), { outcome: "task_done", actualMinutes: 60, remainingMinutes: 0 });
  assert.equal(parse("没做完"), "ASK");
  assert.equal(parse("40分钟"), "ASK", "只给一个数，分不清是做了还是还剩");
  assert.equal(parse("嗯"), "ASK");
});

test("后台轮询：块刚过去就问，重复轮询不重复问；块被主人挪走后问题收回", async () => {
  const task = addTask("微积分作业", 60);
  const block = own(task, "2026-10-13", "08:00", 60);
  clock("2026-10-13T09:05");
  for (let i = 0; i < 3; i++) await runDueJobsOnce();
  assert.equal(feedback(task).length, 1);
  assert.equal(everAsked(block.id), 1);

  const moved = executeOperation({ command: "reschedule_session", sessionId: block.id, targetDate: "2026-10-13", startLocalTime: "19:00", expectedVersion: null }, ctx());
  assert.ok(moved.result.ok, JSON.stringify(moved.result));
  askSessionFeedback({ conversationId: null, tz: TZ });
  assert.deepEqual(feedback(task), [], "挪走后不再等这段的反馈");
  const rows = sessions(task);
  assert.deepEqual(rows.map((s) => s.id), [block.id], "原地挪动，没有留下两份看似都待执行的安排");
  assert.match(rows[0]!.reason, /原 /);
});
