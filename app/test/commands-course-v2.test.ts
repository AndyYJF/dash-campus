import assert from "node:assert/strict";
import { before, test } from "node:test";
import { NextRequest } from "next/server";
import { migrateAll, getDb } from "./helpers";
import { createOwner, createSession, SESSION_COOKIE } from "@/domain/session";
import { hashPassword } from "@/domain/password";
import { setProvidersForTests } from "@/integrations";
import { FakeModelProvider } from "@/integrations/fake-model-provider";
import { runDueJobsOnce } from "@/worker/runner";
import { listOpenQuestions } from "@/repositories/questions";
import { getIntake, listItems } from "@/repositories/intakes";
import { mondayOf, addDays, localDateInTz, instanceTimezone } from "@/domain/time";
import { POST as createIntakeRoute } from "@/app/api/v2/intakes/route";
import { POST as retryRoute } from "@/app/api/v2/intakes/[id]/retry/route";
import { POST as undoRoute } from "@/app/api/v2/actions/[batchId]/undo/route";
import { POST as answerRoute } from "@/app/api/v2/questions/[id]/answers/route";

/**
 * Agent-first V2 P2 行为测试（MASTER-PLAN §10 P2 退出条件、§5.3 撤销/版本、§8 契约）：
 * 课表经白名单命令落课程语义模型+投影、journal 可撤销、版本冲突不被强覆、失败可重试。
 */

const SDCT1 = [
  "SDCT1",
  "T=20",
  "P=1,08:15-09:00;2,09:10-09:55",
  "C=高等数学|张老师|A101|1|1-2|1-16|A|-",
].join("\n");
const PRACTICE_TEXT = "今天跑了40分钟";

let modelFails = false;
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

async function answerFirstMonday(): Promise<void> {
  const q = listOpenQuestions().find((x) => x.questionKey === "semester.first_monday")!;
  const res = await answerRoute(
    authedReq(`/api/v2/questions/${q.id}/answers`, "POST", { text: "第5周", expectedVersion: q.version }, `idem-c2-ans-${q.id}`),
    { params: Promise.resolve({ id: q.id }) },
  );
  assert.equal(res.status, 202);
}

async function drain(n = 4): Promise<void> {
  for (let i = 0; i < n; i++) await runDueJobsOnce();
}

before(() => {
  migrateAll();
  createOwner(hashPassword("commands-test-pass"));
  const { token, session } = createSession(1);
  sessionToken = token;
  csrfToken = session.csrfToken;
  setProvidersForTests({
    model: {
      mode: "fixture",
      provider: new FakeModelProvider((req) => {
        if (modelFails) return { ok: false, error: { code: "TIMEOUT", message: "模拟模型超时", retryable: true } };
        const text = (req.context as { text: string }).text;
        return {
          ok: true,
          validatedResult: {
            items: [{ itemKey: "practice-1", kind: "practice", summary: "跑步40分钟", excerpt: text.trim().slice(0, 100) }],
          },
        };
      }),
    },
  });
});

let batchId = "";

test("P2：课表候选经 upsert_course_set 落课程语义模型并投影到固定事件", async () => {
  const intakeId = await submitIntake(`${SDCT1}\n${PRACTICE_TEXT}`, "idem-c2-course-1");
  await drain();
  await answerFirstMonday();
  await drain();

  const items = listItems(intakeId);
  const tt = items.find((i) => i.kind === "timetable")!;
  assert.equal(tt.state, "applied");
  const applied = tt.payload.applied as { batchId: string } | undefined;
  assert.ok(applied?.batchId, "applied 载荷应带 batchId");
  batchId = applied!.batchId;

  const expectedMonday = addDays(mondayOf(localDateInTz(new Date(), instanceTimezone())), -28);
  const sem = getDb().prepare(`SELECT * FROM semesters WHERE first_monday = ?`).get(expectedMonday) as { id: string; total_weeks: number } | undefined;
  assert.ok(sem, "应创建学期且首日为推算周一");
  assert.equal(sem!.total_weeks, 20);
  const courses = getDb().prepare(`SELECT * FROM courses WHERE name = '高等数学'`).all();
  assert.equal(courses.length, 1);
  const projections = getDb().prepare(`SELECT * FROM course_meeting_projections`).all();
  assert.ok(projections.length >= 1, "每次课应投影到固定事件");
  const fixed = getDb().prepare(`SELECT * FROM fixed_events WHERE title LIKE '高等数学%'`).all();
  assert.ok(fixed.length >= 1, "固定事件表应有课程投影");

  const links = getDb().prepare(`SELECT * FROM entity_source_links WHERE source_namespace = 'intake'`).all();
  assert.ok(links.length >= 1, "课程应带来源关联");
});

test("P2：undo 撤销课程 bundle，领域结果回滚且不中断无关数据", async () => {
  const res = await undoRoute(
    authedReq(`/api/v2/actions/${batchId}/undo`, "POST", { expectedVersion: 1 }, "idem-c2-undo-1"),
    { params: Promise.resolve({ batchId }) },
  );
  assert.equal(res.status, 200);
  const fixed = getDb().prepare(`SELECT * FROM fixed_events WHERE title LIKE '高等数学%'`).all();
  assert.equal(fixed.length, 0, "投影应随撤销删除");
  const batch = getDb().prepare(`SELECT status FROM agent_action_batches WHERE id = ?`).get(batchId) as { status: string };
  assert.equal(batch.status, "undone");
  const intake = getDb().prepare(`SELECT COUNT(*) AS n FROM intakes`).get() as { n: number };
  assert.ok(intake.n >= 1, "无关 intake 不受影响");
});

test("P2：同一 batch 用新幂等键重复 undo 返回 409，不静默半撤", async () => {
  const res = await undoRoute(
    authedReq(`/api/v2/actions/${batchId}/undo`, "POST", { expectedVersion: 1 }, "idem-c2-undo-2"),
    { params: Promise.resolve({ batchId }) },
  );
  assert.equal(res.status, 409);
});

test("P2：失败事项可显式 retry，仅重试失败分支", async () => {
  modelFails = true;
  const intakeId = await submitIntake(PRACTICE_TEXT, "idem-c2-retry-1");
  await drain();
  let items = listItems(intakeId);
  assert.equal(items[0]!.state, "failed");

  modelFails = false;
  const intake = getIntake(intakeId)!;
  const res = await retryRoute(
    authedReq(`/api/v2/intakes/${intakeId}/retry`, "POST", { expectedVersion: intake.version }, "idem-c2-retry-2"),
    { params: Promise.resolve({ id: intakeId }) },
  );
  assert.equal(res.status, 202);
  await drain();
  items = listItems(intakeId);
  assert.equal(items[0]!.state, "applied");
  const practice = getDb().prepare(`SELECT * FROM practice_entries`).all();
  assert.ok(practice.length >= 1, "重试成功后实践应落记录");
});
