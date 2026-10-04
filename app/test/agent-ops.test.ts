import assert from "node:assert/strict";
import crypto from "node:crypto";
import { after, before, test } from "node:test";
import { NextRequest } from "next/server";
import { migrateAll, getDb } from "./helpers";
import { createOwner, createSession, SESSION_COOKIE } from "@/domain/session";
import { hashPassword } from "@/domain/password";
import { setNowForTests } from "@/domain/clock";
import { parseInstruction } from "@/domain/intent";
import { setProvidersForTests } from "@/integrations";
import { FakeModelProvider } from "@/integrations/fake-model-provider";
import { runDueJobsOnce } from "@/worker/runner";
import { executeOperation, undoWithFollowUps } from "@/workflows/commands";
import { getAiBudget } from "@/workflows/ai-budget";
import { eventsForDay } from "@/workflows/plan";
import { OPERATIONS } from "@/contracts/commands";
import { POST as createIntakeRoute } from "@/app/api/v2/intakes/route";
import { GET as getIntakeRoute } from "@/app/api/v2/intakes/[id]/route";
import { GET as capabilitiesRoute } from "@/app/api/v2/actions/route";

/**
 * 复盘 / 定期探索 / 即时摘要 / 停止处理 / 固定活动（AGENT-INTERFACE-CONTRACT §4；E34、E39 相关的隔离行为）。
 * 规划时钟固定在 2026-10-12（周一）18:30。模型是假件；复盘与摘要只验证“被可靠地排上了”，不验证真实模型或真实邮件投递。
 */

const NOW = new Date("2026-10-12T18:30:00+08:00");
const TZ = "Asia/Shanghai";
const CTX = { intakeId: null, itemId: null, itemKey: "", instanceEpoch: 0, evidence: "", explicit: true, now: NOW };
const intentsOf = (text: string, titles: string[] = []) => parseInstruction(text, "2026-10-12", NOW, TZ, { fixedEventTitles: titles }).intents.map((i) => i.intent);

let sessionToken = "";
let csrfToken = "";
let seq = 0;
let modelCalls = 0;

function req(url: string, method: string, body?: unknown): NextRequest {
  return new NextRequest(`http://localhost${url}`, {
    method,
    headers: { cookie: `${SESSION_COOKIE}=${sessionToken}`, "x-csrf-token": csrfToken, "content-type": "application/json", ...(method === "POST" ? { "idempotency-key": `ops-${seq++}` } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}
type Result = { state: string; summary: string; undo: { available: boolean; batchIds: string[] }; items: Array<{ kind: string; state: string; summary: string; error: string | null }>; questions: Array<{ prompt: string; options: string[] }> };
async function post(text: string): Promise<string> {
  const res = await createIntakeRoute(req("/api/v2/intakes", "POST", { text }));
  assert.equal(res.status, 202, await res.clone().text());
  return ((await res.json()) as { intakeId: string }).intakeId;
}
async function resultOf(intakeId: string): Promise<Result> {
  const got = await getIntakeRoute(req(`/api/v2/intakes/${intakeId}`, "GET"), { params: Promise.resolve({ id: intakeId }) });
  return ((await got.json()) as { result: Result }).result;
}
async function say(text: string): Promise<Result> {
  const id = await post(text);
  for (let i = 0; i < 4; i++) await runDueJobsOnce();
  return resultOf(id);
}
function addFixed(title: string, weekday: number, start: string, end: string, date: string | null = null): string {
  const id = crypto.randomUUID();
  getDb().prepare(`INSERT INTO fixed_events (id, title, weekday, local_start, local_end, timezone, event_date) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(id, title, weekday, start, end, TZ, date);
  return id;
}
const fixedRow = (id: string) => getDb().prepare(`SELECT title, weekday, local_start, local_end, event_date, version FROM fixed_events WHERE id = ?`).get(id) as { title: string; weekday: number; local_start: string; local_end: string; event_date: string | null; version: number } | undefined;
const titlesOn = (date: string) => eventsForDay(date, TZ).map((e) => e.title);

before(() => {
  migrateAll();
  setNowForTests(NOW);
  createOwner(hashPassword("ops-test-pass"));
  const { token, session } = createSession(1);
  sessionToken = token;
  csrfToken = session.csrfToken;
  setProvidersForTests({
    model: {
      mode: "fixture",
      provider: new FakeModelProvider((r) => {
        modelCalls++;
        const text = ((r.context as { text?: string }).text ?? "").trim();
        return { ok: true, validatedResult: { items: [{ itemKey: "item-1", kind: "note", summary: text.slice(0, 40), excerpt: text.slice(0, 100) }] } };
      }),
    },
  });
});
after(() => setNowForTests(null));

test("新操作都在注册表里，能力清单与注册表一致（不展示没实现的工具）", async () => {
  const names = ["request_review", "configure_exploration", "request_owner_digest", "cancel_operation", "update_fixed_event", "schedule_session", "update_agent_policy"];
  for (const n of names) assert.ok(n in OPERATIONS, n);
  const body = (await (await capabilitiesRoute(req("/api/v2/actions", "GET"))).json()) as { operations: Array<{ name: string }> };
  assert.deepEqual(body.operations.map((o) => o.name).sort(), Object.keys(OPERATIONS).sort());
});

test("说法识别：复盘、定期复盘、关注方向、现在发摘要、停止处理、固定活动——各归各的意图，互不串", () => {
  assert.deepEqual(intentsOf("帮我复盘一下上周"), [{ op: "review", week: "last" }]);
  assert.deepEqual(intentsOf("这周复盘一下"), [{ op: "review", week: "this" }]);
  assert.deepEqual(intentsOf("每周日晚上八点复盘"), [{ op: "agent_policy", weeklyReview: { weekday: 7, localTime: "20:00" } }]);
  assert.deepEqual(intentsOf("不用每周复盘了"), [{ op: "agent_policy", weeklyReview: null }]);
  assert.deepEqual(intentsOf("别再主动找项目了"), [{ op: "agent_policy", scheduledEnabled: false }], "总开关的说法不变");
  assert.deepEqual(intentsOf("每周六上午十点帮我找找计算机视觉方向的比赛"), [{ op: "explore_topic", title: "计算机视觉", weekday: 6, stop: false, localTime: "10:00" }]);
  assert.deepEqual(intentsOf("别再找计算机视觉的比赛了"), [{ op: "explore_topic", title: "计算机视觉", stop: true }]);
  assert.deepEqual(intentsOf("现在发一份今天的摘要给我"), [{ op: "digest_now", kind: "daily" }]);
  assert.deepEqual(intentsOf("工作日晚八点给摘要"), [{ op: "digest", dailyEnabled: true, dailyTime: "20:00", weekdaysOnly: true }], "定期策略的说法不被“现在发”抢走");
  assert.deepEqual(intentsOf("刚才那份先别处理了"), [{ op: "cancel_intake" }]);
  assert.deepEqual(intentsOf("撤销刚才的修改"), [{ op: "undo" }], "撤销已生效的变化仍是撤销");

  const titles = ["社团例会"];
  assert.deepEqual(intentsOf("把社团例会改到每周四 19:00-20:30", titles), [{ op: "fixed_event", name: "社团例会", remove: false, weekday: 4, start: "19:00", end: "20:30" }]);
  assert.deepEqual(intentsOf("社团例会改到晚上八点", titles), [{ op: "fixed_event", name: "社团例会", remove: false, start: "20:00" }]);
  assert.deepEqual(intentsOf("以后不去社团例会了", titles), [{ op: "fixed_event", name: "社团例会", remove: true }]);
  assert.deepEqual(intentsOf("明天不去社团例会", titles), [{ op: "fixed_event", name: "社团例会", remove: false, skipDate: "2026-10-13" }]);
  assert.deepEqual(intentsOf("以后不去社团例会了"), [], "没有这个固定活动时不当成对它的指令");
});

test("update_fixed_event：改星期/钟点保留时长、单次不去、以后不去；课程不能从这里改；都可撤销且版本不倒退", () => {
  const id = addFixed("社团例会", 2, "19:00", "20:30");
  assert.ok(titlesOn("2026-10-13").includes("社团例会"));

  const skip = executeOperation({ command: "update_fixed_event", eventId: id, skipDate: "2026-10-13" }, CTX);
  assert.ok(skip.result.ok, skip.result.ok ? "" : skip.result.error);
  assert.match(skip.result.ok ? skip.result.summary : "", /10\/13 的「社团例会」（19:00–20:30）这次不去.*以后照常/);
  assert.equal(titlesOn("2026-10-13").includes("社团例会"), false, "那一天空出来");
  assert.ok(titlesOn("2026-10-20").includes("社团例会"), "下一周照常");
  const wrongDay = executeOperation({ command: "update_fixed_event", eventId: id, skipDate: "2026-10-14" }, CTX).result;
  assert.deepEqual([wrongDay.ok, wrongDay.ok ? "" : wrongDay.code], [false, "NO_OCCURRENCE"]);
  assert.equal(undoWithFollowUps(skip.result.ok ? skip.result.batchId! : "").kind, "undone");
  assert.ok(titlesOn("2026-10-13").includes("社团例会"), "撤销后那天又有了");

  const move = executeOperation({ command: "update_fixed_event", eventId: id, weekday: 4, localStart: "20:00" }, CTX);
  assert.ok(move.result.ok, move.result.ok ? "" : move.result.error);
  assert.match(move.result.ok ? move.result.summary : "", /从 每周二 19:00–20:30 改为 每周四 20:00–21:30/);
  assert.deepEqual([fixedRow(id)!.weekday, fixedRow(id)!.local_start, fixedRow(id)!.local_end, fixedRow(id)!.version], [4, "20:00", "21:30", 2]);
  assert.equal(titlesOn("2026-10-13").includes("社团例会"), false);
  assert.ok(titlesOn("2026-10-15").includes("社团例会"));
  const same = executeOperation({ command: "update_fixed_event", eventId: id, weekday: 4 }, CTX).result;
  assert.equal(same.ok && same.noChange, true, "没有变化不写批次");
  const stale = executeOperation({ command: "update_fixed_event", eventId: id, expectedVersion: 1, title: "例会" }, CTX).result;
  assert.deepEqual([stale.ok, stale.ok ? "" : stale.code], [false, "STALE_VERSION"]);
  assert.equal(undoWithFollowUps(move.result.ok ? move.result.batchId! : "").kind, "undone");
  assert.deepEqual([fixedRow(id)!.weekday, fixedRow(id)!.local_start, fixedRow(id)!.local_end, fixedRow(id)!.version], [2, "19:00", "20:30", 3], "字段回去，版本继续前进");

  const gone = executeOperation({ command: "update_fixed_event", eventId: id, remove: true }, CTX);
  assert.ok(gone.result.ok);
  assert.equal(fixedRow(id), undefined);
  assert.equal(undoWithFollowUps(gone.result.ok ? gone.result.batchId! : "").kind, "undone");
  assert.equal(fixedRow(id)!.title, "社团例会");

  // 课程投影出来的占用不能当普通活动改
  const db = getDb();
  const [semester, set, course, meeting] = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
  const courseEvent = addFixed("高等数学 · 张老师 · A101", 1, "08:15", "09:55");
  db.prepare(`INSERT INTO semesters (id, first_monday, total_weeks, timezone, created_at, updated_at) VALUES (?, '2026-08-31', 18, ?, 'x', 'x')`).run(semester, TZ);
  db.prepare(`INSERT INTO course_sets (id, semester_id, created_at, updated_at) VALUES (?, ?, 'x', 'x')`).run(set, semester);
  db.prepare(`INSERT INTO courses (id, course_set_id, name, created_at, updated_at) VALUES (?, ?, '高等数学', 'x', 'x')`).run(course, set);
  db.prepare(`INSERT INTO course_meetings (id, course_id, weekday, local_start, local_end, weeks_json, created_at, updated_at) VALUES (?, ?, 1, '08:15', '09:55', '[7]', 'x', 'x')`).run(meeting, course);
  db.prepare(`INSERT INTO course_meeting_projections (id, meeting_id, fixed_event_id, source_version, rule_hash, created_at) VALUES (?, ?, ?, 1, 'h', 'x')`).run(crypto.randomUUID(), meeting, courseEvent);
  const asCourse = executeOperation({ command: "update_fixed_event", eventId: courseEvent, remove: true }, CTX).result;
  assert.deepEqual([asCourse.ok, asCourse.ok ? "" : asCourse.code], [false, "IS_COURSE"]);
  assert.match(asCourse.ok ? "" : asCourse.error, /「高等数学」是课程/);
});

test("一句话改固定活动：不调模型；两个同名活动只问选哪一个；回答后只改选中的那个", async () => {
  const calls = modelCalls;
  const r = await say("把社团例会改到每周四 19:30-21:00");
  assert.equal(r.state, "applied", JSON.stringify(r));
  assert.equal(modelCalls, calls);
  assert.match(r.summary, /每周二 19:00–20:30 改为 每周四 19:30–21:00/);
  assert.ok(r.undo.available);

  addFixed("家教", 3, "18:00", "19:00");
  addFixed("家教", 6, "10:00", "11:30");
  const ask = await say("以后不去家教了");
  assert.equal(ask.state, "needs_input", JSON.stringify(ask));
  assert.deepEqual(ask.questions[0]!.options, ["家教（每周三 18:00–19:00）", "家教（每周六 10:00–11:30）"]);
  assert.equal((getDb().prepare(`SELECT COUNT(*) AS n FROM fixed_events WHERE title = '家教'`).get() as { n: number }).n, 2, "没回答之前什么都不删");
});

test("configure_exploration：新建关注方向并定时；改时间让未开始的旧一轮作废；停用保留记录；撤销新建=停用归档", () => {
  const made = executeOperation({ command: "configure_exploration", title: "计算机视觉", weekday: 6, localTime: "10:00" }, CTX);
  assert.ok(made.result.ok, made.result.ok ? "" : made.result.error);
  assert.match(made.result.ok ? made.result.summary : "", /以后每周六 10:00帮你找一次「计算机视觉」方向的候选.*不会替你报名或承诺投入/);
  const topic = () => getDb().prepare(`SELECT id, enabled, weekday, local_time, next_run_at, archived_at, version FROM exploration_topics WHERE title = '计算机视觉'`).get() as { id: string; enabled: number; weekday: number; local_time: string; next_run_at: string | null; archived_at: string | null; version: number };
  assert.deepEqual([topic().enabled, topic().weekday, topic().local_time], [1, 6, "10:00"]);
  assert.ok(topic().next_run_at, "下一次运行时间已排");

  const dup = executeOperation({ command: "configure_exploration", title: "计算机视觉" }, CTX).result;
  assert.deepEqual([dup.ok, dup.ok ? "" : dup.code], [false, "DUPLICATE"]);

  const moved = executeOperation({ command: "configure_exploration", topicId: topic().id, weekday: 7, localTime: "09:00" }, CTX);
  assert.ok(moved.result.ok);
  assert.deepEqual([topic().weekday, topic().local_time, topic().version], [7, "09:00", 2]);
  assert.equal(undoWithFollowUps(moved.result.ok ? moved.result.batchId! : "").kind, "undone");
  assert.deepEqual([topic().weekday, topic().local_time], [6, "10:00"]);

  const stop = executeOperation({ command: "configure_exploration", topicId: topic().id, archive: true }, CTX);
  assert.ok(stop.result.ok);
  assert.match(stop.result.ok ? stop.result.summary : "", /不再定期找「计算机视觉」了；之前找到的候选和记录都还在/);
  assert.ok(topic().archived_at);
  assert.equal(topic().next_run_at, null);
});

test("定期复盘时间与按需复盘：策略写进同一份设置；复盘任务可靠入队，重复说不叠第二个", async () => {
  const set = await say("每周日晚上八点复盘");
  assert.equal(set.state, "applied", JSON.stringify(set));
  assert.match(set.summary, /以后每周日 20:00 自动整理上一周的复盘（建议不会自动执行）/);
  assert.deepEqual(getAiBudget().budget.weeklyReview, { weekday: 7, localTime: "20:00" });

  const reviews = () => getDb().prepare(`SELECT local_monday, trigger, status FROM reviews ORDER BY created_at`).all() as Array<{ local_monday: string; trigger: string; status: string }>;
  const first = executeOperation({ command: "request_review", week: "last" }, CTX).result;
  assert.ok(first.ok, first.ok ? "" : first.error);
  assert.match(first.ok ? first.summary : "", /开始整理 10\/5–10\/11 这一周的复盘.*建议要你点头才会执行/);
  assert.deepEqual(reviews().map((r) => [r.local_monday, r.trigger]), [["2026-10-05", "manual"]]);
  const again = executeOperation({ command: "request_review", week: "last" }, CTX).result;
  assert.match(again.ok ? again.summary : "", /已经在生成了/);
  assert.equal(reviews().length, 1, "在途的不叠加");
  const future = executeOperation({ command: "request_review", localMonday: "2026-10-19" }, CTX).result;
  assert.equal(future.ok, false);

  const off = await say("不用每周复盘了");
  assert.equal(off.state, "applied");
  assert.equal(getAiBudget().budget.weeklyReview, null);
  assert.equal(getAiBudget().budget.scheduledEnabled, true, "只停复盘，不连带停掉定期探索");
});

test("request_owner_digest：邮件没配置时如实说发不出去，不排任务、不假称已发", () => {
  const before1 = (getDb().prepare(`SELECT COUNT(*) AS n FROM jobs WHERE type = 'digest'`).get() as { n: number }).n;
  const r = executeOperation({ command: "request_owner_digest", kind: "daily" }, CTX).result;
  assert.deepEqual([r.ok, r.ok ? "" : r.code], [false, "MAIL_NOT_CONFIGURED"]);
  assert.match(r.ok ? "" : r.error, /邮件还没配置完整.*现在发不出去/);
  assert.equal((getDb().prepare(`SELECT COUNT(*) AS n FROM jobs WHERE type = 'digest'`).get() as { n: number }).n, before1);
});

test("cancel_operation：停止一份还在等回答的材料——没执行的不再执行、问题关闭；已处理完的说明改用撤销", async () => {
  addFixed("排练", 5, "19:00", "20:00");
  addFixed("排练", 7, "15:00", "16:00");
  const pendingId = await post("以后不去排练了");
  for (let i = 0; i < 4; i++) await runDueJobsOnce();
  assert.equal((await resultOf(pendingId)).state, "needs_input");

  const stop = await say("刚才那份先别处理了");
  assert.equal(stop.state, "applied", JSON.stringify(stop));
  assert.match(stop.summary, /已停止处理那份材料.*已经生效的变化保留/);
  assert.equal((getDb().prepare(`SELECT status FROM intakes WHERE id = ?`).get(pendingId) as { status: string }).status, "cancelled");
  assert.equal((getDb().prepare(`SELECT COUNT(*) AS n FROM fixed_events WHERE title = '排练'`).get() as { n: number }).n, 2, "没执行的没有被执行");

  // 更早那份“家教”的提问也还挂着：再说一次，停的是它
  const older = await say("刚才那份先别处理了");
  assert.equal(older.state, "applied");
  assert.equal((getDb().prepare(`SELECT COUNT(*) AS n FROM intakes WHERE status = 'waiting_input'`).get() as { n: number }).n, 0);
  const none = await say("刚才那份先别处理了");
  assert.match(none.items[0]?.error ?? "", /现在没有还在处理中的材料.*直接说“撤销”/);

  const done = executeOperation({ command: "cancel_operation", intakeId: pendingId }, CTX).result;
  assert.equal(done.ok && /已经停止处理了/.test(done.summary), true);
});
