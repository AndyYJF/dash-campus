import assert from "node:assert/strict";
import { before, test } from "node:test";
import { NextRequest } from "next/server";
import { migrateAll, getDb } from "./helpers";
import { createOwner, createSession, SESSION_COOKIE } from "@/domain/session";
import { createTask, updateTask, getTask } from "@/repositories/planning";
import { createProposal, getProposal, listProposals, bumpPlanningRevision } from "@/repositories/proposals";
import { snoozeProposal } from "@/repositories/proposal-decisions";
import { applyProposal } from "@/workflows/apply-proposal";
import { POST } from "@/app/api/v1/proposals/[id]/snooze/route";
import { GET as today } from "@/app/api/v1/today/route";
import { addDays, instanceTimezone, localDateInTz, wallTimeToUtc } from "@/domain/time";

before(() => { migrateAll(); createOwner("unused-test-hash"); });
const input = { title: "暂缓测试", description: "", projectId: null, goalId: null, status: "todo" as const,
  priority: "normal" as const, estimateMinutes: null, plannedWeek: null, scheduledStart: null, scheduledEnd: null, due: { kind: "none" as const } };

test("暂缓期满：已变任务不再进入首页决策；保留原提案并提示冲突，刷新不修改业务数据", async () => {
  const task = createTask(input);
  const p = createProposal({ contextRefs: [`task:${task.id}`], inputVersions: { [`task:${task.id}`]: task.version }, reason: "旧建议",
    operations: [{ kind: "set_task_status", taskId: task.id, expectedVersion: task.version, status: "done" }] });
  assert.equal(snoozeProposal(p.id, "2099-01-01T00:00:00Z", p.version), "ok");
  updateTask(task.id, { title: "主人更新后的任务" }, task.version);
  assert.equal(listProposals().find((v) => v.id === p.id)?.validation, undefined, "尚在暂缓期不作为可行动建议重检");
  getDb().prepare("UPDATE proposals SET snooze_until='2000-01-01T00:00:00Z' WHERE id=?").run(p.id);
  const before = getProposal(p.id);
  assert.equal(listProposals().find((v) => v.id === p.id)?.validation?.code, "CONFLICT");
  const { token } = createSession();
  const result = await today(new NextRequest("http://localhost/api/v1/today", { headers: { cookie: `${SESSION_COOKIE}=${token}` } })).json();
  assert.ok(!result.decisions.some((d: { id: string }) => d.id === p.id));
  assert.deepEqual(getProposal(p.id), before, "不自动拒绝、改写或重新生成");
  const applied = applyProposal(p.id); assert.ok(!applied.ok);
  assert.equal(getTask(task.id)?.status, "todo");
});

test("期满展示与 apply 使用同一校验：排程 revision 变化失效，纯状态仍可行动", () => {
  const task = createTask(input);
  const schedule = createProposal({ contextRefs: [], inputVersions: {}, reason: "改期",
    operations: [{ kind: "reschedule_task", taskId: task.id, expectedVersion: task.version, scheduledStart: null, scheduledEnd: null }] });
  const status = createProposal({ contextRefs: [], inputVersions: {}, reason: "状态",
    operations: [{ kind: "set_task_status", taskId: task.id, expectedVersion: task.version, status: "doing" }] });
  bumpPlanningRevision();
  assert.equal(listProposals().find((p) => p.id === schedule.id)?.validation?.code, "STALE_PLANNING");
  assert.equal(listProposals().find((p) => p.id === status.id)?.validation, null);
  assert.ok(!applyProposal(schedule.id).ok); assert.ok(applyProposal(status.id).ok);
});

test("暂缓 API 必须带版本、受登录/CSRF 保护，默认实例次日09:00，旧版本和过去时间不会修改", async () => {
  const task = createTask(input), p = createProposal({ contextRefs: [], inputVersions: {}, reason: "API 暂缓",
    operations: [{ kind: "set_task_status", taskId: task.id, expectedVersion: task.version, status: "doing" }] });
  const { session, token } = createSession(), params = { params: Promise.resolve({ id: p.id }) };
  const request = (body: unknown, csrf = session.csrfToken) => new NextRequest("http://localhost/snooze", { method: "POST", headers: { cookie: `${SESSION_COOKIE}=${token}`, "x-csrf-token": csrf }, body: JSON.stringify(body) });
  assert.equal((await POST(new NextRequest("http://localhost/snooze", { method: "POST" }), params)).status, 401);
  assert.equal((await POST(request({ expectedVersion: p.version }, "wrong"), params)).status, 403);
  assert.equal((await POST(request({}), params)).status, 422);
  assert.equal((await POST(request({ expectedVersion: p.version, snoozeUntil: "2000-01-01T00:00:00Z" }), params)).status, 422);
  const tz = instanceTimezone(), expected = wallTimeToUtc(addDays(localDateInTz(new Date(), tz), 1), "09:00", tz).toISOString();
  const ok = await POST(request({ expectedVersion: p.version }), params); assert.equal(ok.status, 200);
  assert.equal((await ok.json()).snoozeUntil, expected); assert.equal(getProposal(p.id)?.snoozeUntil, expected);
  const saved = getProposal(p.id); assert.equal((await POST(request({ expectedVersion: p.version }), params)).status, 409);
  assert.deepEqual(getProposal(p.id), saved); assert.equal(getTask(task.id)?.status, "todo");
});
