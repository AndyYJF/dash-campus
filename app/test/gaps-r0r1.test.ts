import assert from "node:assert/strict";
import crypto from "node:crypto";
import { before, test } from "node:test";
import { migrateAll, getDb } from "./helpers";
import { futureCapacity } from "@/domain/budget";
import { estimateFromText } from "@/domain/task-text";
import { parseIcs } from "@/domain/ics";
import { importTimetable } from "@/repositories/timetable";
import { getPlanningRevision } from "@/repositories/proposals";
import { getPrefs } from "@/repositories/plan";
import { executeCommand, undoWithFollowUps } from "@/workflows/commands";
import { calendarDay } from "@/workflows/calendar";
import { dayLedger, eventsForDay } from "@/workflows/plan";

/**
 * R0/R1 补充行为（E02、E06、E12 的隔离行为）：旧课表被 V2 语义层认领而不双扣；预算口径算例；跨午夜按本地日切分。
 */

const TZ = "Asia/Shanghai";
const CTX = { intakeId: null, itemId: null, itemKey: "", instanceEpoch: 0, evidence: "" };
const at = (local: string) => new Date(`${local}:00+08:00`);
const SDCT = ["SDCT1", "T=18", "P=1,08:15-09:00;2,09:10-09:55;3,10:15-11:00;4,11:10-11:55", "C=高等数学|张老师|A101|1|1-2|1-18|A|-", "C=形势与政策|李老师|B202|1|3-4|6,10|A|-"].join("\n");

before(() => migrateAll());

test("E02：旧版课表导入的固定活动先按“无课程资料的占用”如实显示；同一份课表经 V2 重新投递后被认领为课程，忙碌区间不变、不双扣；再投一次不新增副本", () => {
  const db = getDb();
  const r1 = importTimetable({ text: SDCT, firstMonday: "2026-08-31", timezone: TZ }, getPlanningRevision());
  assert.ok(r1.created > 0);
  const monday = "2026-10-05"; // 第 6 周周一
  const before1 = eventsForDay(monday, TZ);
  assert.ok(before1.length === 2 && before1.every((e) => e.kind === "fixed"), "来源证明不了是课程时不猜");
  const prefs = getPrefs();
  const l0 = dayLedger(monday, at("2026-10-04T08:00"), prefs, TZ);
  assert.deepEqual([l0.courseMinutes, l0.fixedMinutes], [0, 200], "占用照扣，单独计入");
  const fixedIds = (db.prepare(`SELECT id FROM fixed_events ORDER BY id`).all() as Array<{ id: string }>).map((x) => x.id);

  const up = executeCommand({ command: "upsert_course_set", sdctText: SDCT, firstMonday: "2026-08-31", timezone: TZ }, CTX);
  assert.ok(up.ok, up.ok ? "" : up.error);
  assert.deepEqual((db.prepare(`SELECT id FROM fixed_events ORDER BY id`).all() as Array<{ id: string }>).map((x) => x.id), fixedIds, "相同规则被认领，不新建第二份");
  const after1 = eventsForDay(monday, TZ);
  assert.deepEqual(after1.map((e) => [e.kind, e.interval[0], e.interval[1]]).sort(), before1.map((e) => ["course", e.interval[0], e.interval[1]]).sort(), "忙碌区间与迁移前完全相同");
  const l1 = dayLedger(monday, at("2026-10-04T08:00"), prefs, TZ);
  assert.deepEqual([l1.courseMinutes, l1.fixedMinutes], [200, 0], "现在算作课程占用，没有双扣");
  // 通勤现在按课程计入（课前后各 15 分钟），学习窗口相应变化，但不出现重复扣除
  assert.ok(calendarDay("2026-10-12", TZ).courses.every((c) => c.courseName !== "形势与政策"), "仅 6/10 周的课在第 7 周不出现");

  const again = executeCommand({ command: "upsert_course_set", sdctText: SDCT, firstMonday: "2026-08-31", timezone: TZ }, CTX);
  assert.equal(again.ok && again.noChange, true, "同一份课表再投一次：没有变化，不换一套新对象、不写批次");
  assert.equal(eventsForDay(monday, TZ).length, 2, "重复来源不新增副本");
  assert.deepEqual((db.prepare(`SELECT id FROM fixed_events ORDER BY id`).all() as Array<{ id: string }>).map((x) => x.id), fixedIds);
  assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM course_sets WHERE status = 'active'`).get() as { n: number }).n, 1);
  // 撤销认领：回到“没有课程资料的占用”，忙碌区间仍在
  assert.equal(undoWithFollowUps(up.ok ? up.batchId! : "").kind, "undone");
  assert.deepEqual(eventsForDay(monday, TZ).map((e) => e.kind), ["fixed", "fixed"]);
});

test("E06：C=100、B=30、未来窗口 90、缓冲 20%、未来承诺 40 → futureBudget=70、futureCapacity=30；缓冲不二次扣", () => {
  assert.deepEqual(futureCapacity({ cDay: 100, bDay: 30, wFutureMinutes: 90, pFutureMinutes: 40, bufferPercent: 20 }), { futureBudget: 70, futureCapacity: 30 });
  assert.deepEqual(futureCapacity({ cDay: 100, bDay: 30, wFutureMinutes: 50, pFutureMinutes: 0, bufferPercent: 20 }), { futureBudget: 40, futureCapacity: 40 }, "未来窗口更紧时以窗口为准");
  assert.deepEqual(futureCapacity({ cDay: 100, bDay: 130, wFutureMinutes: 90, pFutureMinutes: 0, bufferPercent: 20 }), { futureBudget: 0, futureCapacity: 0 }, "已超出不出现负数");
});

test("E12：跨午夜的学习块按本地日切分；“一个半小时”= 90；ICS 的 UTC 时刻不当墙钟", () => {
  const db = getDb();
  const taskId = crypto.randomUUID();
  db.prepare(`INSERT INTO tasks (id, title, description, status, priority, estimate_minutes, due_kind, created_at, updated_at) VALUES (?, '通宵任务', '', 'todo', 'normal', 120, 'none', 'x', 'x')`).run(taskId);
  db.prepare(`INSERT INTO plan_sessions (id, task_id, start_utc, end_utc, timezone, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'completed', 'x', 'x')`).run(crypto.randomUUID(), taskId, at("2026-11-03T23:30").toISOString(), at("2026-11-04T00:45").toISOString(), TZ);
  const prefs = getPrefs();
  const asOf = at("2026-11-04T08:00");
  assert.equal(dayLedger("2026-11-03", asOf, prefs, TZ).estimatedMinutes, 30, "23:30–24:00 算在 11/3");
  assert.equal(dayLedger("2026-11-04", asOf, prefs, TZ).estimatedMinutes, 45, "00:00–00:45 算在 11/4，不全算到开始当天");
  assert.equal(estimateFromText("学了一个半小时"), 90);

  const ics = ["BEGIN:VCALENDAR", "BEGIN:VEVENT", "UID:u1", "DTSTART:20261108T060000Z", "DTEND:20261108T073000Z", "SUMMARY:UTC 讲座", "END:VEVENT", "BEGIN:VEVENT", "UID:u2", "DTSTART;TZID=Asia/Shanghai:20261108T140000", "DTEND;TZID=Asia/Shanghai:20261108T153000", "SUMMARY:本地讲座", "END:VEVENT", "END:VCALENDAR"].join("\r\n");
  const parsed = parseIcs(ics);
  const utc = parsed.events.find((e) => e.title === "UTC 讲座");
  const localEv = parsed.events.find((e) => e.title === "本地讲座");
  assert.ok(utc && localEv, JSON.stringify(parsed));
  assert.deepEqual([utc.localStart, utc.localEnd], ["14:00", "15:30"], "UTC 06:00 = 当地 14:00");
  assert.deepEqual([localEv.localStart, localEv.localEnd], ["14:00", "15:30"]);
});

test("E12/A15：ICS 子集——TZID 按那个时区换算；WEEKLY/DAILY + INTERVAL/BYDAY/COUNT/UNTIL/EXDATE 展开；全天、跨夜、不支持的规则逐条说明", () => {
  const ics = [
    "BEGIN:VCALENDAR",
    "BEGIN:VEVENT", "UID:tokyo", "DTSTART;TZID=Asia/Tokyo:20261110T100000", "DTEND;TZID=Asia/Tokyo:20261110T113000", "SUMMARY:东京时区的会", "END:VEVENT",
    "BEGIN:VEVENT", "UID:weekly", "DTSTART:20261102T190000", "DTEND:20261102T200000", "RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE;COUNT=5", "EXDATE:20261116T190000", "SUMMARY:双周社团", "END:VEVENT",
    "BEGIN:VEVENT", "UID:weekly", "RECURRENCE-ID:20261104T190000", "DTSTART:20261104T203000", "DTEND:20261104T213000", "SUMMARY:双周社团", "END:VEVENT",
    "BEGIN:VEVENT", "UID:daily", "DTSTART:20261201T070000", "DTEND:20261201T073000", "RRULE:FREQ=DAILY;UNTIL=20261203T235959", "SUMMARY:晨读", "END:VEVENT",
    "BEGIN:VEVENT", "UID:allday", "DTSTART;VALUE=DATE:20261111", "DTEND;VALUE=DATE:20261112", "SUMMARY:运动会", "END:VEVENT",
    "BEGIN:VEVENT", "UID:night", "DTSTART:20261112T230000", "DTEND:20261113T010000", "SUMMARY:通宵自习", "END:VEVENT",
    "BEGIN:VEVENT", "UID:monthly", "DTSTART:20261105T100000", "DTEND:20261105T110000", "RRULE:FREQ=MONTHLY;BYMONTHDAY=5", "SUMMARY:月会", "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");
  const r = parseIcs(ics, "Asia/Shanghai");
  const of = (title: string) => r.events.filter((e) => e.title === title).map((e) => `${e.date} ${e.localStart}-${e.localEnd}`);
  assert.deepEqual(of("东京时区的会"), ["2026-11-10 09:00-10:30"], "东京 10:00 = 上海 09:00");
  assert.deepEqual(of("双周社团"), ["2026-11-02 19:00-20:00", "2026-11-04 20:30-21:30", "2026-11-18 19:00-20:00", "2026-11-30 19:00-20:00"], "隔周一/三共 5 次，去掉 EXDATE 的 11/16，11/4 那次按单次改时");
  assert.deepEqual(of("晨读"), ["2026-12-01 07:00-07:30", "2026-12-02 07:00-07:30", "2026-12-03 07:00-07:30"]);
  assert.deepEqual(r.unsupported.map((u) => u.title).sort(), ["月会", "运动会", "通宵自习"].sort(), "不支持的逐条列出，不静默忽略");
  assert.match(r.unsupported.find((u) => u.title === "运动会")!.reason, /全天事件不支持/);
  assert.equal(r.events.some((e) => e.localEnd === "23:59"), false, "不拿 23:59 冒充全天");
});
