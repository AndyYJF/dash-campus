import assert from "node:assert/strict";
import { test, before, beforeEach } from "node:test";
import { NextRequest } from "next/server";
import { migrateAll } from "./helpers";
import { hashPassword } from "@/domain/password";
import { createOwner, createSession, SESSION_COOKIE } from "@/domain/session";
import { LOGIN_MAX_FAILURES_PER_CLIENT, resetLoginLimits } from "@/domain/login-limit";
import { classifyAction, buildActions } from "@/domain/today";
import { createGoal, createTask, updateGoal, type TaskRow } from "@/repositories/planning";
import { claimDueJobs, createJob } from "@/repositories/jobs";
import { POST as login } from "@/app/api/v1/auth/login/route";
import { PATCH as patchTask } from "@/app/api/v1/tasks/[id]/route";
import { POST as postLog } from "@/app/api/v1/logs/route";
import { POST as postTask } from "@/app/api/v1/tasks/route";
import { GET as getJobRoute } from "@/app/api/v1/jobs/[id]/route";

let cookie = "";
let csrf = "";

before(() => {
  migrateAll();
  createOwner(hashPassword("correct-horse"));
  const { session, token } = createSession(1);
  cookie = `${SESSION_COOKIE}=${token}`;
  csrf = session.csrfToken;
});

beforeEach(() => resetLoginLimits());

function loginReq(password: string, ip = "203.0.113.1"): NextRequest {
  return new NextRequest("http://localhost/api/v1/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": ip },
    body: JSON.stringify({ password }),
  });
}

function authed(url: string, method: string, body?: unknown, extra: Record<string, string> = {}): NextRequest {
  return new NextRequest(`http://localhost${url}`, {
    method,
    headers: { cookie, "x-csrf-token": csrf, "content-type": "application/json", ...extra },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const params = (id: string) => ({ params: Promise.resolve({ id }) });

function task(overrides: Partial<Parameters<typeof createTask>[0]> = {}): TaskRow {
  return createTask({
    title: "t",
    description: "",
    projectId: null,
    goalId: null,
    status: "todo",
    priority: "normal",
    estimateMinutes: null,
    plannedWeek: null,
    scheduledStart: null,
    scheduledEnd: null,
    due: { kind: "none" },
    ...overrides,
  });
}

test("登录限速：同一来源连续失败后 429 + Retry-After；其他来源不受影响；成功清零", async () => {
  for (let i = 0; i < LOGIN_MAX_FAILURES_PER_CLIENT; i++) {
    assert.equal((await login(loginReq("wrong"))).status, 401);
  }
  const blocked = await login(loginReq("correct-horse"));
  assert.equal(blocked.status, 429, "达到上限后正确密码也先被拒");
  assert.ok(Number(blocked.headers.get("retry-after")) > 0);
  assert.equal((await login(loginReq("correct-horse", "198.51.100.7"))).status, 200);

  resetLoginLimits();
  for (let i = 0; i < LOGIN_MAX_FAILURES_PER_CLIENT - 1; i++) await login(loginReq("wrong"));
  assert.equal((await login(loginReq("correct-horse"))).status, 200);
  assert.equal((await login(loginReq("wrong"))).status, 401, "成功后计数清零，不会立即被锁");
});

test("CSRF 不匹配 403（常量时间比较，长度不同也安全）", async () => {
  const t = task();
  const res = await patchTask(
    authed(`/api/v1/tasks/${t.id}`, "PATCH", { expectedVersion: t.version, title: "x" }, { "x-csrf-token": "short" }),
    params(t.id),
  );
  assert.equal(res.status, 403);
});

test("引用不存在的 ID 返回 422 而不是 500", async () => {
  const t = task();
  const missing = "00000000-0000-4000-8000-000000000000";
  const patched = await patchTask(
    authed(`/api/v1/tasks/${t.id}`, "PATCH", { expectedVersion: t.version, projectId: missing }),
    params(t.id),
  );
  assert.equal(patched.status, 422);
  assert.equal((await patched.json()).error.code, "INVALID_REFERENCE");

  const log = await postLog(
    authed("/api/v1/logs", "POST", {
      clientEntryId: "c0ffee00-0000-4000-8000-000000000001",
      occurredOn: "2026-09-30",
      progress: "p",
      blocker: "",
      taskId: missing,
    }),
  );
  assert.equal(log.status, 422);
  assert.equal((await log.json()).error.code, "INVALID_REFERENCE");

  const created = await postTask(
    authed("/api/v1/tasks", "POST", { title: "t", goalId: missing }, { "idempotency-key": "fk-1" }),
  );
  assert.equal(created.status, 422);
  assert.equal((await created.json()).error.code, "INVALID_REFERENCE");
});

test("目标空 PATCH 不递增版本；版本不符仍 409", () => {
  const g = createGoal({ title: "g", reason: "", horizon: "semester" });
  const same = updateGoal(g.id, {}, g.version);
  assert.ok(same !== "conflict" && same !== "not_found");
  assert.equal(same.version, g.version);
  assert.equal(updateGoal(g.id, {}, g.version + 5), "conflict");
});

test("jobs 接口不返回租约 token", async () => {
  const job = createJob({
    type: "reminder",
    dedupeKey: `lease-${Date.now()}`,
    runAt: new Date(Date.now() - 1000).toISOString(),
    payload: {},
  });
  claimDueJobs(new Date().toISOString(), 50);
  const res = await getJobRoute(authed(`/api/v1/jobs/${job.id}`, "GET"), params(job.id));
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.ok(!("leaseToken" in body.job));
});

test("首页近期行动：没有近期时间且不属本周的任务不上首页；七天外截止不算临近", () => {
  const tz = "Asia/Shanghai";
  const asOf = new Date("2026-09-30T10:00:00+08:00"); // 周三
  const today = "2026-09-30";
  const monday = "2026-09-28";
  const week = { localMonday: monday, timezone: tz };
  const tz8 = (d: string) => ({ kind: "date" as const, localDate: d, timezone: tz });

  const none = task({ title: "无时间" });
  const far = task({ title: "远期截止", due: tz8("2026-10-20") });
  const soon = task({ title: "三天后截止", due: tz8("2026-10-03") });
  const dueToday = task({ title: "今天截止", due: tz8(today) });
  const scheduledToday = task({
    title: "今天时段",
    scheduledStart: "2026-09-30T06:00:00.000Z",
    scheduledEnd: "2026-09-30T07:00:00.000Z",
    plannedWeek: week,
  });
  const overdue = task({ title: "逾期", due: tz8("2026-09-29") });
  const weekLow = task({ title: "本周普通", plannedWeek: week });
  const weekHigh = task({ title: "本周高优", plannedWeek: week, priority: "high" });

  assert.equal(classifyAction(none, today, monday, asOf, tz), null);
  assert.equal(classifyAction(far, today, monday, asOf, tz), null);
  assert.equal(classifyAction(soon, today, monday, asOf, tz), "upcoming");
  assert.equal(classifyAction(dueToday, today, monday, asOf, tz), "today");
  assert.equal(classifyAction(scheduledToday, today, monday, asOf, tz), "today");
  assert.equal(classifyAction(overdue, today, monday, asOf, tz), "overdue");

  const titles = buildActions(
    [none, far, weekLow, weekHigh, soon, dueToday, scheduledToday, overdue],
    today,
    monday,
    asOf,
    tz,
  ).map((a) => a.task.title);
  assert.deepEqual(titles, ["逾期", "今天时段", "今天截止", "三天后截止", "本周高优", "本周普通"]);
});
