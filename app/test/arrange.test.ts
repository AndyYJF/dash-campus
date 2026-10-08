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
type Result = { state: string; summary: string; items: Array<{ kind: string; state: string; summary: string; error: string | null }> };
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

/**
 * 以下是 2026-10-08 审计 3e66e01 时复现的六个问题的回归。
 * 端到端的几条都排在明天或更后（今天 15:30–16:30 有上面插入的“社团例会”）。
 */
const show = (body: string, slot: typeof TOMORROW_SLOT | null = null, nowMinute: number | null = 750, durationOf?: (title: string) => number | null) =>
  parseArrange(body, slot, TODAY, nowMinute, durationOf).map((x) => (x.ok ? `${x.title}|${x.date.slice(5)} ${x.start}-${x.end}|${x.timed}` : `!${x.error}`));
const AFTERNOON_SLOT = { date: "2026-10-13", start: "16:00", end: "18:00" };

test("回归①：“一点/三点”作数量时不是钟点——不排到 13:00，标题不被挖掉；真正的中文钟点照常读", () => {
  for (const body of ["多背一点单词", "做一点高数题", "复习三点内容", "一点点高数", "多背一点儿单词", "看一点三国演义"]) {
    assert.equal(hasClockTime(body), false, body);
    assert.deepEqual(show(body, AFTERNOON_SLOT), [`${body}|10-13 16:00-18:00|none`], `${body}：用点选的空档，标题原样`);
    assert.match(show(body)[0]!, /^!.*没说什么时候做/, `${body}：没点空档时要求补时间，不猜成 1 点`);
  }
  assert.deepEqual(show("三点写作业，然后四点背单词"), ["写作业|10-12 15:00-16:00|start", "背单词|10-12 16:00-17:00|start"], "句首的中文钟点");
  assert.deepEqual(show("背单词下午一点"), ["背单词|10-12 13:00-14:00|start"], "带了下午");
  assert.deepEqual(show("明天三点半复习"), ["复习|10-13 15:30-16:30|start"], "带了分钟");
  assert.deepEqual(show("一点到两点整理笔记"), ["整理笔记|10-12 13:00-14:00|range"], "起止时间里的“一点”");
  assert.equal(hasClockTime("写作业三点开始"), true, "后面跟着“开始”");
  assert.equal(hasClockTime("多背一点单词，下午3点到4点写作业"), true, "别的分句里有钟点");
});

test("回归②（解析）：只说开始时间的那件按已有任务估时定时长，后一件接在它真正结束的地方", () => {
  const durationOf = (title: string) => (title.includes("微积分") ? 90 : null);
  assert.deepEqual(show("下午3点写微积分作业，然后背单词", null, 750, durationOf), ["写微积分作业|10-12 15:00-16:30|start", "背单词|10-12 16:30-17:30|start"]);
  assert.deepEqual(show("下午3点写半小时微积分作业，然后背单词", null, 750, durationOf), ["写半小时微积分作业|10-12 15:00-15:30|start", "背单词|10-12 15:30-16:30|start"], "话里说了时长的按话里的");
});

test("回归③：换了一天不沿用前一天的“下午”；同一天里仍然接在前一件之后", () => {
  assert.deepEqual(show("今天下午3点到4点写微积分，明天9点到10点写英语"), ["写微积分|10-12 15:00-16:00|range", "写英语|10-13 09:00-10:00|range"]);
  assert.deepEqual(show("今天下午3点到4点写微积分，明天3点到4点写英语"), ["写微积分|10-12 15:00-16:00|range", "写英语|10-13 15:00-16:00|range"], "8 点前的钟点仍按下午");
  assert.deepEqual(show("明天上午9点到10点写英语，下午2点到3点写物理，4点背单词"), ["写英语|10-13 09:00-10:00|range", "写物理|10-13 14:00-15:00|range", "背单词|10-13 16:00-17:00|start"]);
});

test("回归④：超过 6 件事时，多出来的单独说明，不悄悄丢掉", () => {
  const body = ["甲甲", "乙乙", "丙丙", "丁丁", "戊戊", "己己", "庚庚", "辛辛"].map((t, i) => `${13 + i}:00-${13 + i}:20 ${t}`).join("，");
  const pieces = show(body);
  assert.equal(pieces.length, 7);
  assert.equal(pieces[5], "己己|10-12 18:00-18:20|range");
  assert.equal(pieces[6], "!一次最多安排 6 件事，后面 2 件没有排：19:00-19:20 庚庚，20:00-20:20 辛辛。请把它们再发一次");
  assert.equal(show(body.split("，").slice(0, 6).join("，")).length, 6, "刚好 6 件不多说");
});

test("回归⑤：晚上12点不是中午，上午12点不是半夜", () => {
  assert.match(show("晚上12点背单词")[0]!, /^!「背单词」说的「晚上12点」已经是第二天凌晨了，没有排/);
  assert.match(show("晚上1点背单词")[0]!, /^!「背单词」说的「晚上1点」已经是第二天凌晨了/);
  assert.deepEqual(show("晚上10点到晚上12点背单词"), ["背单词|10-12 22:00-24:00|range"]);
  assert.deepEqual(show("晚上11点到12点背单词"), ["背单词|10-12 23:00-24:00|range"]);
  assert.deepEqual(show("22点到24点背单词"), ["背单词|10-12 22:00-24:00|range"]);
  assert.deepEqual(show("上午十二点到一点吃饭", null, null), ["吃饭|10-12 12:00-13:00|range"]);
  assert.deepEqual(show("中午12点到1点吃饭", null, null), ["吃饭|10-12 12:00-13:00|range"]);
  assert.deepEqual(show("凌晨12点到1点背单词", null, null), ["背单词|10-12 00:00-01:00|range"]);
  assert.match(show("晚上11点到晚上1点背单词")[0]!, /^!「背单词」的时间跨过了半夜，没有排/);
});

test("回归⑥：紧贴钟点的日期不进标题；标题里本来的日期词留着", () => {
  assert.deepEqual(show("周五下午3点到4点写作业"), ["写作业|10-16 15:00-16:00|range"]);
  assert.deepEqual(show("下周三下午3点到4点写作业"), ["写作业|10-21 15:00-16:00|range"]);
  assert.deepEqual(show("10月15日下午3点到4点写作业"), ["写作业|10-15 15:00-16:00|range"]);
  assert.deepEqual(show("2026年10月15日 15:00-16:00 写作业"), ["写作业|10-15 15:00-16:00|range"]);
  assert.deepEqual(show("写作业 周五下午3点到4点"), ["写作业|10-16 15:00-16:00|range"]);
  assert.deepEqual(show("明早8点背单词"), ["背单词|10-13 08:00-09:00|start"]);
  assert.deepEqual(show("写周五要交的作业 下午3点到4点"), ["写周五要交的作业|10-16 15:00-16:00|range"]);
});

test("回归②（端到端）：第一件对上估时 90 分钟的已有任务——两件都排上，不再撞在一起", async () => {
  reset();
  await say("/安排 后天下午2点到3点写微积分作业");
  getDb().prepare(`UPDATE tasks SET estimate_minutes = 90 WHERE title = '写微积分作业'`).run();
  const r = await say("/安排 明天下午3点写微积分作业，然后背单词");
  assert.equal(r.result!.state, "applied", JSON.stringify(r.result));
  assert.deepEqual(blocks(), ["写微积分作业 2026-10-13 15:00–16:30", "背单词 2026-10-13 16:30–17:30", "写微积分作业 2026-10-14 14:00–15:00"]);
});

test("回归①（端到端）：点了空档说“多背一点单词”——排在点的空档里；不带 /安排 的说法也一样；没点空档就拦在入口", async () => {
  reset();
  const slashed = await say("/安排 多背一点单词", { slot: AFTERNOON_SLOT });
  assert.equal(slashed.result!.state, "applied", JSON.stringify(slashed.result));
  assert.deepEqual(blocks(), ["多背一点单词 2026-10-13 16:00–17:00"]);
  reset();
  const plain = await say("做一点高数题", { slot: AFTERNOON_SLOT });
  assert.equal(plain.result!.state, "applied", JSON.stringify(plain.result));
  assert.deepEqual(blocks(), ["一点高数题 2026-10-13 16:00–17:00"], "规则回退路径：还是在点的空档里");
  const blocked = await say("/安排 多背一点单词");
  assert.equal(blocked.status, 422);
  assert.match(blocked.error, /请写上时间/);
});

test("回归④⑤（端到端）：第 7 件作为没办成的一项报出来；“晚上12点”如实说明、不排到中午", async () => {
  reset();
  const body = ["甲甲", "乙乙", "丙丙", "丁丁", "戊戊", "己己", "庚庚"].map((t, i) => `${i === 0 ? "明天" : ""}${13 + i}:00-${13 + i}:20 ${t}`).join("，");
  const many = await say(`/安排 ${body}`);
  const items = many.result!.items.filter((i) => i.kind === "command");
  assert.deepEqual(items.map((i) => i.state), ["applied", "applied", "applied", "applied", "applied", "applied", "failed"], JSON.stringify(items));
  assert.match(items[6]!.error ?? "", /一次最多安排 6 件事，后面 1 件没有排：19:00-19:20 庚庚/);
  assert.equal(many.result!.state, "partly_applied");
  assert.equal(blocks().length, 6);
  reset();
  const midnight = await say("/安排 明天晚上12点背单词");
  assert.equal(midnight.result!.items[0]!.state, "failed");
  assert.match(midnight.result!.items[0]!.error ?? "", /「晚上12点」已经是第二天凌晨了/);
  assert.deepEqual(blocks(), []);
});
