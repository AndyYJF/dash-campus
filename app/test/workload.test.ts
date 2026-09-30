import assert from "node:assert/strict";
import { test, before } from "node:test";
import { migrateAll, getDb } from "./helpers";
import { computeWorkload } from "@/domain/workload";
import type { TaskRow } from "@/repositories/planning";

before(migrateAll);

function makeTask(partial: Partial<TaskRow>): TaskRow {
  return {
    id: Math.random().toString(36).slice(2),
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
    version: 1,
    reminderRevision: 0,
    sourceRevisionId: null,
    completedAt: null,
    createdAt: "",
    updatedAt: "",
    archivedAt: null,
    ...partial,
  };
}

// 每个测试用自己的一周 + valid 范围限制，避免同文件共享库互相污染
function addBlock(id: string, week: string, weekday: number, start: string, end: string): void {
  getDb()
    .prepare(
      `INSERT INTO availability_blocks (id, title, weekday, local_start, local_end, timezone, valid_from, valid_until)
       VALUES (?, '', ?, ?, ?, 'Asia/Shanghai', ?, ?)`,
    )
    .run(id, weekday, start, end, week, addDaysLocal(week, 6));
}

function addDaysLocal(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

test("F6：净可用 600（窗口 750 分钟）、缓冲 20% → 容量 600；任务 540 + 1 未知 → 超量", () => {
  const week = "2026-09-28";
  // F6：净可用 600（窗口 600 分钟）→ ×0.8 = 480；任务 540 → 超量 60
  addBlock("f6", week, 1, "00:00", "10:00");
  const tasks = [
    makeTask({ estimateMinutes: 540, plannedWeek: { localMonday: week, timezone: "Asia/Shanghai" } }),
    makeTask({ estimateMinutes: null, plannedWeek: { localMonday: week, timezone: "Asia/Shanghai" } }),
  ];
  const w = computeWorkload(tasks, week, new Date("2026-09-28T00:00:00+08:00"));
  assert.equal(w.weekCapacityMinutes, 480);
  assert.equal(w.committedMinutes, 540);
  assert.equal(w.committedUnknownCount, 1);
  assert.ok(w.committedMinutes - w.weekCapacityMinutes! >= 60, "至少超量 60 分钟");
});

test("F21：周中口径 —— 承诺含 done 360+180；未来容量 96；缺口 84", () => {
  const week = "2026-10-05";
  // 周一~周四每天 09:00-19:00；周五 09:00-11:00（120 分钟净可用 → ×0.8 = 96）
  for (const d of [1, 2, 3, 4]) addBlock(`f21-${d}`, week, d, "09:00", "19:00");
  addBlock("f21-5", week, 5, "09:00", "11:00");
  const asOf = new Date("2026-10-09T08:00:00+08:00"); // 周五早上
  const tasks = [
    makeTask({ estimateMinutes: 360, status: "done", plannedWeek: { localMonday: week, timezone: "Asia/Shanghai" } }),
    makeTask({ estimateMinutes: 180, status: "todo", plannedWeek: { localMonday: week, timezone: "Asia/Shanghai" } }),
  ];
  const w = computeWorkload(tasks, week, asOf);
  assert.equal(w.committedMinutes, 540, "整周承诺含已完成");
  assert.equal(w.remainingKnownMinutes, 180);
  assert.equal(w.futureCapacityMinutes, 96, "未来净可用 120 × 0.8");
  const gap = w.remainingKnownMinutes - w.futureCapacityMinutes!;
  assert.equal(gap, 84, "至少 84 分钟缺口");
  assert.ok(w.futureCapacityMinutes! < w.weekCapacityMinutes!);
});

test("过去空闲不计入未来容量", () => {
  const week = "2026-10-12";
  addBlock("past", week, 1, "09:00", "12:00"); // 只有周一上午窗口
  const asOf = new Date("2026-10-12T15:00:00+08:00"); // 窗口已全部过去
  const w = computeWorkload([], week, asOf);
  assert.equal(w.futureCapacityMinutes, 0);
  assert.ok(w.weekCapacityMinutes! > 0);
});

test("无时间数据时容量为 null，不报安排合理", () => {
  const week = "2026-10-19"; // 没有任何 block 覆盖这一周
  const w = computeWorkload([], week, new Date("2026-10-19T00:00:00+08:00"));
  assert.equal(w.weekCapacityMinutes, null);
  assert.equal(w.futureCapacityMinutes, null);
  assert.equal(w.hasAnyTimeData, false);
});

test("cancelled 不计入承诺；固定事件扣减窗口", () => {
  const week = "2026-10-26";
  addBlock("fe1", week, 2, "09:00", "19:00");
  getDb()
    .prepare(
      `INSERT INTO fixed_events (id, title, weekday, local_start, local_end, timezone, event_date, valid_from, valid_until)
       VALUES ('ev1', '课', 2, '12:00', '14:00', 'Asia/Shanghai', NULL, ?, ?)`,
    )
    .run(week, addDaysLocal(week, 6));
  const tasks = [
    makeTask({ estimateMinutes: 100, status: "cancelled", plannedWeek: { localMonday: week, timezone: "Asia/Shanghai" } }),
  ];
  const w = computeWorkload(tasks, week, new Date("2026-10-25T00:00:00+08:00"));
  assert.equal(w.committedMinutes, 0);
  // 周二 600 − 120 = 480，× 0.8 = 384
  assert.equal(w.weekCapacityMinutes, 384);
});

test("重叠固定事件只扣一次", () => {
  const week = "2026-11-02";
  addBlock("ov1", week, 3, "09:00", "19:00");
  const ins = getDb().prepare(
    `INSERT INTO fixed_events (id, title, weekday, local_start, local_end, timezone, event_date, valid_from, valid_until)
     VALUES (?, '课', 3, ?, ?, 'Asia/Shanghai', NULL, ?, ?)`,
  );
  ins.run("ov-a", "12:00", "14:00", week, addDaysLocal(week, 6));
  ins.run("ov-b", "13:00", "15:00", week, addDaysLocal(week, 6));
  const w = computeWorkload([], week, new Date("2026-11-01T00:00:00+08:00"));
  // 周三 600 − 并集 180 = 420，× 0.8 = 336
  assert.equal(w.weekCapacityMinutes, 336);
});

test("只覆盖周中几天的窗口也算有时间数据", () => {
  const week = "2026-11-09";
  getDb()
    .prepare(
      `INSERT INTO availability_blocks (id, title, weekday, local_start, local_end, timezone, valid_from, valid_until)
       VALUES ('mid', '', 3, '09:00', '11:00', 'Asia/Shanghai', ?, ?)`,
    )
    .run(addDaysLocal(week, 2), addDaysLocal(week, 3));
  const w = computeWorkload([], week, new Date("2026-11-08T00:00:00+08:00"));
  assert.equal(w.hasAnyTimeData, true);
  assert.equal(w.weekCapacityMinutes, 96);
});
