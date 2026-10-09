import assert from "node:assert/strict";
import { after, before, test } from "node:test";
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
const env = (extra: Partial<BindEnv> = {}): BindEnv => ({ intakeId: "missing-target-test", itemId: "one", conversationId: null, referenceDate: "2026-10-12", now: NOW, tz: "Asia/Shanghai", selected: null, answer: () => null, ...extra });
const named = (text: string) => ({ kind: "named" as const, text, date: null, part: "any" as const });
const archive = (ref: Extract<Intent, { op: "archive" }> ["ref"]): Intent => ({ op: "archive", entityKind: "task", ref });
const createInProject: Intent = { op: "create_task", title: "整理文献", estimateMinutes: 30, dueLocalDate: null, dueLocalTime: null, priority: "normal", projectRef: named("科研项目") };
const taskIds: string[] = [];
const projectId = "1f761c56-a583-4390-86ef-dde27f664f70", otherProjectId = "a9797ff6-e584-490e-b251-369b458c6ed4";
let token = "", csrf = "", sequence = 0;
const business = () => JSON.stringify([getDb().prepare("SELECT * FROM tasks ORDER BY id").all(), getDb().prepare("SELECT * FROM projects ORDER BY id").all(), getDb().prepare("SELECT * FROM plan_sessions ORDER BY id").all()]);

before(() => {
  migrateAll(); setNowForTests(NOW); createOwner(hashPassword("isolated-missing-target-test"));
  const session = createSession(1); token = session.token; csrf = session.session.csrfToken;
  for (let n = 0; n < 10; n++) {
    const title = n === 0 ? "院士报告报名" : n === 1 ? "微积分作业" : `独立待办${n}`;
    const result = executeOperation({ command: "create_or_update_task", title }, { intakeId: null, itemId: null, itemKey: "", instanceEpoch: 0, evidence: "", explicit: true, now: NOW });
    assert.ok(result.result.ok, JSON.stringify(result));
    taskIds.push((getDb().prepare("SELECT id FROM tasks WHERE title=?").get(title) as { id: string }).id);
  }
  for (const [id, title] of [[projectId, "论文复现实验"], [otherProjectId, "工程小工具"]]) {
    getDb().prepare("INSERT INTO projects (id,title,status,created_at,updated_at) VALUES (?,?,'active',?,?)").run(id, title, NOW.toISOString(), NOW.toISOString());
  }
});
after(() => { setNowForTests(null); setProvidersForTests({ model: null, search: null }); });

test("任务名称没有对应对象时列真实候选，不凭‘讲座’猜中报告，也不自动创建", () => {
  const before = business();
  const result = bindIntents([archive(named("讲座通知"))], env());
  assert.equal(result.kind, "ask", JSON.stringify(result));
  if (result.kind !== "ask") return;
  assert.equal(result.question.purpose, "entity_ref");
  assert.equal(result.question.options.length, 8, "候选数有界");
  assert.match(result.question.prompt, /没有找到.*讲座通知/);
  const candidates = result.question.context?.candidates as Array<{ kind: string; id: string; label: string }>;
  assert.ok(candidates.every((c) => c.kind === "task" && taskIds.includes(c.id)));
  assert.equal(business(), before, "追问前不改业务数据");
  const continued = bindIntents([archive(named("讲座通知"))], env({ answer: () => ({ ref: { kind: "task", id: candidates[0]!.id } }) }));
  assert.equal(continued.kind, "run", JSON.stringify(continued));
  if (continued.kind === "run") { assert.equal(continued.command.command, "archive_entity"); assert.equal(continued.command.entityId, candidates[0]!.id); }
});

test("没有最近任务时追问实际任务；未知显式 ID 仍拒绝，不能换一个候选来执行", () => {
  assert.equal(bindIntents([archive({ kind: "recent" })], env()).kind, "ask");
  assert.equal(bindIntents([archive({ kind: "id", entityKind: "task", id: taskIds[0]! })], env()).kind, "fail");
  const result = bindIntents([archive({ kind: "id", entityKind: "task", id: "nonexistent" })], env({ seen: [{ kind: "task", id: "nonexistent" }] }));
  assert.equal(result.kind, "fail", JSON.stringify(result));
});

test("等回答期间任务已归档，旧选择不能落到别的任务", () => {
  const before = business();
  getDb().prepare("UPDATE tasks SET archived_at=? WHERE id=?").run(NOW.toISOString(), taskIds[0]);
  const result = bindIntents([archive(named("讲座通知"))], env({ answer: () => ({ ref: { kind: "task", id: taskIds[0] } }) }));
  assert.equal(result.kind, "fail", JSON.stringify(result));
  getDb().prepare("UPDATE tasks SET archived_at=NULL WHERE id=?").run(taskIds[0]);
  assert.equal(business(), before);
});

test("项目未匹配时追问同类真实对象，单个候选也不默认认领；显式失效 ID 不恢复", () => {
  const before = business();
  getDb().prepare("UPDATE projects SET status='completed' WHERE id=?").run(otherProjectId);
  const result = bindIntents([createInProject], env());
  assert.equal(result.kind, "ask", JSON.stringify(result));
  if (result.kind === "ask") { assert.deepEqual(result.question.options, ["论文复现实验"]); assert.equal(result.question.fieldPath, "project.ref"); }
  const continued = bindIntents([createInProject], env({ answer: () => ({ ref: { kind: "project", id: projectId } }) }));
  assert.equal(continued.kind, "run", JSON.stringify(continued));
  if (continued.kind === "run") assert.equal(continued.command.projectId, projectId);
  assert.equal(bindIntents([{ ...createInProject, projectRef: { kind: "recent" } }], env()).kind, "ask");
  assert.equal(bindIntents([{ ...createInProject, projectRef: { kind: "id", entityKind: "project", id: projectId } }], env()).kind, "fail");
  getDb().prepare("UPDATE projects SET status='completed' WHERE id=?").run(projectId);
  assert.equal(bindIntents([createInProject], env({ answer: () => ({ ref: { kind: "project", id: projectId } }) })).kind, "fail");
  getDb().prepare("UPDATE projects SET status='active' WHERE id IN (?,?)").run(projectId, otherProjectId);
  assert.equal(business(), before);
});

test("同一操作先问任务、再问项目：两次对象选择独立保存，不把任务的回答当成项目", () => {
  const intent: Intent = { op: "practice", occurredOn: "2026-10-12", actualMinutes: 30, note: "整理文献", category: "study", blocker: "", taskRef: named("数学练习"), projectRef: named("科研项目") };
  const answers = new Map<string, Record<string, unknown>>();
  const selectedEnv = () => env({ answer: (key) => answers.get(key) ?? null });
  const first = bindIntents([intent], selectedEnv());
  assert.equal(first.kind, "ask", JSON.stringify(first));
  if (first.kind !== "ask") return;
  answers.set(first.question.key, { ref: { kind: "task", id: taskIds[1] } });
  const second = bindIntents([intent], selectedEnv());
  assert.equal(second.kind, "ask", JSON.stringify(second));
  if (second.kind !== "ask") return;
  assert.equal(second.question.fieldPath, "project.ref");
  assert.notEqual(first.question.key, second.question.key);
  answers.set(second.question.key, { ref: { kind: "project", id: projectId } });
  const final = bindIntents([intent], selectedEnv());
  assert.equal(final.kind, "run", JSON.stringify(final));
  if (final.kind === "run") { assert.equal(final.command.taskId, taskIds[1]); assert.equal(final.command.projectId, projectId); }
});

test("升级前待答对象选择兼容旧键；错误类型的回答不执行，即使 ID 相同", () => {
  const intent = archive(named("讲座通知"));
  const oldAnswer = env({ answer: (key) => key === "entity_ref:one" ? { ref: { kind: "task", id: taskIds[0] } } : null });
  const result = bindIntents([intent], oldAnswer);
  assert.equal(result.kind, "run", JSON.stringify(result));
  if (result.kind === "run") assert.equal(result.command.entityId, taskIds[0]);
  const wrongKind = bindIntents([intent], env({ answer: () => ({ ref: { kind: "project", id: taskIds[0] } }) }));
  assert.equal(wrongKind.kind, "ask", JSON.stringify(wrongKind));
});

function request(body: unknown) {
  return new NextRequest("http://localhost/api/v2/intakes", { method: "POST", headers: { cookie: `${SESSION_COOKIE}=${token}`, "x-csrf-token": csrf, "content-type": "application/json", "idempotency-key": `missing-target-${sequence++}` }, body: JSON.stringify(body) });
}
async function drain() { for (let n = 0; n < 5; n++) await runDueJobsOnce(); }
async function say(text: string) {
  const response = await POST(request({ text }));
  assert.equal(response.status, 202, await response.clone().text());
  const { intakeId } = await response.json() as { intakeId: string };
  await drain(); return intakeResultById(intakeId)!;
}
async function answer(q: { id: string; version: number }, text: string) {
  const response = await answerRoute(request({ text, expectedVersion: q.version }), { params: Promise.resolve({ id: q.id }) });
  assert.equal(response.status, 202, await response.clone().text()); await drain();
}
function route(intents: Intent[], excerpt: string) {
  setProvidersForTests({ model: { mode: "fixture", provider: new ScriptedChatProvider((r) => r.workflow === "agent_route" ? { ok: true, text: JSON.stringify({ items: [{ itemKey: "missing-target", excerpt, outcome: { kind: "act", intents, rationale: "保留原操作，具体对象由主人选择" } }] }) } : { ok: false, code: "HTTP_ERROR", message: "unexpected workflow", retryable: false }) } });
}

test("HTTP/worker：未匹配→名称回答→具体归档确认→仅选中任务归档，并保留其他任务", async () => {
  const untouched = getDb().prepare("SELECT * FROM tasks WHERE id != ? ORDER BY id").all(taskIds[0]);
  route([archive(named("讲座通知"))], "把那个讲座通知归档");
  const pending = await say("把那个讲座通知归档");
  assert.equal(pending.state, "needs_input", JSON.stringify(pending));
  const choose = pending.questions.find((q) => q.purpose === "entity_ref")!;
  assert.ok(choose, JSON.stringify(pending));
  await answer(choose, "院士报告报名");
  const resumed = intakeResultById(pending.intakeId)!;
  const confirm = resumed.questions.find((q) => q.purpose === "confirm")!;
  assert.ok(confirm, JSON.stringify(resumed));
  assert.match(confirm.prompt, /院士报告报名/);
  assert.equal((getDb().prepare("SELECT archived_at FROM tasks WHERE id=?").get(taskIds[0]) as { archived_at: string | null }).archived_at, null);
  await answer(confirm, "可以");
  const final = intakeResultById(pending.intakeId)!;
  assert.equal(final.state, "applied", JSON.stringify(final));
  assert.ok((getDb().prepare("SELECT archived_at FROM tasks WHERE id=?").get(taskIds[0]) as { archived_at: string | null }).archived_at);
  assert.deepEqual(getDb().prepare("SELECT * FROM tasks WHERE id != ? ORDER BY id").all(taskIds[0]), untouched);
});

test("多步：项目未匹配先追问，依赖创建结果的排程等待；选项目后续办原两步", async () => {
  const intents: Intent[] = [createInProject, { op: "schedule_at", title: null, taskRef: { kind: "step", step: 1 }, date: "2026-10-13", startLocalTime: "14:00", durationMinutes: 30 }];
  const excerpt = "科研项目下建一个整理文献的任务，明天下午两点做半小时";
  route(intents, excerpt);
  const count = (getDb().prepare("SELECT COUNT(*) AS n FROM tasks").get() as { n: number }).n;
  const pending = await say(excerpt);
  assert.equal(pending.state, "needs_input", JSON.stringify(pending));
  assert.equal((getDb().prepare("SELECT COUNT(*) AS n FROM tasks").get() as { n: number }).n, count);
  const rows = getDb().prepare("SELECT state FROM intake_items WHERE intake_id=? AND stable_item_key LIKE '%step%' ORDER BY stable_item_key").all(pending.intakeId) as Array<{ state: string }>;
  assert.ok(rows.every((r) => r.state !== "failed"), JSON.stringify(rows));
  const choose = pending.questions.find((q) => q.purpose === "entity_ref")!;
  assert.ok(choose, JSON.stringify(pending)); await answer(choose, "论文复现实验");
  let final = intakeResultById(pending.intakeId)!;
  for (let n = 0; n < 3 && final.state === "needs_input"; n++) {
    const confirm = final.questions.find((q) => q.purpose === "confirm")!;
    assert.ok(confirm, JSON.stringify(final)); await answer(confirm, "可以"); final = intakeResultById(pending.intakeId)!;
  }
  assert.equal(final.state, "applied", JSON.stringify(final));
  const created = getDb().prepare("SELECT id,project_id FROM tasks WHERE title='整理文献'").all() as Array<{ id: string; project_id: string }>;
  assert.equal(created.length, 1); assert.equal(created[0]!.project_id, projectId);
  const sessions = getDb().prepare("SELECT task_id,start_utc,end_utc FROM plan_sessions WHERE task_id=? AND status='planned'").all(created[0]!.id) as Array<{ task_id: string; start_utc: string; end_utc: string }>;
  assert.equal(sessions.length, 1); assert.equal(sessions[0]!.start_utc, "2026-10-13T06:00:00.000Z");
  assert.equal(Date.parse(sessions[0]!.end_utc) - Date.parse(sessions[0]!.start_utc), 30 * 60000);
});
