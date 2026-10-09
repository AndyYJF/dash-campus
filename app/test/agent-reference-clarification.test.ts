import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { NextRequest } from "next/server";
import { migrateAll, getDb } from "./helpers";
import { bindIntents, type BindEnv } from "@/workflows/agent";
import { executeOperation } from "@/workflows/commands";
import { setNowForTests } from "@/domain/clock";
import { createOwner, createSession, SESSION_COOKIE } from "@/domain/session";
import { hashPassword } from "@/domain/password";
import { setProvidersForTests } from "@/integrations";
import { ScriptedChatProvider } from "@/integrations/fake-model-provider";
import { POST } from "@/app/api/v2/intakes/route";
import { POST as answerRoute } from "@/app/api/v2/questions/[id]/answers/route";
import { intakeResultById } from "@/workflows/results";
import { runDueJobsOnce } from "@/worker/runner";
import type { Intent } from "@/domain/intent";

const NOW = new Date("2026-10-12T09:00:00+08:00");
let first = "", second = "", english = "", token = "", csrf = "";
const env = (extra: Partial<BindEnv> = {}): BindEnv => ({ intakeId: "reference-test", itemId: "one", conversationId: null, referenceDate: "2026-10-12", now: NOW, tz: "Asia/Shanghai", selected: null, answer: () => null, ...extra });
const shorten = (text: string, date: string | null = "2026-10-12"): Intent => ({ op: "shorten_session", ref: { kind: "named", text, date, part: "any" }, durationMinutes: 60 });
const facts = () => JSON.stringify(getDb().prepare("SELECT id,start_utc,end_utc,status,version FROM plan_sessions ORDER BY id").all());
before(() => {
  migrateAll(); setNowForTests(NOW); createOwner(hashPassword("isolated-reference-test"));
  const s = createSession(1); token = s.token; csrf = s.session.csrfToken;
  for (const [title, date, startLocalTime, durationMinutes] of [["微积分复习", "2026-10-12", "10:00", 30], ["微积分复习", "2026-10-12", "14:00", 90], ["英语阅读", "2026-10-13", "10:00", 60]] as const) {
    const taskId = startLocalTime === "14:00" ? (getDb().prepare("SELECT id FROM tasks WHERE title=?").get(title) as { id: string }).id : undefined;
    const r = executeOperation({ command: "schedule_session", title, taskId, date, startLocalTime, durationMinutes }, { intakeId: null, itemId: null, itemKey: "", instanceEpoch: 0, evidence: "", explicit: true, now: NOW });
    assert.ok(r.result.ok, JSON.stringify(r));
  }
  const rows = getDb().prepare("SELECT id FROM plan_sessions ORDER BY start_utc").all() as Array<{ id: string }>;
  [first, second, english] = rows.map((r) => r.id);
});
after(() => { setNowForTests(null); setProvidersForTests({ model: null, search: null }); });

test("名称没匹配上也能列出限定日的真实安排，选择后继续原操作，不猜数学等于微积分", () => {
  const before = facts(), intent = shorten("数学");
  const result = bindIntents([intent], env());
  assert.equal(result.kind, "ask", JSON.stringify(result));
  if (result.kind !== "ask") return;
  assert.equal(result.question.purpose, "entity_ref");
  assert.match(result.question.prompt, /没有找到|没找到|未匹配/);
  assert.match(result.question.options.join(" "), /10:00.*14:00/);
  assert.doesNotMatch(result.question.options.join(" "), /英语/);
  assert.equal(facts(), before);
  const continued = bindIntents([intent], env({ answer: () => ({ ref: { kind: "plan_session", id: second } }) }));
  assert.equal(continued.kind, "run", JSON.stringify(continued));
  if (continued.kind === "run") { assert.equal(continued.command.sessionId, second); assert.equal(continued.command.durationMinutes, 60); }
});

test("同一任务同一天两段安排必须询问哪一段，不能默认取第一段", () => {
  const result = bindIntents([shorten("微积分复习")], env());
  assert.equal(result.kind, "ask", JSON.stringify(result));
  if (result.kind === "ask") assert.equal(result.question.options.length, 2);
});

test("没有最近对象的‘刚排的那个’列候选追问；显式卡片指向同一任务多段时也不选第一段", () => {
  const intent: Intent = { op: "move_session", ref: { kind: "recent" }, targetDate: "2026-10-18", part: "morning", startLocalTime: null };
  const missing = bindIntents([intent], env());
  assert.equal(missing.kind, "ask", JSON.stringify(missing));
  const taskId = (getDb().prepare("SELECT task_id FROM plan_sessions WHERE id=?").get(first) as { task_id: string }).task_id;
  const task = bindIntents([intent], env({ selected: { kind: "task", id: taskId } }));
  assert.equal(task.kind, "ask", JSON.stringify(task));
  if (task.kind === "ask") assert.equal(task.question.options.length, 2);
});

test("限定日期不向其他日扩散；范围内只有一段但名称不匹配仍先问，不自动认领", () => {
  const result = bindIntents([shorten("微积分复习", "2026-10-13")], env());
  assert.equal(result.kind, "ask", JSON.stringify(result));
  if (result.kind === "ask") { assert.equal(result.question.options.length, 1); assert.match(result.question.options[0]!, /英语/); }
  const empty = bindIntents([shorten("微积分复习", "2026-10-14")], env());
  assert.equal(empty.kind, "fail", JSON.stringify(empty));
});

test("未见ID、过时已选对象保持拒绝；不借候选恢复越权或换成另一段", () => {
  const unknown: Intent = { op: "shorten_session", ref: { kind: "id", entityKind: "plan_session", id: english }, durationMinutes: 60 };
  assert.equal(bindIntents([unknown], env()).kind, "fail");
  const before = facts();
  getDb().prepare("UPDATE plan_sessions SET status='superseded' WHERE id=?").run(second);
  const stale = bindIntents([shorten("数学")], env({ answer: () => ({ ref: { kind: "plan_session", id: second } }) }));
  assert.equal(stale.kind, "fail", JSON.stringify(stale));
  getDb().prepare("UPDATE plan_sessions SET status='planned' WHERE id=?").run(second);
  assert.equal(facts(), before);
});

test("真实HTTP/worker：未匹配→选择第二段→原缩短意图续办；第一段和其他日期不变", async () => {
  setProvidersForTests({ model: { mode: "fixture", provider: new ScriptedChatProvider((request) => request.workflow === "agent_route" ? { ok: true, text: JSON.stringify({ items: [{ itemKey: "shorten", excerpt: "今天的数学别排那么长，一小时就够", outcome: { kind: "act", intents: [shorten("数学")], rationale: "按原话缩短今天某段数学学习" } }] }) } : { ok: false, code: "HTTP_ERROR", message: "unexpected workflow", retryable: false }) } });
  const make = (url: string, body: unknown, key: string) => new NextRequest(url, { method: "POST", headers: { cookie: `${SESSION_COOKIE}=${token}`, "x-csrf-token": csrf, "content-type": "application/json", "idempotency-key": key }, body: JSON.stringify(body) });
  const posted = await POST(make("http://localhost/api/v2/intakes", { text: "今天的数学别排那么长，一小时就够" }, "reference-http-create"));
  assert.equal(posted.status, 202);
  const id = ((await posted.json()) as { intakeId: string }).intakeId;
  for (let n = 0; n < 4; n++) await runDueJobsOnce();
  const pending = intakeResultById(id)!;
  assert.equal(pending.state, "needs_input", JSON.stringify(pending));
  const q = pending.questions.find((q) => q.purpose === "entity_ref")!;
  assert.ok(q, JSON.stringify(pending));
  const unchanged = getDb().prepare("SELECT id,start_utc,end_utc,status,version FROM plan_sessions WHERE id IN (?,?) ORDER BY id").all(first, english);
  const answered = await answerRoute(make("http://localhost/api/v2/questions", { text: "第二个", expectedVersion: q.version }, "reference-http-answer"), { params: Promise.resolve({ id: q.id }) });
  assert.equal(answered.status, 202, JSON.stringify(await answered.json()));
  for (let n = 0; n < 4; n++) await runDueJobsOnce();
  const resumed = intakeResultById(id)!;
  assert.equal(resumed.state, "needs_input", JSON.stringify(resumed));
  const confirm = resumed.questions.find((q) => q.purpose === "confirm")!;
  assert.ok(confirm, "对象选择后仍保留具体修改的确认，不绕过授权门");
  assert.deepEqual(getDb().prepare("SELECT id,start_utc,end_utc,status,version FROM plan_sessions WHERE id IN (?,?) ORDER BY id").all(first, english), unchanged);
  const approved = await answerRoute(make("http://localhost/api/v2/questions", { text: "可以", expectedVersion: confirm.version }, "reference-http-confirm"), { params: Promise.resolve({ id: confirm.id }) });
  assert.equal(approved.status, 202);
  for (let n = 0; n < 4; n++) await runDueJobsOnce();
  assert.equal(intakeResultById(id)!.state, "applied", JSON.stringify(intakeResultById(id)));
  const row = getDb().prepare("SELECT start_utc,end_utc FROM plan_sessions WHERE id=?").get(second) as { start_utc: string; end_utc: string };
  assert.equal(Date.parse(row.end_utc) - Date.parse(row.start_utc), 60 * 60000);
  assert.deepEqual(getDb().prepare("SELECT id,start_utc,end_utc,status,version FROM plan_sessions WHERE id IN (?,?) ORDER BY id").all(first, english), unchanged);
});
