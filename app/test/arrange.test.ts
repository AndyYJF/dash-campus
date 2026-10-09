import assert from "node:assert/strict";
import crypto from "node:crypto";
import { after, before, test } from "node:test";
import { NextRequest } from "next/server";
import { migrateAll, getDb } from "./helpers";
import { createOwner, createSession, SESSION_COOKIE } from "@/domain/session";
import { hashPassword } from "@/domain/password";
import { setNowForTests } from "@/domain/clock";
import { hasClockTime, parseArrange } from "@/domain/arrange";
import { agentInputIssue, parseAgentText } from "@/domain/agent-input";
import { setProvidersForTests } from "@/integrations";
import { FakeModelProvider } from "@/integrations/fake-model-provider";
import { runDueJobsOnce } from "@/worker/runner";
import { POST as createIntakeRoute } from "@/app/api/v2/intakes/route";
import { GET as getIntakeRoute } from "@/app/api/v2/intakes/[id]/route";

/**
 * “/安排 …” 按话里的时间排，一句多件事分别排（主人 2026-10-06 报告的缺陷：
 * “/安排 下午3点到4点写微积分作业，4点到4点写英语作业”被当成一件事排到了点选空档的开头——第二天 08:00）。
 * 规划时钟固定在 2026-10-12（周一）12:30。模型假件不应被调用。
 */

const NOW = new Date("2026-10-12T12:30:00+08:00");
const TZ = "Asia/Shanghai";
const TODAY = "2026-10-12";
const TOMORROW_SLOT = { date: "2026-10-13", start: "08:00", end: "12:00" };
const local = (iso: string) => new Date(Date.parse(iso) + 8 * 3600_000).toISOString().slice(0, 16).replace("T", " ");
type Row = { title: string; start_utc: string; end_utc: string; origin: string };
const blocks = () =>
  (getDb().prepare(`SELECT t.title, s.start_utc, s.end_utc, s.origin FROM plan_sessions s JOIN tasks t ON t.id = s.task_id WHERE s.status IN ('planned','tentative','in_progress') ORDER BY s.start_utc`).all() as Row[]).map((b) => `${b.title} ${local(b.start_utc)}–${local(b.end_utc).slice(11)}`);

let sessionToken = "";
let csrfToken = "";
let seq = 0;
let modelCalls = 0;
function req(url: string, method: string, body?: unknown): NextRequest {
  return new NextRequest(`http://localhost${url}`, {
    method,
    headers: { cookie: `${SESSION_COOKIE}=${sessionToken}`, "x-csrf-token": csrfToken, "content-type": "application/json", ...(method === "POST" ? { "idempotency-key": `arr-${seq++}` } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}
type Result = { state: string; summary: string; items: Array<{ kind: string; state: string; summary: string; error: string | null }>; goal?: { state: string }; verification?: { status: string } };
async function say(text: string, extra: Record<string, unknown> = {}): Promise<{ status: number; result: Result | null; error: string }> {
  const res = await createIntakeRoute(req("/api/v2/intakes", "POST", { text, ...extra }));
  if (res.status !== 202) return { status: res.status, result: null, error: ((await res.json()) as { error?: { message?: string } }).error?.message ?? "" };
  const { intakeId } = (await res.json()) as { intakeId: string };
  for (let i = 0; i < 5; i++) await runDueJobsOnce();
  const got = await getIntakeRoute(req(`/api/v2/intakes/${intakeId}`, "GET"), { params: Promise.resolve({ id: intakeId }) });
  return { status: 202, result: ((await got.json()) as { result: Result }).result, error: "" };
}
function reset() {
  const db = getDb();
  for (const t of ["plan_sessions", "practice_entries", "entity_source_links", "tasks"]) db.prepare(`DELETE FROM ${t}`).run();
}

before(() => {
  migrateAll();
  setNowForTests(NOW);
  createOwner(hashPassword("arrange-test-pass"));
  const { token, session } = createSession(1);
  sessionToken = token;
  csrfToken = session.csrfToken;
  setProvidersForTests({ model: { mode: "fixture", provider: new FakeModelProvider(() => { modelCalls++; return { ok: true, validatedResult: { items: [] } }; }) } });
});
after(() => setNowForTests(null));

test("解析：一句两件事各带时间；“下午”沿用到后一件；起止相同的那件单独指出", () => {
  const pieces = parseArrange("下午3点到4点写微积分作业，4点到4点写英语作业", TOMORROW_SLOT, TODAY, 750);
  assert.deepEqual(pieces[0], { ok: true, title: "写微积分作业", date: "2026-10-13", start: "15:00", end: "16:00", timed: "range" });
  assert.equal(pieces[1]!.ok, false);
  assert.match(pieces[1]!.ok ? "" : pieces[1]!.error, /「写英语作业」的时间是 16:00 到 16:00，开始和结束一样，没有排。告诉我到几点结束/);
});

test("解析：各种写法的钟点；没说上午下午时按上下文取", () => {
  const p = (body: string, slot: typeof TOMORROW_SLOT | null = null, nowMinute: number | null = 750) => parseArrange(body, slot, TODAY, nowMinute).map((x) => (x.ok ? `${x.title}|${x.date.slice(5)} ${x.start}-${x.end}|${x.timed}` : `!${x.error}`));
  assert.deepEqual(p("下午3点到4点写微积分作业，4点到5点写英语作业"), ["写微积分作业|10-12 15:00-16:00|range", "写英语作业|10-12 16:00-17:00|range"]);
  assert.deepEqual(p("15:00-16:30 复习线性代数；晚上八点半到九点背单词"), ["复习线性代数|10-12 15:00-16:30|range", "背单词|10-12 20:30-21:00|range"]);
  assert.deepEqual(p("明天上午十点到十一点半写实验报告"), ["写实验报告|10-13 10:00-11:30|range"]);
  assert.deepEqual(p("11点到1点整理笔记", null, 600), ["整理笔记|10-12 11:00-13:00|range"], "结束钟点倒过来时往后推半天");
  assert.deepEqual(p("3点到4点写作业"), ["写作业|10-12 15:00-16:00|range"], "今天 12:30，3 点只能是下午");
  assert.deepEqual(p("9点到10点写作业", TOMORROW_SLOT), ["写作业|10-13 09:00-10:00|range"], "落在点选的上午空档里：按上午");
  assert.deepEqual(p("下午3点写一小时微积分"), ["写一小时微积分|10-12 15:00-16:00|start"]);
  assert.deepEqual(p("下午3点到4点写微积分，然后写英语作业"), ["写微积分|10-12 15:00-16:00|range", "写英语作业|10-12 16:00-17:00|start"], "没写时间的接在上一件后面");
  assert.deepEqual(p("背单词", TOMORROW_SLOT), ["背单词|10-13 08:00-12:00|none"], "没写时间：用点选的空档");
  assert.match(p("背单词")[0]!, /^!「背单词」没说什么时候做/);
  assert.match(p("5点到3点写作业")[0]!, /^!「写作业」的结束时间 15:00 早于开始时间 17:00/);
  assert.equal(hasClockTime("下午3点到4点写作业"), true);
  assert.equal(hasClockTime("写一小时作业"), false);
});

test("准入：/安排 没点空档时，话里写了钟点就可以；两样都没有才拦", () => {
  const ctx = { hasFiles: false, hasUrls: false, hasTask: false, hasQuestion: false, hasSlot: false };
  assert.equal(agentInputIssue(parseAgentText("/安排 下午3点到4点写微积分作业"), ctx), null);
  assert.match(agentInputIssue(parseAgentText("/安排 写微积分作业"), ctx) ?? "", /请写上时间.*或先点时间线上的一个空档/);
  assert.equal(agentInputIssue(parseAgentText("/安排 写微积分作业"), { ...ctx, hasSlot: true }), null);
});

test("跨日期不沿用上一天下午，24小时钟点不被改成另一个半天，午夜结束保留24:00", () => {
  const pieces = parseArrange("今天下午3点到4点复习数学，明天9点到10点写英语，后天08:00-09:00写报告", null, TODAY, 750);
  assert.deepEqual(pieces.map((p) => p.ok && [p.date, p.start, p.end]), [
    [TODAY, "15:00", "16:00"], ["2026-10-13", "09:00", "10:00"], ["2026-10-14", "08:00", "09:00"],
  ]);
  assert.deepEqual(parseArrange("下午3点到4点数学，明天00:30-01:00英语", null, TODAY, 750)[1], {
    ok: true, title: "英语", date: "2026-10-13", start: "00:30", end: "01:00", timed: "range",
  });
  assert.deepEqual(parseArrange("23:00-24:00整理笔记", null, TODAY, 750)[0], {
    ok: true, title: "整理笔记", date: TODAY, start: "23:00", end: "24:00", timed: "range",
  });
});

test("非法午夜钟点和倒序24小时区间不猜成中午或另一日", () => {
  for (const body of ["明天24:30写作业", "明天24:00写作业", "明天08:00-07:00写作业", "明天23:00-00:00写作业"]) {
    assert.equal(parseArrange(body, null, TODAY, 750)[0]!.ok, false, body);
  }
});

test("一句超过六件事明确报告未处理的尾项，不能静默丢掉并声称全完成", async () => {
  reset();
  const clauses = Array.from({ length: 7 }, (_, i) => {
    const start = 15 * 60 + i * 10;
    const hm = (n: number) => `${Math.floor(n / 60)}:${String(n % 60).padStart(2, "0")}`;
    return `${hm(start)}-${hm(start + 10)}复习第${i + 1}章`;
  });
  const r = await say(`/安排 ${clauses.join("，")}`);
  assert.equal(r.status, 202);
  assert.equal(r.result!.state, "partly_applied", JSON.stringify(r.result));
  assert.equal(r.result!.goal?.state, "partial");
  assert.equal(r.result!.verification?.status, "partial");
  assert.deepEqual(r.result!.items.map((i) => i.state), [...Array(6).fill("applied"), "failed"]);
  assert.match(r.result!.items[6]!.error ?? "", /六|6/);
  assert.match(r.result!.items[6]!.error ?? "", /第7章/);
  assert.equal(blocks().length, 6);
});

test("主人报告的原句：点了明天上午的空档再说两件事——微积分排在话里说的 15:00–16:00，不是空档开头；英语那件说明原因，没有乱排", async () => {
  reset();
  const calls = modelCalls;
  const r = await say("/安排 下午3点到4点写微积分作业，4点到4点写英语作业", { slot: TOMORROW_SLOT });
  assert.equal(r.status, 202, r.error);
  assert.deepEqual(blocks(), ["写微积分作业 2026-10-13 15:00–16:00"], "只排了说清楚的那一件，时间照话里的");
  assert.equal(blocks().some((b) => b.includes("08:00")), false, "没有排到空档开头的 08:00");
  const items = r.result!.items.filter((i) => i.kind === "command");
  assert.deepEqual(items.map((i) => i.state), ["applied", "failed"]);
  assert.match(items[1]!.error ?? "", /「写英语作业」的时间是 16:00 到 16:00，开始和结束一样/);
  assert.equal(r.result!.state, "partly_applied");
  assert.equal(modelCalls, calls, "明确的安排不需要模型");
  assert.equal((getDb().prepare(`SELECT COUNT(*) AS n FROM tasks`).get() as { n: number }).n, 1, "没有把整句话建成一个任务");
});

test("两件事都说清楚：各建各的、各排各的；不点空档也行，默认是今天", async () => {
  reset();
  const r = await say("/安排 下午3点到4点写微积分作业，4点到5点写英语作业");
  assert.equal(r.status, 202, r.error);
  assert.equal(r.result!.state, "applied", JSON.stringify(r.result));
  assert.deepEqual(blocks(), ["写微积分作业 2026-10-12 15:00–16:00", "写英语作业 2026-10-12 16:00–17:00"]);
});

test("照说的排，但硬约束照旧：已经过去的时间、撞固定活动都如实拒绝，不挪到别处", async () => {
  reset();
  const past = await say("/安排 上午9点到10点写微积分作业");
  assert.equal(past.result!.items[0]!.state, "failed");
  assert.match(past.result!.items[0]!.error ?? "", /已经过去了/);
  getDb().prepare(`INSERT INTO fixed_events (id, title, weekday, local_start, local_end, timezone, event_date) VALUES (?, '社团例会', 1, '15:30', '16:30', ?, '2026-10-12')`).run(crypto.randomUUID(), TZ);
  const clash = await say("/安排 下午3点到4点写微积分作业");
  assert.match(clash.result!.items[0]!.error ?? "", /社团例会/);
  assert.deepEqual(blocks(), []);
});

test("没点空档也没写时间：直接拦在入口，说明怎么补", async () => {
  const r = await say("/安排 写微积分作业");
  assert.equal(r.status, 422);
  assert.match(r.error, /请写上时间/);
});
