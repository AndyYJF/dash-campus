import assert from "node:assert/strict";
import { test, before } from "node:test";
import { NextRequest } from "next/server";
import { migrateAll, getDb } from "./helpers";
import { runIdempotent, HttpError } from "@/workflows/http";
import { createTask, getTask, updateTask } from "@/repositories/planning";
import { createProposal, getPlanningRevision } from "@/repositories/proposals";
import { applyProposal, fixedEventClash, scheduleProblem } from "@/workflows/apply-proposal";
import { taskSchema } from "@/contracts/planning";

before(migrateAll);

function req(key: string | null): NextRequest {
  return new NextRequest("http://localhost/api/v1/x", {
    method: "POST",
    headers: key ? { "idempotency-key": key } : {},
  });
}

function baseTask(overrides: Record<string, unknown> = {}) {
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

test("幂等：check/execute/record 同一事务 —— 重放不再执行；execute 抛错回滚且不记录键", async () => {
  let runs = 0;
  const exec = () => {
    runs++;
    const t = baseTask({ title: `idem-${runs}` });
    return { statusCode: 201, body: { id: t.id }, resourceType: "task", resourceId: t.id };
  };
  const a = runIdempotent(req("k-1"), "{}", { actorScope: "owner:1", route: "t", execute: exec });
  const b = runIdempotent(req("k-1"), "{}", { actorScope: "owner:1", route: "t", execute: exec });
  assert.equal(a.status, 201);
  assert.equal(b.status, 201);
  assert.deepEqual(await a.json(), await b.json());
  assert.equal(runs, 1, "同键只执行一次");
  assert.equal(runIdempotent(req("k-1"), "{\"x\":1}", { actorScope: "owner:1", route: "t", execute: exec }).status, 409);
  assert.equal(runIdempotent(req(null), "{}", { actorScope: "owner:1", route: "t", execute: exec }).status, 422);

  // 失败回滚：业务写入与幂等记录都不留下；修正后同键可再次执行
  const before = (getDb().prepare(`SELECT COUNT(*) AS n FROM tasks`).get() as { n: number }).n;
  const failing = runIdempotent(req("k-2"), "{}", {
    actorScope: "owner:1",
    route: "t",
    execute: () => {
      baseTask({ title: "会被回滚" });
      throw new HttpError(422, "VALIDATION", "关联不存在");
    },
  });
  assert.equal(failing.status, 422);
  assert.equal((getDb().prepare(`SELECT COUNT(*) AS n FROM tasks`).get() as { n: number }).n, before, "回滚");
  const retry = runIdempotent(req("k-2"), "{}", { actorScope: "owner:1", route: "t", execute: exec });
  assert.equal(retry.status, 201);
});

test("任务排程：planningRevision 在 updateTask 事务内递增；plannedWeek 跟随时段；值不变不递增", () => {
  const t = baseTask();
  const r0 = getPlanningRevision();
  const u = updateTask(t.id, { scheduledStart: "2026-10-07T11:00:00+08:00", scheduledEnd: "2026-10-07T12:00:00+08:00" }, 1);
  assert.ok(u !== "conflict" && u !== "not_found");
  assert.equal(getPlanningRevision(), r0 + 1);
  // 2026-10-07 是周三 → 所在周一 2026-10-05（实例时区 Asia/Shanghai）
  assert.deepEqual(u.plannedWeek, { localMonday: "2026-10-05", timezone: "Asia/Shanghai" });
  // 同值重发不递增
  updateTask(t.id, { scheduledStart: "2026-10-07T11:00:00+08:00" }, u.version);
  assert.equal(getPlanningRevision(), r0 + 1);
  // 空 PATCH 用旧版本 → conflict
  assert.equal(updateTask(t.id, {}, 1), "conflict");
});

test("due 同值重发不递增 reminderRevision", () => {
  const due = { kind: "date" as const, localDate: "2099-01-01", timezone: "Asia/Shanghai" };
  const t = baseTask({ due });
  const u = updateTask(t.id, { due }, 1);
  assert.ok(u !== "conflict" && u !== "not_found");
  assert.equal(u.reminderRevision, t.reminderRevision);
});

test("plannedWeek 必须是周一", () => {
  const ok = taskSchema.safeParse({ title: "x", plannedWeek: { localMonday: "2026-10-05", timezone: "Asia/Shanghai" } });
  const bad = taskSchema.safeParse({ title: "x", plannedWeek: { localMonday: "2026-10-07", timezone: "Asia/Shanghai" } });
  assert.ok(ok.success);
  assert.ok(!bad.success);
});

test("改期提案：apply 后同任务另一份排程提案失效；start>=end 与固定事件冲突被拒且全不写入", () => {
  const t = baseTask();
  const mk = (start: string, end: string | null) =>
    createProposal({
      contextRefs: [`task:${t.id}`],
      inputVersions: { [`task:${t.id}`]: getTask(t.id)!.version },
      operations: [{ kind: "reschedule_task", taskId: t.id, expectedVersion: getTask(t.id)!.version, scheduledStart: start, scheduledEnd: end }],
      reason: "",
      reasonCode: "manual_reschedule",
    });
  const a = mk("2026-10-06T19:00:00+08:00", "2026-10-06T20:00:00+08:00");
  const b = mk("2026-10-08T19:00:00+08:00", "2026-10-08T20:00:00+08:00");
  assert.ok(applyProposal(a.id).ok);
  const rb = applyProposal(b.id);
  assert.ok(!rb.ok && rb.status === 409, "A 应用后 B 过时（F10 不能被绕过）");

  assert.equal(scheduleProblem("2026-10-06T20:00:00+08:00", "2026-10-06T19:00:00+08:00"), "结束时间必须晚于开始时间");
  assert.equal(scheduleProblem(null, "2026-10-06T19:00:00+08:00"), "只有结束时间没有开始时间");

  // 周二 10:00–12:00 固定课程
  getDb()
    .prepare(
      `INSERT INTO fixed_events (id, title, weekday, local_start, local_end, timezone) VALUES ('fe1', '高数课', 2, '10:00', '12:00', 'Asia/Shanghai')`,
    )
    .run();
  assert.equal(fixedEventClash("2026-10-06T11:00:00+08:00", "2026-10-06T13:00:00+08:00"), "高数课");
  assert.equal(fixedEventClash("2026-10-06T12:00:00+08:00", "2026-10-06T13:00:00+08:00"), null, "相接不算冲突");
  const before = getTask(t.id)!;
  const c = mk("2026-10-13T10:30:00+08:00", "2026-10-13T11:30:00+08:00");
  const rc = applyProposal(c.id);
  assert.ok(!rc.ok && rc.code === "FIXED_EVENT_CONFLICT");
  assert.equal(getTask(t.id)!.scheduledStart, before.scheduledStart, "冲突时不写入");
});
