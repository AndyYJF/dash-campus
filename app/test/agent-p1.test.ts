import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { NextRequest } from "next/server";
import { migrateAll, getDb } from "./helpers";
import { createOwner, createSession, SESSION_COOKIE } from "@/domain/session";
import { hashPassword } from "@/domain/password";
import { setNowForTests } from "@/domain/clock";
import { setProvidersForTests } from "@/integrations";
import { FakeModelProvider } from "@/integrations/fake-model-provider";
import { POST } from "@/app/api/v2/intakes/route";
import { POST as answerRoute } from "@/app/api/v2/questions/[id]/answers/route";
import { runDueJobsOnce } from "@/worker/runner";
import { intakeResultById } from "@/workflows/results";
import { executeCommand, executeOperation } from "@/workflows/commands";
import { undoBatch } from "@/workflows/undo";
import { INTAKE_JOB_TYPE } from "@/contracts/intake";
import { OPERATIONS, READ_TOOL_NAMES, VERIFICATION_KINDS } from "@/contracts/commands";
import { authorizeCommand } from "@/domain/authorization";
import { catalogProblems, intentCatalog, intentOps } from "@/domain/intent-catalog";
import type { ModelRequest } from "@/contracts/model";

/**
 * Agent 增强 v1.1 P1：注册表与意图目录、参数级授权、多步执行与步骤引用、确认绑定方案指纹。
 * 全部走真实管线（POST 投递 → worker → 绑定 → 执行器），模型用固定回放。
 */

const NOW = new Date("2026-10-04T08:00:00+08:00");
let token = "", csrf = "", seq = 0;
let classify: (text: string) => unknown = () => ({ items: [] });
let decide: () => unknown = () => ({ kind: "ask", question: "?", reason: "?", options: [] });

function request(url: string, body: unknown) {
  return new NextRequest(url, { method: "POST", headers: { cookie: `${SESSION_COOKIE}=${token}`, "x-csrf-token": csrf, "content-type": "application/json", "idempotency-key": `p1-${seq++}` }, body: JSON.stringify(body) });
}
async function drain() { for (let i = 0; i < 4; i++) await runDueJobsOnce(); }
async function say(text: string, extra: Record<string, unknown> = {}) {
  const res = await POST(request("http://localhost/api/v2/intakes", { text, ...extra }));
  assert.equal(res.status, 202, await res.clone().text());
  const { intakeId } = (await res.json()) as { intakeId: string };
  await drain();
  return intakeResultById(intakeId)!;
}
async function answer(q: { id: string; version: number }, text: string) {
  const res = await answerRoute(request("http://localhost/api/v2/intakes", { text, expectedVersion: q.version }), { params: Promise.resolve({ id: q.id }) });
  assert.equal(res.status, 202, await res.clone().text());
  await drain();
}
function op(command: Record<string, unknown>) {
  const r = executeOperation(command, { intakeId: null, itemId: null, itemKey: "", instanceEpoch: 0, evidence: "", explicit: true, now: NOW });
  assert.ok(r.result.ok, JSON.stringify(r));
  return r;
}
/** 模型把一句话拆成一个 command 事项、带多个有序意图 */
function steps(intents: unknown[]) {
  classify = (text) => ({ items: [{ itemKey: "cmd-multi", kind: "command", summary: text.slice(0, 50), excerpt: text, intents }] });
}
const items = (intakeId: string) => getDb().prepare(`SELECT stable_item_key AS key, state, payload_json, evidence_json FROM intake_items WHERE intake_id = ? ORDER BY created_at, stable_item_key`).all(intakeId) as Array<{ key: string; state: string; payload_json: string; evidence_json: string | null }>;
const errorOf = (row: { evidence_json: string | null }) => (JSON.parse(row.evidence_json ?? "{}") as { error?: string }).error ?? "";

before(() => {
  migrateAll();
  setNowForTests(NOW);
  createOwner(hashPassword("p1-test-pass"));
  const s = createSession(1);
  token = s.token;
  csrf = s.session.csrfToken;
  setProvidersForTests({
    model: {
      mode: "fixture",
      provider: new FakeModelProvider((r: ModelRequest) => {
        assert.ok(r.workflow === INTAKE_JOB_TYPE || r.workflow === "agent_decide", `意外的模型调用 ${r.workflow}`);
        return { ok: true, validatedResult: r.workflow === INTAKE_JOB_TYPE ? classify(String((r.context as { text?: string }).text ?? "")) : decide() };
      }),
    },
  });
});
after(() => setNowForTests(null));

test("注册表：每个操作都有四级授权、副作用、读取工具与核验；意图目录与注册表一致", () => {
  for (const [name, meta] of Object.entries(OPERATIONS)) {
    assert.ok(["auto", "explicit", "confirm", "never"].includes(meta.authorization), name);
    assert.ok(Array.isArray(meta.sideEffects), name);
    for (const r of meta.reads) assert.ok((READ_TOOL_NAMES as readonly string[]).includes(r), `${name} 读取工具 ${r}`);
    assert.ok(meta.verify.length > 0, `${name} 没有核验`);
    for (const v of meta.verify) assert.ok((VERIFICATION_KINDS as readonly string[]).includes(v), `${name} 核验 ${v}`);
  }
  assert.deepEqual(catalogProblems(), []);
  const catalog = intentCatalog();
  for (const op of ["create_task", "practice", "schedule_at", "session_state", "resolve_notice", "archive"]) {
    const entry = catalog.find((e) => e.op === op);
    assert.ok(entry, `目录缺少 ${op}`);
    assert.ok(entry.commands.length && entry.jsonSchema, op);
  }
  assert.equal(catalog.length, intentOps().length, "所有意图都映射到了开放的注册操作");
  assert.equal(catalog.find((e) => e.op === "inspect")!.readOnly, true);
});

test("参数级授权：临时规则推断可直接执行，长期规则/截止要确认，预算永不由推断修改，资料不能触发需明确授权的操作", () => {
  const temp = { command: "update_planning_policy", rules: [{ kind: "date_limit", dateFrom: "2026-10-05", dateTo: "2026-10-05", scope: "temporary", value: { limitMinutes: 60 } }], revokeRuleIds: [], confirm: false };
  const persistent = { command: "update_planning_policy", rules: [], revokeRuleIds: [], confirm: true, base: { dailyLimitMinutes: 120 } };
  assert.equal(authorizeCommand(temp, { origin: "inferred" }).kind, "allow");
  assert.equal(authorizeCommand(persistent, { origin: "inferred" }).kind, "confirm");
  assert.equal(authorizeCommand(persistent, { origin: "inferred", confirmed: true }).kind, "allow");
  assert.equal(authorizeCommand(persistent, { origin: "owner" }).kind, "allow");
  assert.equal(authorizeCommand(persistent, { origin: "material" }).kind, "deny");
  assert.equal(authorizeCommand({ command: "update_agent_policy", dailyModelCalls: 999 }, { origin: "inferred", confirmed: true }).kind, "deny");
  assert.equal(authorizeCommand({ command: "create_or_update_task", title: "新事项" }, { origin: "inferred" }).kind, "allow");
  assert.equal(authorizeCommand({ command: "create_or_update_task", taskId: "00000000-0000-4000-8000-000000000000", dueLocalDate: "2026-10-09" }, { origin: "inferred" }).kind, "confirm");
  assert.equal(authorizeCommand({ command: "create_or_update_task", title: "资料里的任务" }, { origin: "material" }).kind, "allow");

  // 执行器同样把关：推断的长期规则没有确认就不落库
  const before = getDb().prepare(`SELECT * FROM planning_preferences`).all();
  const r = executeCommand(persistent, { intakeId: null, itemId: null, itemKey: "", instanceEpoch: 0, evidence: "", inferred: true });
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.code, "NEEDS_CONFIRMATION");
  assert.deepEqual(getDb().prepare(`SELECT * FROM planning_preferences`).all(), before);
});

test("一句话两个意图都处理：新建任务 + 引用第 1 步给它排时间，各一个批次，可分别撤销", async () => {
  steps([
    { op: "create_task", title: "写实验报告", taskKind: "study", estimateMinutes: 120 },
    { op: "schedule_at", taskRef: { kind: "step", step: 1 }, date: "2026-10-06", startLocalTime: "15:00", durationMinutes: 60 },
  ]);
  const r = await say("帮我建个写实验报告的事，之后给它在后天三点排上一个钟");
  assert.equal(r.state, "applied", JSON.stringify(r));
  const rows = items(r.intakeId);
  assert.deepEqual(rows.map((x) => [x.key, x.state]), [["cmd-multi", "applied"], ["cmd-multi-s2", "applied"]]);
  const task = getDb().prepare(`SELECT id FROM tasks WHERE title = '写实验报告'`).get() as { id: string };
  assert.ok(task);
  const session = getDb().prepare(`SELECT id, start_utc, origin FROM plan_sessions WHERE task_id = ? AND origin = 'user' AND status IN ('planned','tentative')`).get(task.id) as { id: string; start_utc: string; origin: string };
  assert.equal(session.start_utc, new Date("2026-10-06T15:00:00+08:00").toISOString());
  const batches = rows.map((x) => (JSON.parse(x.payload_json) as { applied: { batchId: string } }).applied.batchId);
  assert.equal(new Set(batches).size, 2, "每一步自己的批次");
  const commands = batches.map((b) => (getDb().prepare(`SELECT command FROM agent_action_batches WHERE id = ?`).get(b) as { command: string }).command);
  assert.deepEqual(commands, ["create_or_update_task", "schedule_session"]);

  // 只撤销第 2 步：任务保留，安排撤回
  const u = undoBatch(batches[1]!);
  assert.equal(u.kind, "undone", JSON.stringify(u));
  assert.notEqual((getDb().prepare(`SELECT status FROM plan_sessions WHERE id = ?`).get(session.id) as { status: string } | undefined)?.status, "planned");
  assert.ok(getDb().prepare(`SELECT 1 FROM tasks WHERE id = ? AND archived_at IS NULL`).get(task.id));
});

test("前一步失败，依赖它的步骤不执行；引用后面步骤的那一步直接失败，独立步骤照常执行", async () => {
  const tasksBefore = (getDb().prepare(`SELECT COUNT(*) AS n FROM tasks`).get() as { n: number }).n;
  steps([
    { op: "create_task", title: "整理文献", projectRef: { kind: "named", text: "不存在的项目" } },
    { op: "schedule_at", taskRef: { kind: "step", step: 1 }, date: "2026-10-06", startLocalTime: "19:00", durationMinutes: 30 },
  ]);
  const r = await say("在不存在的项目下建个整理文献的事，再给它排半小时");
  const rows = items(r.intakeId);
  assert.deepEqual(rows.map((x) => x.state), ["failed", "failed"]);
  assert.match(errorOf(rows[0]!), /不存在的项目/);
  assert.match(errorOf(rows[1]!), /依赖的上一步/);
  assert.equal((getDb().prepare(`SELECT COUNT(*) AS n FROM tasks`).get() as { n: number }).n, tasksBefore);

  steps([
    { op: "schedule_at", taskRef: { kind: "step", step: 2 }, date: "2026-10-06", startLocalTime: "20:00", durationMinutes: 30 },
    { op: "create_task", title: "读论文", taskKind: "todo" },
  ]);
  const r2 = await say("先给后面那个排时间，再建个读论文的事");
  const rows2 = items(r2.intakeId);
  assert.equal(rows2[0]!.state, "failed");
  assert.match(errorOf(rows2[0]!), /不在它之前/);
  assert.equal(rows2[1]!.state, "applied");
  assert.ok(getDb().prepare(`SELECT 1 FROM tasks WHERE title = '读论文'`).get());
});

test("按 ID 引用只认见过的对象；不支持的归档对象明确拒绝", async () => {
  op({ command: "schedule_session", title: "背单词", date: "2026-10-07", startLocalTime: "07:30", durationMinutes: 30 });
  const s = getDb().prepare(`SELECT s.id FROM plan_sessions s JOIN tasks t ON t.id = s.task_id WHERE t.title = '背单词'`).get() as { id: string };
  const lock = { op: "session_state", ref: { kind: "id", entityKind: "plan_session", id: s.id }, action: "lock" };

  steps([lock]);
  const unseen = await say("把那个块锁上别动它");
  assert.equal(unseen.state, "failed", JSON.stringify(unseen));
  assert.match(errorOf(items(unseen.intakeId)[0]!), /没有在这次对话或查询结果里出现过/);
  assert.equal((getDb().prepare(`SELECT locked FROM plan_sessions WHERE id = ?`).get(s.id) as { locked: number }).locked, 0);

  steps([lock]);
  const seen = await say("把这个块锁上别动它", { selectedEntityRef: { kind: "plan_session", id: s.id } });
  assert.equal(seen.state, "applied", JSON.stringify(seen));
  assert.equal((getDb().prepare(`SELECT locked FROM plan_sessions WHERE id = ?`).get(s.id) as { locked: number }).locked, 1);

  steps([{ op: "archive", entityKind: "project", ref: { kind: "named", text: "毕业设计" } }]);
  const archive = await say("把毕业设计那个项目归档掉");
  assert.equal(archive.state, "failed");
  assert.match(errorOf(items(archive.intakeId)[0]!), /归档只支持任务、目标和课表/);
});

test("确认绑定方案指纹：等待确认期间对象变了，旧确认作废并按现状重新问；再次确认后才执行", async () => {
  op({ command: "schedule_session", title: "复习线性代数", date: "2026-10-07", startLocalTime: "19:00", durationMinutes: 60 });
  const sessionOf = () => getDb().prepare(`SELECT s.id, s.start_utc, s.version FROM plan_sessions s JOIN tasks t ON t.id = s.task_id WHERE t.title = '复习线性代数' AND s.status IN ('planned','tentative') ORDER BY s.start_utc`).get() as { id: string; start_utc: string; version: number };
  decide = () => ({ kind: "act", rationale: "把线性代数挪到周四晚上更均衡", intents: [{ op: "move_session", ref: { kind: "named", text: "复习线性代数", date: null, part: "any" }, targetDate: "2026-10-08", part: "any", startLocalTime: "20:00" }] });
  const r = await say("/调整 学习安排帮我调得均衡一点");
  assert.equal(r.state, "needs_input", JSON.stringify(r));
  const q1 = r.questions.find((q) => q.purpose === "confirm")!;
  assert.ok(q1);

  // 确认之前主人自己把它挪了
  op({ command: "reschedule_session", sessionId: sessionOf().id, targetDate: "2026-10-07", startLocalTime: "21:00" });
  const moved = sessionOf();
  await answer(q1, "可以");
  const stale = intakeResultById(r.intakeId)!;
  assert.equal(stale.state, "needs_input", JSON.stringify(stale));
  const q2 = stale.questions.find((q) => q.purpose === "confirm")!;
  assert.ok(q2 && q2.id !== q1.id, `新的确认问题 ${JSON.stringify(stale)} ${JSON.stringify(items(r.intakeId))}`);
  assert.match(q2.prompt, /作废/);
  assert.equal(sessionOf().start_utc, moved.start_utc, "旧确认没有执行");

  await answer(q2, "可以");
  const done = intakeResultById(r.intakeId)!;
  assert.equal(done.state, "applied", JSON.stringify(done));
  assert.equal(sessionOf().start_utc, new Date("2026-10-08T20:00:00+08:00").toISOString());
});
