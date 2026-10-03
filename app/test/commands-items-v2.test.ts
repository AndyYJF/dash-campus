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

test("P2：task 事项经 create_or_update_task 落任务", async () => {
  const intakeId = await submitIntake("下周要交操作系统实验报告", "idem-i2-task-1");
  for (let i = 0; i < 3; i++) await runDueJobsOnce();
  const item = listItems(intakeId)[0]!;
  assert.equal(item.state, "applied");
  const applied = item.payload.applied as { batchId: string };
  taskBatchId = applied.batchId;
  const rows = getDb().prepare(`SELECT * FROM tasks WHERE title LIKE '%操作系统%'`).all() as Array<{ id: string; status: string; version: number }>;
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.status, "todo");
  taskId = rows[0]!.id;
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
