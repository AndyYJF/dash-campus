import assert from "node:assert/strict";
import fs from "node:fs";
import { after, before, test } from "node:test";
import { NextRequest } from "next/server";
import { migrateAll, getDb } from "./helpers";
import { createOwner, createSession, SESSION_COOKIE } from "@/domain/session";
import { hashPassword } from "@/domain/password";
import { setNowForTests } from "@/domain/clock";
import { htmlToText } from "@/domain/holiday-notice";
import { setProvidersForTests } from "@/integrations";
import { FakeModelProvider } from "@/integrations/fake-model-provider";
import { runDueJobsOnce } from "@/worker/runner";
import { calendarDay, teachingWeekOf } from "@/workflows/calendar";
import { timetableToSdct, timetableExtractionSchema } from "@/workflows/materials";
import { runCalendarSync, scheduleCalendarSync, setCalendarFetcherForTests, syncHolidayYear } from "@/workflows/calendar-sync";
import { executeCommand, undoWithFollowUps } from "@/workflows/commands";
import { POST as createIntakeRoute } from "@/app/api/v2/intakes/route";
import { GET as getIntakeRoute } from "@/app/api/v2/intakes/[id]/route";
import { GET as questionsRoute } from "@/app/api/v2/questions/route";
import { POST as answerRoute } from "@/app/api/v2/questions/[id]/answers/route";
import { GET as weekRoute } from "@/app/api/v2/week/route";
import { GET as calendarContextRoute } from "@/app/api/v2/calendar-context/route";

/**
 * R2 材料入口（REPAIR-PLAN §3.3，ACADEMIC-CALENDAR §4；E01、E18、E40–E42、E46–E48 的隔离行为）。
 * 证据层说明：图片课表/校历的“视觉提取”这里用模型假件返回结构化字段，只证明协议与确定性链路，
 * 不证明真实视觉识别；国家节假日用 2026 年官方通知网页原文走真实解析。
 */

const TZ = "Asia/Shanghai";
const NOW = new Date("2026-10-12T09:00:00+08:00");
const GOV_URL = "https://www.gov.cn/zhengce/zhengceku/202511/content_7047091.htm";
const GOV_TEXT = htmlToText(fs.readFileSync("test/fixtures/gov-holiday-2026.html", "utf8"));
const PNG = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));

let sessionToken = "";
let csrfToken = "";
let seq = 0;
const calls: string[] = [];
let classify: (ctx: { text: string; images: string[] }) => unknown = () => ({ items: [] });
let extract: Record<string, unknown> = {};

function jsonReq(url: string, method: string, body?: unknown): NextRequest {
  return new NextRequest(`http://localhost${url}`, {
    method,
    headers: { cookie: `${SESSION_COOKIE}=${sessionToken}`, "x-csrf-token": csrfToken, "content-type": "application/json", ...(method === "POST" ? { "idempotency-key": `mat-${seq++}` } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}
async function drain() {
  for (let i = 0; i < 4; i++) await runDueJobsOnce();
}
type Result = { state: string; summary: string; nextActions: string[]; questions: Array<{ id: string; prompt: string; purpose: string; version: number }>; items: Array<{ kind: string; state: string; error: string | null; summary: string }> };
async function resultOf(intakeId: string): Promise<Result> {
  const res = await getIntakeRoute(jsonReq(`/api/v2/intakes/${intakeId}`, "GET"), { params: Promise.resolve({ id: intakeId }) });
  return ((await res.json()) as { result: Result }).result;
}
async function sayText(text: string, extra: Record<string, unknown> = {}) {
  const res = await createIntakeRoute(jsonReq("/api/v2/intakes", "POST", { text, ...extra }));
  assert.equal(res.status, 202, await res.clone().text());
  const { intakeId } = (await res.json()) as { intakeId: string };
  await drain();
  return { intakeId, result: await resultOf(intakeId) };
}
async function sayImage(text: string, name = "pic.png") {
  const form = new FormData();
  if (text) form.append("text", text);
  form.append("files", new File([PNG as BlobPart], name, { type: "image/png" }));
  const res = await createIntakeRoute(new NextRequest("http://localhost/api/v2/intakes", { method: "POST", headers: { cookie: `${SESSION_COOKIE}=${sessionToken}`, "x-csrf-token": csrfToken, "idempotency-key": `mat-${seq++}` }, body: form }));
  assert.equal(res.status, 202, await res.clone().text());
  const { intakeId } = (await res.json()) as { intakeId: string };
  await drain();
  return { intakeId, result: await resultOf(intakeId) };
}
async function openQuestions() {
  return ((await (await questionsRoute(jsonReq("/api/v2/questions", "GET"))).json()) as { questions: Array<{ id: string; prompt: string; purpose: string; version: number; questionKey: string }> }).questions;
}
async function answer(q: { id: string; version: number }, text: string) {
  const res = await answerRoute(jsonReq(`/api/v2/questions/${q.id}/answers`, "POST", { text, expectedVersion: q.version }), { params: Promise.resolve({ id: q.id }) });
  await drain();
  return res;
}
const names = (date: string) => calendarDay(date, TZ).courses.map((c) => c.courseName).sort();

before(() => {
  migrateAll();
  setNowForTests(NOW);
  createOwner(hashPassword("mat-test-pass"));
  const { token, session } = createSession(1);
  sessionToken = token;
  csrfToken = session.csrfToken;
  setProvidersForTests({
    model: {
      mode: "fixture",
      provider: new FakeModelProvider((r) => {
        calls.push(r.workflow);
        const ctx = r.context as { text: string; images: string[] };
        if (r.workflow === "intake_process") return { ok: true, validatedResult: classify(ctx) };
        const parsed = r.schema.safeParse(extract[r.workflow]);
        return parsed.success ? { ok: true, validatedResult: parsed.data } : { ok: false, error: { code: "SCHEMA_INVALID", message: "fixture 不合法", retryable: false } };
      }),
    },
  });
});
after(() => {
  setNowForTests(null);
  setCalendarFetcherForTests(null);
});

test("结构化课表 → 确定性课表文本：节次表/直接钟点都能展开；周次或时间读不出的课程跳过并具体列出", () => {
  const x = timetableExtractionSchema.parse({
    courses: [
      { name: "高等数学", teacher: "张老师", location: "A101", weekday: 3, start: "8:15", end: "9:55", weeks: "1-16周", evidence: "周三第1-2节" },
      { name: "大学物理", weekday: 3, start: "08:15", end: "11:55", weeks: "2-16", parity: "even", evidence: "周三第1-4节" },
      { name: "形势与政策", weekday: 5, start: "14:00", end: "15:40", weeks: "6、10" },
      { name: "体育", weekday: 2, start: "16:00", end: "17:40", weeks: "看不清" },
      { name: "英语", weekday: 1, periods: [9, 10], weeks: "1-16" },
    ],
    unclear: [{ where: "周四下午", what: "格子被遮挡" }],
  });
  const r = timetableToSdct(x);
  assert.ok(r.ok, r.ok ? "" : r.error);
  assert.equal(r.courseCount, 3);
  assert.deepEqual(r.sdct.split("\n").slice(0, 3), ["SDCT1", "T=16", "P=1,08:15-09:55;2,09:55-11:55;3,14:00-15:40"], "重叠的钟点切成不重叠的节次");
  assert.ok(r.sdct.includes("C=高等数学|张老师|A101|3|1|1-16|A|-"));
  assert.ok(r.sdct.includes("C=大学物理|-|-|3|1-2|2-16|E|-"));
  assert.ok(r.sdct.includes("C=形势与政策|-|-|5|3|6,10|A|-"));
  assert.deepEqual(r.skipped.map((s) => s.what), ["格子被遮挡", "「体育」的周次没读出来（写的是“看不清”）", "「英语」的上课时间没读出来（第 9、10 节没有对应的时间）"]);
  assert.equal(timetableToSdct(timetableExtractionSchema.parse({ courses: [{ name: "体育", weekday: 2, weeks: "?" }] })).ok, false, "一门都读不全就是失败，不算导入");
});

test("E01/E18（协议层，模型假件）：投一张课表图 → 结构化课程 → 只问学期锚点 → 今天/本周课程与预算一起更新；没读清的地方如实列出", async () => {
  classify = (ctx) => (ctx.images.length ? { items: [{ itemKey: "tt", kind: "timetable", summary: "课表截图", excerpt: "图片" }] } : { items: [] });
  extract = {
    timetable_extract: {
      totalWeeks: 18,
      periods: [
        { index: 1, start: "08:15", end: "09:00" },
        { index: 2, start: "09:10", end: "09:55" },
        { index: 5, start: "14:00", end: "14:45" },
        { index: 6, start: "14:55", end: "15:40" },
      ],
      courses: [
        { name: "高等数学", teacher: "张老师", location: "A101", weekday: 5, periods: [1, 2], weeks: "1-18", evidence: "周五第1-2节" },
        { name: "形势与政策", teacher: "李老师", location: "B202", weekday: 5, periods: [5, 6], weeks: "6,10", evidence: "周五第5-6节" },
        { name: "大学物理", teacher: "", location: "", weekday: 4, periods: [1, 2], weeks: "1-18", evidence: "周四第1-2节" },
        { name: "体育", weekday: 2, periods: [7, 8], weeks: "1-18", evidence: "周二第7-8节" },
      ],
      unclear: [],
    },
  };
  const before1 = calls.length;
  const r = await sayImage("");
  assert.deepEqual(calls.slice(before1), ["intake_process", "timetable_extract"], "一次分类 + 一次结构化提取");
  assert.equal(r.result.state, "needs_input", "课程字段已读出，只差学期锚点");
  const [q] = await openQuestions();
  assert.match(q!.prompt, /第几周/);
  assert.equal((await answer(q!, "第7周")).status, 202);
  const done = await resultOf(r.intakeId);
  assert.equal(done.state, "applied");
  assert.match(done.summary, /3 门课/);
  assert.ok(done.nextActions.some((a) => /1 处没读清/.test(a) && /体育/.test(a)), "体育的节次没有对应时间：具体说出来，不猜");
  assert.equal(teachingWeekOf("2026-10-12")?.week, 7);
  assert.deepEqual(names("2026-10-16"), ["高等数学"], "第 7 周周五：没有仅 6/10 周的课");
  assert.deepEqual(names("2026-10-09"), ["形势与政策", "高等数学"]);
  const week = (await (await weekRoute(jsonReq("/api/v2/week?monday=2026-10-12", "GET"))).json()) as { days: Array<{ date: string; courseMinutes: number; events: Array<{ title: string; kind: string; location: string }>; calendar: { teachingWeek: number } }> };
  const fri = week.days.find((d) => d.date === "2026-10-16")!;
  assert.equal(fri.courseMinutes, 100);
  assert.equal(fri.calendar.teachingWeek, 7);
  assert.deepEqual(fri.events.map((e) => [e.kind, e.location]), [["course", "A101"]], "时间线与预算用同一批课程实例");
  assert.equal(calls.length, before1 + 2, "回答后从 Resolve 继续，不重复提取");
});

test("真实国家来源走统一入口：贴官方链接（或原文）→ 确定性解析入库，不经模型；非官方网址不入库；重复投递无变化", async () => {
  setCalendarFetcherForTests(null);
  const before1 = calls.length;
  const pasted = await sayText(GOV_TEXT);
  assert.equal(pasted.result.state, "applied", JSON.stringify(pasted.result.items));
  assert.equal(calls.length, before1, "节假日通知不调用模型");
  assert.match(pasted.result.summary, /放假 33 天、调整上班 6 天/);
  assert.match(pasted.result.summary, /只标注公历日/);
  const row = getDb().prepare(`SELECT origin, year FROM holiday_datasets WHERE status = 'active'`).get();
  assert.deepEqual(row, { origin: "user_upload", year: 2026 }, "主人贴的原文按“主人提供”标注，不冒充官方抓取");
  assert.equal(calendarDay("2026-10-01", TZ).civil.type, "holiday");

  const again = await sayText(GOV_TEXT);
  assert.equal(again.result.state, "no_change", "同一修订重复投递没有变化");
  assert.equal((getDb().prepare(`SELECT COUNT(*) AS n FROM holiday_datasets`).get() as { n: number }).n, 1);

  const garbled = await sayText(GOV_TEXT.replace("10月1日（周四）至7日（周三）", "10月1日（周五）至7日（周三）"));
  assert.equal(garbled.result.state, "failed");
  assert.match(garbled.result.items[0]!.error ?? "", /国庆节.*周五.*周四/, "日期自洽校验没过：具体报错，不入库");
  assert.equal(calendarDay("2026-10-01", TZ).civil.type, "holiday", "保留上一版可靠数据");
});

test("E42 经统一入口：通知只说周六上课、没说按哪天的课 → 只问这一项；说“不清楚”就标待核对，不生成课程；说明后按源教学日展开", async () => {
  classify = (ctx) => ({ items: [{ itemKey: "adj", kind: "adjustment", summary: "国庆调课通知", excerpt: ctx.text.slice(0, 40) }] });
  extract = { adjustment_extract: { items: [{ scope: "school", mode: "replace", targetDate: "2026-10-10", sourceTeachingDate: null, evidence: "10月10日（周六）正常上课" }] } };
  const r = await sayText("教务处通知：10月10日（周六）正常上课，请同学们按时到课。");
  assert.equal(r.result.state, "needs_input");
  const q = r.result.questions[0]!;
  assert.equal(q.purpose, "teaching_source");
  assert.match(q.prompt, /2026-10-10 要上课，但没写按哪一天的课表/);
  assert.equal((await answer(q, "不清楚")).status, 202);
  const pending = await resultOf(r.intakeId);
  assert.ok(pending.nextActions.some((a) => /待核对/.test(a)));
  assert.equal(calendarDay("2026-10-10", TZ).courses.length, 0, "不猜补哪天的课");
  assert.equal(calendarDay("2026-10-10", TZ).teaching.status, "pending", "国家补班 + 无学校规则：教学待核对");

  const r2 = await sayText("教务处补充通知：10月10日（周六）正常上课。");
  const q2 = r2.result.questions[0]!;
  const bad = await answer(q2, "嗯嗯");
  assert.equal(bad.status, 422);
  assert.equal((await answer((await openQuestions()).find((x) => x.id === q2.id)!, "补10月9日的课")).status, 202);
  assert.equal((await resultOf(r2.intakeId)).state, "applied");
  assert.deepEqual(names("2026-10-10"), ["形势与政策", "高等数学"], "按第 6 周周五的源实例展开");
  assert.equal(calendarDay("2026-10-10", TZ).teaching.status, "makeup");
});

test("E40/E41/E46（协议层）：一份材料里两个学期的校历分别入库并关联学期；校历不是课程也不是 24h 占用；首周冲突先问；不适用人群不套用", async () => {
  const fixedBefore = (getDb().prepare(`SELECT COUNT(*) AS n FROM fixed_events`).get() as { n: number }).n;
  classify = () => ({ items: [{ itemKey: "cal", kind: "calendar", summary: "2026-2027 学年校历", excerpt: "图片" }] });
  extract = {
    calendar_extract: {
      school: "合成大学",
      academicYear: "2026-2027",
      audience: "all",
      terms: [
        { termLabel: "秋季学期", registrationDate: "2026-08-28", teachingStart: "2026-08-31", totalWeeks: 18, termEnd: "2027-01-10", events: [{ kind: "holiday", title: "国庆节放假", startDate: "2026-10-01", endDate: "2026-10-07", cancelsClasses: true, evidence: "校历图第 5 周" }, { kind: "exam", title: "考试周", startDate: "2027-01-04", endDate: "2027-01-10" }] },
        { termLabel: "春季学期", registrationDate: "2027-02-26", teachingStart: "2027-03-01", totalWeeks: 18, termEnd: "2027-07-04", events: [] },
      ],
    },
  };
  const r = await sayImage("这是今年的校历", "calendar.png");
  assert.equal(r.result.state, "applied", JSON.stringify(r.result.items));
  const cals = getDb().prepare(`SELECT term_label, first_monday, registration_date, semester_id IS NOT NULL AS linked FROM academic_calendars WHERE status = 'active' ORDER BY first_monday`).all();
  assert.deepEqual(cals, [
    { term_label: "秋季学期", first_monday: "2026-08-31", registration_date: "2026-08-28", linked: 1 },
    { term_label: "春季学期", first_monday: "2027-03-01", registration_date: "2027-02-26", linked: 1 },
  ]);
  assert.equal((getDb().prepare(`SELECT COUNT(*) AS n FROM semesters`).get() as { n: number }).n, 2, "秋季关联已有学期，春季新建，不出现第二个秋季学期");
  assert.equal((getDb().prepare(`SELECT COUNT(*) AS n FROM fixed_events`).get() as { n: number }).n, fixedBefore, "校历不是额外课程，也不存成 24 小时固定活动");
  assert.equal(calendarDay("2026-10-02", TZ).teaching.status, "cancelled", "学校明确放假：停课");
  assert.equal(calendarDay("2027-01-05", TZ).phase, "exam");

  // 新修订把首周改到 9/7：会移动全部课程 → 先问
  extract = { calendar_extract: { school: "合成大学", academicYear: "2026-2027", audience: "all", terms: [{ termLabel: "秋季学期", teachingStart: "2026-09-07", totalWeeks: 18 }] } };
  const rev = await sayImage("校历更新了", "calendar2.png");
  assert.equal(rev.result.state, "needs_input");
  assert.match(rev.result.questions[0]!.prompt, /第一教学周是 2026-09-07.*现有课表是按 2026-08-31/);
  assert.equal(teachingWeekOf("2026-10-12")?.week, 7, "回答前什么都不变");
  assert.equal((await answer(rev.result.questions[0]!, "先不改")).status, 202);
  assert.equal(teachingWeekOf("2026-10-12")?.week, 7);
  assert.ok((await resultOf(rev.intakeId)).nextActions.some((a) => /不按这份校历修正/.test(a)));

  // 研究生校历：主人是本科生 → 存为资料，不套用
  getDb().prepare(`INSERT INTO profile_facts (id, field, value, source, created_at, updated_at) VALUES ('f1', 'education_level', '本科', 'master', 'x', 'x')`).run();
  extract = { calendar_extract: { school: "合成大学", academicYear: "2026-2027", audience: "graduate", terms: [{ termLabel: "秋季学期", teachingStart: "2026-09-14", totalWeeks: 16 }] } };
  const grad = await sayImage("研究生校历", "calendar3.png");
  assert.ok(grad.result.nextActions.some((a) => /研究生的安排，你是本科生/.test(a)));
  assert.equal(teachingWeekOf("2026-10-12")?.week, 7);
});

test("E47/E48：来源刷新——403/断网/读不懂都保留上一版并退避；无变化不重复解析；未发布不预测；第三方不入库；撤销后同修订不复活", async () => {
  const db = getDb();
  const at = new Date("2026-10-12T09:00:00+08:00");
  const official = (text: string) => async (url: string) => ({ ok: true as const, text, images: [], finalUrl: url });
  executeCommand({ command: "update_calendar_sync_policy", enabled: true, holidayYear: 2026, holidayUrl: GOV_URL }, { intakeId: null, itemId: null, itemKey: "", instanceEpoch: 0, evidence: "" });
  const status = (year: string) => db.prepare(`SELECT last_status, failure_count, next_check_at, last_error FROM calendar_sync_sources WHERE kind = 'holiday' AND scope_key = ?`).get(year) as { last_status: string; failure_count: number; next_check_at: string; last_error: string | null };

  // 403：失败 ≠ 无节假日；上一版（主人贴的那版）仍然有效
  setCalendarFetcherForTests(async () => ({ ok: false, error: "抓取失败 HTTP 403", status: 403 }));
  const f1 = await syncHolidayYear(2026, at);
  assert.equal(f1.status, "failed", JSON.stringify(db.prepare(`SELECT * FROM calendar_sync_sources`).all()));
  assert.equal(calendarDay("2026-10-01", TZ).civil.type, "holiday", "保留最后可靠数据");
  assert.equal(status("2026").failure_count, 1);
  assert.equal(status("2026").next_check_at, new Date(at.getTime() + 3600_000).toISOString(), "有限退避");
  assert.equal((await syncHolidayYear(2026, at)).status, "not_due", "退避期内不反复请求");
  await syncHolidayYear(2026, at, { force: true });
  assert.equal(status("2026").next_check_at, new Date(at.getTime() + 2 * 3600_000).toISOString(), "连续失败退避加倍");

  // 官方来源恢复：内容与已入库的同一修订 → 无变化；再查一次不再解析
  const batchesBefore = (db.prepare(`SELECT COUNT(*) AS n FROM agent_action_batches WHERE command = 'sync_holiday_calendar'`).get() as { n: number }).n;
  setCalendarFetcherForTests(official(GOV_TEXT));
  assert.equal((await syncHolidayYear(2026, at, { force: true })).status, "unchanged");
  assert.equal(status("2026").failure_count, 0);
  assert.equal((await syncHolidayYear(2026, at, { force: true })).status, "unchanged");
  assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM agent_action_batches WHERE command = 'sync_holiday_calendar'`).get() as { n: number }).n, batchesBefore, "无变化不写批次、不触发重排");

  // 下一年度未发布：不沿用、不预测
  const all = await runCalendarSync(at, { force: true });
  assert.deepEqual(all.map((o) => `${o.scopeKey}:${o.status}`), ["2026:unchanged", "2027:not_published"], "10 月起也查下一年度");
  assert.equal(calendarDay("2027-01-01", TZ).civil.known, false);
  assert.equal(calendarDay("2027-01-01", TZ).civil.type, "workday", "未发布就是未知，不显示为节假日也不说全年无假");

  // 页面改版读不懂 / 第三方网址：都不入库
  setCalendarFetcherForTests(official("<html>系统维护中</html>"));
  assert.equal((await syncHolidayYear(2026, at, { force: true })).status, "not_published");
  executeCommand({ command: "update_calendar_sync_policy", holidayYear: 2026, holidayUrl: "https://example.com/holiday-2026" }, { intakeId: null, itemId: null, itemKey: "", instanceEpoch: 0, evidence: "" });
  setCalendarFetcherForTests(official(GOV_TEXT.replace("共7天", "共7天 ")));
  const third = await syncHolidayYear(2026, at, { force: true });
  assert.equal(third.status, "unchanged", "内容相同：与来源是谁无关，本来就没有新东西");
  db.prepare(`DELETE FROM holiday_days`).run();
  db.prepare(`DELETE FROM holiday_datasets`).run();
  db.prepare(`UPDATE calendar_sync_sources SET last_hash = NULL`).run();
  const thirdFresh = await syncHolidayYear(2026, at, { force: true });
  assert.equal(thirdFresh.status, "needs_review");
  assert.match(thirdFresh.detail, /没有官方出处/);
  assert.equal(calendarDay("2026-10-01", TZ).civil.known, false, "第三方数据没有官方定位：不自动成为事实");

  // 官方入库 → 撤销 → 再同步：墓碑保护
  executeCommand({ command: "update_calendar_sync_policy", holidayYear: 2026, holidayUrl: GOV_URL }, { intakeId: null, itemId: null, itemKey: "", instanceEpoch: 0, evidence: "" });
  setCalendarFetcherForTests(official(GOV_TEXT));
  db.prepare(`UPDATE calendar_sync_sources SET last_hash = NULL`).run();
  assert.equal((await syncHolidayYear(2026, at, { force: true })).status, "ok");
  assert.equal((db.prepare(`SELECT origin FROM holiday_datasets WHERE status = 'active'`).get() as { origin: string }).origin, "official");
  const batch = db.prepare(`SELECT id FROM agent_action_batches WHERE command = 'sync_holiday_calendar' AND status = 'applied' ORDER BY rowid DESC LIMIT 1`).get() as { id: string };
  assert.equal(undoWithFollowUps(batch.id).kind, "undone");
  db.prepare(`UPDATE calendar_sync_sources SET last_hash = NULL`).run();
  assert.equal((await syncHolidayYear(2026, at, { force: true })).status, "unchanged");
  assert.equal(calendarDay("2026-10-01", TZ).civil.known, false, "撤销过的修订不被下一次同步重新套用");
});

test("E49：一句话开关自动核对；每天最多排一次核对任务；关闭后不再排", async () => {
  const db = getDb();
  db.prepare(`DELETE FROM jobs WHERE type = 'calendar_sync'`).run();
  setCalendarFetcherForTests(async () => ({ ok: false, error: "offline" }));
  const off = await sayText("别再自动更新节假日和校历了");
  assert.equal(off.result.state, "applied", JSON.stringify(off.result.items));
  assert.match(off.result.summary, /自动更新已关闭/);
  db.prepare(`DELETE FROM jobs WHERE type = 'calendar_sync'`).run();
  scheduleCalendarSync();
  assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM jobs WHERE type = 'calendar_sync'`).get() as { n: number }).n, 0);
  const on = await sayText("每两周自动核对一次节假日和校历");
  assert.match(on.result.summary, /每 14 天核对一次/);
  db.prepare(`DELETE FROM jobs WHERE type = 'calendar_sync'`).run();
  scheduleCalendarSync();
  scheduleCalendarSync();
  assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM jobs WHERE type = 'calendar_sync'`).get() as { n: number }).n, 1, "worker 读到的是同一份设置；同一天只排一次");
});

test("GET /api/v2/calendar-context：按范围返回公历日类型、教学周、有效课程与同步状态；与页面同一个解释器", async () => {
  const res = await calendarContextRoute(jsonReq("/api/v2/calendar-context?from=2026-10-08&to=2026-10-10", "GET"));
  assert.equal(res.status, 200);
  const body = (await res.json()) as { days: Array<{ date: string; civil: { type: string }; teachingWeek: number | null; teaching: { status: string }; courses: Array<{ name: string; sourceDate: string }> }>; sync: { sources: unknown[] } };
  assert.deepEqual(body.days.map((d) => d.date), ["2026-10-08", "2026-10-09", "2026-10-10"]);
  const sat = body.days[2]!;
  assert.equal(sat.teaching.status, "makeup");
  assert.ok(sat.courses.every((c) => c.sourceDate === "2026-10-09"), "补课实例带着源教学日期");
  assert.ok(Array.isArray(body.sync.sources));
  assert.equal((await calendarContextRoute(jsonReq("/api/v2/calendar-context?from=2026-10-10&to=2026-10-01", "GET"))).status, 422);
});
