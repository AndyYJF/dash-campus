import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { NextRequest } from "next/server";
import { migrateAll, getDb } from "./helpers";
import { createOwner, createSession, SESSION_COOKIE } from "@/domain/session";
import { hashPassword } from "@/domain/password";
import { setNowForTests } from "@/domain/clock";
import { runDueJobsOnce } from "@/worker/runner";
import { getPlanningRevision, planIsStale } from "@/repositories/proposals";
import { undoWithFollowUps } from "@/workflows/commands";
import { eventsForDay } from "@/workflows/plan";
import { POST as importTimetableRoute } from "@/app/api/v1/timetable/import/route";
import { POST as createTaskRoute } from "@/app/api/v1/tasks/route";
import { PATCH as patchTaskRoute } from "@/app/api/v1/tasks/[id]/route";
import { GET as weekRoute } from "@/app/api/v2/week/route";
import { POST as sessionActionRoute } from "@/app/api/v2/sessions/[id]/[action]/route";

/**
 * 旧兼容接口与统一通路对齐（AGENT-INTERFACE-CONTRACT §6；E35、E02 的隔离行为）：
 * 设置页导入课表走同一个课程操作；v1 任务接口改动后学习安排自动对账；同一个任务对象，没有第二份。
 * 规划时钟固定在 2026-10-12（周一）18:30。
 */

const NOW = new Date("2026-10-12T18:30:00+08:00");
const TZ = "Asia/Shanghai";
const SDCT = ["SDCT1", "T=18", "P=1,08:15-09:00;2,09:10-09:55;3,10:15-11:00;4,11:10-11:55", "C=高等数学|张老师|A101|3|1-2|1-18|A|-", "C=形势与政策|李老师|B202|3|3-4|6,10|A|-"].join("\n");

let sessionToken = "";
let csrfToken = "";
let seq = 0;
function req(url: string, method: string, body?: unknown): NextRequest {
  return new NextRequest(`http://localhost${url}`, {
    method,
    headers: { cookie: `${SESSION_COOKIE}=${sessionToken}`, "x-csrf-token": csrfToken, "content-type": "application/json", ...(method !== "GET" ? { "idempotency-key": `compat-${seq++}` } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}
const count = (sql: string, ...args: unknown[]) => (getDb().prepare(sql).get(...args) as { n: number }).n;
type Block = { id: string; start_utc: string; end_utc: string; version: number; status: string };
const blocksOf = (taskId: string) => getDb().prepare(`SELECT id, start_utc, end_utc, version, status FROM plan_sessions WHERE task_id = ? AND status IN ('planned','tentative','in_progress') ORDER BY start_utc`).all(taskId) as Block[];

before(() => {
  migrateAll();
  setNowForTests(NOW);
  createOwner(hashPassword("compat-test-pass"));
  const { token, session } = createSession(1);
  sessionToken = token;
  csrfToken = session.csrfToken;
});
after(() => setNowForTests(null));

test("E02：设置页导入课表（v1 接口）直接进入课程语义层——今天/本周显示为课程、可撤销；重复导入不新增副本；响应形状不变", async () => {
  const res = await importTimetableRoute(req("/api/v1/timetable/import", "POST", { text: SDCT, firstMonday: "2026-08-31", timezone: TZ, expectedRevision: getPlanningRevision() }));
  assert.equal(res.status, 201, await res.clone().text());
  const body = (await res.json()) as { created: number; skipped: number; ids: string[]; planningRevision: number; batchId: string };
  assert.equal(body.created, body.ids.length);
  assert.ok(body.created >= 2);
  assert.equal(body.planningRevision, getPlanningRevision());

  // 第 7 周周三：高等数学有课，仅 6/10 周的形势与政策没有；都是“课程”而不是无资料的占用
  const wed = eventsForDay("2026-10-14", TZ);
  assert.deepEqual(wed.map((e) => [e.kind, e.title.split(" · ")[0]]), [["course", "高等数学"]]);
  const week = (await (await weekRoute(req("/api/v2/week?date=2026-10-12", "GET"))).json()) as { days: Array<{ date: string; courseMinutes: number }>; teachingWeek: number | null };
  assert.equal(week.teachingWeek, 7);
  assert.equal(week.days.find((d) => d.date === "2026-10-14")!.courseMinutes, 100, "课程占用不是零");

  const fixedBefore = count(`SELECT COUNT(*) AS n FROM fixed_events`);
  const again = await importTimetableRoute(req("/api/v1/timetable/import", "POST", { text: SDCT, firstMonday: "2026-08-31", timezone: TZ, expectedRevision: getPlanningRevision() }));
  assert.equal(again.status, 201);
  const second = (await again.json()) as { created: number; batchId: string | null };
  assert.deepEqual([second.created, second.batchId], [0, null], "同一份课表再导一次：没有变化");
  assert.equal(count(`SELECT COUNT(*) AS n FROM fixed_events`), fixedBefore, "重复来源不新增副本");
  assert.equal(count(`SELECT COUNT(*) AS n FROM course_sets WHERE status = 'active'`), 1);

  const stale = await importTimetableRoute(req("/api/v1/timetable/import", "POST", { text: SDCT, firstMonday: "2026-08-31", timezone: TZ, expectedRevision: getPlanningRevision() - 1 }));
  assert.equal(stale.status, 409, "预览之后别处改过：照旧要求重新预览");

  assert.equal(undoWithFollowUps(body.batchId).kind, "undone");
  assert.equal(eventsForDay("2026-10-14", TZ).length, 0, "和统一入口导入的一样可以整批撤销");
});

test("E35：v1 接口建的任务就是 V2 排的那个任务——worker 自动补一次重排；改估时后安排跟着变；从卡片完成后实际投入记在同一任务上", async () => {
  const created = await createTaskRoute(req("/api/v1/tasks", "POST", { title: "旧表单建的任务", estimateMinutes: 60 }));
  assert.equal(created.status, 201, await created.clone().text());
  const task = { id: ((await created.json()) as { id: string }).id, version: 1 };
  assert.equal(blocksOf(task.id).length, 0, "旧接口本身不排");
  assert.equal(planIsStale(), true);

  await runDueJobsOnce();
  assert.equal(planIsStale(), false);
  const first = blocksOf(task.id);
  assert.equal(first.length, 1, "worker 发现规划事实变了，补一次确定性重排");
  assert.equal((Date.parse(first[0]!.end_utc) - Date.parse(first[0]!.start_utc)) / 60000, 60);
  const batches = count(`SELECT COUNT(*) AS n FROM agent_action_batches`);
  await runDueJobsOnce();
  assert.equal(count(`SELECT COUNT(*) AS n FROM agent_action_batches`), batches, "没有新变化就不再重排、不写批次");

  // 旧编辑表单把估时改成 120：同一个任务，缺的 60 分钟被补排（近 24 小时内已有的块不动）
  const patched = await patchTaskRoute(req(`/api/v1/tasks/${task.id}`, "PATCH", { expectedVersion: task.version, estimateMinutes: 120 }), { params: Promise.resolve({ id: task.id }) });
  assert.equal(patched.status, 200, await patched.clone().text());
  await runDueJobsOnce();
  const second = blocksOf(task.id);
  assert.equal(second.reduce((s, b) => s + (Date.parse(b.end_utc) - Date.parse(b.start_utc)) / 60000, 0), 120);
  assert.ok(second.some((b) => b.id === first[0]!.id), "原来的块还是那一个");
  assert.equal(count(`SELECT COUNT(*) AS n FROM tasks WHERE title = '旧表单建的任务'`), 1, "没有第二份任务");

  // 卡片入口完成这个块 → 旧接口读到的是同一任务
  const b = second[0]!;
  const start = await sessionActionRoute(req(`/api/v2/sessions/${b.id}/start`, "POST", { expectedVersion: b.version }), { params: Promise.resolve({ id: b.id, action: "start" }) });
  assert.equal(start.status, 200, await start.clone().text());
  const v = (getDb().prepare(`SELECT version FROM plan_sessions WHERE id = ?`).get(b.id) as { version: number }).version;
  const done = await sessionActionRoute(req(`/api/v2/sessions/${b.id}/complete`, "POST", { expectedVersion: v, actualMinutes: 25 }), { params: Promise.resolve({ id: b.id, action: "complete" }) });
  assert.equal(done.status, 200, await done.clone().text());
  assert.equal(count(`SELECT COUNT(*) AS n FROM practice_entries WHERE task_id = ? AND actual_minutes = 25`, task.id), 1, "实际投入记在同一个任务上");
});
