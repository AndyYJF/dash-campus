import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { NextRequest } from "next/server";
import { migrateAll, getDb } from "./helpers";
import { createOwner, createSession, SESSION_COOKIE } from "@/domain/session";
import { hashPassword } from "@/domain/password";
import { setNowForTests } from "@/domain/clock";
import { setProvidersForTests } from "@/integrations";
import { FakeModelProvider } from "@/integrations/fake-model-provider";
import { runDueJobsOnce } from "@/worker/runner";
import { profileFactsFromText } from "@/domain/identity";
import { POST as createIntakeRoute } from "@/app/api/v2/intakes/route";
import { GET as getIntakeRoute } from "@/app/api/v2/intakes/[id]/route";
import { POST as answerRoute } from "@/app/api/v2/questions/[id]/answers/route";

/**
 * R2 身份与通知筛选、状态解释与导出（E30、E36、E39 的隔离行为）。
 * 模型假件：分类给出 notice，提取给出带原文引用的资格条件与行动；身份、三值判断、提问、建任务走真实实现。
 */

const NOW = new Date("2026-10-12T09:00:00+08:00");
let sessionToken = "";
let csrfToken = "";
let seq = 0;
let noticeFixture: (text: string) => unknown = () => ({ structured: null, actionQuote: null, dueQuote: null, unknownReason: "未提供" });

function req(url: string, method: string, body?: unknown): NextRequest {
  return new NextRequest(`http://localhost${url}`, {
    method,
    headers: { cookie: `${SESSION_COOKIE}=${sessionToken}`, "x-csrf-token": csrfToken, "content-type": "application/json", ...(method === "POST" ? { "idempotency-key": `ntc-${seq++}` } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}
type Result = { state: string; summary: string; nextActions: string[]; undo: { available: boolean; batchIds: string[] }; questions: Array<{ id: string; prompt: string; purpose: string; options: string[]; version: number }>; items: Array<{ kind: string; state: string; error: string | null; summary: string }> };
async function drain() {
  for (let i = 0; i < 4; i++) await runDueJobsOnce();
}
async function resultOf(id: string): Promise<Result> {
  const res = await getIntakeRoute(req(`/api/v2/intakes/${id}`, "GET"), { params: Promise.resolve({ id }) });
  return ((await res.json()) as { result: Result }).result;
}
async function say(text: string) {
  const res = await createIntakeRoute(req("/api/v2/intakes", "POST", { text }));
  assert.equal(res.status, 202);
  const { intakeId } = (await res.json()) as { intakeId: string };
  await drain();
  return { intakeId, result: await resultOf(intakeId) };
}
async function answer(q: { id: string; version: number }, text: string) {
  const res = await answerRoute(req(`/api/v2/questions/${q.id}/answers`, "POST", { text, expectedVersion: q.version }), { params: Promise.resolve({ id: q.id }) });
  await drain();
  return res;
}
const facts = () => Object.fromEntries((getDb().prepare(`SELECT field, value FROM profile_facts ORDER BY field`).all() as Array<{ field: string; value: string }>).map((f) => [f.field, f.value]));
const taskTitles = () => (getDb().prepare(`SELECT title FROM tasks WHERE archived_at IS NULL ORDER BY created_at`).all() as Array<{ title: string }>).map((t) => t.title);

before(() => {
  migrateAll();
  setNowForTests(NOW);
  createOwner(hashPassword("ntc-test-pass"));
  const { token, session } = createSession(1);
  sessionToken = token;
  csrfToken = session.csrfToken;
  setProvidersForTests({
    model: {
      mode: "fixture",
      provider: new FakeModelProvider((r) => {
        const text = (r.context as { text: string }).text;
        if (r.workflow === "notice-extraction") return { ok: true, validatedResult: noticeFixture(text) };
        return { ok: true, validatedResult: { items: [{ itemKey: "n1", kind: "notice", summary: text.slice(0, 30), excerpt: text.slice(0, 200) }] } };
      }),
    },
  });
});
after(() => setNowForTests(null));

test("身份陈述的归一：大一=本科一年级；不从兴趣或愿望推断", () => {
  assert.deepEqual(profileFactsFromText("我是AI专业大一"), [
    { field: "education_level", value: "本科" },
    { field: "study_year", value: "一年级" },
    { field: "program", value: "AI" },
  ]);
  assert.deepEqual(profileFactsFromText("我在江安校区，2026级"), [
    { field: "grade_year", value: "2026" },
    { field: "campus", value: "江安" },
  ]);
  assert.deepEqual(profileFactsFromText("我是研一"), [
    { field: "education_level", value: "研究生" },
    { field: "study_year", value: "一年级" },
  ]);
});

test("E30：一句话说明身份并设筛选规则 → 研究生专属通知只存资料；资格不明只问缺的字段；可查看、可撤销；原文不变", async () => {
  const who = await say("我是AI专业大一，不用给我研究生专属通知");
  assert.equal(who.result.state, "applied", JSON.stringify(who.result.items));
  assert.deepEqual(facts(), { education_level: "本科", program: "AI", study_year: "一年级" });
  assert.match(who.result.summary, /学历层次：本科/);
  assert.match(who.result.summary, /只面向研究生的通知只存资料、不进行动/);
  assert.match(who.result.summary, /原文都保留/);

  // 研究生专属：与身份不符 → 折叠，不建任务
  const gradText = "关于研究生学术论坛报名的通知：仅限研究生报名，10月20日前提交报名表。";
  noticeFixture = () => ({
    structured: { noticeType: "学术活动", condition: { kind: "leaf", field: "education_level", op: "eq", value: "研究生", quote: "仅限研究生报名" }, action: { actionKey: "x", title: "提交学术论坛报名表", required: true, due: { kind: "date", localDate: "2026-10-20", timezone: "Asia/Shanghai" } } },
    actionQuote: "10月20日前提交报名表",
    dueQuote: "10月20日前提交报名表",
    unknownReason: null,
  });
  const grad = await say(gradText);
  assert.equal(grad.result.state, "no_change", JSON.stringify(grad.result.items));
  assert.match(grad.result.summary, /与你无关，已折叠保存（资格条件和你的身份不符）/);
  assert.deepEqual(taskTitles(), [], "明确无关的通知不占行动");
  assert.equal((getDb().prepare(`SELECT text FROM inbox_revisions`).get() as { text: string }).text, gradText, "来源原文一字不动");

  // 资格不明：只面向江安校区，校区还不知道 → 只问校区
  noticeFixture = () => ({
    structured: { noticeType: "体检", condition: { kind: "leaf", field: "campus", op: "eq", value: "江安校区", quote: "江安校区本科生" }, action: { actionKey: "x", title: "预约新生体检", required: true, due: { kind: "date", localDate: "2026-10-20", timezone: "Asia/Shanghai" } } },
    actionQuote: "须在10月20日前完成体检预约",
    dueQuote: "须在10月20日前完成体检预约",
    unknownReason: null,
  });
  const exam = await say("体检通知：江安校区本科生须在10月20日前完成体检预约。");
  assert.equal(exam.result.state, "needs_input");
  const q = exam.result.questions[0]!;
  assert.equal(q.purpose, "profile_fact");
  assert.match(q.prompt, /“江安校区本科生”。你的校区是什么？/);
  assert.deepEqual(q.options, ["江安"], "条件里的写法已归一");
  assert.deepEqual(taskTitles(), [], "资格不明时不默认建任务，也不默认过滤");

  assert.equal((await answer(q, "不知道")).status, 422, "答非所问给具体提示");
  const again = (await resultOf(exam.intakeId)).questions[0]!;
  assert.equal((await answer(again, "我在江安校区")).status, 202);
  assert.equal(facts().campus, "江安");
  const done = await resultOf(exam.intakeId);
  assert.equal(done.state, "applied", JSON.stringify(done.items));
  assert.match(done.summary, /已建任务「预约新生体检」/);
  assert.deepEqual(taskTitles(), ["预约新生体检"]);
  const task = getDb().prepare(`SELECT due_kind, due_local_date FROM tasks WHERE title = '预约新生体检'`).get();
  assert.deepEqual(task, { due_kind: "date", due_local_date: "2026-10-20" }, "真实截止按原文保存");
  assert.equal(done.undo.available, true);
});

test("E30/E39：身份未知时筛选规则才起作用；“撤销筛选规则”后不再折叠；历史通知不因重评估变成新任务", async () => {
  const db = getDb();
  db.prepare(`DELETE FROM profile_facts WHERE field = 'education_level'`).run();
  noticeFixture = () => ({
    structured: { noticeType: "奖学金", condition: { kind: "leaf", field: "education_level", op: "eq", value: "研究生", quote: "研究生国家奖学金" }, action: { actionKey: "x", title: "提交奖学金申请", required: true } },
    actionQuote: "请于本周内提交申请材料",
    dueQuote: null,
    unknownReason: null,
  });
  const folded = await say("研究生国家奖学金申请：请于本周内提交申请材料。");
  assert.match(folded.result.summary, /与你无关，已折叠保存（按你的规则：只面向研究生的通知不进行动）/, "身份未知 + 有规则：按规则折叠，不追问");
  assert.equal(folded.result.questions.length, 0);

  const undo = await say("撤销筛选规则");
  assert.equal(undo.result.state, "applied", JSON.stringify(undo.result.items));
  assert.match(undo.result.summary, /已撤回.*研究生专属通知不进行动/);
  assert.match(undo.result.summary, /可以在收件箱里看到/);
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM tasks WHERE title = '提交奖学金申请'`).get() instanceof Object && (db.prepare(`SELECT COUNT(*) AS n FROM tasks WHERE title = '提交奖学金申请'`).get() as { n: number }).n, 0, "规则撤回不把旧通知自动变成任务");

  const asked = await say("研究生助教岗位报名：研究生国家奖学金获得者优先，请于本周内提交申请材料。");
  assert.equal(asked.result.state, "needs_input", "规则撤回后，资格不明就问关键字段");
  assert.match(asked.result.questions[0]!.prompt, /你的学历层次是什么/);
});

test("E39：“为什么没提醒我”给出查得到的事实；“打包我的数据”生成可下载导出，不含秘密", async () => {
  const why = await say("为什么没提醒我");
  assert.equal(why.result.items[0]!.state, "applied");
  assert.match(why.result.summary, /还没有配置收件邮箱/);
  assert.match(why.result.summary, /22:00–08:00 是安静时段/);
  assert.match(why.result.summary, /最近没有任何邮件投递记录|已排好/);
  assert.equal(why.result.undo.available, false, "只读回答不改数据");
  assert.equal((getDb().prepare(`SELECT COUNT(*) AS n FROM agent_action_batches WHERE intake_id = ?`).get(why.intakeId) as { n: number }).n, 0);

  const pack = await say("打包我的全部数据");
  assert.equal(pack.result.state, "applied", JSON.stringify(pack.result.items));
  assert.match(pack.result.summary, /24 小时内可下载：\/api\/v1\/exports\/[0-9a-f-]+\/download/);
  assert.match(pack.result.summary, /不含密码、会话和后台队列/);
  const row = getDb().prepare(`SELECT status, type FROM exports ORDER BY created_at DESC LIMIT 1`).get();
  assert.deepEqual(row, { status: "ready", type: "full_json" });
});
