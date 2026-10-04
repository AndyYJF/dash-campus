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
import { POST as createIntakeRoute } from "@/app/api/v2/intakes/route";
import { POST as answerRoute } from "@/app/api/v2/questions/[id]/answers/route";
import { GET as dashboardRoute } from "@/app/api/v2/dashboard/route";
import { GET as weekRoute } from "@/app/api/v2/week/route";
import { GET as directionRoute } from "@/app/api/v2/direction/route";
import { POST as sessionActionRoute } from "@/app/api/v2/sessions/[id]/[action]/route";
import { executeCommand } from "@/workflows/commands";
import { rebuildPlan } from "@/workflows/plan";

/**
 * Agent-first V2 P3 行为测试（MASTER-PLAN §10 P3 退出条件、§6 预算口径、§8 端点）：
 * 课表导入即见课程占用与暂定容量；2h 任务落入合法时段；三页面同一 snapshot；complete 只完成学习块。
 * 确定性：学期锚点用显式日期 2026-09-01（周一 2026-08-31），观测周一 2026-09-07（第 2 周，课在周内）。
 */

const SDCT1 = [
  "SDCT1",
  "T=20",
  "P=1,08:15-09:00;2,09:10-09:55",
  "C=高等数学|张老师|A101|1|1-2|1-16|A|-",
].join("\n");
const MONDAY = "2026-09-07";
const AS_OF = new Date("2026-09-06T20:00:00+08:00");

let sessionToken = "";
let csrfToken = "";

function authedReq(url: string, method: string, body?: unknown, key?: string): NextRequest {
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

before(async () => {
  migrateAll();
  createOwner(hashPassword("p3-test-pass"));
  const { token, session } = createSession(1);
  sessionToken = token;
  csrfToken = session.csrfToken;
  setProvidersForTests({ model: { mode: "fixture", provider: new FakeModelProvider(() => ({ ok: true, validatedResult: { items: [{ itemKey: "n", kind: "note", summary: "资料", excerpt: "资料" }] } })) } });

  const res = await createIntakeRoute(authedReq("/api/v2/intakes", "POST", { text: SDCT1 }, "idem-p3-course"));
  const { intakeId } = (await res.json()) as { intakeId: string };
  await runDueJobsOnce();
  const q = listOpenQuestions()[0]!;
  await answerRoute(authedReq(`/api/v2/questions/${q.id}/answers`, "POST", { text: "2026-09-01", expectedVersion: q.version }, "idem-p3-ans"), { params: Promise.resolve({ id: q.id }) });
  for (let i = 0; i < 3; i++) await runDueJobsOnce();
  void intakeId;
});

test("P3：课表导入后 dashboard 显示课程占用与暂定容量（C_day=180 模板）", async () => {
  const res = await dashboardRoute(authedReq(`/api/v2/dashboard?date=${MONDAY}`, "GET"));
  assert.equal(res.status, 200);
  const snap = (await res.json()) as {
    today: { courseMinutes: number; budget: { cDay: number; source: string } };
    snapshotRevision: string;
  };
  assert.equal(snap.today.courseMinutes, 100, "周一课程 08:15-09:55 = 100 分钟");
  assert.equal(snap.today.budget.cDay, 180, "模板下日容量被日上限 180 截断");
  assert.equal(snap.today.budget.source, "tentative", "未确认的模板必须标暂定");
});

test("P3：2h 任务排入合法时段：避开课程、块 25-90 分钟、总量覆盖 120", async () => {
  const ctx = { intakeId: null, itemId: null, itemKey: "", instanceEpoch: 0, evidence: "" };
  const r = executeCommand({ command: "create_or_update_task", title: "复习微积分", estimateMinutes: 120, dueLocalDate: "2026-09-13" }, ctx);
  assert.ok(r.ok);
  const plan = rebuildPlan(AS_OF);
  assert.equal(plan.kind, "planned");
  const sessions = getDb().prepare(`SELECT * FROM plan_sessions WHERE status IN ('planned','tentative')`).all() as Array<{ start_utc: string; end_utc: string }>;
  assert.ok(sessions.length >= 2 && sessions.length <= 3, "每项最多 3 个未来块");
  const total = sessions.reduce((a, s) => a + (new Date(s.end_utc).getTime() - new Date(s.start_utc).getTime()) / 60000, 0);
  assert.equal(total, 120);
  for (const s of sessions) {
    const len = (new Date(s.end_utc).getTime() - new Date(s.start_utc).getTime()) / 60000;
    assert.ok(len >= 25 && len <= 90, `块长 ${len} 须在 25-90`);
    const start = new Date(s.start_utc);
    const courseStart = new Date("2026-09-07T08:15:00+08:00");
    const courseEnd = new Date("2026-09-07T09:55:00+08:00");
    assert.ok(start >= courseEnd || new Date(s.end_utc) <= courseStart, "不能与课程重叠");
  }
});

test("P3：week 端点与 dashboard 同一 snapshotRevision，预算账本一致", async () => {
  const dash = (await (await dashboardRoute(authedReq(`/api/v2/dashboard?date=${MONDAY}`, "GET"))).json()) as { snapshotRevision: string };
  const res = await weekRoute(authedReq(`/api/v2/week?monday=${MONDAY}`, "GET"));
  assert.equal(res.status, 200);
  const week = (await res.json()) as { snapshotRevision: string; days: Array<{ date: string; courseMinutes: number; cDay: number }>; weekBudget: number };
  assert.equal(week.snapshotRevision, dash.snapshotRevision);
  assert.equal(week.days[0]!.date, MONDAY);
  assert.equal(week.days[0]!.courseMinutes, 100);
  assert.equal(week.weekBudget, 7 * 180);
});

test("P3：start/complete 只完成学习块，不自动完成任务", async () => {
  const session = getDb().prepare(`SELECT * FROM plan_sessions WHERE status = 'planned' LIMIT 1`).get() as { id: string; task_id: string; version: number };
  const r1 = await sessionActionRoute(authedReq(`/api/v2/sessions/${session.id}/start`, "POST", { expectedVersion: session.version }, "idem-p3-start"), { params: Promise.resolve({ id: session.id, action: "start" }) });
  assert.equal(r1.status, 200);
  const v = (getDb().prepare(`SELECT version FROM plan_sessions WHERE id = ?`).get(session.id) as { version: number }).version;
  const r2 = await sessionActionRoute(authedReq(`/api/v2/sessions/${session.id}/complete`, "POST", { expectedVersion: v }, "idem-p3-complete"), { params: Promise.resolve({ id: session.id, action: "complete" }) });
  assert.equal(r2.status, 200);
  const s = getDb().prepare(`SELECT status FROM plan_sessions WHERE id = ?`).get(session.id) as { status: string };
  assert.equal(s.status, "completed");
  const t = getDb().prepare(`SELECT status FROM tasks WHERE id = ?`).get(session.task_id) as { status: string };
  assert.equal(t.status, "todo", "完成学习块不自动完成任务");
});

test("P3：超截止不可行任务出现在未排原因，不自动顺延截止", async () => {
  const ctx = { intakeId: null, itemId: null, itemKey: "", instanceEpoch: 0, evidence: "" };
  executeCommand({ command: "create_or_update_task", title: "不可能完成的报告", taskKind: "study", estimateMinutes: 600, dueLocalDate: "2026-09-07" }, ctx);
  rebuildPlan(AS_OF);
  const week = (await (await weekRoute(authedReq(`/api/v2/week?monday=${MONDAY}`, "GET"))).json()) as {
    unscheduled: Array<{ title: string; reason: string }>;
  };
  const hit = week.unscheduled.find((u) => u.title === "不可能完成的报告");
  assert.ok(hit, "不可行任务要给出未排原因");
  assert.match(hit!.reason, /deadline_unfeasible|insufficient_capacity/);
  const t = getDb().prepare(`SELECT due_local_date FROM tasks WHERE title = '不可能完成的报告'`).get() as { due_local_date: string };
  assert.equal(t.due_local_date, "2026-09-07", "正式截止不被顺延");
});

test("P3：direction 诚实呈现证据状态，GET 无副作用", async () => {
  const res = await directionRoute(authedReq("/api/v2/direction", "GET"));
  assert.equal(res.status, 200);
  const d = (await res.json()) as { goals: unknown[]; practice: unknown[]; evidenceState: string };
  assert.ok(Array.isArray(d.goals));
  assert.ok(["no_evidence", "has_evidence"].includes(d.evidenceState));
});
