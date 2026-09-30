import assert from "node:assert/strict";
import { test, before } from "node:test";
import { migrateAll, closeDb } from "./helpers";
import {
  archiveTask,
  createGoal,
  createProject,
  createTask,
  getTask,
  listGoals,
  updateGoal,
  updateTask,
} from "@/repositories/planning";
import { getDb } from "@/repositories/db";
import { goalPatchSchema, projectPatchSchema, taskPatchSchema } from "@/contracts/planning";

before(migrateAll);

test("目标创建与版本冲突 409 语义", () => {
  const goal = createGoal({ title: "毕业", reason: "", horizon: "long_term" });
  assert.equal(goal.version, 1);
  const updated = updateGoal(goal.id, { title: "顺利毕业" }, 1);
  assert.notEqual(updated, "conflict");
  if (updated !== "conflict" && updated !== "not_found") {
    assert.equal(updated.title, "顺利毕业");
    assert.equal(updated.version, 2);
  }
  // 旧版本号再改 → conflict
  assert.equal(updateGoal(goal.id, { title: "X" }, 1), "conflict");
  // 不存在 → not_found
  assert.equal(updateGoal("00000000-0000-0000-0000-000000000000", { title: "X" }, 1), "not_found");
});

test("项目-目标关联：联合唯一，重复关联被拒绝", () => {
  const goal = createGoal({ title: "学期目标", reason: "", horizon: "semester" });
  const project = createProject({
    title: "探索项目",
    question: "",
    expectedOutcome: "",
    prerequisites: "",
    reviewQuestions: "",
    goalIds: [goal.id],
  });
  assert.deepEqual(project.goalIds, [goal.id]);
  const db = getDb();
  assert.throws(
    () => db.prepare("INSERT INTO project_goals (project_id, goal_id) VALUES (?, ?)").run(project.id, goal.id),
    /UNIQUE constraint failed/,
  );
});

test("任务：due 三种形态与软删除", () => {
  const taskDate = createTask({
    title: "交报告",
    description: "",
    projectId: null,
    goalId: null,
    status: "todo",
    priority: "normal",
    estimateMinutes: 60,
    plannedWeek: null,
    scheduledStart: null,
    scheduledEnd: null,
    due: { kind: "date", localDate: "2026-10-01", timezone: "Asia/Shanghai" },
  });
  assert.deepEqual(getTask(taskDate.id)!.due, {
    kind: "date",
    localDate: "2026-10-01",
    timezone: "Asia/Shanghai",
  });

  const taskInstant = createTask({
    ...baseTask(),
    due: { kind: "instant", at: "2026-10-01T15:30:00+08:00", timezone: "Asia/Shanghai" },
  });
  assert.equal(getTask(taskInstant.id)!.due.kind, "instant");

  const archived = archiveTask(taskDate.id, 1);
  assert.notEqual(archived, "conflict");
  const stillReadable = getTask(taskDate.id)!;
  assert.ok(stillReadable.archivedAt);
  // 已归档不能再改
  assert.equal(updateTask(taskDate.id, { title: "Y" }, 2), "not_found");
});

test("任务 PATCH：版本不匹配 conflict，无字段时不递增版本", () => {
  const task = createTask(baseTask());
  assert.equal(updateTask(task.id, { title: "新标题" }, 99), "conflict");
  const same = updateTask(task.id, {}, 1);
  if (same !== "conflict" && same !== "not_found") {
    assert.equal(same.version, 1);
  }
});

test("PATCH schema 不补默认值：只改状态不清空其他字段", () => {
  assert.deepEqual(taskPatchSchema.parse({ status: "done" }), { status: "done" });
  assert.deepEqual(goalPatchSchema.parse({ title: "x" }), { title: "x" });
  assert.deepEqual(projectPatchSchema.parse({ title: "x" }), { title: "x" });

  const project = createProject({
    title: "P",
    question: "",
    expectedOutcome: "",
    prerequisites: "",
    reviewQuestions: "",
    goalIds: [],
  });
  const task = createTask({
    ...baseTask(),
    projectId: project.id,
    estimateMinutes: 90,
    priority: "high",
    due: { kind: "date", localDate: "2026-10-09", timezone: "Asia/Shanghai" },
  });
  const done = updateTask(task.id, taskPatchSchema.parse({ status: "done" }), 1);
  assert.ok(done !== "conflict" && done !== "not_found");
  assert.equal(done.status, "done");
  assert.equal(done.projectId, project.id);
  assert.equal(done.estimateMinutes, 90);
  assert.equal(done.priority, "high");
  assert.equal(done.due.kind, "date");
});

test("重启保留数据：关闭连接重开后目标仍在", () => {
  createGoal({ title: "持久化目标", reason: "", horizon: "long_term" });
  closeDb();
  const goals = listGoals();
  assert.ok(goals.some((g) => g.title === "持久化目标"));
});

function baseTask() {
  return {
    title: "基础任务",
    description: "",
    projectId: null,
    goalId: null,
    status: "todo" as const,
    priority: "normal" as const,
    estimateMinutes: null,
    plannedWeek: null,
    scheduledStart: null,
    scheduledEnd: null,
    due: { kind: "none" as const },
  };
}
