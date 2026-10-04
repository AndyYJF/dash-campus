import assert from "node:assert/strict";
import crypto from "node:crypto";
import { before, test } from "node:test";
import { migrateAll, getDb } from "./helpers";
import { estimateAdvice } from "@/domain/estimate-advice";
import { parseInstruction } from "@/domain/intent";
import { executeCommand, executeOperation, undoWithFollowUps } from "@/workflows/commands";
import { getAiBudget } from "@/workflows/ai-budget";
import { rebuildPlan } from "@/workflows/plan";
import { getIntake } from "@/repositories/intakes";
import { intakeResultView } from "@/workflows/results";

/**
 * R4 策略（REPAIR-PLAN §4.4/§4.5；E16、E17 与估时建议、主动程度的隔离行为）。固定时钟。
 */

const TZ = "Asia/Shanghai";
const CTX = { intakeId: null, itemId: null, itemKey: "", instanceEpoch: 0, evidence: "" };
const at = (local: string) => new Date(`${local}:00+08:00`);
const local = (iso: string) => new Date(Date.parse(iso) + 8 * 3600_000).toISOString().slice(0, 16).replace("T", " ");
type S = { id: string; task_id: string; start_utc: string; end_utc: string; reason: string };

function addTask(title: string, estimate: number | null, extra: { dueAt?: string; status?: string; projectId?: string | null; createdAt?: string } = {}): string {
  const id = crypto.randomUUID();
  const created = extra.createdAt ?? "2026-10-01T00:00:00.000Z";
  getDb()
    .prepare(`INSERT INTO tasks (id, title, description, status, priority, estimate_minutes, due_kind, due_timezone, due_at, project_id, created_at, updated_at) VALUES (?, ?, '', ?, 'normal', ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, title, extra.status ?? "todo", estimate, extra.dueAt ? "instant" : "none", extra.dueAt ? TZ : null, extra.dueAt ?? null, extra.projectId ?? null, created, created);
  getDb().prepare("UPDATE tasks SET task_kind = 'study' WHERE id = ?").run(id);
  return id;
}
function addFixed(title: string, date: string, start: string, end: string) {
  const weekday = ((new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7) + 1;
  getDb().prepare(`INSERT INTO fixed_events (id, title, weekday, local_start, local_end, timezone, event_date) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(crypto.randomUUID(), title, weekday, start, end, TZ, date);
}
const sessions = (taskId: string) => getDb().prepare(`SELECT * FROM plan_sessions WHERE task_id = ? AND status IN ('planned','tentative') ORDER BY start_utc`).all(taskId) as S[];
function reset() {
  const db = getDb();
  for (const t of ["agent_action_changes", "agent_action_batches", "plan_sessions", "practice_entries", "planning_policy_rules", "course_meeting_projections", "course_meetings", "courses", "course_sets", "semesters", "fixed_events", "entity_source_links", "tasks"]) db.prepare(`DELETE FROM ${t}`).run();
}

before(() => migrateAll());

test("估时建议：至少 3 个可比样本才给，中位数比例限制在 0.5–2 倍，偏差小不打扰", () => {
  assert.equal(estimateAdvice(60, [{ estimateMinutes: 60, actualMinutes: 90 }, { estimateMinutes: 30, actualMinutes: 45 }]), null, "两个样本不够");
  assert.deepEqual(estimateAdvice(60, [{ estimateMinutes: 60, actualMinutes: 90 }, { estimateMinutes: 30, actualMinutes: 45 }, { estimateMinutes: 40, actualMinutes: 50 }]), { ratio: 1.5, samples: 3, suggestedMinutes: 90 });
  assert.equal(estimateAdvice(60, [{ estimateMinutes: 10, actualMinutes: 100 }, { estimateMinutes: 10, actualMinutes: 90 }, { estimateMinutes: 10, actualMinutes: 80 }])!.ratio, 2, "封顶 2 倍");
  assert.equal(estimateAdvice(60, [{ estimateMinutes: 60, actualMinutes: 62 }, { estimateMinutes: 60, actualMinutes: 58 }, { estimateMinutes: 60, actualMinutes: 63 }]), null);
});

test("估时建议出现在结果里但不改主人的估时", () => {
  reset();
  const db = getDb();
  for (const [est, act] of [[60, 95], [30, 44], [40, 62]] as const) {
    const id = addTask(`历史任务${est}`, est, { status: "done" });
    db.prepare(`INSERT INTO practice_entries (id, task_id, occurred_on, actual_minutes, minutes_origin, note, category, created_at, updated_at) VALUES (?, ?, '2026-10-01', ?, 'user_reported', '', 'study', 'x', 'x')`).run(crypto.randomUUID(), id, act);
  }
  const intakeId = crypto.randomUUID();
  db.prepare(`INSERT INTO intakes (id, channel, text, reference_date, timezone, status, instance_epoch, created_at, updated_at) VALUES (?, 'web', '新任务', '2026-10-05', ?, 'completed', 0, 'x', 'x')`).run(intakeId, TZ);
  const r = executeCommand({ command: "create_or_update_task", title: "新的练习", estimateMinutes: 60 }, { ...CTX, intakeId });
  assert.ok(r.ok);
  const view = intakeResultView(getIntake(intakeId)!);
  assert.ok(view.nextActions.some((a) => /你估 60 分钟；最近 3 个同类任务实际用时约为估时的 1\.55 倍，可能要 95 分钟左右（只是参考，没有改你的估时）/.test(a)), JSON.stringify(view.nextActions));
  assert.equal((db.prepare(`SELECT estimate_minutes FROM tasks WHERE title = '新的练习'`).get() as { estimate_minutes: number }).estimate_minutes, 60);
});

test("E16：课很满的那天不压无截止的集中任务；截止任务仍然最早可行优先；已知短收尾可以用短块", () => {
  reset();
  const asOf = at("2026-10-12T07:00"); // 周一
  // 周一课很满（5 小时），周二空
  addFixed("上午连堂", "2026-10-12", "08:30", "11:30");
  addFixed("下午实验", "2026-10-12", "14:00", "16:00");
  const db = getDb();
  // 让它们算作课程占用：补上课程投影
  const semester = crypto.randomUUID(), set = crypto.randomUUID(), course = crypto.randomUUID();
  db.prepare(`INSERT INTO semesters (id, first_monday, total_weeks, timezone, created_at, updated_at) VALUES (?, '2026-08-31', 18, ?, 'x', 'x')`).run(semester, TZ);
  db.prepare(`INSERT INTO course_sets (id, semester_id, created_at, updated_at) VALUES (?, ?, 'x', 'x')`).run(set, semester);
  db.prepare(`INSERT INTO courses (id, course_set_id, name, created_at, updated_at) VALUES (?, ?, '连堂课', 'x', 'x')`).run(course, set);
  for (const fe of db.prepare(`SELECT id FROM fixed_events`).all() as Array<{ id: string }>) {
    const m = crypto.randomUUID();
    db.prepare(`INSERT INTO course_meetings (id, course_id, weekday, local_start, local_end, weeks_json, created_at, updated_at) VALUES (?, ?, 1, '08:30', '11:30', '[7]', 'x', 'x')`).run(m, course);
    db.prepare(`INSERT INTO course_meeting_projections (id, meeting_id, fixed_event_id, source_version, rule_hash, created_at) VALUES (?, ?, ?, 1, ?, 'x')`).run(crypto.randomUUID(), m, fe.id, fe.id);
  }
  const lab = addTask("基线实验（无截止）", 90, { createdAt: "2026-10-01T00:00:00.000Z" });
  const report = addTask("今晚截止的小结", 40, { dueAt: at("2026-10-12T21:00").toISOString(), createdAt: "2026-10-02T00:00:00.000Z" });
  const wrap = addTask("收尾", 15, { createdAt: "2026-10-03T00:00:00.000Z" });
  rebuildPlan(asOf);
  const [labBlock] = sessions(lab);
  assert.ok(local(labBlock!.start_utc).startsWith("2026-10-13"), `无截止的集中任务放到更宽裕的周二：${local(labBlock!.start_utc)}`);
  assert.match(labBlock!.reason, /10\/12 课比较满/, "解释里写出为什么没排在周一");
  const [rep] = sessions(report);
  assert.ok(local(rep!.start_utc).startsWith("2026-10-12"), "有截止的必要事项不因课满而拖后");
  assert.ok(Date.parse(rep!.end_utc) <= at("2026-10-12T21:00").getTime());
  const [w] = sessions(wrap);
  assert.equal((Date.parse(w!.end_utc) - Date.parse(w!.start_utc)) / 60000, 15, "已知只剩 15 分钟：短收尾块");
});

test("E17：没有需求就留白；预算够但全是碎片说“缺连续空档”；截止不可达说缺多少——三种原因分开", () => {
  reset();
  const asOf = at("2026-10-12T07:00");
  const empty = rebuildPlan(asOf);
  assert.equal(empty.placed, 0);
  assert.equal(empty.batchId, null, "没有任务就不制造安排，也不写批次");

  // 一周每天都被切成 20 分钟以内的碎片（除三餐外每半小时有 10 分钟占用）
  for (let d = 0; d < 7; d++) {
    const date = new Date(Date.UTC(2026, 9, 12 + d)).toISOString().slice(0, 10);
    for (let m = 8 * 60; m < 22 * 60; m += 30) addFixed("碎片占用", date, `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`, `${String(Math.floor((m + 10) / 60)).padStart(2, "0")}:${String((m + 10) % 60).padStart(2, "0")}`);
  }
  const deep = addTask("需要整块时间的阅读", 60);
  const frag = rebuildPlan(asOf);
  assert.deepEqual(frag.unscheduled.filter((u) => u.taskId === deep).map((u) => [u.reason, u.missingMinutes]), [["no_contiguous_slot", 60]], "预算有、只是没有连续空档");
  assert.equal(sessions(deep).length, 0, "不为了塞进去把它切成 20 分钟的碎片");

  getDb().prepare(`DELETE FROM fixed_events`).run();
  const urgent = addTask("马上截止", 300, { dueAt: at("2026-10-12T12:00").toISOString() });
  const late = rebuildPlan(asOf);
  const u = late.unscheduled.find((x) => x.taskId === urgent)!;
  assert.equal(u.reason, "deadline_unfeasible");
  assert.ok((u.missingMinutes ?? 0) > 0, "说清缺多少分钟");
  assert.equal((getDb().prepare(`SELECT due_at FROM tasks WHERE id = ?`).get(urgent) as { due_at: string }).due_at, at("2026-10-12T12:00").toISOString(), "截止不动");
});

test("主动程度与模型预算：一句话调整，超限影响说清楚，可撤销", () => {
  const intents = parseInstruction("每天最多用20次模型，没新消息就别问我", "2026-10-12", at("2026-10-12T09:00"), TZ).intents.map((i) => i.intent);
  assert.deepEqual(intents, [{ op: "agent_policy", dailyModelCalls: 20 }, { op: "agent_policy", scheduledEnabled: false }]);
  const out = executeOperation({ command: "update_agent_policy", dailyModelCalls: 0, scheduledEnabled: false }, CTX);
  assert.ok(out.result.ok);
  assert.match(out.result.ok ? out.result.summary : "", /今天已到上限，新材料会先存原文、不做理解，直接下的指令和截止提醒不受影响/);
  assert.match(out.result.ok ? out.result.summary : "", /不再主动做定期探索和定期复盘/);
  assert.deepEqual([getAiBudget().budget.dailyModelCalls, getAiBudget().budget.scheduledEnabled], [0, false]);
  assert.equal(undoWithFollowUps(out.result.ok ? out.result.batchId! : "").kind, "undone");
  assert.equal(getAiBudget().budget.scheduledEnabled, true);
});

test("E15/R4：已确认“晚上集中学”后，同样条件下优先排晚上；不因此错过截止", () => {
  reset();
  getDb().prepare(`DELETE FROM planning_policy_rules`).run();
  const asOf = at("2026-10-13T07:00");
  const t1 = addTask("读论文", 60);
  rebuildPlan(asOf);
  assert.equal(local(sessions(t1)[0]!.start_utc).slice(11), "08:30", "没有偏好：最早可行");
  getDb().prepare(`DELETE FROM plan_sessions`).run();
  executeCommand({ command: "update_planning_policy", rules: [{ kind: "preferred_window", value: { part: "evening" } }] }, CTX);
  rebuildPlan(asOf);
  assert.equal(local(sessions(t1)[0]!.start_utc).slice(11), "19:00", "偏好晚上：排到晚间窗口");
  const due = addTask("中午前交", 30, { dueAt: at("2026-10-13T12:00").toISOString() });
  rebuildPlan(asOf);
  assert.ok(Date.parse(sessions(due)[0]!.end_utc) <= at("2026-10-13T12:00").getTime(), "偏好不能让截止任务错过截止");
});
