import assert from "node:assert/strict";
import crypto from "node:crypto";
import { after, before, beforeEach, test } from "node:test";
import { NextRequest } from "next/server";
import { migrateAll, getDb } from "./helpers";
import { createOwner, createSession, SESSION_COOKIE } from "@/domain/session";
import { hashPassword } from "@/domain/password";
import { setNowForTests } from "@/domain/clock";
import { setProvidersForTests } from "@/integrations";
import { ScriptedChatProvider } from "@/integrations/fake-model-provider";
import type { ChatMessage, RawCallResult } from "@/integrations/model-json";
import { POST } from "@/app/api/v2/intakes/route";
import { POST as answerRoute } from "@/app/api/v2/questions/[id]/answers/route";
import { runDueJobsOnce } from "@/worker/runner";
import { intakeResultById } from "@/workflows/results";
import { getQuestion, openQuestionsInConversation } from "@/repositories/questions";
import { INTAKE_JOB_TYPE } from "@/contracts/intake";
import { listItems } from "@/repositories/intakes";
import { GET as conversationRoute } from "@/app/api/v2/conversations/[id]/route";

// Real intake/worker/question persistence; scripted model only controls routing/decisions.
const NOW = new Date("2026-10-12T08:00:00+08:00");
type Context = Record<string, unknown>;
let token = "", csrf = "", conversationId = "", seq = 0;
let route: (c: Context) => unknown;
let decide: (c: Context) => unknown;
let provider: ScriptedChatProvider;
const context = (messages: ChatMessage[]) => (JSON.parse(String(messages[1]!.content)) as { context: Context }).context;
const final = (value: unknown): RawCallResult => ({ ok: true, text: JSON.stringify(value) });
const decisionItem = (text: string) => ({ itemKey: "goal", excerpt: text, outcome: { kind: "decide", objective: text, rationale: "先询问取舍" } });
const replan = { kind: "act", rationale: "按现有课程和预算重排今天", intents: [{ op: "replan", dateFrom: "2026-10-12", dateTo: "2026-10-12" }] };

function request(body: unknown) {
  return new NextRequest("http://localhost/api/v2/intakes", { method: "POST", headers: { cookie: `${SESSION_COOKIE}=${token}`, "x-csrf-token": csrf, "content-type": "application/json", "idempotency-key": `dialogue-${seq++}` }, body: JSON.stringify(body) });
}
async function drain() { for (let i = 0; i < 6; i++) await runDueJobsOnce(); }
async function say(text: string) {
  const res = await POST(request({ text, conversationId }));
  assert.equal(res.status, 202, JSON.stringify(await res.clone().json()));
  const body = await res.json() as { intakeId: string };
  await drain();
  return intakeResultById(body.intakeId)!;
}
async function answer(q: { id: string; version: number }, text: string) {
  const res = await answerRoute(request({ text, expectedVersion: q.version }), { params: Promise.resolve({ id: q.id }) });
  await drain();
  return res.status;
}
const routes = () => provider.exchanges.filter((e) => e.workflow === "agent_route").length;
const writes = () => (getDb().prepare("SELECT COUNT(*) n FROM agent_action_batches").get() as { n: number }).n;

before(() => {
  migrateAll();
  setNowForTests(NOW);
  createOwner(hashPassword("dialogue-test-pass"));
  const session = createSession(1);
  token = session.token;
  csrf = session.session.csrfToken;
  provider = new ScriptedChatProvider((req, messages) => {
    if (req.workflow === "agent_route") return final(route(context(messages)));
    if (req.workflow === "agent_decide") return final(decide(context(messages)));
    if (req.workflow === INTAKE_JOB_TYPE) return final({ items: [] });
    return { ok: false, code: "HTTP_ERROR", message: `unexpected workflow ${req.workflow}`, retryable: false };
  });
  setProvidersForTests({ model: { mode: "fixture", provider } });
});
beforeEach(() => {
  conversationId = crypto.randomUUID();
  const now = new Date().toISOString();
  getDb().prepare("INSERT INTO conversations (id,status,created_at,updated_at) VALUES (?, 'open', ?, ?)").run(conversationId, now, now);
  route = (c) => ({ items: [decisionItem(String(c.text))] });
  decide = (c) => (c.replies as unknown[]).length ? replan : { kind: "ask", question: `${String(c.text)}优先哪个？`, reason: "两种选择都合理", options: ["先做基础", "先做实践"] };
});
after(() => setNowForTests(null));

async function twoQuestions() {
  const a = await say("数学节奏");
  const b = await say("英语节奏");
  return { a: a.questions[0]!, b: b.questions[0]! };
}

test("定位问题本身也能自然语言回答：可以→在问哪一个→第二个，推进所选原目标，不再次定位", async () => {
  const { a, b } = await twoQuestions();
  const count = routes();
  const ambiguous = await say("可以");
  const locate = ambiguous.questions[0]!;
  assert.equal(locate.purpose, "locate");
  assert.deepEqual(locate.options.slice(0, 2), [b.prompt, a.prompt]);
  const selected = await say("第二个");
  assert.equal(selected.state, "answered", JSON.stringify(selected));
  assert.equal(getQuestion(locate.id)!.status, "answered", "回答了定位问题");
  assert.equal(getQuestion(a.id)!.status, "answered", "将原来的“可以”交给数学问题");
  assert.equal(getQuestion(b.id)!.status, "open", "英语问题没有被代答");
  assert.equal(routes(), count, "有明确待答定位问题不重复调用模型");
});

test("明确指向已作废的问题时不退回自动答另一个：模型读到后发生并发变化", async () => {
  const { a, b } = await twoQuestions();
  const batches = writes();
  route = () => {
    getDb().prepare("UPDATE clarification_questions SET status='superseded',version=version+1 WHERE id=?").run(a.id);
    return { items: [{ itemKey: "reply", excerpt: "数学那条先做基础", outcome: { kind: "reply", questionId: a.id } }] };
  };
  const result = await say("数学那条先做基础");
  assert.equal(result.state, "failed", JSON.stringify(result));
  assert.equal(getQuestion(b.id)!.status, "open", "不因只剩英语问题就把数学回答交给它");
  assert.equal(writes(), batches, "没有错误执行另一个目标");
});

test("定位后目标问题已在另一设备回答，收起旧定位并拒绝旧选择，不切换到其他问题", async () => {
  const { a, b } = await twoQuestions();
  const ambiguous = await say("可以");
  const locate = ambiguous.questions[0]!;
  assert.equal(await answer(a, "先做基础"), 202);
  const batches = writes();
  assert.equal(getQuestion(locate.id)!.status, "superseded");
  assert.equal(await answer(locate, "第二个"), 409);
  const result = intakeResultById(ambiguous.intakeId)!;
  assert.equal(result.state, "answered");
  assert.match(result.summary, /没有指明对象的回答已收起/);
  assert.equal(getQuestion(b.id)!.status, "open");
  assert.equal(writes(), batches);
});

test("自然语言答定位问题仍可明确选择“作为新的要求”，原来两个问题不被回答", async () => {
  const { a, b } = await twoQuestions();
  const ambiguous = await say("可以");
  const locate = ambiguous.questions[0]!;
  decide = () => replan;
  const selected = await say("作为新的要求");
  assert.equal(selected.state, "answered", JSON.stringify(selected));
  assert.equal(getQuestion(locate.id)!.status, "answered");
  assert.equal(getQuestion(a.id)!.status, "open");
  assert.equal(getQuestion(b.id)!.status, "open");
  assert.ok(["applied", "no_change"].includes(intakeResultById(ambiguous.intakeId)!.state));
});

test("多于十个旧问题时仍能看到并回答刚问的定位问题，不让历史积压挤掉最新对话", async () => {
  const pending: Array<{ id: string; prompt: string }> = [];
  for (let i = 0; i < 11; i++) {
    const result = await say(`学习项目${i + 1}`);
    pending.push(result.questions[0]!);
  }
  const open = openQuestionsInConversation(conversationId, null);
  assert.equal(open.length, 10, "仍有界，不把全部历史交给模型");
  assert.equal(open.at(-1)!.id, pending.at(-1)!.id, "最新的问题在上下文里");
  const ambiguous = await say("第一个");
  const locate = ambiguous.questions[0]!;
  assert.equal(locate.options[0], pending.at(-1)!.prompt);
  const selected = await say("第一个");
  assert.equal(selected.state, "answered", JSON.stringify(selected));
  assert.equal(getQuestion(locate.id)!.status, "answered");
  assert.equal(getQuestion(pending.at(-1)!.id)!.status, "answered");
  assert.ok(pending.slice(0, -1).every((q) => getQuestion(q.id)!.status === "open"));
});

test("有定位问题时仍可直接回答业务独有选项；无效序号保留定位问题，不执行", async () => {
  const a = await say("数学节奏");
  decide = (c) => (c.replies as unknown[]).length ? replan : { kind: "ask", question: "英语放在哪天？", reason: "要确定哪天", options: ["工作日", "周末"] };
  const b = await say("英语节奏");
  const ambiguous = await say("可以");
  const locate = ambiguous.questions[0]!;
  const count = writes();
  const invalid = await say("第四个");
  assert.equal(invalid.state, "failed");
  assert.equal(getQuestion(locate.id)!.status, "open");
  assert.equal(writes(), count);
  const direct = await say("周末");
  assert.equal(direct.state, "answered");
  assert.equal(getQuestion(b.questions[0]!.id)!.status, "answered");
  assert.equal(getQuestion(a.questions[0]!.id)!.status, "open");
  assert.equal(getQuestion(locate.id)!.status, "superseded", "明确答了候选问题后不留过时的定位卡");
  assert.equal(intakeResultById(ambiguous.intakeId)!.state, "answered");
  const next = await say("第一个");
  assert.equal(next.state, "answered", "下次短答直接答剩余问题，不陷在旧定位卡里");
  assert.equal(getQuestion(a.questions[0]!.id)!.status, "answered");
});

test("自然语言答复在写结果卡时中断：答案、原分支续办和定位收起应一起回滚；重试只答一次", async () => {
  const { a, b } = await twoQuestions();
  const ambiguous = await say("可以");
  const locate = ambiguous.questions[0]!;
  route = () => ({ items: [{ itemKey: "reply", excerpt: "数学那条先做基础", outcome: { kind: "reply", questionId: a.id } }] });
  const res = await POST(request({ text: "数学那条先做基础", conversationId }));
  assert.equal(res.status, 202);
  const { intakeId } = await res.json() as { intakeId: string };
  const answers = () => (getDb().prepare("SELECT COUNT(*) n FROM clarification_answers WHERE question_id=?").get(a.id) as { n: number }).n;
  getDb().exec(`CREATE TRIGGER dialogue_fail_reply BEFORE UPDATE ON intake_items
    WHEN NEW.intake_id='${intakeId}' AND NEW.state='applied'
    BEGIN SELECT RAISE(ABORT, 'test: reply card write interrupted'); END`);
  try {
    await assert.rejects(runDueJobsOnce(), /reply card write interrupted/);
    assert.equal(getQuestion(a.id)!.status, "open", "结果卡没有写成时，答案也不能单独提交");
    assert.equal(answers(), 0);
    assert.equal(getQuestion(locate.id)!.status, "open", "旧定位卡也不能半途收起");
    assert.equal(listItems(getQuestion(a.id)!.intakeId!)[0]!.state, "awaiting_input", "原分支仍待答，不半途续办");
  } finally {
    getDb().exec("DROP TRIGGER dialogue_fail_reply");
  }
  const calls = routes();
  getDb().prepare("UPDATE jobs SET lease_until='2000-01-01T00:00:00.000Z' WHERE type=? AND json_extract(payload_json,'$.intakeId')=? AND status='running'").run(INTAKE_JOB_TYPE, intakeId);
  await drain();
  assert.equal(intakeResultById(intakeId)!.state, "answered");
  assert.equal(answers(), 1);
  assert.equal(getQuestion(a.id)!.status, "answered");
  assert.equal(getQuestion(b.id)!.status, "open");
  assert.equal(getQuestion(locate.id)!.status, "superseded");
  assert.equal(routes(), calls, "恢复已经持久化的路由，不重复理解原话");
});

test("已回答或版本过期的问题先报失效，不先解析新文本或记入错误对话", async () => {
  const r = await say("数学节奏");
  const q = r.questions[0]!;
  assert.equal(await answer(q, "先做基础"), 202);
  const invalid = await answerRoute(request({ text: "", optionIndex: 20, expectedVersion: q.version }), { params: Promise.resolve({ id: q.id }) });
  assert.equal(invalid.status, 409, await invalid.text());
  const another = await say("英语节奏");
  const pending = another.questions[0]!;
  const turns = () => (getDb().prepare("SELECT COUNT(*) n FROM conversation_turns WHERE conversation_id=?").get(conversationId) as { n: number }).n;
  const count = turns();
  const stale = await answerRoute(request({ text: "先做实践", expectedVersion: pending.version + 1 }), { params: Promise.resolve({ id: pending.id }) });
  assert.equal(stale.status, 409);
  assert.equal(turns(), count, "版本失效的旧卡片回答不应成为有效会话内容");
  assert.equal(getQuestion(pending.id)!.status, "open");
});

test("聊天记录恢复卡片回答与续办结果，读对话不写新消息或新操作", async () => {
  const r = await say("数学节奏");
  assert.equal(await answer(r.questions[0]!, "先做基础"), 202);
  const db = getDb();
  const before = JSON.stringify([db.prepare("SELECT * FROM conversation_turns").all(), db.prepare("SELECT * FROM agent_action_batches").all()]);
  const res = await conversationRoute(new NextRequest("http://localhost/api/v2/conversations/current", { headers: { cookie: `${SESSION_COOKIE}=${token}` } }), { params: Promise.resolve({ id: conversationId }) });
  assert.equal(res.status, 200);
  const body = await res.json() as { turns: Array<{ role: string; text: string; replyTo: { intakeId: string } | null; replyResult: { intakeId: string; state: string } | null }> };
  const reply = body.turns.find((t) => t.role === "owner" && t.text === "先做基础");
  assert.equal(reply!.replyTo!.intakeId, r.intakeId);
  assert.equal(reply!.replyResult!.intakeId, r.intakeId);
  assert.ok(["applied", "no_change"].includes(reply!.replyResult!.state));
  assert.equal(JSON.stringify([db.prepare("SELECT * FROM conversation_turns").all(), db.prepare("SELECT * FROM agent_action_batches").all()]), before);
});

test("从卡片直接答清业务问题后收起旧定位，下一句不会再被过时定位卡截住", async () => {
  const { a, b } = await twoQuestions();
  const ambiguous = await say("可以");
  const locate = ambiguous.questions[0]!;
  assert.equal(await answer(a, "先做基础"), 202);
  assert.equal(getQuestion(locate.id)!.status, "superseded", "卡片回答也应收起针对同一业务问题的旧定位");
  assert.equal(intakeResultById(ambiguous.intakeId)!.state, "answered");
  const next = await say("第一个");
  assert.equal(next.state, "answered", JSON.stringify(next));
  assert.equal(getQuestion(b.id)!.status, "answered", "下一句答剩余问题，不能去答已经失效的数学问题");
  assert.equal((getDb().prepare("SELECT COUNT(*) n FROM clarification_answers WHERE question_id=?").get(a.id) as { n: number }).n, 1);
});

test("聊天栏携问题ID回答时，旧定位清理中断全部回滚；同键重试和重放只接受一次", async () => {
  const { a, b } = await twoQuestions();
  const ambiguous = await say("可以");
  const locate = ambiguous.questions[0]!;
  const body = { text: "/回答 先做基础", questionId: a.id, questionVersion: a.version };
  const key = `card-retry-${seq++}`;
  const req = () => new NextRequest("http://localhost/api/v2/intakes", { method: "POST", headers: { cookie: `${SESSION_COOKIE}=${token}`, "x-csrf-token": csrf, "content-type": "application/json", "idempotency-key": key }, body: JSON.stringify(body) });
  const db = getDb();
  const turns = () => (db.prepare("SELECT COUNT(*) n FROM conversation_turns WHERE conversation_id=?").get(conversationId) as { n: number }).n;
  const count = turns();
  const answers = () => (db.prepare("SELECT COUNT(*) n FROM clarification_answers WHERE question_id=?").get(a.id) as { n: number }).n;
  db.exec(`CREATE TRIGGER dialogue_fail_card_cleanup BEFORE UPDATE ON intake_items
    WHEN NEW.intake_id='${ambiguous.intakeId}' AND NEW.state='applied'
    BEGIN SELECT RAISE(ABORT, 'test: card locator cleanup interrupted'); END`);
  try {
    await assert.rejects(POST(req()), /card locator cleanup interrupted/);
    assert.equal(getQuestion(a.id)!.status, "open");
    assert.equal(getQuestion(locate.id)!.status, "open");
    assert.equal(answers(), 0);
    assert.equal(turns(), count);
  } finally { db.exec("DROP TRIGGER dialogue_fail_card_cleanup"); }
  const success = await POST(req());
  assert.equal(success.status, 202, await success.clone().text());
  assert.equal((await success.json() as { answered: boolean }).answered, true);
  await drain();
  const after = turns(), batches = writes();
  assert.equal(getQuestion(locate.id)!.status, "superseded");
  assert.equal(getQuestion(b.id)!.status, "open");
  assert.equal((await POST(req())).status, 202);
  assert.equal(answers(), 1);
  assert.equal(turns(), after);
  assert.equal(writes(), batches);
});
