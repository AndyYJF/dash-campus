import assert from "node:assert/strict";
import { before, beforeEach, test } from "node:test";
import { migrateAll, getDb } from "./helpers";
import { createSource, getDecisionByRevision, getRevision } from "@/repositories/inbox";
import { importNotice, resolveProfile } from "@/workflows/inbox";
import { getFactByField } from "@/repositories/profile";
import { noticeImportSchema } from "@/contracts/inbox";
import { enqueueNoticeExtraction, runNoticeExtractionJob, validateNoticeEvidence } from "@/workflows/notice-extraction";
import { setProvidersForTests } from "@/integrations";
import { fixtureModelProvider } from "@/integrations/fixtures";
import { claimDueJobs, createJob, getJob } from "@/repositories/jobs";
import { getDigestSettings, scheduleDigests, renderDigest, runDigestJob, occurrenceKey } from "@/workflows/digests";
import { updateSetting } from "@/repositories/settings";
import { DIGEST_SETTINGS_KEY } from "@/contracts/digests";
import { setMailerForTests, type MailPayload } from "@/integrations/mailer";
import { listDeliveries, markDeliveryUnknown } from "@/repositories/deliveries";
import { writeCalendar, saveCalendarException } from "@/repositories/calendar";
import { computeWorkload } from "@/domain/workload";
import { startTemplate } from "@/workflows/templates";
import { listTemplates } from "@/repositories/exploration";
import { createTask, listTasks, updateTask } from "@/repositories/planning";
import { getMailTemplateSettings } from "@/workflows/mail-settings";
import { reminderTriggerUtc } from "@/domain/reminders";
import { applyRestoreHold, resumeAfterRestore } from "@/workflows/restore";

before(migrateAll);
beforeEach(() => { setProvidersForTests({ model: { provider: fixtureModelProvider(), mode: "fixture" }, search: null }); setMailerForTests(null); });
const imported = (source: string, token: string, n = 1, text = "面向本科生的自愿报名活动，请提交报名表。") => {
  const result = importNotice(noticeImportSchema.parse({ schemaVersion: 1, source, externalId: "a", revisionKey: `r${n}`, revisionOrder: n, occurredAt: new Date().toISOString(), text }), token);
  assert.ok(result.ok); return result;
};

test("原文→有原文依据的结构→身份判断；人工事实批量更新全部成功或全部不写", async () => {
  const source = createSource("raw", "原文测试"), result = imported(source.source.id, source.token);
  assert.equal(getDecisionByRevision(result.revisionId)?.partition, "review");
  const job = claimDueJobs(new Date().toISOString(), 50).find((j) => (j.payload as { revisionId?: string }).revisionId === result.revisionId)!;
  assert.ok(job); assert.equal((await runNoticeExtractionJob(job)).kind, "done");
  assert.ok(getRevision(result.revisionId)?.structured);
  assert.equal(getDecisionByRevision(result.revisionId)?.applicability, "UNKNOWN");
  assert.deepEqual(resolveProfile([{ field: "education_level", value: "本科", expectedVersion: 0 }]), { updated: 1, conflicts: [] });
  assert.equal(getDecisionByRevision(result.revisionId)?.partition, "opportunity");
  const batch = resolveProfile([{ field: "program", value: "人工智能", expectedVersion: 0 }, { field: "education_level", value: "研究生", expectedVersion: 0 }]);
  assert.deepEqual(batch, { updated: 0, conflicts: ["education_level"] }); assert.equal(getFactByField("program"), null);
});

test("旧修订模型返回时出现新版本：旧结果不发布；无模型与编造引用有明确失败", async () => {
  const source = createSource("race", "测试"), a = imported("race", source.token);
  const job = claimDueJobs(new Date().toISOString(), 50).find((j) => (j.payload as { revisionId?: string }).revisionId === a.revisionId)!;
  setProvidersForTests({ model: { mode: "fixture", provider: { protocol: "fake", async call(request) {
    imported("race", source.token, 2, "新版本：面向研究生，请报名。"); return fixtureModelProvider().call(request);
  } } }, search: null });
  assert.equal((await runNoticeExtractionJob(job)).kind, "done");
  assert.equal(getRevision(a.revisionId)?.structured, null);
  assert.equal((getDb().prepare("SELECT status FROM notice_extractions WHERE revision_id=?").get(a.revisionId) as { status: string }).status, "superseded");
  assert.ok(validateNoticeEvidence({ structured: { noticeType: "x", condition: { kind: "leaf", field: "program", op: "eq", value: "AI", quote: "编造" } }, actionQuote: null, dueQuote: null, unknownReason: null }, "真实原文"));
  setProvidersForTests({ model: null, search: null });
  const missing = createSource("missing", "未配置"), result = imported("missing", missing.token);
  assert.match(enqueueNoticeExtraction(result.revisionId, true).error!, /INTEGRATION_UNAVAILABLE/);
  assert.equal(getRevision(result.revisionId)?.text, "面向本科生的自愿报名活动，请提交报名表。");
});

test("日历窗口、单日停课与缓冲共用同一容量；旧版本修改拒绝", () => {
  const input = { title: "周一学习", weekday: 1, localStart: "19:00", localEnd: "21:00", timezone: "Asia/Shanghai", validFrom: null, validUntil: null, eventDate: null };
  const id = writeCalendar("availability", null, input);
  const event = writeCalendar("fixed-event", null, { ...input, title: "课程", localEnd: "20:00" });
  assert.equal(computeWorkload([], "2026-10-05", new Date("2026-10-05T00:00:00Z")).weekCapacityMinutes, 48);
  assert.equal(writeCalendar("availability", id, { ...input, localEnd: "22:00" }, 99), "conflict");
  assert.equal(saveCalendarException(event, { localDate: "2026-10-05", cancelled: true, localStart: null, localEnd: null, expectedVersion: 0 }), "ok");
  assert.equal(computeWorkload([], "2026-10-05", new Date("2026-10-05T00:00:00Z")).weekCapacityMinutes, 96);
  assert.equal(saveCalendarException(event, { localDate: "2026-10-05", cancelled: false, localStart: "19:00", localEnd: "20:00", expectedVersion: 0 }), "conflict");
});

test("每日/每周调度错过多个周期只入队一个；关闭不补发；发生时刻包含偏移", () => {
  const { settings, version } = getDigestSettings();
  updateSetting(DIGEST_SETTINGS_KEY, { ...settings, dailyEnabled: true, dailyTime: "08:30", weeklyEnabled: true, weeklyWeekday: 1, weeklyTime: "08:00" }, version);
  assert.equal(scheduleDigests(new Date("2026-09-28T00:00:00Z")), 0);
  assert.equal(scheduleDigests(new Date("2026-10-12T01:00:00Z")), 2);
  assert.equal(scheduleDigests(new Date("2026-10-12T01:00:00Z")), 0);
  assert.notEqual(occurrenceKey("2026-11-01T05:30:00Z", "America/New_York"), occurrenceKey("2026-11-01T06:30:00Z", "America/New_York"));
});

test("摘要沿用邮件隐私设置和投递状态机：unknown 重领不重复发送", async () => {
  const out: MailPayload[] = [];
  setMailerForTests({ async send(mail) { out.push(mail); return { ok: true, response: "captured" }; } });
  const date = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(new Date());
  const j = createJob({ type: "digest", dedupeKey: "test-digest-one", runAt: new Date().toISOString(), payload: { kind: "daily", date } });
  const job = claimDueJobs(new Date().toISOString(), 100).find((row) => row.id === j.id)!;
  assert.equal((await runDigestJob(job)).kind, "done"); assert.equal(out.length, 1);
  const delivery = listDeliveries().find((d) => d.jobId === job.id)!; assert.equal(delivery.status, "accepted");
  getDb().prepare("UPDATE deliveries SET status='submitting' WHERE id=?").run(delivery.id); markDeliveryUnknown(delivery.id, "模拟进程退出");
  getDb().prepare("UPDATE jobs SET status='queued',run_at='2020-01-01T00:00:00Z' WHERE id=?").run(job.id);
  const retry = claimDueJobs(new Date().toISOString(), 100).find((row) => row.id === job.id)!;
  assert.equal((await runDigestJob(retry)).kind, "done"); assert.equal(out.length, 1);
  const t = createTask({ title: "<script>private</script>", description: "", projectId: null, goalId: null, status: "todo", priority: "normal", estimateMinutes: 1, plannedWeek: { localMonday: "2026-10-05", timezone: "Asia/Shanghai" }, scheduledStart: null, scheduledEnd: null, due: { kind: "none" } });
  const preview = renderDigest("daily", "2026-10-05"); assert.ok(preview.html.includes("&lt;script&gt;private")); assert.ok(!preview.html.includes("<script>"));
  const settings = getMailTemplateSettings(); updateSetting("mailTemplate", { ...settings, privacyMode: true }, 0);
  assert.ok(!renderDigest("daily", "2026-10-05").text.includes(t.title));
  assert.equal(getJob(job.id)?.status, "done");
});

test("三个可用模板无需模型创建项目和待安排任务；模板过期版本不创建", () => {
  for (const t of listTemplates()) {
    assert.equal(t.status, "ready"); assert.ok(t.sourceLinks.length > 0); assert.ok(t.initialTasks.length >= 3);
    const p = startTemplate(t.id, t.version, null); assert.equal(listTasks({ projectId: p.id }).length, 3);
    assert.ok(listTasks({ projectId: p.id }).every((task) => task.plannedWeek === null));
    assert.throws(() => startTemplate(t.id, t.version - 1, null), /新版本/);
  }
});

test("自定义提前提醒触发点，编辑提前量使旧提醒失效", () => {
  assert.equal(reminderTriggerUtc({ kind: "instant", at: "2027-01-01T12:00:00Z", timezone: "UTC" }, 30), "2027-01-01T11:30:00.000Z");
  const t = createTask({ title: "提醒", description: "", projectId: null, goalId: null, status: "todo", priority: "normal", estimateMinutes: null, plannedWeek: null, scheduledStart: null, scheduledEnd: null, due: { kind: "instant", at: "2027-01-01T12:00:00Z", timezone: "UTC" } });
  const updated = updateTask(t.id, { reminderLeadMinutes: 30 }, t.version); assert.ok(typeof updated === "object"); assert.equal(updated.reminderRevision, t.reminderRevision + 1);
  const active = getDb().prepare("SELECT run_at FROM jobs WHERE task_id=? AND status='queued'").all(t.id) as Array<{ run_at: string }>;
  assert.deepEqual(active.map((r) => r.run_at), ["2027-01-01T11:30:00.000Z"]);
});

test("恢复后取消旧提取并从下一周期重新调度摘要，不显示永久排队或补发旧摘要", () => {
  const source = createSource("restore-raw", "恢复测试"), result = imported("restore-raw", source.token);
  applyRestoreHold(getDb(), "disposable-test-backup");
  const resumed = resumeAfterRestore(); assert.ok(resumed.ok);
  assert.equal((getDb().prepare("SELECT status FROM notice_extractions WHERE revision_id=?").get(result.revisionId) as {status: string}).status, "failed");
  assert.equal(scheduleDigests(), 0);
  assert.ok(enqueueNoticeExtraction(result.revisionId, true).jobId);
});
