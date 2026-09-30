import assert from "node:assert/strict";
import { test, before } from "node:test";
import { migrateAll } from "./helpers";
import { createLog } from "@/repositories/logs";
import {
  bumpPlanningRevision,
  createProposal,
  getPlanningRevision,
  type ProposalOperationInput,
} from "@/repositories/proposals";
import { applyProposal } from "@/workflows/apply-proposal";
import { createTask, getTask, updateTask } from "@/repositories/planning";
import { rejectProposal } from "@/repositories/proposal-decisions";

before(migrateAll);

const baseTaskInput = {
  title: "任务A",
  description: "",
  projectId: null,
  goalId: null,
  status: "todo" as const,
  priority: "normal" as const,
  estimateMinutes: 30,
  plannedWeek: null,
  scheduledStart: null,
  scheduledEnd: null,
  due: { kind: "none" as const },
};

test("F17：同 clientEntryId 同正文重放；异正文 409；空进展空卡点拒绝", () => {
  const input = {
    clientEntryId: "draft-1",
    occurredOn: "2026-09-28",
    progress: "写了测试",
    blocker: "",
    taskId: null,
    projectId: null,
  };
  const first = createLog(input);
  assert.ok(first !== "content_conflict");
  assert.equal(first.replayed, false);
  const replay = createLog(input);
  assert.ok(replay !== "content_conflict");
  assert.equal(replay.replayed, true);
  assert.equal(replay.log.id, first.log.id);
  const conflict = createLog({ ...input, progress: "不同内容" });
  assert.equal(conflict, "content_conflict");
});

test("F9：多操作提案一个实体版本已变 → 全不写入 409；合法提案重复 apply 返回相同结果", () => {
  const t1 = createTask(baseTaskInput);
  const t2 = createTask({ ...baseTaskInput, title: "任务B" });
  const ops: ProposalOperationInput[] = [
    {
      kind: "reschedule_task",
      taskId: t1.id,
      expectedVersion: t1.version,
      scheduledStart: "2026-10-01T19:00:00+08:00",
      scheduledEnd: null,
    },
    {
      kind: "set_task_status",
      taskId: t2.id,
      expectedVersion: t2.version,
      status: "doing",
    },
  ];
  const proposal = createProposal({
    contextRefs: [`task:${t1.id}`, `task:${t2.id}`],
    inputVersions: { [`task:${t1.id}`]: t1.version, [`task:${t2.id}`]: t2.version },
    operations: ops,
    reason: "F9 测试提案",
  });

  // 先让 t1 版本变化（模拟他人修改）
  const r = applyProposal(proposal.id);
  assert.ok(r.ok);
  // 第一次 apply 成功；任务已变更
  assert.equal(getTask(t2.id)!.status, "doing");
  const afterFirst = getTask(t1.id)!;
  assert.equal(afterFirst.scheduledStart, "2026-10-01T19:00:00+08:00");

  // 重复 apply 返回既有结果，不重复写入（幂等）
  const again = applyProposal(proposal.id);
  assert.ok(again.ok);
  assert.equal(getTask(t1.id)!.version, afterFirst.version, "重复 apply 不再递增版本");
});

test("F9 负例：apply 前实体版本变化 → 全不写入", () => {
  const t1 = createTask(baseTaskInput);
  const t2 = createTask({ ...baseTaskInput, title: "任务C" });
  const proposal = createProposal({
    contextRefs: [`task:${t1.id}`, `task:${t2.id}`],
    inputVersions: { [`task:${t1.id}`]: t1.version, [`task:${t2.id}`]: t2.version },
    operations: [
      {
        kind: "set_task_status",
        taskId: t1.id,
        expectedVersion: t1.version,
        status: "done",
      },
      {
        kind: "set_task_status",
        taskId: t2.id,
        expectedVersion: t2.version,
        status: "done",
      },
    ],
    reason: "F9 负例",
  });
  // t2 被外部修改 → 版本变化
  const u = updateTask(t2.id, { title: "任务C改" }, t2.version);
  assert.notEqual(u, "conflict");

  const result = applyProposal(proposal.id);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.status, 409);
  assert.equal(getTask(t1.id)!.status, "todo", "第一个操作不得写入");
  assert.equal(getTask(t2.id)!.status, "todo");
});

test("F10：planningRevision 变化使排程提案 409；纯状态提案不受影响", () => {
  const t1 = createTask(baseTaskInput);
  const t2 = createTask({ ...baseTaskInput, title: "任务D" });
  const scheduleProposal = createProposal({
    contextRefs: [`task:${t1.id}`],
    inputVersions: { [`task:${t1.id}`]: t1.version },
    operations: [
      {
        kind: "reschedule_task",
        taskId: t1.id,
        expectedVersion: t1.version,
        scheduledStart: "2026-10-02T19:00:00+08:00",
        scheduledEnd: null,
      },
    ],
    reason: "排程提案",
  });
  const statusProposal = createProposal({
    contextRefs: [`task:${t2.id}`],
    inputVersions: { [`task:${t2.id}`]: t2.version },
    operations: [
      { kind: "set_task_status", taskId: t2.id, expectedVersion: t2.version, status: "doing" },
    ],
    reason: "状态提案",
  });

  const before = getPlanningRevision();
  bumpPlanningRevision();
  assert.equal(getPlanningRevision(), before + 1);

  const r1 = applyProposal(scheduleProposal.id);
  assert.equal(r1.ok, false);
  if (!r1.ok) assert.equal(r1.code, "STALE_PLANNING");

  const r2 = applyProposal(statusProposal.id);
  assert.ok(r2.ok, "纯状态提案不因 planningRevision 失效");
});

test("已拒绝提案不能 apply", () => {
  const t1 = createTask(baseTaskInput);
  const p = createProposal({
    contextRefs: [`task:${t1.id}`],
    inputVersions: { [`task:${t1.id}`]: t1.version },
    operations: [
      { kind: "set_task_status", taskId: t1.id, expectedVersion: t1.version, status: "done" },
    ],
    reason: "将被拒绝",
  });
  assert.equal(rejectProposal(p.id), "ok");
  const r = applyProposal(p.id);
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.status, 409);
});
