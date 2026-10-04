import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import { before, test } from "node:test";
import { migrateAll, getDb } from "./helpers";
import { executeCommand } from "@/workflows/commands";
import { undoBatch } from "@/workflows/undo";
import { calendarDay, teachingWeekOf } from "@/workflows/calendar";
import { dayLedger, rebuildPlan } from "@/workflows/plan";
import { getPrefs } from "@/repositories/plan";
import { htmlToText, isOfficialHolidaySource, parseHolidayNotice } from "@/domain/holiday-notice";

/**
 * R0/R1 日历层（ACADEMIC-CALENDAR-AND-HOLIDAYS §3–§5；E03、E42–E47、E49 的隔离行为）。
 * 课表与补课映射是合成案例（不是任何学校的真实调课通知）；国家节假日用 2026 年官方通知网页原文解析。
 */

const TZ = "Asia/Shanghai";
const CTX = { intakeId: null, itemId: null, itemKey: "", instanceEpoch: 0, evidence: "" };
const GOV_URL = "https://www.gov.cn/zhengce/zhengceku/202511/content_7047091.htm";
const at = (local: string) => new Date(`${local}:00+08:00`);

// 首周周一 2026-08-31：第 5 周 9/28–10/4，第 6 周 10/5–10/11，第 7 周 10/12–10/18
const SDCT = [
  "SDCT1",
  "T=18",
  "P=1,08:15-09:00;2,09:10-09:55;3,10:15-11:00;4,11:10-11:55;5,14:00-14:45;6,14:55-15:40",
  "C=高等数学|张老师|A101|5|1-2|1-18|A|-",
  "C=形势与政策|李老师|B202|5|3-4|6,10|A|-",
  "C=大学物理|王老师|C303|5|5-6|1-18|E|-",
  "C=实验课|钱老师|E505|5|5-6|1-18|O|-",
  "C=线性代数|赵老师|D404|1|1-2|1-18|A|-",
].join("\n");

function run(cmd: Record<string, unknown>) {
  const r = executeCommand(cmd, CTX);
  assert.ok(r.ok, r.ok ? "" : r.error);
  return r;
}
const names = (date: string) => calendarDay(date, TZ).courses.map((c) => c.courseName);
const hm = (ms: number) => new Date(ms + 8 * 3600_000).toISOString().slice(11, 16);
function addFixed(title: string, date: string, start: string, end: string) {
  const weekday = ((new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7) + 1;
  getDb().prepare(`INSERT INTO fixed_events (id, title, weekday, local_start, local_end, timezone, event_date) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(crypto.randomUUID(), title, weekday, start, end, TZ, date);
}

before(() => {
  migrateAll();
  run({ command: "upsert_course_set", sdctText: SDCT, firstMonday: "2026-08-31", timezone: TZ });
});

test("E03：第 6、10 周的课只在这两周出现；单次停课/跨周调课只影响目标日期，可撤销", () => {
  assert.equal(teachingWeekOf("2026-10-09")?.week, 6);
  assert.ok(names("2026-10-09").includes("形势与政策"));
  for (const d of ["2026-10-16", "2026-10-23", "2026-10-30"]) assert.ok(!names(d).includes("形势与政策"), `${d}（第 7–9 周）不应有这门课`);
  assert.ok(names("2026-11-06").includes("形势与政策"), "第 10 周有");

  const cancel = run({ command: "apply_teaching_day_override", scope: "course", courseName: "高等数学", mode: "cancel", sourceTeachingDate: "2026-09-18" });
  assert.ok(!names("2026-09-18").includes("高等数学"));
  assert.ok(names("2026-09-25").includes("高等数学"), "例外只影响当天");
  assert.deepEqual(undoBatch(cancel.batchId!), { kind: "undone" });
  assert.ok(names("2026-09-18").includes("高等数学"), "撤销后恢复");

  const prefs = getPrefs();
  const before1 = dayLedger("2026-09-11", at("2026-09-01T08:00"), prefs, TZ).courseMinutes;
  const move = run({ command: "apply_teaching_day_override", scope: "course", courseName: "高等数学", mode: "move", sourceTeachingDate: "2026-09-11", targetDate: "2026-09-15", targetStart: "14:00", targetEnd: "15:40" });
  assert.ok(!names("2026-09-11").includes("高等数学"));
  const moved = calendarDay("2026-09-15", TZ).courses.find((c) => c.courseName === "高等数学")!;
  assert.equal(moved.origin, "moved");
  assert.equal(moved.sourceDate, "2026-09-11", "保留源教学日期");
  assert.equal(`${hm(moved.interval[0])}-${hm(moved.interval[1])}`, "14:00-15:40");
  assert.equal(dayLedger("2026-09-11", at("2026-09-01T08:00"), prefs, TZ).courseMinutes, before1 - 100, "源日预算释放");
  assert.equal(dayLedger("2026-09-15", at("2026-09-01T08:00"), prefs, TZ).courseMinutes, 100, "目标日占用");
  assert.deepEqual(undoBatch(move.batchId!), { kind: "undone" });
  assert.ok(names("2026-09-11").includes("高等数学"));
  assert.equal(calendarDay("2026-09-15", TZ).courses.length, 0);

  const bad = executeCommand({ command: "apply_teaching_day_override", scope: "course", courseName: "高等数学", mode: "cancel", sourceTeachingDate: "2026-09-16" }, CTX);
  assert.equal(bad.ok, false, "那天没有这门课：不制造例外");
});

test("E44（合成映射）：第 6 周周五的课移到第 7 周周六——按源教学日判断周次/单双周，无副本，其他固定活动不移动", () => {
  addFixed("体检", "2026-10-09", "16:00", "17:00");
  // 第 6 周（双周）周五：高数、形势与政策（仅 6/10 周）、大学物理（双周）；实验课是单周
  assert.deepEqual(names("2026-10-09").sort(), ["大学物理", "形势与政策", "高等数学"]);
  const r = run({ command: "apply_teaching_day_override", scope: "school", mode: "replace", sourceTeachingDate: "2026-10-09", targetDate: "2026-10-17", cancelSource: true, origin: "source", evidence: "合成规则：第6周周五课程调至10月17日（周六）" });
  const target = calendarDay("2026-10-17", TZ);
  assert.deepEqual(target.courses.map((c) => c.courseName).sort(), ["大学物理", "形势与政策", "高等数学"], "按第 6 周源实例展开：有仅 6/10 周的课、有双周课，没有单周的实验课");
  assert.equal(teachingWeekOf("2026-10-17")?.week, 7, "目标日在第 7 周（单周）——不能按目标日期重新筛选");
  assert.equal(target.teaching.status, "makeup");
  assert.equal(target.teaching.sourceTeachingDate, "2026-10-09");
  assert.match(target.teaching.note, /第 6 周周五/);
  for (const c of target.courses) {
    assert.equal(c.sourceDate, "2026-10-09");
    assert.ok(c.occurrenceId.endsWith("@2026-10-09"), "源实例标识保留");
  }
  const source = calendarDay("2026-10-09", TZ);
  assert.equal(source.courses.length, 0, "源日课程按来源取消");
  assert.equal(source.teaching.status, "cancelled");
  assert.deepEqual(source.fixed.map((f) => f.title), ["体检"], "非课程固定活动留在原日期");
  assert.equal(target.fixed.length, 0);

  const prefs = getPrefs();
  assert.equal(dayLedger("2026-10-17", at("2026-10-01T08:00"), prefs, TZ).courseMinutes, 300, "三门课各 100 分钟，只扣一次");
  assert.equal(dayLedger("2026-10-09", at("2026-10-01T08:00"), prefs, TZ).courseMinutes, 0, "旧投影与新实例不双扣");

  const again = run({ command: "apply_teaching_day_override", scope: "school", mode: "replace", sourceTeachingDate: "2026-10-09", targetDate: "2026-10-17", cancelSource: true });
  assert.equal(again.noChange, true, "重复应用不产生副本");
  const other = executeCommand({ command: "apply_teaching_day_override", scope: "school", mode: "add", sourceTeachingDate: "2026-10-09", targetDate: "2026-10-18" }, CTX);
  assert.equal(other.ok, false, "同一原教学日最多一个去向");

  assert.deepEqual(undoBatch(r.batchId!), { kind: "undone" });
  assert.equal(calendarDay("2026-10-17", TZ).courses.length, 0);
  assert.equal(names("2026-10-09").length, 3, "撤销映射后源日课程恢复");
});

test("E44：已用课程单次移动表示的补课，不再被全校映射叠加成副本", () => {
  const move = run({ command: "apply_teaching_day_override", scope: "course", courseName: "高等数学", mode: "move", sourceTeachingDate: "2026-10-09", targetDate: "2026-10-13" });
  const map = run({ command: "apply_teaching_day_override", scope: "school", mode: "replace", sourceTeachingDate: "2026-10-09", targetDate: "2026-10-17", cancelSource: true });
  assert.ok(!names("2026-10-17").includes("高等数学"), "已单独调走的课不随全校映射再出现");
  assert.deepEqual(names("2026-10-13"), ["高等数学"]);
  undoBatch(map.batchId!);
  undoBatch(move.batchId!);
});

test("真实国家来源：2026 年官方通知网页原文可解析（星期、天数自洽），非官方出处被拒绝", () => {
  const parsed = parseHolidayNotice(htmlToText(fs.readFileSync("test/fixtures/gov-holiday-2026.html", "utf8")));
  assert.ok(parsed.ok, parsed.ok ? "" : parsed.error);
  assert.equal(parsed.notice.year, 2026);
  assert.equal(parsed.notice.publishedAt, "2025-11-04");
  assert.equal(parsed.notice.days.filter((d) => d.kind === "holiday").length, 33);
  assert.deepEqual(parsed.notice.days.filter((d) => d.kind === "adjusted_workday").map((d) => d.localDate), ["2026-01-04", "2026-02-14", "2026-02-28", "2026-05-09", "2026-09-20", "2026-10-10"]);
  assert.equal(isOfficialHolidaySource(GOV_URL), true);
  assert.equal(isOfficialHolidaySource("https://example.com/holiday.json"), false);

  // 年份对不上（星期不自洽）或缺条目：整体失败，不猜
  const wrongYear = parseHolidayNotice(htmlToText(fs.readFileSync("test/fixtures/gov-holiday-2026.html", "utf8")).replaceAll("2026年", "2027年"));
  assert.equal(wrongYear.ok, false);
  assert.equal(parseHolidayNotice("随便一段文字").ok, false);

  assert.equal(calendarDay("2026-10-01", TZ).civil.known, false, "未获取数据时不能当成“全年无节假日”");
  const third = executeCommand({ command: "sync_holiday_calendar", year: 2026, days: parsed.notice.days, revisionHash: parsed.notice.revisionHash, origin: "third_party", sourceUrl: "https://example.com/x" }, CTX);
  assert.equal(third.ok, false, "第三方数据没有官方定位：不入库");
  assert.equal(calendarDay("2026-10-01", TZ).civil.known, false);

  const r = run({ command: "sync_holiday_calendar", year: 2026, days: parsed.notice.days, revisionHash: parsed.notice.revisionHash, origin: "official", sourceUrl: GOV_URL, sourceTitle: parsed.notice.title, publishedAt: parsed.notice.publishedAt });
  assert.ok(r.batchId);
  const day = calendarDay("2026-10-01", TZ);
  assert.deepEqual([day.civil.type, day.civil.name, day.civil.known], ["holiday", "国庆节", true]);
  assert.equal(calendarDay("2027-01-01", TZ).civil.known, false, "E45：跨年数据按年度独立获取，2027 未获取就是未知");
});

test("E42：国家周六补班、没有学校补课规则——只标公历日，教学待核对；不生成周一/周五的课，不把可能上课的时段排满", () => {
  const sat = calendarDay("2026-10-10", TZ);
  assert.equal(sat.civil.type, "adjusted_workday");
  assert.equal(sat.courses.length, 0, "国家补班不推导补哪天的课");
  assert.equal(sat.teaching.status, "pending");
  assert.ok(sat.pending.length > 0, "保守预留可能的上课时段");
  const prefs = getPrefs();
  const ledger = dayLedger("2026-10-10", at("2026-10-05T08:00"), prefs, TZ);
  assert.equal(ledger.courseMinutes, 0, "预留不算已确认课程");
  assert.equal(ledger.policy.template, "weekend", "法定补班不把个人窗口改成工作日模板");
  // 预留覆盖本周周一/周五课程的钟点（08:15–11:55、14:00–15:40），学习窗口不含这些时段
  for (const [s, e] of ledger.w) assert.ok(e <= at("2026-10-10T09:00").getTime() || s >= at("2026-10-10T11:55").getTime(), "上午可能上课的时段不开放");

  const fri = calendarDay("2026-10-02", TZ); // 国庆假期内的周五，学校规则未知
  assert.equal(fri.civil.type, "holiday");
  assert.equal(fri.teaching.status, "pending", "学校是否停课待核对");
  assert.ok(fri.courses.length > 0, "暂按原课表预留，不显示为已确认停课");
});

test("E43/E45：学校假期停课释放课程与交通；节假日不自动把预算变零；个人假期策略与“回家不安排”分别生效", () => {
  const prefs = getPrefs();
  const asOf = at("2026-09-25T08:00");
  assert.ok(dayLedger("2026-10-02", asOf, prefs, TZ).courseMinutes > 0);
  const cal = run({
    command: "upsert_academic_calendar",
    school: "合成大学",
    audience: "all",
    academicYear: "2026-2027",
    termLabel: "秋季学期",
    registrationDate: "2026-08-28",
    teachingStart: "2026-08-31",
    totalWeeks: 18,
    events: [
      { kind: "holiday", title: "国庆节放假", startDate: "2026-10-01", endDate: "2026-10-07", cancelsClasses: true, evidence: "合成校历" },
      { kind: "exam", title: "期末考试周", startDate: "2027-01-04", endDate: "2027-01-10", cancelsClasses: false },
    ],
    source: "合成校历",
    sourceRevision: "rev-1",
  });
  const c = getDb().prepare(`SELECT registration_date, teaching_start, first_monday, semester_id FROM academic_calendars WHERE status = 'active'`).get() as Record<string, string>;
  assert.deepEqual([c.registration_date, c.teaching_start, c.first_monday], ["2026-08-28", "2026-08-31", "2026-08-31"], "报到日/授课日/首周周一分开保存，报到日（周五）不当首周");
  assert.ok(c.semester_id, "关联到已有学期，不另建第二个");
  assert.equal((getDb().prepare(`SELECT COUNT(*) AS n FROM semesters`).get() as { n: number }).n, 1);

  const fri = dayLedger("2026-10-02", asOf, prefs, TZ);
  assert.equal(fri.calendar.teaching.status, "cancelled");
  assert.equal(fri.courseMinutes, 0, "停课释放课程占用");
  assert.equal(fri.cDay, 180, "假日不自动把学习预算变零，日上限仍然约束");
  assert.equal(teachingWeekOf("2026-10-02")?.week, 5, "假期不暂停、不重编教学周");
  assert.equal(teachingWeekOf("2026-10-09")?.week, 6);
  const exam = calendarDay("2027-01-05", TZ);
  assert.equal(exam.phase, "exam");
  assert.equal(exam.courses.length, 0, "考试周不虚构具体考试");
  assert.equal(exam.fixed.length, 0);

  const policy = run({ command: "update_planning_policy", rules: [{ kind: "holiday_policy", value: { mode: "none" } }] });
  assert.equal(dayLedger("2026-10-02", asOf, prefs, TZ).cDay, 0, "已确认假期不学：预算为 0");
  assert.equal(dayLedger("2026-10-10", asOf, prefs, TZ).cDay > 0, true, "补班的周六不是假日，不受假期策略影响");
  undoBatch(policy.batchId!);
  assert.equal(dayLedger("2026-10-02", asOf, prefs, TZ).cDay, 180);

  const trip = run({ command: "update_planning_policy", rules: [{ kind: "no_study", dateFrom: "2026-10-03", dateTo: "2026-10-05", scope: "temporary", value: { label: "回家" } }] });
  assert.equal(dayLedger("2026-10-04", asOf, prefs, TZ).cDay, 0, "个人不安排区间：有效窗口归零");
  assert.equal(dayLedger("2026-10-06", asOf, prefs, TZ).cDay, 180, "只影响说的那几天");
  undoBatch(trip.batchId!);
  void cal;
});

test("E46/E47：首周与现有课表冲突时先问；同一修订重复导入无变化；撤销后同修订不被再次套用", () => {
  const base = { command: "upsert_academic_calendar", school: "合成大学", academicYear: "2026-2027", termLabel: "秋季学期", totalWeeks: 18, source: "合成校历" };
  const same = run({ ...base, teachingStart: "2026-08-31", registrationDate: "2026-08-28", sourceRevision: "rev-1" });
  assert.equal(same.noChange, true, "相同修订不重复导入、不写批次");

  const conflict = executeCommand({ ...base, teachingStart: "2026-09-07", sourceRevision: "rev-2" }, CTX);
  assert.equal(conflict.ok, false);
  assert.equal(conflict.ok ? "" : conflict.code, "ANCHOR_CONFLICT", "首周变化会移动全部课程：不暗改，交回提问");
  assert.equal(teachingWeekOf("2026-10-09")?.week, 6, "冲突时什么都没变");

  // 学校明确国庆那周不计教学周：主人确认后，课程按周次表重新展开
  const r = run({ ...base, teachingStart: "2026-08-31", skippedWeeks: ["2026-10-05"], sourceRevision: "rev-3", confirmAnchorChange: true });
  assert.equal(teachingWeekOf("2026-10-07")?.week ?? null, null, "被跳过的那周不编号");
  assert.equal(teachingWeekOf("2026-10-16")?.week, 6, "之后的周次顺延");
  assert.ok(names("2026-10-16").includes("形势与政策"), "仅第 6 周的课随周次表移到 10/16");
  assert.ok(!names("2026-10-09").includes("形势与政策"));
  assert.equal(names("2026-10-09").length, 0, "跳过的那周没有课");

  assert.deepEqual(undoBatch(r.batchId!), { kind: "undone" });
  assert.equal(teachingWeekOf("2026-10-09")?.week, 6, "撤销后学期与课程投影一并恢复");
  assert.ok(names("2026-10-09").includes("形势与政策"));
  const replay = run({ ...base, teachingStart: "2026-08-31", skippedWeeks: ["2026-10-05"], sourceRevision: "rev-3", confirmAnchorChange: true });
  assert.equal(replay.noChange, true, "撤销过的修订留有墓碑，再次同步不复活");
  assert.equal(teachingWeekOf("2026-10-09")?.week, 6);
});

test("E47：节假日相同修订重复同步无变化；撤销后墓碑阻止同修订复活，新修订仍可进入", () => {
  const parsed = parseHolidayNotice(htmlToText(fs.readFileSync("test/fixtures/gov-holiday-2026.html", "utf8")));
  assert.ok(parsed.ok);
  const cmd = { command: "sync_holiday_calendar", year: 2026, days: parsed.notice.days, revisionHash: parsed.notice.revisionHash, origin: "official", sourceUrl: GOV_URL };
  const batches = () => (getDb().prepare(`SELECT COUNT(*) AS n FROM agent_action_batches WHERE command = 'sync_holiday_calendar'`).get() as { n: number }).n;
  const n = batches();
  assert.equal(run(cmd).noChange, true);
  assert.equal(batches(), n, "无变化不写批次");
  const batch = getDb().prepare(`SELECT id FROM agent_action_batches WHERE command = 'sync_holiday_calendar' AND status = 'applied'`).get() as { id: string };
  assert.deepEqual(undoBatch(batch.id), { kind: "undone" });
  assert.equal(calendarDay("2026-10-01", TZ).civil.known, false);
  assert.equal(run(cmd).noChange, true, "同修订不被重新套用");
  assert.equal(calendarDay("2026-10-01", TZ).civil.type, "workday");
  const revised = run({ ...cmd, revisionHash: "revised-0000-0001" });
  assert.equal(revised.noChange, false, "新修订进入");
  assert.equal(calendarDay("2026-10-01", TZ).civil.type, "holiday");
});

test("E15/E26：一句话改作息是持久的；“今晚不学”只关当天并让出今晚的块；按星期上限持久生效", () => {
  const db = getDb();
  for (const t of ["plan_sessions", "practice_entries"]) db.prepare(`DELETE FROM ${t}`).run();
  db.prepare(`DELETE FROM tasks`).run();
  const prefs0 = getPrefs();
  assert.equal(prefs0.status, "tentative");
  // “晚上九点后不排，工作日最多两小时”
  const r = run({ command: "update_planning_policy", base: { workdayEnd: "21:00", weekendEnd: "21:00" }, rules: [{ kind: "group_limit", value: { group: "workday", limitMinutes: 120 } }], confirm: true });
  assert.match(r.summary, /工作日每天最多安排 120 分钟/);
  const prefs = getPrefs();
  assert.equal(prefs.status, "confirmed");
  const tue = dayLedger("2026-11-10", at("2026-11-09T07:00"), prefs, TZ);
  assert.equal(tue.cDay, 120);
  for (const [, e] of tue.w) assert.ok(e <= at("2026-11-10T21:00").getTime(), "21:00 之后不在可安排窗口");
  assert.equal(dayLedger("2026-11-14", at("2026-11-09T07:00"), prefs, TZ).cDay, 180, "周末不受工作日上限影响");

  const wed = run({ command: "update_planning_policy", rules: [{ kind: "weekday_limit", weekday: 3, value: { limitMinutes: 60 } }] });
  assert.equal(dayLedger("2026-11-11", at("2026-11-09T07:00"), prefs, TZ).cDay, 60);
  assert.equal(dayLedger("2026-11-18", at("2026-11-09T07:00"), prefs, TZ).cDay, 60, "之后每个周三都生效");
  assert.equal(dayLedger("2026-11-12", at("2026-11-09T07:00"), prefs, TZ).cDay, 120);

  // 今晚有安排 → “今晚不学了”
  const taskId = crypto.randomUUID();
  db.prepare(`INSERT INTO tasks (id, title, description, status, priority, estimate_minutes, due_kind, created_at, updated_at) VALUES (?, '微积分复习', '', 'todo', 'normal', 60, 'none', ?, ?)`).run(taskId, "2026-11-01T00:00:00.000Z", "2026-11-01T00:00:00.000Z");
  const asOf = at("2026-11-09T18:30"); // 周一晚
  rebuildPlan(asOf);
  const tonight = db.prepare(`SELECT id, start_utc FROM plan_sessions WHERE task_id = ? AND status = 'planned'`).all(taskId) as Array<{ id: string; start_utc: string }>;
  assert.equal(tonight.length, 1);
  assert.ok(tonight[0]!.start_utc < at("2026-11-10T00:00").toISOString(), "原本排在今晚");
  const off = run({ command: "update_planning_policy", rules: [{ kind: "no_study", dateFrom: "2026-11-09", dateTo: "2026-11-09", scope: "temporary", value: { fromTime: "18:30", label: "今晚不学" } }] });
  assert.match(off.summary, /1 个还没开始的学习块已让出/);
  rebuildPlan(asOf);
  const after = db.prepare(`SELECT id, start_utc FROM plan_sessions WHERE task_id = ? AND status = 'planned'`).all(taskId) as Array<{ id: string; start_utc: string }>;
  assert.equal(after.length, 1, "需求仍在，另找时间，不产生副本");
  assert.ok(after[0]!.start_utc >= at("2026-11-10T00:00").toISOString(), "今晚不再安排");
  assert.equal(dayLedger("2026-11-09", asOf, prefs, TZ).futureCapacity, 0);
  assert.ok(dayLedger("2026-11-16", at("2026-11-16T18:30"), prefs, TZ).futureCapacity > 0, "不是永久关闭晚间学习：下周一晚上照常");
  undoBatch(off.batchId!);
  undoBatch(wed.batchId!);
});

test("E29：重新安排的授权有范围、可撤回；不含锁定块；撤回后近期块恢复保护", () => {
  const db = getDb();
  for (const t of ["plan_sessions"]) db.prepare(`DELETE FROM ${t}`).run();
  db.prepare(`DELETE FROM tasks`).run();
  const mk = (title: string, minutes: number) => {
    const id = crypto.randomUUID();
    db.prepare(`INSERT INTO tasks (id, title, description, status, priority, estimate_minutes, due_kind, created_at, updated_at) VALUES (?, ?, '', 'todo', 'normal', ?, 'none', ?, ?)`).run(id, title, minutes, "2026-11-01T00:00:00.000Z", "2026-11-01T00:00:00.000Z");
    db.prepare("UPDATE tasks SET task_kind = 'study' WHERE id = ?").run(id);
    return id;
  };
  const a = mk("任务甲", 50);
  const b = mk("任务乙", 50);
  const asOf = at("2026-11-21T08:00"); // 周六
  rebuildPlan(asOf);
  const rows = () => db.prepare(`SELECT id, task_id, start_utc, locked FROM plan_sessions WHERE status = 'planned' ORDER BY start_utc`).all() as Array<{ id: string; task_id: string; start_utc: string; locked: number }>;
  const first = rows();
  assert.equal(first.length, 2);
  db.prepare(`UPDATE plan_sessions SET locked = 1 WHERE task_id = ?`).run(a);
  // 今天加一个临时活动压在两个块上：没有授权时都不动，只标冲突
  addFixed("临时讲座", "2026-11-21", "09:00", "11:30");
  const r1 = rebuildPlan(asOf);
  assert.deepEqual(rows().map((x) => x.id), first.map((x) => x.id), "24h 内的块不擅自移动");
  assert.equal(r1.conflicts.length, 2);

  const grant = run({ command: "update_planning_policy", rules: [{ kind: "auto_reschedule", dateFrom: "2026-11-21", dateTo: "2026-11-21", scope: "temporary", value: {} }] });
  const r2 = rebuildPlan(asOf);
  const now = rows();
  const lockedRow = now.find((x) => x.task_id === a)!;
  assert.equal(lockedRow.id, first.find((x) => x.task_id === a)!.id, "锁定块不因授权被移动，也不被永久解锁");
  assert.equal(lockedRow.locked, 1);
  const movedRow = now.find((x) => x.task_id === b)!;
  assert.notEqual(movedRow.id, first.find((x) => x.task_id === b)!.id, "授权范围内的未锁定块被重新安排");
  assert.ok(movedRow.start_utc >= at("2026-11-21T11:30").toISOString(), "避开临时活动");
  assert.deepEqual(r2.conflicts.map((c) => c.taskId), [a], "锁定块的冲突仍然标出");

  const revoke = run({ command: "update_planning_policy", revokeRuleIds: [(db.prepare(`SELECT id FROM planning_policy_rules WHERE kind = 'auto_reschedule' AND status = 'active'`).get() as { id: string }).id] });
  assert.match(revoke.summary, /已撤回/);
  addFixed("又一个活动", "2026-11-21", movedRow.start_utc.slice(11, 16) === "03:45" ? "11:45" : "12:00", "20:00");
  const r3 = rebuildPlan(asOf);
  assert.ok(rows().some((x) => x.id === movedRow.id), "授权撤回后，近期块重新受保护");
  assert.ok(r3.conflicts.length >= 1);
  void grant;
});
