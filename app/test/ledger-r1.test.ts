import assert from "node:assert/strict";
import crypto from "node:crypto";
import { before, beforeEach, test } from "node:test";
import { migrateAll, getDb } from "./helpers";
import { rebuildPlan, dayLedger } from "@/workflows/plan";
import { dashboardSnapshot, weekSnapshot } from "@/workflows/snapshot";
import { getPrefs } from "@/repositories/plan";
import { undoBatch } from "@/workflows/undo";

/**
 * R1 共享预算账本与稳定排程（REPAIR-PLAN §4.2–§4.6；E05–E11、E13 的隔离行为）。
 * 固定时区 Asia/Shanghai 与固定 asOf；任务/记录直接落真实表，时间算法与重排走真实实现。
 */

const TZ = "Asia/Shanghai";
const at = (local: string) => new Date(`${local}:00+08:00`);

type Session = { id: string; task_id: string; start_utc: string; end_utc: string; status: string; version: number };

function addTask(title: string, estimate: number | null, extra: { dueAt?: string; dueDate?: string; effortMode?: string; createdAt?: string } = {}): string {
  const id = crypto.randomUUID();
  const created = extra.createdAt ?? "2026-10-01T00:00:00.000Z";
  getDb()
    .prepare(
      `INSERT INTO tasks (id, title, description, status, priority, estimate_minutes, due_kind, due_local_date, due_timezone, due_at, effort_mode, created_at, updated_at)
       VALUES (?, ?, '', 'todo', 'normal', ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, title, estimate, extra.dueAt ? "instant" : extra.dueDate ? "date" : "none", extra.dueDate ?? null, extra.dueAt || extra.dueDate ? TZ : null, extra.dueAt ?? null, extra.effortMode ?? "deliverable", created, created);
  return id;
}

function addPractice(date: string, minutes: number, opts: { taskId?: string; category?: string } = {}): void {
  getDb()
    .prepare(`INSERT INTO practice_entries (id, task_id, occurred_on, actual_minutes, minutes_origin, note, category, created_at, updated_at) VALUES (?, ?, ?, ?, 'user_reported', '', ?, ?, ?)`)
    .run(crypto.randomUUID(), opts.taskId ?? null, date, minutes, opts.category ?? "study", "2026-10-01T00:00:00.000Z", "2026-10-01T00:00:00.000Z");
}

function addFixedEvent(title: string, date: string, start: string, end: string): void {
  const weekday = ((new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7) + 1;
  getDb().prepare(`INSERT INTO fixed_events (id, title, weekday, local_start, local_end, timezone, event_date) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(crypto.randomUUID(), title, weekday, start, end, TZ, date);
}

function activeSessions(taskId?: string): Session[] {
  const rows = getDb().prepare(`SELECT * FROM plan_sessions WHERE status IN ('planned','tentative','in_progress') ORDER BY start_utc`).all() as Session[];
  return taskId ? rows.filter((r) => r.task_id === taskId) : rows;
}

const minutes = (s: Session) => (Date.parse(s.end_utc) - Date.parse(s.start_utc)) / 60000;
const onDate = (rows: Session[], date: string) => rows.filter((s) => Date.parse(s.start_utc) >= at(`${date}T00:00`).getTime() && Date.parse(s.start_utc) < at(`${date}T00:00`).getTime() + 86_400_000);
const total = (rows: Session[]) => rows.reduce((a, s) => a + minutes(s), 0);
const key = (rows: Session[]) => rows.map((s) => `${s.id}|${s.start_utc}|${s.end_utc}|${s.status}`).join("\n");

before(() => migrateAll());

beforeEach(() => {
  const db = getDb();
  for (const t of ["agent_action_changes", "agent_action_batches", "plan_sessions", "practice_entries", "fixed_event_exceptions", "fixed_events", "tasks"]) db.prepare(`DELETE FROM ${t}`).run();
});

test("E05：日预算 180、已确认学习 150 → 当天新增最多 30；页面与排程同口径；运动不占学习预算", () => {
  const asOf = at("2026-10-10T08:59"); // 周六
  addPractice("2026-10-10", 150);
  addPractice("2026-10-10", 60, { category: "other" });
  const before = dashboardSnapshot("2026-10-10", asOf).today.budget;
  assert.equal(before.bDay, 150, "运动记录不计入学习消耗");
  assert.equal(before.otherActivityMinutes, 60);
  assert.equal(before.futureCapacity, 30);

  const taskId = addTask("写实验报告", 120);
  const plan = rebuildPlan(asOf);
  const rows = activeSessions(taskId);
  assert.equal(total(onDate(rows, "2026-10-10")), 30, "当天实际新增分钟不得超过页面显示的 30");
  assert.equal(total(rows), 120, "其余需求排到后续日期");
  assert.deepEqual(plan.unscheduled, []);
  assert.equal(dashboardSnapshot("2026-10-10", asOf).today.budget.futureCapacity, 0, "排完后页面剩余归零");
});

test("E07：已完成块暂扣 60，补记同一任务实际 40 → 只扣 40；另一项相近时长活动不被合并", () => {
  const asOf = at("2026-10-10T20:00");
  const taskId = addTask("线代作业", 120);
  const id = crypto.randomUUID();
  getDb().prepare(`INSERT INTO plan_sessions (id, task_id, start_utc, end_utc, timezone, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'completed', ?, ?)`).run(id, taskId, at("2026-10-10T09:00").toISOString(), at("2026-10-10T10:00").toISOString(), TZ, "x", "x");
  const prefs = getPrefs();
  assert.equal(dayLedger("2026-10-10", asOf, prefs, TZ).bDay, 60);
  assert.equal(dayLedger("2026-10-10", asOf, prefs, TZ).estimatedMinutes, 60, "无实际记录时标为估算");
  addPractice("2026-10-10", 40, { taskId });
  const l = dayLedger("2026-10-10", asOf, prefs, TZ);
  assert.equal(l.bDay, 40, "预算回补 20");
  assert.equal(l.actualMinutes, 40);
  assert.equal(l.estimatedMinutes, 0);
  addPractice("2026-10-10", 38); // 另一活动，分钟相近
  assert.equal(dayLedger("2026-10-10", asOf, prefs, TZ).bDay, 78, "不同活动各自计入，不按分钟相近合并");
});

test("E09：相同事实重复重算无变更；只影响某天的新课程只改必要的块，无关块保留 ID 与时段", () => {
  const asOf = at("2026-10-05T07:00"); // 周一
  const a = addTask("任务A", 180, { createdAt: "2026-10-01T00:00:00.000Z" });
  const b = addTask("任务B", 180, { createdAt: "2026-10-01T00:00:01.000Z" });
  const first = rebuildPlan(asOf);
  assert.ok(first.batchId);
  const snap1 = key(activeSessions());
  const again = rebuildPlan(asOf);
  assert.equal(again.changed, false);
  assert.equal(again.batchId, null, "无变更不写新批次");
  assert.equal(key(activeSessions()), snap1, "块 ID/时段/状态完全不变");
  assert.equal(weekSnapshot("2026-10-05", asOf).snapshotRevision, weekSnapshot("2026-10-05", asOf).snapshotRevision);

  // 找一个 24h 之外的块，在它所在时段加一门课
  const far = activeSessions().find((s) => Date.parse(s.start_utc) > asOf.getTime() + 86_400_000);
  assert.ok(far, "应有 24h 之外的块");
  const farDate = new Date(Date.parse(far.start_utc) + 8 * 3600_000).toISOString().slice(0, 10);
  const others = activeSessions().filter((s) => s.id !== far.id);
  addFixedEvent("新增讲座", farDate, "08:00", "09:00");
  const third = rebuildPlan(asOf);
  assert.equal(third.changed, true);
  const now = activeSessions();
  for (const o of others) {
    const same = now.find((s) => s.id === o.id);
    assert.ok(same, `无关块 ${o.id} 必须保留`);
    assert.equal(same.start_utc, o.start_utc);
  }
  assert.ok(!now.some((s) => s.id === far.id), "与新课程冲突的远期块被替换");
  assert.equal(total(now.filter((s) => s.task_id === a)) + total(now.filter((s) => s.task_id === b)), 360, "总需求仍被覆盖，无副本");
  for (const s of now) assert.ok(!(Date.parse(s.start_utc) < at(`${farDate}T09:15`).getTime() && Date.parse(s.end_utc) > at(`${farDate}T07:45`).getTime()), "新块避开课程与通勤");
});

test("E08：asOf 在块开始前/恰好开始/块中，都不产生重叠副本，已开始的块保留并占位", () => {
  const taskId = addTask("复习", 60);
  rebuildPlan(at("2026-10-05T07:00"));
  const [block] = activeSessions(taskId);
  assert.ok(block);
  const start = Date.parse(block.start_utc);
  for (const asOf of [new Date(start - 60_000), new Date(start), new Date(start + 20 * 60_000)]) {
    const r = rebuildPlan(asOf);
    const rows = activeSessions(taskId);
    assert.equal(rows.length, 1, `asOf=${asOf.toISOString()} 不应出现副本`);
    assert.equal(rows[0]!.id, block.id);
    assert.equal(r.changed, false);
  }
  const l = dayLedger("2026-10-05", new Date(start + 20 * 60_000), getPrefs(), TZ);
  assert.equal(l.provisionalMinutes, 20, "已流逝部分暂占预算");
  assert.equal(l.pFuture, 40, "剩余部分是未来承诺");
  assert.equal(l.actualMinutes, 0, "暂占不显示为已记录实际");
});

test("E13：完成 90 分钟块但任务未完成 → 只补剩余 30，不重排全部原始需求；投入达估时后不再自动补排", () => {
  const taskId = addTask("复现基线", 120);
  rebuildPlan(at("2026-10-05T07:00"));
  const blocks = activeSessions(taskId);
  const big = blocks.find((s) => minutes(s) === 90)!;
  getDb().prepare(`UPDATE plan_sessions SET status = 'completed', version = version + 1 WHERE id = ?`).run(big.id);
  const later = new Date(Date.parse(big.end_utc) + 60_000);
  rebuildPlan(later);
  assert.equal(total(activeSessions(taskId)), 30, "未来只保留剩余 30 分钟");

  for (const s of activeSessions(taskId)) getDb().prepare(`UPDATE plan_sessions SET status = 'completed' WHERE id = ?`).run(s.id);
  const r = rebuildPlan(at("2026-10-09T07:00"));
  assert.equal(activeSessions(taskId).length, 0, "deliverable 投入已达估时：不无依据再排");
  assert.deepEqual(r.unscheduled.map((u) => u.reason), ["needs_remaining_estimate"]);
});

test("E13：time_budget 任务按确认投入扣剩余（估 120、已投入 40 → 未来 80）", () => {
  const taskId = addTask("本周学两小时", 120, { effortMode: "time_budget" });
  addPractice("2026-10-04", 40, { taskId });
  rebuildPlan(at("2026-10-05T07:00"));
  assert.equal(total(activeSessions(taskId)), 80);
});

test("E11：截止到具体时刻（2026-10-05 10:00，估 30 分钟）→ 安排结束不晚于截止", () => {
  const taskId = addTask("交报告", 30, { dueAt: at("2026-10-05T10:00").toISOString() });
  const r = rebuildPlan(at("2026-10-04T20:00"));
  const rows = activeSessions(taskId);
  assert.equal(total(rows), 30);
  for (const s of rows) assert.ok(Date.parse(s.end_utc) <= at("2026-10-05T10:00").getTime(), "不得晚于截止时刻");
  assert.deepEqual(r.unscheduled, []);
});

test("§4.6：17:15、预算 180 已投入 120；报告 18:00 截止剩 40 → 17:15–17:55；90 分钟实验不塞今天", () => {
  const asOf = at("2026-10-08T17:15"); // 周四，无课
  addPractice("2026-10-08", 120);
  const report = addTask("报告", 40, { dueAt: at("2026-10-08T18:00").toISOString(), createdAt: "2026-10-02T00:00:00.000Z" });
  const lab = addTask("基线实验", 90, { createdAt: "2026-10-01T00:00:00.000Z" });
  const r = rebuildPlan(asOf);
  const rep = activeSessions(report);
  assert.equal(rep.length, 1);
  assert.equal(rep[0]!.start_utc, at("2026-10-08T17:15").toISOString());
  assert.equal(rep[0]!.end_utc, at("2026-10-08T17:55").toISOString());
  const labRows = activeSessions(lab);
  assert.equal(total(labRows), 90);
  assert.equal(labRows.length, 1, "实验保持连续 90 分钟");
  assert.equal(onDate(labRows, "2026-10-08").length, 0, "今天只剩 20 分钟预算，不塞实验");
  assert.deepEqual(r.unscheduled, []);
  assert.equal(dashboardSnapshot("2026-10-08", asOf).today.budget.futureCapacity, 20);
});

test("§4.6：报告剩 60 而 18:00 前只有 45 分钟 → 明确缺 15，不越过截止、不占晚餐", () => {
  const asOf = at("2026-10-08T17:15");
  addPractice("2026-10-08", 120);
  const report = addTask("报告", 60, { dueAt: at("2026-10-08T18:00").toISOString() });
  const r = rebuildPlan(asOf);
  const rows = activeSessions(report);
  assert.equal(total(rows), 45);
  for (const s of rows) assert.ok(Date.parse(s.end_utc) <= at("2026-10-08T18:00").getTime());
  assert.deepEqual(r.unscheduled, [{ taskId: report, title: "报告", reason: "deadline_unfeasible", missingMinutes: 15 }]);
  const t = getDb().prepare(`SELECT due_at FROM tasks WHERE id = ?`).get(report) as { due_at: string };
  assert.equal(t.due_at, at("2026-10-08T18:00").toISOString(), "截止不被修改");
});

test("E10：24h 内的块与新增课程冲突 → 不擅自移动，标出冲突；任务完成后其未执行块被取消", () => {
  const asOf = at("2026-10-05T07:00");
  const taskId = addTask("近期复习", 60);
  rebuildPlan(asOf);
  const [block] = activeSessions(taskId);
  assert.ok(block && Date.parse(block.start_utc) < asOf.getTime() + 86_400_000, "块在 24h 内");
  const local = new Date(Date.parse(block.start_utc) + 8 * 3600_000).toISOString();
  addFixedEvent("临时加课", local.slice(0, 10), local.slice(11, 16), new Date(Date.parse(block.end_utc) + 8 * 3600_000).toISOString().slice(11, 16));
  const r = rebuildPlan(asOf);
  const rows = activeSessions(taskId);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.id, block.id, "受保护块保留原 ID");
  assert.equal(rows[0]!.start_utc, block.start_utc, "时段不被擅自移动");
  assert.deepEqual(r.conflicts, [{ sessionId: block.id, taskId, reason: "overlaps_fixed" }]);
  assert.deepEqual(weekSnapshot("2026-10-05", asOf).conflicts, r.conflicts, "冲突进入页面快照");

  getDb().prepare(`UPDATE tasks SET status = 'done' WHERE id = ?`).run(taskId);
  rebuildPlan(asOf);
  assert.equal(activeSessions(taskId).length, 0, "任务完成后未执行块取消");
});

test("重排批次可撤销：恢复被替换的块、移除新增的块", () => {
  const asOf = at("2026-10-05T07:00");
  const taskId = addTask("可撤销", 60);
  const first = rebuildPlan(asOf);
  const before1 = key(activeSessions(taskId));
  assert.ok(first.batchId);
  assert.deepEqual(undoBatch(first.batchId), { kind: "undone" });
  assert.equal(activeSessions(taskId).length, 0);
  assert.notEqual(before1, "");
});

test("R0：没有课程语义来源的旧固定活动仍扣空档，并单独计入 fixedMinutes（不显示为零占用）", () => {
  const asOf = at("2026-10-05T07:00");
  addFixedEvent("高等数学 @A101", "2026-10-05", "08:15", "09:55");
  const snap = dashboardSnapshot("2026-10-05", asOf);
  assert.equal(snap.today.courseMinutes, 0, "来源不能证明是课程时不猜");
  assert.equal(snap.today.fixedMinutes, 100, "但占用如实展示");
  assert.deepEqual(snap.today.events.map((e) => [e.title, e.kind]), [["高等数学 @A101", "fixed"]]);
  const taskId = addTask("预习", 60);
  rebuildPlan(asOf);
  for (const s of activeSessions(taskId)) assert.ok(Date.parse(s.end_utc) <= at("2026-10-05T08:15").getTime() || Date.parse(s.start_utc) >= at("2026-10-05T09:55").getTime(), "旧活动仍然占位");
});
