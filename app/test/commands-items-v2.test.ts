import assert from "node:assert/strict";
import { before, test } from "node:test";
import { NextRequest } from "next/server";
import { migrateAll, getDb } from "./helpers";
import { createOwner, createSession, SESSION_COOKIE } from "@/domain/session";
import { hashPassword } from "@/domain/password";
import { setProvidersForTests } from "@/integrations";
import { FakeModelProvider } from "@/integrations/fake-model-provider";
import { runDueJobsOnce } from "@/worker/runner";
import { getIntake, listItems } from "@/repositories/intakes";
import { POST as createIntakeRoute } from "@/app/api/v2/intakes/route";
import { POST as cancelRoute } from "@/app/api/v2/intakes/[id]/cancel/route";
import { POST as undoRoute } from "@/app/api/v2/actions/[batchId]/undo/route";

/**
 * Agent-first V2 P2 行为测试（事项落领域 + 版本冲突 + 取消）：
 * practice/task 经白名单命令落领域记录；后续实体版本冲突不被强行覆盖；取消保留已应用结果。
 */

let sessionToken = "";
let csrfToken = "";

function authedReq(url: string, method: string, body: unknown, key?: string): NextRequest {
  return new NextRequest(`http://localhost${url}`, {
    method,
    headers: {
      cookie: `${SESSION_COOKIE}=${sessionToken}`,
      "x-csrf-token": csrfToken,
      "content-type": "application/json",
      ...(key ? { "idempotency-key": key } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

async function submitIntake(text: string, key: string): Promise<string> {
  const res = await createIntakeRoute(authedReq("/api/v2/intakes", "POST", { text }, key));
  assert.equal(res.status, 202);
  return ((await res.json()) as { intakeId: string }).intakeId;
}

before(() => {
  migrateAll();
  createOwner(hashPassword("items-test-pass"));
  const { token, session } = createSession(1);
  sessionToken = token;
  csrfToken = session.csrfToken;
  setProvidersForTests({
    model: {
      mode: "fixture",
      provider: new FakeModelProvider((req) => {
        const text = (req.context as { text: string }).text.trim();
        const kind = /跑|学|练/.test(text) ? "practice" : "task";
        return {
          ok: true,
          validatedResult: {
            items: [{ itemKey: "item-1", kind, summary: text.slice(0, 30), excerpt: text.slice(0, 100) }],
          },
        };
      }),
    },
  });
});

let taskBatchId = "";
let taskId = "";

test("P2：practice 事项经 record_practice 落实践记录（分钟来自用户报告）", async () => {
  const intakeId = await submitIntake("今天跑了40分钟", "idem-i2-practice-1");
  for (let i = 0; i < 3; i++) await runDueJobsOnce();
  const item = listItems(intakeId)[0]!;
  assert.equal(item.state, "applied");
  const rows = getDb().prepare(`SELECT * FROM practice_entries`).all() as Array<{ actual_minutes: number; minutes_origin: string; note: string }>;
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.actual_minutes, 40);
  assert.equal(rows[0]!.minutes_origin, "user_reported");
});

test("P2：task 事项经 create_or_update_task 落任务（估时/截止从原文解析）", async () => {
  const intakeId = await submitIntake("明天前要交操作系统实验报告，预计两小时", "idem-i2-task-1");
  for (let i = 0; i < 3; i++) await runDueJobsOnce();
  const item = listItems(intakeId)[0]!;
  assert.equal(item.state, "applied");
  const applied = item.payload.applied as { batchId: string };
  taskBatchId = applied.batchId;
  const rows = getDb().prepare(`SELECT * FROM tasks WHERE title LIKE '%操作系统%'`).all() as Array<{ id: string; status: string; version: number; estimate_minutes: number | null; due_local_date: string | null }>;
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.status, "todo");
  assert.equal(rows[0]!.estimate_minutes, 120, "两小时 \u2192 120 分钟");
  assert.ok(rows[0]!.due_local_date, "明天 \u2192 有截止");
  taskId = rows[0]!.id;
  // U02：任务落库即进入安排——要么有学习块，要么最近一次重排给出具体未排原因
  const planned = getDb().prepare(`SELECT COUNT(*) AS n FROM plan_sessions WHERE task_id = ? AND status = 'planned'`).get(taskId) as { n: number };
  const { latestPlanUnscheduled } = await import("@/workflows/plan");
  assert.ok(planned.n > 0 || latestPlanUnscheduled().some((u) => u.taskId === taskId), "投递完成意味着已有安排或具体阻碍");
});

test("P2：实体后续被修改后 undo 返回 409，不强行覆盖", async () => {
  getDb().prepare(`UPDATE tasks SET title = title || '（主人改）', version = version + 1 WHERE id = ?`).run(taskId);
  const res = await undoRoute(
    authedReq(`/api/v2/actions/${taskBatchId}/undo`, "POST", { expectedVersion: 1 }, "idem-i2-undo-conflict"),
    { params: Promise.resolve({ batchId: taskBatchId }) },
  );
  assert.equal(res.status, 409);
  const row = getDb().prepare(`SELECT title FROM tasks WHERE id = ?`).get(taskId) as { title: string };
  assert.ok(row.title.includes("（主人改）"), "后续修改不被撤销覆盖");
});

test("P2：任务撤销连带清理其学习块（FK 安全）", async () => {
  const { rebuildPlan } = await import("@/workflows/plan");
  const { executeCommand } = await import("@/workflows/commands");
  const r = await executeCommand(
    { command: "create_or_update_task", title: "FK 验证任务", estimateMinutes: 30 },
    { intakeId: null, itemId: null, itemKey: "", instanceEpoch: 0, evidence: "" },
  );
  assert.ok(r.ok && r.batchId);
  rebuildPlan(new Date());
  const fkTask = getDb().prepare(`SELECT id FROM tasks WHERE title = 'FK 验证任务'`).get() as { id: string };
  const res = await undoRoute(
    authedReq(`/api/v2/actions/${r.batchId}/undo`, "POST", { expectedVersion: 1 }, "idem-i2-undo-fk"),
    { params: Promise.resolve({ batchId: r.batchId }) },
  );
  assert.equal(res.status, 200, "带学习块的任务也能干净撤销");
  const gone = getDb().prepare(`SELECT COUNT(*) AS n FROM tasks WHERE id = ?`).get(fkTask.id) as { n: number };
  assert.equal(gone.n, 0);
  const orphan = getDb().prepare(`SELECT COUNT(*) AS n FROM plan_sessions WHERE task_id = ?`).get(fkTask.id) as { n: number };
  assert.equal(orphan.n, 0, "学习块随任务撤销清理");
});

test("P2：cancel 取消未应用部分，保留已应用结果与撤销入口", async () => {
  const before = (getDb().prepare(`SELECT COUNT(*) AS n FROM practice_entries`).get() as { n: number }).n;
  const intakeId = await submitIntake("今天练了听力", "idem-i2-cancel-1");
  const intake = getIntake(intakeId)!;
  const res = await cancelRoute(
    authedReq(`/api/v2/intakes/${intakeId}/cancel`, "POST", { expectedVersion: intake.version }, "idem-i2-cancel-2"),
    { params: Promise.resolve({ id: intakeId }) },
  );
  assert.equal(res.status, 200);
  for (let i = 0; i < 3; i++) await runDueJobsOnce();
  assert.equal(getIntake(intakeId)!.status, "cancelled");
  const practice = getDb().prepare(`SELECT COUNT(*) AS n FROM practice_entries`).get() as { n: number };
  assert.equal(practice.n, before, "取消的投递不应产生实践记录");
});
