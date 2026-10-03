import assert from "node:assert/strict";
import { before, test } from "node:test";
import { NextRequest } from "next/server";
import { migrateAll, getDb } from "./helpers";
import { createOwner, createSession, SESSION_COOKIE } from "@/domain/session";
import { hashPassword } from "@/domain/password";
import { setProvidersForTests } from "@/integrations";
import { FakeModelProvider } from "@/integrations/fake-model-provider";
import { runDueJobsOnce } from "@/worker/runner";
import { listOpenQuestions, latestAnswerForKey } from "@/repositories/questions";
import { getIntake, listItems } from "@/repositories/intakes";
import { mondayOf, addDays, localDateInTz } from "@/domain/time";
import { POST as createIntakeRoute } from "@/app/api/v2/intakes/route";
import { GET as getIntakeRoute } from "@/app/api/v2/intakes/[id]/route";
import { GET as listQuestionsRoute } from "@/app/api/v2/questions/route";
import { POST as answerRoute } from "@/app/api/v2/questions/[id]/answers/route";

/**
 * Agent-first V2 P1 行为测试（MASTER-PLAN §10 P1 退出条件、A01/A02/A04/A10/A11）：
 * 混合文字拆分、缺锚点只问 1 个问题、回答后恢复、幂等、过时答案、模型失败原文仍存。
 */

const SDCT1 = [
  "SDCT1",
  "T=20",
  "P=1,08:15-09:00;2,09:10-09:55",
  "C=高等数学|张老师|A101|1|1-2|1-16|A|-",
].join("\n");
const PRACTICE_TEXT = "今天跑了40分钟，环境一直报错";

let modelCalls = 0;
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

before(() => {
  migrateAll();
  createOwner(hashPassword("intake-test-pass"));
  const { token: t, session } = createSession(1);
  sessionToken = t;
  csrfToken = session.csrfToken;
  setProvidersForTests({
    model: {
      mode: "fixture",
      provider: new FakeModelProvider((req) => {
        modelCalls++;
        const text = (req.context as { text: string }).text;
        return {
          ok: true,
          validatedResult: {
            items: [{ itemKey: "practice-1", kind: "practice", summary: "跑步40分钟，环境报错", excerpt: text.trim().slice(0, 100) }],
          },
        };
      }),
    },
  });
});

test("A04/A01：混合文字拆成课表+实践两个事项；缺首周只产生 1 个 open 问题", async () => {
  const res = await createIntakeRoute(authedReq("/api/v2/intakes", "POST", { text: `${SDCT1}\n${PRACTICE_TEXT}` }, "idem-mix-1"));
  assert.equal(res.status, 202);
  const { intakeId } = (await res.json()) as { intakeId: string };
  await runDueJobsOnce();

  const intake = getIntake(intakeId)!;
  assert.equal(intake.status, "waiting_input");
  const items = listItems(intakeId);
  assert.equal(items.length, 2);
  const timetable = items.find((i) => i.kind === "timetable")!;
  const practice = items.find((i) => i.kind === "practice")!;
  assert.equal(timetable.state, "awaiting_input");
  assert.equal(practice.state, "applied"); // P2 起：practice 经白名单命令落领域
  assert.equal(practice.payload.summary, "跑步40分钟，环境报错");

  const open = listOpenQuestions();
  assert.equal(open.length, 1);
  assert.equal(open[0]!.questionKey, "semester.first_monday");
  assert.equal(timetable.waitingQuestionId, open[0]!.id);
});

test("同一缺口共享问题：第二份课表不再新建问题", async () => {
  const res = await createIntakeRoute(authedReq("/api/v2/intakes", "POST", { text: SDCT1 }, "idem-mix-2"));
  assert.equal(res.status, 202);
  const { intakeId } = (await res.json()) as { intakeId: string };
  await runDueJobsOnce();

  assert.equal(listOpenQuestions().length, 1, "仍然只有 1 个 open 问题");
  const timetable = listItems(intakeId).find((i) => i.kind === "timetable")!;
  assert.equal(timetable.state, "awaiting_input");
  assert.equal(timetable.waitingQuestionId, listOpenQuestions()[0]!.id);
});

test("无法理解的回答：422，问题保持 open", async () => {
  const q = listOpenQuestions()[0]!;
  const res = await answerRoute(authedReq(`/api/v2/questions/${q.id}/answers`, "POST", { text: "不知道", expectedVersion: q.version }, "idem-ans-bad"), { params: Promise.resolve({ id: q.id }) });
  assert.equal(res.status, 422);
  assert.equal((await res.json() as { error: { code: string } }).error.code, "ANSWER_UNPARSEABLE");
  assert.equal(listOpenQuestions().length, 1);
});

test("过时答案：expectedVersion 不匹配返回 409，问题保持 open", async () => {
  const q = listOpenQuestions()[0]!;
  const res = await answerRoute(authedReq(`/api/v2/questions/${q.id}/answers`, "POST", { text: "第5周", expectedVersion: q.version + 9 }, "idem-ans-stale"), { params: Promise.resolve({ id: q.id }) });
  assert.equal(res.status, 409);
  assert.equal((await res.json() as { error: { code: string } }).error.code, "STALE_ANSWER");
  assert.equal(listOpenQuestions().length, 1);
});

test("A02/A11：回答后从 Resolve 恢复，两份课表都得到锚点候选；不重复调模型", async () => {
  const q = listOpenQuestions()[0]!;
  const before_ = modelCalls;
  const res = await answerRoute(authedReq(`/api/v2/questions/${q.id}/answers`, "POST", { text: "第5周", expectedVersion: q.version }, "idem-ans-ok"), { params: Promise.resolve({ id: q.id }) });
  assert.equal(res.status, 202);

  // 答案已持久化；即使这里“进程重启”，恢复 job 已在队列里
  const today = localDateInTz(new Date(), "Asia/Shanghai");
  const expectedFirstMonday = addDays(mondayOf(today), -28);
  const answer = latestAnswerForKey("semester.first_monday")!;
  assert.equal(answer.structured?.firstMonday, expectedFirstMonday);

  await runDueJobsOnce(); // 恢复第一份
  await runDueJobsOnce(); // 恢复第二份
  assert.equal(modelCalls, before_, "恢复不重复分类");

  const anchor = latestAnswerForKey("semester.first_monday")!;
  assert.ok(anchor.structured?.derivation);
  const intakes = getDb().prepare(`SELECT id, status FROM intakes ORDER BY created_at`).all() as Array<{ id: string; status: string }>;
  assert.equal(intakes.length, 2);
  for (const row of intakes) {
    assert.equal(row.status, "completed");
    const timetable = listItems(row.id).find((i) => i.kind === "timetable")!;
    assert.equal(timetable.state, "applied");
    const candidate = timetable.payload.candidate as { firstMonday: string; courseCount: number; occurrenceCount: number };
    assert.equal(candidate.firstMonday, expectedFirstMonday);
    assert.equal(candidate.courseCount, 1);
    assert.ok(candidate.occurrenceCount > 0);
  }
});

test("幂等：同键同体重放同一结果；同键不同体 409", async () => {
  const body = { text: PRACTICE_TEXT };
  const first = await createIntakeRoute(authedReq("/api/v2/intakes", "POST", body, "idem-replay"));
  assert.equal(first.status, 202);
  const firstBody = (await first.json()) as { intakeId: string };

  const replay = await createIntakeRoute(authedReq("/api/v2/intakes", "POST", body, "idem-replay"));
  assert.equal(replay.status, 202);
  assert.equal(((await replay.json()) as { intakeId: string }).intakeId, firstBody.intakeId);

  const collision = await createIntakeRoute(authedReq("/api/v2/intakes", "POST", { text: "不同的内容" }, "idem-replay"));
  assert.equal(collision.status, 409);
  assert.equal((getDb().prepare(`SELECT count(*) AS n FROM intakes`).get() as { n: number }).n, 3);
  await runDueJobsOnce(); // 清空队列，避免影响后续用例
});

test("A10：模型失败时原文保留、事项失败、课表分支不受影响", async () => {
  setProvidersForTests({
    model: {
      mode: "fixture",
      provider: new FakeModelProvider(() => ({ ok: false, error: { code: "TIMEOUT" as const, message: "模型请求超时", retryable: true } })),
    },
  });
  try {
    const res = await createIntakeRoute(authedReq("/api/v2/intakes", "POST", { text: `${SDCT1}\n${PRACTICE_TEXT}` }, "idem-model-fail"));
    assert.equal(res.status, 202);
    const { intakeId } = (await res.json()) as { intakeId: string };
    await runDueJobsOnce();

    const items = listItems(intakeId);
    const note = items.find((i) => i.kind === "note")!;
    assert.equal(note.state, "failed");
    assert.match(note.evidence?.error as string, /TIMEOUT/);
    assert.equal(note.payload.text, PRACTICE_TEXT, "原文保留在事项里");
    const doc = getDb().prepare(`SELECT content_text FROM extracted_documents WHERE intake_id = ?`).get(intakeId) as { content_text: string };
    assert.ok(doc.content_text.includes(PRACTICE_TEXT), "原文保留在提取证据里");
    const timetable = items.find((i) => i.kind === "timetable")!;
    assert.equal(timetable.state, "applied", "学期锚点已答，课表分支独立落领域");
    assert.equal(getIntake(intakeId)!.status, "partially_applied");
  } finally {
    setProvidersForTests({});
  }
});

test("GET 状态与问题列表：不暴露实现细节", async () => {
  const id = (getDb().prepare(`SELECT id FROM intakes ORDER BY created_at LIMIT 1`).get() as { id: string }).id;
  const res = await getIntakeRoute(authedReq(`/api/v2/intakes/${id}`, "GET", undefined), { params: Promise.resolve({ id }) });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { intake: { status: string }; items: unknown[]; questions: unknown[] };
  assert.ok(body.intake.status);
  const raw = JSON.stringify(body);
  assert.doesNotMatch(raw, /lease_token|generation|dedupe_key/);

  const qr = await listQuestionsRoute(authedReq("/api/v2/questions", "GET", undefined));
  assert.equal(qr.status, 200);
  const qb = (await qr.json()) as { questions: unknown[]; totalOpen: number };
  assert.equal(qb.totalOpen, 0, "问题已回答");

  const missing = await getIntakeRoute(authedReq(`/api/v2/intakes/00000000-0000-0000-0000-000000000000`, "GET", undefined), { params: Promise.resolve({ id: "00000000-0000-0000-0000-000000000000" }) });
  assert.equal(missing.status, 404);
});
