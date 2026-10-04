import assert from "node:assert/strict";
import crypto from "node:crypto";
import { after, before, test } from "node:test";
import { NextRequest } from "next/server";
import { migrateAll, getDb } from "./helpers";
import { createOwner, createSession, SESSION_COOKIE } from "@/domain/session";
import { hashPassword } from "@/domain/password";
import { setNowForTests } from "@/domain/clock";
import { setProvidersForTests } from "@/integrations";
import { FakeModelProvider } from "@/integrations/fake-model-provider";
import { runDueJobsOnce } from "@/worker/runner";
import { executeOperation, undoWithFollowUps } from "@/workflows/commands";
import { POST as createIntakeRoute } from "@/app/api/v2/intakes/route";
import { GET as getIntakeRoute } from "@/app/api/v2/intakes/[id]/route";

/**
 * 从时间轴空档直接安排（REPAIR-PLAN §3.2 “点空档带时段上下文安排”；E05/E27 的隔离行为）：
 * 注册操作 schedule_session + 统一入口带 slot 上下文两条链路。规划时钟固定在 2026-10-12（周一）18:30。
 */

const NOW = new Date("2026-10-12T18:30:00+08:00");
const TZ = "Asia/Shanghai";
const CTX = { intakeId: null, itemId: null, itemKey: "", instanceEpoch: 0, evidence: "", explicit: true, now: NOW };
const at = (local: string) => new Date(`${local}:00+08:00`);
const local = (iso: string) => new Date(Date.parse(iso) + 8 * 3600_000).toISOString().slice(0, 16).replace("T", " ");
type Row = { id: string; task_id: string; title: string; start_utc: string; end_utc: string; origin: string; reason: string };
const blocks = (like?: string) =>
  (getDb()
    .prepare(`SELECT s.id, s.task_id, t.title, s.start_utc, s.end_utc, s.origin, s.reason FROM plan_sessions s JOIN tasks t ON t.id = s.task_id WHERE s.status IN ('planned','tentative','in_progress') ORDER BY s.start_utc`)
    .all() as Row[]).filter((b) => !like || b.title.includes(like));
const span = (b: Row) => `${local(b.start_utc)}–${local(b.end_utc).slice(11)}`;

let sessionToken = "";
let csrfToken = "";
let seq = 0;
let modelCalls = 0;

function req(url: string, method: string, body?: unknown): NextRequest {
  return new NextRequest(`http://localhost${url}`, {
    method,
    headers: { cookie: `${SESSION_COOKIE}=${sessionToken}`, "x-csrf-token": csrfToken, "content-type": "application/json", ...(method === "POST" ? { "idempotency-key": `slot-${seq++}` } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}
type Result = { state: string; summary: string; undo: { available: boolean; batchIds: string[] }; items: Array<{ kind: string; state: string; error: string | null }>; questions: Array<{ prompt: string; options: string[] }> };
async function say(text: string, extra: Record<string, unknown> = {}): Promise<Result> {
  const res = await createIntakeRoute(req("/api/v2/intakes", "POST", { text, ...extra }));
  assert.equal(res.status, 202, await res.clone().text());
  const { intakeId } = (await res.json()) as { intakeId: string };
  for (let i = 0; i < 4; i++) await runDueJobsOnce();
  const got = await getIntakeRoute(req(`/api/v2/intakes/${intakeId}`, "GET"), { params: Promise.resolve({ id: intakeId }) });
  return ((await got.json()) as { result: Result }).result;
}
function addTask(title: string, estimate: number | null, dueAt?: string): string {
  const id = crypto.randomUUID();
  getDb()
    .prepare(`INSERT INTO tasks (id, title, description, status, priority, estimate_minutes, due_kind, due_timezone, due_at, created_at, updated_at) VALUES (?, ?, '', 'todo', 'normal', ?, ?, ?, ?, 'x', 'x')`)
    .run(id, title, estimate, dueAt ? "instant" : "none", dueAt ? TZ : null, dueAt ?? null);
  return id;
}
function addFixed(title: string, date: string, start: string, end: string) {
  const weekday = ((new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7) + 1;
  getDb().prepare(`INSERT INTO fixed_events (id, title, weekday, local_start, local_end, timezone, event_date) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(crypto.randomUUID(), title, weekday, start, end, TZ, date);
}

before(() => {
  migrateAll();
  setNowForTests(NOW);
  createOwner(hashPassword("slot-test-pass"));
  const { token, session } = createSession(1);
  sessionToken = token;
  csrfToken = session.csrfToken;
  setProvidersForTests({
    model: {
      mode: "fixture",
      provider: new FakeModelProvider((r) => {
        modelCalls++;
        const text = (r.context as { text: string }).text.trim();
        return { ok: true, validatedResult: { items: [{ itemKey: "item-1", kind: "task", summary: text.slice(0, 40), excerpt: text.slice(0, 100) }] } };
      }),
    },
  });
});
after(() => setNowForTests(null));

test("schedule_session：新建任务并原样排在指定时段；后续重排不再给它多排；撤销连任务一起撤", () => {
  const out = executeOperation({ command: "schedule_session", title: "读一篇综述", date: "2026-10-13", startLocalTime: "15:00", durationMinutes: 60 }, CTX);
  assert.ok(out.result.ok, out.result.ok ? "" : out.result.error);
  assert.match(out.result.ok ? out.result.summary : "", /「读一篇综述」排在 .*15:00–16:00/);
  const mine = blocks("读一篇综述");
  assert.deepEqual(mine.map(span), ["2026-10-13 15:00–16:00"], "只有主人指定的这一段，重排没有再加");
  assert.equal(mine[0]!.origin, "user");
  assert.equal(mine[0]!.reason, "你指定排在这里");
  assert.equal((getDb().prepare(`SELECT estimate_minutes FROM tasks WHERE id = ?`).get(mine[0]!.task_id) as { estimate_minutes: number }).estimate_minutes, 60);

  assert.equal(undoWithFollowUps(out.result.ok ? out.result.batchId! : "").kind, "undone");
  assert.equal(blocks("读一篇综述").length, 0);
  assert.equal((getDb().prepare(`SELECT COUNT(*) AS n FROM tasks WHERE title = '读一篇综述' AND archived_at IS NULL`).get() as { n: number }).n, 0, "撤销后任务也不在了");
});

test("schedule_session：撞课程/固定活动、撞别的学习块、已过去、晚于截止、超出当日预算——都拒绝并说清原因，不留半截数据", () => {
  addFixed("社团例会", "2026-10-14", "15:00", "16:00");
  const run = (cmd: Record<string, unknown>) => executeOperation({ command: "schedule_session", ...cmd }, CTX).result;
  const tasksBefore = (getDb().prepare(`SELECT COUNT(*) AS n FROM tasks`).get() as { n: number }).n;

  const clash = run({ title: "写周报", date: "2026-10-14", startLocalTime: "15:30", durationMinutes: 30 });
  assert.deepEqual([clash.ok, clash.ok ? "" : clash.code], [false, "SLOT_CONFLICT"]);
  assert.match(clash.ok ? "" : clash.error, /社团例会/);

  const past = run({ title: "写周报", date: "2026-10-12", startLocalTime: "09:00", durationMinutes: 30 });
  assert.deepEqual([past.ok, past.ok ? "" : past.code], [false, "IN_THE_PAST"]);
  assert.equal((getDb().prepare(`SELECT COUNT(*) AS n FROM tasks`).get() as { n: number }).n, tasksBefore, "被拒绝的请求没有留下新任务");

  const due = addTask("周三中午交的作业", 60, at("2026-10-14T12:00").toISOString());
  const late = run({ taskId: due, date: "2026-10-14", startLocalTime: "13:00", durationMinutes: 30 });
  assert.deepEqual([late.ok, late.ok ? "" : late.code], [false, "DEADLINE_CONFLICT"]);
  assert.match(late.ok ? "" : late.error, /晚于截止/);

  // 周四：每天最多 180 分钟。已排 90 + 30，再排 90 就超了
  const first = run({ title: "整理笔记", date: "2026-10-15", startLocalTime: "09:00", durationMinutes: 90 });
  assert.ok(first.ok, first.ok ? "" : first.error);
  const overlap = run({ title: "背单词", date: "2026-10-15", startLocalTime: "10:00", durationMinutes: 30 });
  assert.deepEqual([overlap.ok, overlap.ok ? "" : overlap.code], [false, "SLOT_CONFLICT"]);
  const fits = run({ title: "背单词", date: "2026-10-15", startLocalTime: "14:00", durationMinutes: 30 });
  assert.ok(fits.ok, fits.ok ? "" : fits.error);
  const over = run({ title: "刷一套真题", date: "2026-10-15", startLocalTime: "16:00", durationMinutes: 90 });
  assert.deepEqual([over.ok, over.ok ? "" : over.code], [false, "OVER_BUDGET"]);
  assert.match(over.ok ? "" : over.error, /10\/15 的学习预算只剩 60 分钟，放不下 90 分钟/);
  assert.equal((getDb().prepare(`SELECT COUNT(*) AS n FROM tasks WHERE title = '刷一套真题'`).get() as { n: number }).n, 0);
});

test("从空档发起一句“这里安排…”：不调模型，直接排进那个时段；对得上已有任务就给它排，时长按任务估时且不超过空档", async () => {
  getDb().prepare(`DELETE FROM plan_sessions`).run();
  getDb().prepare(`DELETE FROM tasks`).run();
  const before1 = modelCalls;
  const r1 = await say("这里安排复习概率论", { slot: { date: "2026-10-16", start: "19:00", end: "21:30" } });
  assert.equal(r1.state, "applied", JSON.stringify(r1));
  assert.equal(modelCalls, before1, "一句明确的安排不需要模型");
  assert.deepEqual(blocks("复习概率论").map(span), ["2026-10-16 19:00–20:00"], "没说时长：默认一小时，从空档开头排");
  assert.ok(r1.undo.available);

  // 已有任务（估时 45）：给它排，时长取任务估时
  const hw = addTask("离散数学作业", 45);
  const r2 = await say("这里安排离散数学作业", { slot: { date: "2026-10-17", start: "10:00", end: "12:00" } });
  assert.equal(r2.state, "applied", JSON.stringify(r2));
  const hwBlocks = blocks("离散数学作业");
  assert.ok(hwBlocks.every((b) => b.task_id === hw), "没有另建同名任务");
  assert.ok(hwBlocks.some((b) => span(b) === "2026-10-17 10:00–10:45"), JSON.stringify(hwBlocks.map(span)));

  // 话里说了时长，但空档只有 30 分钟：不超过空档
  const r3 = await say("这里安排两小时的编程练习", { slot: { date: "2026-10-18", start: "16:00", end: "16:30" } });
  assert.equal(r3.state, "applied", JSON.stringify(r3));
  assert.deepEqual(blocks("编程练习").filter((b) => b.origin === "user").map(span), ["2026-10-18 16:00–16:30"]);
});

test("今天的空档已经过去一截：从现在之后的整 5 分钟开始；整段都过去了如实说；没有空档上下文时同一句话照常走分类", async () => {
  const r = await say("这里安排看一节网课", { slot: { date: "2026-10-12", start: "18:00", end: "21:00" } });
  assert.equal(r.state, "applied", JSON.stringify(r));
  assert.deepEqual(blocks("看一节网课").map(span), ["2026-10-12 18:30–19:30"]);

  const gone = await say("这里安排练字", { slot: { date: "2026-10-12", start: "16:00", end: "18:00" } });
  assert.equal(gone.items.find((i) => i.kind === "command")?.state, "failed");
  assert.match(gone.items.find((i) => i.kind === "command")?.error ?? "", /这个空档已经过去了/);
  assert.equal(blocks("练字").length, 0);

  const calls = modelCalls;
  const plain = await say("安排一下下周的口语练习");
  assert.equal(plain.items.some((i) => i.kind === "command"), false, "没有空档上下文：不当成指定时段的安排");
  assert.equal(modelCalls, calls + 1);
});
