import assert from "node:assert/strict";
import { before, test } from "node:test";
import { NextRequest } from "next/server";
import { migrateAll, getDb } from "./helpers";
import { createOwner, createSession, SESSION_COOKIE } from "@/domain/session";
import { hashPassword } from "@/domain/password";
import { setProvidersForTests } from "@/integrations";
import { FakeModelProvider } from "@/integrations/fake-model-provider";
import { runDueJobsOnce } from "@/worker/runner";
import { listItems } from "@/repositories/intakes";
import { listOpenQuestions } from "@/repositories/questions";
import { executeCommand } from "@/workflows/commands";
import { undoBatch } from "@/workflows/undo";
import { rebuildPlan } from "@/workflows/plan";
import { POST as createIntakeRoute } from "@/app/api/v2/intakes/route";
import { POST as answerRoute } from "@/app/api/v2/questions/[id]/answers/route";

/**
 * R2 U03/U04（E11、E14 的隔离行为）：真实 intake_process 管线 + 真实命令/重排。
 * 模型假件只做意图分类（task/practice），截止、时长、对象绑定、完成与取消块都走真实实现。
 */

const CTX = { intakeId: null, itemId: null, itemKey: "", instanceEpoch: 0, evidence: "" };
let sessionToken = "";
let csrfToken = "";
let seq = 0;

function authedReq(url: string, body: unknown): NextRequest {
  return new NextRequest(`http://localhost${url}`, {
    method: "POST",
    headers: { cookie: `${SESSION_COOKIE}=${sessionToken}`, "x-csrf-token": csrfToken, "content-type": "application/json", "idempotency-key": `r2-${seq++}` },
    body: JSON.stringify(body),
  });
}

async function submit(text: string): Promise<string> {
  const res = await createIntakeRoute(authedReq("/api/v2/intakes", { text }));
  assert.equal(res.status, 202);
  const { intakeId } = (await res.json()) as { intakeId: string };
  for (let i = 0; i < 3; i++) await runDueJobsOnce();
  return intakeId;
}

type TaskRow = { id: string; title: string; status: string; version: number; estimate_minutes: number | null; due_kind: string; due_local_date: string | null; due_at: string | null; completed_at: string | null };
const task = (id: string) => getDb().prepare(`SELECT * FROM tasks WHERE id = ?`).get(id) as TaskRow;
const taskByTitle = (like: string) => getDb().prepare(`SELECT * FROM tasks WHERE title LIKE ?`).all(`%${like}%`) as TaskRow[];
const plannedBlocks = (id: string) => (getDb().prepare(`SELECT COUNT(*) AS n FROM plan_sessions WHERE task_id = ? AND status IN ('planned','tentative')`).get(id) as { n: number }).n;

before(() => {
  migrateAll();
  createOwner(hashPassword("r2-test-pass"));
  const { token, session } = createSession(1);
  sessionToken = token;
  csrfToken = session.csrfToken;
  setProvidersForTests({
    model: {
      mode: "fixture",
      provider: new FakeModelProvider((req) => {
        const text = (req.context as { text: string }).text.trim();
        const kind = /学了|跑|打了/.test(text) ? "practice" : "task";
        return { ok: true, validatedResult: { items: [{ itemKey: "item-1", kind, summary: text.slice(0, 30), excerpt: text.slice(0, 100) }] } };
      }),
    },
  });
});

test("E11：「2099-10-05 10:00前交报告，预计30分钟」保存为具体截止时刻，安排不晚于截止", async () => {
  await submit("2099-10-05 10:00前交线代报告，预计30分钟");
  const [t] = taskByTitle("线代报告");
  assert.ok(t);
  assert.equal(t.due_kind, "instant");
  assert.equal(t.due_at, "2099-10-05T02:00:00.000Z", "当地 10:00 = UTC 02:00");
  assert.equal(t.estimate_minutes, 30);
  rebuildPlan(new Date("2099-10-04T12:00:00.000Z"));
  const blocks = getDb().prepare(`SELECT end_utc FROM plan_sessions WHERE task_id = ? AND status = 'planned'`).all(t.id) as Array<{ end_utc: string }>;
  assert.ok(blocks.length >= 1);
  for (const b of blocks) assert.ok(b.end_utc <= "2099-10-05T02:00:00.000Z");
});

test("U03：带 taskId 的 create_or_update_task 修改原任务，不新增副本，可撤销", () => {
  const created = executeCommand({ command: "create_or_update_task", title: "概率论作业", estimateMinutes: 60 }, CTX);
  assert.ok(created.ok);
  const [t] = taskByTitle("概率论作业");
  const count = (getDb().prepare(`SELECT COUNT(*) AS n FROM tasks`).get() as { n: number }).n;
  const r = executeCommand({ command: "create_or_update_task", taskId: t!.id, estimateMinutes: 90, dueLocalDate: "2099-11-01", dueLocalTime: "18:00" }, CTX);
  assert.ok(r.ok, r.ok ? "" : r.error);
  assert.equal((getDb().prepare(`SELECT COUNT(*) AS n FROM tasks`).get() as { n: number }).n, count, "不新增任务");
  const after = task(t!.id);
  assert.equal(after.title, "概率论作业", "没给的字段保持不变");
  assert.equal(after.estimate_minutes, 90);
  assert.equal(after.due_kind, "instant");
  assert.equal(after.version, t!.version + 1);
  assert.deepEqual(undoBatch(r.batchId), { kind: "undone" });
  const undone = task(t!.id);
  assert.equal(undone.estimate_minutes, 60);
  assert.equal(undone.due_kind, "none");
  assert.equal(executeCommand({ command: "create_or_update_task", estimateMinutes: 30 }, CTX).ok, false, "新建必须有标题");
});

test("U03：「做完了」完成原任务、取消未执行块、记下投入；撤销恢复", async () => {
  executeCommand({ command: "create_or_update_task", title: "操作系统实验报告", estimateMinutes: 120 }, CTX);
  const [t] = taskByTitle("操作系统实验报告");
  rebuildPlan(new Date());
  assert.ok(plannedBlocks(t!.id) > 0, "先有学习块");
  const before1 = (getDb().prepare(`SELECT COUNT(*) AS n FROM tasks`).get() as { n: number }).n;

  const intakeId = await submit("操作系统实验报告做完了，花了40分钟");
  const item = listItems(intakeId)[0]!;
  assert.equal(item.state, "applied");
  const done = task(t!.id);
  assert.equal(done.status, "done", "原任务被完成，而不是只记一条实践");
  assert.ok(done.completed_at);
  assert.equal(plannedBlocks(t!.id), 0, "未执行学习块取消");
  assert.equal((getDb().prepare(`SELECT COUNT(*) AS n FROM tasks`).get() as { n: number }).n, before1, "不新建同名任务");
  const practice = getDb().prepare(`SELECT actual_minutes FROM practice_entries WHERE task_id = ?`).all(t!.id) as Array<{ actual_minutes: number }>;
  assert.deepEqual(practice.map((p) => p.actual_minutes), [40]);

  const batchId = (item.payload.applied as { batchId: string }).batchId;
  assert.deepEqual(undoBatch(batchId), { kind: "undone" });
  assert.equal(task(t!.id).status, "todo");
  assert.equal(task(t!.id).completed_at, null);
  assert.ok(plannedBlocks(t!.id) > 0, "撤销后学习块恢复");
});

test("E14：两个同名对象 → 只问选哪一个；回答后完成目标任务，另一个不动", async () => {
  executeCommand({ command: "create_or_update_task", title: "英语读书报告", estimateMinutes: 60 }, CTX);
  executeCommand({ command: "create_or_update_task", title: "马原读书报告", estimateMinutes: 60 }, CTX);
  const intakeId = await submit("读书报告写完了");
  const item = listItems(intakeId)[0]!;
  assert.equal(item.state, "awaiting_input", "有歧义不猜");
  const q = listOpenQuestions().find((x) => x.id === item.waitingQuestionId)!;
  assert.match(q.prompt, /英语读书报告/);
  assert.match(q.prompt, /马原读书报告/);
  assert.equal(taskByTitle("读书报告").filter((x) => x.status === "done").length, 0);

  const res = await answerRoute(authedReq(`/api/v2/questions/${q.id}/answers`, { text: "马原的", expectedVersion: q.version }), { params: Promise.resolve({ id: q.id }) });
  assert.equal(res.status, 202);
  for (let i = 0; i < 3; i++) await runDueJobsOnce();
  assert.equal(listItems(intakeId)[0]!.state, "applied");
  assert.equal(taskByTitle("马原读书报告")[0]!.status, "done");
  assert.equal(taskByTitle("英语读书报告")[0]!.status, "todo");
});

test("E12/E05：「学了一个半小时」记 90 分钟并关联任务；运动记为非学习", async () => {
  executeCommand({ command: "create_or_update_task", title: "数据结构复习", estimateMinutes: 180 }, CTX);
  const [t] = taskByTitle("数据结构复习");
  await submit("数据结构复习学了一个半小时");
  const linked = getDb().prepare(`SELECT actual_minutes, category FROM practice_entries WHERE task_id = ?`).all(t!.id);
  assert.deepEqual(linked, [{ actual_minutes: 90, category: "study" }]);
  assert.equal(task(t!.id).status, "todo", "投入不等于完成");
  await submit("打了38分钟羽毛球");
  const sport = getDb().prepare(`SELECT actual_minutes, category, task_id FROM practice_entries WHERE note LIKE '%羽毛球%'`).all();
  assert.deepEqual(sport, [{ actual_minutes: 38, category: "other", task_id: null }]);
});
