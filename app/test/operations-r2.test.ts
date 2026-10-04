import assert from "node:assert/strict";
import crypto from "node:crypto";
import { before, beforeEach, test } from "node:test";
import { NextRequest } from "next/server";
import { migrateAll, getDb } from "./helpers";
import { createOwner, createSession, SESSION_COOKIE } from "@/domain/session";
import { hashPassword } from "@/domain/password";
import { executeCommand, executeOperation, undoWithFollowUps } from "@/workflows/commands";
import { dayLedger, rebuildPlan } from "@/workflows/plan";
import { getPrefs } from "@/repositories/plan";
import { GET as listActions, POST as actionRoute } from "@/app/api/v2/actions/route";
import { POST as sessionRoute } from "@/app/api/v2/sessions/[id]/[action]/route";

/**
 * R2 操作注册表与学习块/任务操作（REPAIR-PLAN §4.3/§4.5/§5.1.1；E14、E25、E27、E33、E35、E37 的隔离行为）。
 * 固定 asOf（ctx.now），真实执行器、真实重排、真实路由处理函数。
 */

const TZ = "Asia/Shanghai";
const at = (local: string) => new Date(`${local}:00+08:00`);
const ctx = (now: Date, extra: Record<string, unknown> = {}) => ({ intakeId: null, itemId: null, itemKey: "", instanceEpoch: 0, evidence: "", now, ...extra });
type S = { id: string; task_id: string; start_utc: string; end_utc: string; status: string; version: number; origin: string; kind: string; reason: string; locked: number };
let sessionToken = "";
let csrfToken = "";
let seq = 0;

function addTask(title: string, estimate: number | null, extra: { dueAt?: string; createdAt?: string } = {}): string {
  const id = crypto.randomUUID();
  const created = extra.createdAt ?? "2026-10-01T00:00:00.000Z";
  getDb()
    .prepare(`INSERT INTO tasks (id, title, description, status, priority, estimate_minutes, due_kind, due_timezone, due_at, created_at, updated_at) VALUES (?, ?, '', 'todo', 'normal', ?, ?, ?, ?, ?, ?)`)
    .run(id, title, estimate, extra.dueAt ? "instant" : "none", extra.dueAt ? TZ : null, extra.dueAt ?? null, created, created);
  getDb().prepare("UPDATE tasks SET task_kind = 'study' WHERE id = ?").run(id);
  return id;
}
function addFixed(title: string, date: string, start: string, end: string) {
  const weekday = ((new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7) + 1;
  getDb().prepare(`INSERT INTO fixed_events (id, title, weekday, local_start, local_end, timezone, event_date) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(crypto.randomUUID(), title, weekday, start, end, TZ, date);
}
const blocks = (taskId?: string) =>
  (getDb().prepare(`SELECT * FROM plan_sessions WHERE status IN ('planned','tentative','in_progress') ORDER BY start_utc`).all() as S[]).filter((s) => !taskId || s.task_id === taskId);
const minutes = (s: S) => (Date.parse(s.end_utc) - Date.parse(s.start_utc)) / 60000;
const local = (iso: string) => new Date(Date.parse(iso) + 8 * 3600_000).toISOString().slice(0, 16).replace("T", " ");
function req(url: string, method: string, body?: unknown): NextRequest {
  return new NextRequest(`http://localhost${url}`, {
    method,
    headers: { cookie: `${SESSION_COOKIE}=${sessionToken}`, "x-csrf-token": csrfToken, "content-type": "application/json", "idempotency-key": `ops-${seq++}` },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

before(() => {
  migrateAll();
  createOwner(hashPassword("ops-test-pass"));
  const { token, session } = createSession(1);
  sessionToken = token;
  csrfToken = session.csrfToken;
});

beforeEach(() => {
  const db = getDb();
  for (const t of ["agent_action_changes", "agent_action_batches", "plan_sessions", "practice_entries", "planning_policy_rules", "fixed_event_exceptions", "fixed_events", "entity_source_links", "tasks"]) db.prepare(`DELETE FROM ${t}`).run();
});

test("E25：“把今晚微积分挪到明天下午”——24h 内的指定块按主人指令直接挪，同一个块、没有副本，其他不动", () => {
  const asOf = at("2026-10-12T18:30"); // 周一晚
  const calc = addTask("微积分复习", 60, { createdAt: "2026-10-01T00:00:00.000Z" });
  const other = addTask("英语听力", 30, { createdAt: "2026-10-01T00:00:01.000Z" });
  rebuildPlan(asOf);
  const [block] = blocks(calc);
  const [otherBlock] = blocks(other);
  assert.ok(block && local(block.start_utc).startsWith("2026-10-12"), "原本排在今晚");

  const out = executeOperation({ command: "reschedule_session", sessionId: block.id, targetDate: "2026-10-13", part: "afternoon" }, ctx(asOf, { explicit: true }));
  assert.ok(out.result.ok, out.result.ok ? "" : out.result.error);
  const moved = blocks(calc);
  assert.equal(moved.length, 1, "不复制任务、没有副本");
  assert.equal(moved[0]!.id, block.id, "同一个块原地移动");
  assert.equal(local(moved[0]!.start_utc), "2026-10-13 13:00", "明天下午最早可行的时段（午餐后）");
  assert.equal(minutes(moved[0]!), 60);
  assert.equal(moved[0]!.origin, "user");
  assert.match(out.result.ok ? out.result.summary : "", /挪到 10\/13 13:00–14:00/);
  const stillOther = blocks(other);
  assert.equal(stillOther[0]!.id, otherBlock!.id, "其他块不动");
  assert.equal(stillOther[0]!.start_utc, otherBlock!.start_utc);
  assert.equal(out.followUps[0]!.state, "unchanged", "挪动本身不引发别的重排");

  // 之后的自动重排不再挪主人指定位置的块
  addTask("新任务", 90, { createdAt: "2026-10-02T00:00:00.000Z" });
  rebuildPlan(asOf);
  assert.equal(blocks(calc)[0]!.start_utc, moved[0]!.start_utc);

  // 撤销恢复原时段
  assert.equal(undoWithFollowUps(out.result.ok ? out.result.batchId! : "").kind, "undone");
  assert.equal(blocks(calc)[0]!.start_utc, block.start_utc);
});

test("挪动的硬约束：撞课、晚于截止、超预算、没有连续空档——都不执行，并说明具体缺什么", () => {
  const asOf = at("2026-10-12T08:00");
  const report = addTask("实验报告", 60, { dueAt: at("2026-10-13T12:00").toISOString() });
  rebuildPlan(asOf);
  const [block] = blocks(report);
  addFixed("组会", "2026-10-13", "09:00", "10:30");
  const run = (args: Record<string, unknown>) => executeCommand({ command: "reschedule_session", sessionId: block!.id, ...args }, ctx(asOf));

  const clash = run({ targetDate: "2026-10-13", startLocalTime: "09:30" });
  assert.equal(clash.ok ? "" : clash.code, "SLOT_CONFLICT");
  assert.match(clash.ok ? "" : clash.error, /组会/);
  const late = run({ targetDate: "2026-10-13", part: "afternoon" });
  assert.equal(late.ok ? "" : late.code, "DEADLINE_CONFLICT", "涉及正式截止先告知，不默默执行");
  assert.match(late.ok ? "" : late.error, /10\/13 12:00 截止/);
  getDb().prepare(`INSERT INTO practice_entries (id, occurred_on, actual_minutes, minutes_origin, note, category, created_at, updated_at) VALUES (?, '2026-10-12', 150, 'user_reported', '', 'study', 'x', 'x')`).run(crypto.randomUUID());
  const budget = run({ targetDate: "2026-10-12", part: "evening" });
  assert.equal(budget.ok ? "" : budget.code, "OVER_BUDGET");
  assert.match(budget.ok ? "" : budget.error, /只剩 30 分钟/);
  addFixed("社团活动", "2026-10-14", "08:00", "11:50");
  const none = run({ targetDate: "2026-10-14", part: "morning" });
  assert.equal(none.ok ? "" : none.code, "NO_SLOT");
  assert.equal(blocks(report)[0]!.start_utc, block!.start_utc, "失败时原安排不变");
  assert.equal((getDb().prepare(`SELECT COUNT(*) AS n FROM agent_action_batches WHERE command = 'reschedule_session'`).get() as { n: number }).n, 0, "失败不留 journal");
});

test("“这次复习只留半小时”：只改这一段，任务总需求不变；进行中的块挪走时保留已发生投入", () => {
  const asOf = at("2026-10-12T08:00");
  const calc = addTask("微积分复习", 90);
  rebuildPlan(asOf);
  const [block] = blocks(calc);
  assert.equal(minutes(block!), 90);
  const r = executeCommand({ command: "reschedule_session", sessionId: block!.id, durationMinutes: 30, startLocalTime: local(block!.start_utc).slice(11) }, ctx(asOf));
  assert.ok(r.ok, r.ok ? "" : r.error);
  assert.equal(minutes(blocks(calc)[0]!), 30);
  assert.equal((getDb().prepare(`SELECT estimate_minutes FROM tasks WHERE id = ?`).get(calc) as { estimate_minutes: number }).estimate_minutes, 90, "不默默修改任务总需求");

  // 进行中：已学 20 分钟后说“剩下的挪到明天上午”
  const start = Date.parse(blocks(calc)[0]!.start_utc);
  getDb().prepare(`UPDATE plan_sessions SET status = 'in_progress' WHERE id = ?`).run(block!.id);
  const mid = new Date(start + 20 * 60000);
  const split = executeCommand({ command: "reschedule_session", sessionId: block!.id, targetDate: "2026-10-13", part: "morning" }, ctx(mid));
  assert.ok(split.ok, split.ok ? "" : split.error);
  const done = getDb().prepare(`SELECT status, end_utc FROM plan_sessions WHERE id = ?`).get(block!.id) as { status: string; end_utc: string };
  assert.equal(done.status, "completed");
  assert.equal(done.end_utc, mid.toISOString(), "已发生的 20 分钟留在原处，不挪到未来");
  const rest = blocks(calc);
  assert.equal(rest.length, 1);
  assert.equal(minutes(rest[0]!), 10, "只挪剩余部分");
  assert.ok(local(rest[0]!.start_utc).startsWith("2026-10-13"));
});

test("E35：卡片按钮与统一操作同一执行器——开始/完成记实际分钟，预算同步；过期版本 409；未知操作 422", async () => {
  const asOf = new Date();
  const taskId = addTask("线代作业", 60);
  rebuildPlan(asOf);
  const [block] = blocks(taskId);
  const call = (action: string, body: unknown) => sessionRoute(req(`/api/v2/sessions/${block!.id}/${action}`, "POST", body), { params: Promise.resolve({ id: block!.id, action }) });
  assert.equal((await call("start", { expectedVersion: block!.version })).status, 200);
  assert.equal((await call("complete", { expectedVersion: block!.version })).status, 409, "过期版本不执行");
  const res = await call("complete", { expectedVersion: block!.version + 1, actualMinutes: 45 });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { result: { state: string; undo: { available: boolean; batchId: string } } };
  assert.equal(body.result.state, "applied");
  assert.equal(body.result.undo.available, true, "按钮操作同样进 journal、可撤销");
  const practice = getDb().prepare(`SELECT actual_minutes, task_id, plan_session_id FROM practice_entries`).all();
  assert.deepEqual(practice, [{ actual_minutes: 45, task_id: taskId, plan_session_id: block!.id }]);
  assert.equal((getDb().prepare(`SELECT status FROM tasks WHERE id = ?`).get(taskId) as { status: string }).status, "todo", "完成学习块不等于完成任务");
  assert.equal((await call("teleport", { expectedVersion: 1 })).status, 422);

  const list = (await (await listActions(req("/api/v2/actions", "GET"))).json()) as { operations: Array<{ name: string }> };
  assert.ok(list.operations.some((o) => o.name === "reschedule_session"));
  const unknown = await actionRoute(req("/api/v2/actions", "POST", { operation: "drop_all_tables", args: {} }));
  assert.equal(unknown.status, 422);
  const ok = await actionRoute(req("/api/v2/actions", "POST", { operation: "complete_task", args: { taskId } }));
  assert.equal(ok.status, 200);
  assert.equal((getDb().prepare(`SELECT status FROM tasks WHERE id = ?`).get(taskId) as { status: string }).status, "done", "同一实体、同一服务，没有第二份对象");
});

test("E37：未知操作显式拒绝、不兜底成任务；资料里的文字不能触发需要主人明确指令的操作；旧周期请求不执行", () => {
  const before1 = (getDb().prepare(`SELECT COUNT(*) AS n FROM tasks`).get() as { n: number }).n;
  const unknown = executeCommand({ command: "delete_everything", title: "看起来像任务的参数" }, ctx(new Date()));
  assert.equal(unknown.ok ? "" : unknown.code, "UNKNOWN_OPERATION");
  assert.equal((getDb().prepare(`SELECT COUNT(*) AS n FROM tasks`).get() as { n: number }).n, before1, "不会掉进任务创建");

  const taskId = addTask("别人的要求", 30);
  const fromMaterial = executeCommand({ command: "complete_task", taskId }, ctx(new Date(), { explicit: false }));
  assert.equal(fromMaterial.ok ? "" : fromMaterial.code, "NOT_AUTHORIZED");
  assert.equal((getDb().prepare(`SELECT status FROM tasks WHERE id = ?`).get(taskId) as { status: string }).status, "todo");
  const auto = executeCommand({ command: "record_practice", occurredOn: "2026-10-12", actualMinutes: 20, note: "读资料" }, ctx(new Date(), { explicit: false }));
  assert.equal(auto.ok, true, "明确且可逆的记录类操作可以自动执行");
  const stale = executeCommand({ command: "complete_task", taskId }, ctx(new Date(), { instanceEpoch: 99 }));
  assert.equal(stale.ok ? "" : stale.code, "STALE_EPOCH");
  const forged = executeCommand({ command: "complete_task", taskId, explicit: true, instanceEpoch: 0, actor: "owner" }, ctx(new Date(), { explicit: false }));
  assert.equal(forged.ok ? "" : forged.code, "NOT_AUTHORIZED", "参数里伪造的权限字段不起作用");
});

test("暂停任务：让出未执行块、到期前不排、到期自动恢复；不是取消任务", () => {
  const asOf = at("2026-10-12T08:00");
  const lab = addTask("基线实验", 90);
  rebuildPlan(asOf);
  assert.equal(blocks(lab).length, 1);
  const out = executeOperation({ command: "pause_task", taskId: lab, until: "2026-10-19" }, ctx(asOf));
  assert.ok(out.result.ok);
  assert.match(out.result.ok ? out.result.summary : "", /让出 1 个还没开始的学习块/);
  assert.equal(blocks(lab).length, 0);
  assert.equal((getDb().prepare(`SELECT status FROM tasks WHERE id = ?`).get(lab) as { status: string }).status, "todo", "任务还在");
  rebuildPlan(at("2026-10-15T08:00"));
  assert.equal(blocks(lab).length, 0, "暂停期间不排");
  rebuildPlan(at("2026-10-19T08:00"));
  assert.equal(blocks(lab).length, 1, "到期后恢复安排");
});

test("E33：“其实那次只用了40分钟”——纠正原记录而不是新增，预算随之刷新，可撤销", () => {
  const taskId = addTask("数据结构", 180);
  const rec = executeCommand({ command: "record_practice", occurredOn: "2026-10-12", actualMinutes: 90, note: "数据结构", taskId }, ctx(new Date()));
  assert.ok(rec.ok);
  const id = (getDb().prepare(`SELECT id FROM practice_entries`).get() as { id: string }).id;
  const prefs = getPrefs();
  assert.equal(dayLedger("2026-10-12", at("2026-10-12T20:00"), prefs, TZ).bDay, 90);
  const fix = executeCommand({ command: "correct_practice", practiceId: id, actualMinutes: 40 }, ctx(new Date()));
  assert.ok(fix.ok, fix.ok ? "" : fix.error);
  assert.match(fix.ok ? fix.summary : "", /90 分钟 → 40 分钟/);
  assert.equal((getDb().prepare(`SELECT COUNT(*) AS n FROM practice_entries`).get() as { n: number }).n, 1, "实际更新不重复");
  assert.equal(dayLedger("2026-10-12", at("2026-10-12T20:00"), prefs, TZ).bDay, 40, "预算一致刷新");
  const history = getDb().prepare(`SELECT before_json FROM agent_action_changes WHERE entity_kind = 'practice_entry' AND action = 'update'`).get() as { before_json: string };
  assert.deepEqual(JSON.parse(history.before_json), { actualMinutes: 90 }, "旧值保留在变更历史");
  assert.equal(undoWithFollowUps(fix.ok ? fix.batchId! : "").kind, "undone");
  assert.equal(dayLedger("2026-10-12", at("2026-10-12T20:00"), prefs, TZ).bDay, 90);
});

test("E14 前半：工作量未知的任务只排一次 25 分钟起步块，做过之后不无限续排；报告剩余后按剩余安排", () => {
  const asOf = at("2026-10-12T08:00");
  const taskId = addTask("读懂那篇论文", null);
  const r1 = rebuildPlan(asOf);
  const [starter] = blocks(taskId);
  assert.ok(starter);
  assert.equal(starter.kind, "starter");
  assert.equal(minutes(starter), 25, "不为塞进碎片把未知任务缩成 5 分钟，也不假装覆盖全部工作量");
  assert.match(starter.reason, /工作量还不清楚/);
  assert.deepEqual(r1.unscheduled, []);
  assert.equal(rebuildPlan(asOf).changed, false, "重算不产生第二个起步块");

  getDb().prepare(`UPDATE plan_sessions SET status = 'completed' WHERE id = ?`).run(starter.id);
  const r2 = rebuildPlan(at("2026-10-12T12:00"));
  assert.equal(blocks(taskId).length, 0, "起步块做完后不自动续排");
  assert.deepEqual(r2.unscheduled.map((u) => u.reason), ["unknown_requirement"], "需要结合反馈才知道下一步");

  const report = executeOperation({ command: "create_or_update_task", taskId, remainingMinutes: 60 }, ctx(at("2026-10-12T12:00")));
  assert.ok(report.result.ok);
  assert.equal(blocks(taskId).reduce((a, s) => a + minutes(s), 0), 60, "按主人报告的剩余需求安排");
  assert.equal(report.followUps[0]!.state, "updated");
});

test("E13：deliverable 投入达估时后等主人报告剩余；报告“还差30分钟”后只排 30", () => {
  const asOf = at("2026-10-12T08:00");
  const taskId = addTask("复现基线", 60);
  rebuildPlan(asOf);
  for (const s of blocks(taskId)) getDb().prepare(`UPDATE plan_sessions SET status = 'completed', updated_at = ? WHERE id = ?`).run("2026-10-12T04:00:00.000Z", s.id);
  const later = at("2026-10-13T08:00");
  assert.deepEqual(rebuildPlan(later).unscheduled.map((u) => u.reason), ["needs_remaining_estimate"]);
  const out = executeOperation({ command: "create_or_update_task", taskId, remainingMinutes: 30 }, ctx(later));
  assert.ok(out.result.ok);
  assert.equal(blocks(taskId).reduce((a, s) => a + minutes(s), 0), 30);
  assert.deepEqual(out.followUps[0]!.unscheduled, []);
});

test("E27：撤销一次调整时连同它引起的重排一起撤，不留下重复块；之后又改过的对象不被覆盖", () => {
  const asOf = at("2026-10-12T18:30");
  const calc = addTask("微积分复习", 60);
  rebuildPlan(asOf);
  const [tonight] = blocks(calc);
  const off = executeOperation({ command: "update_planning_policy", rules: [{ kind: "no_study", dateFrom: "2026-10-12", dateTo: "2026-10-12", scope: "temporary", value: { fromTime: "18:30", label: "今晚不学" } }] }, ctx(asOf));
  assert.ok(off.result.ok && off.followUps[0]!.state === "updated");
  const replaced = blocks(calc);
  assert.equal(replaced.length, 1);
  assert.notEqual(replaced[0]!.id, tonight!.id);

  assert.equal(undoWithFollowUps(off.result.ok ? off.result.batchId! : "").kind, "undone");
  const restored = blocks(calc);
  assert.deepEqual(restored.map((s) => s.id), [tonight!.id], "恢复原来的块，替换出来的块一并撤掉，没有副本");
  assert.equal(rebuildPlan(asOf).changed, false, "撤销后的状态自洽，重算无变化");

  // 再来一次，但撤销前主人又动了那块：整体不动并说明冲突
  const again = executeOperation({ command: "update_planning_policy", rules: [{ kind: "no_study", dateFrom: "2026-10-12", dateTo: "2026-10-12", scope: "temporary", value: { fromTime: "18:30", label: "今晚不学" } }] }, ctx(asOf));
  getDb().prepare(`UPDATE plan_sessions SET locked = 1, version = version + 1 WHERE id = ?`).run(tonight!.id);
  const conflict = undoWithFollowUps(again.result.ok ? again.result.batchId! : "");
  assert.equal(conflict.kind, "conflict");
  assert.equal(blocks(calc).length, 1, "冲突时整体不动：重排出来的块还在，没有半撤");
});
