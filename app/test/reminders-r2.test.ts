import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { NextRequest } from "next/server";
import { migrateAll, getDb } from "./helpers";
import { createOwner, createSession, SESSION_COOKIE } from "@/domain/session";
import { hashPassword } from "@/domain/password";
import { setNowForTests } from "@/domain/clock";
import { resetConfigCache } from "@/config";
import { setMailerForTests, type MailPayload } from "@/integrations/mailer";
import { runDueJobsOnce } from "@/worker/runner";
import { executeCommand, undoWithFollowUps } from "@/workflows/commands";
import { adjustForQuiet, DEFAULT_REMINDER_POLICY } from "@/workflows/reminder-policy";
import { scheduleDigests, getDigestSettings } from "@/workflows/digests";
import { POST as createIntakeRoute } from "@/app/api/v2/intakes/route";
import { GET as getIntakeRoute } from "@/app/api/v2/intakes/[id]/route";
import { POST as actionRoute } from "@/app/api/v2/actions/route";

/**
 * R2 提醒与摘要策略（E23、E34、E35 的隔离行为）：
 * 自然语言修改策略 → 设置与既有提醒任务一致；安静时段、只发主人、已发不可撤回如实说明。
 * 邮件用假 mailer 捕获；“SMTP 已接受”与“实际收到”是两回事，这里只验证到提交给 mailer。
 */

const CTX = { intakeId: null, itemId: null, itemKey: "", instanceEpoch: 0, evidence: "" };
const TZ = "Asia/Shanghai";
let sessionToken = "";
let csrfToken = "";
let seq = 0;
const sent: MailPayload[] = [];

function req(url: string, method: string, body?: unknown): NextRequest {
  return new NextRequest(`http://localhost${url}`, {
    method,
    headers: { cookie: `${SESSION_COOKIE}=${sessionToken}`, "x-csrf-token": csrfToken, "content-type": "application/json", ...(method === "POST" ? { "idempotency-key": `rem-${seq++}` } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}
async function say(text: string) {
  const res = await createIntakeRoute(req("/api/v2/intakes", "POST", { text }));
  assert.equal(res.status, 202);
  const { intakeId } = (await res.json()) as { intakeId: string };
  for (let i = 0; i < 3; i++) await runDueJobsOnce();
  const detail = await getIntakeRoute(req(`/api/v2/intakes/${intakeId}`, "GET"), { params: Promise.resolve({ id: intakeId }) });
  return ((await detail.json()) as { result: { state: string; summary: string; items: Array<{ error: string | null }> } }).result;
}
const reminderJobs = (taskId: string) =>
  getDb().prepare(`SELECT status, run_at FROM jobs WHERE type = 'reminder' AND task_id = ? ORDER BY created_at`).all(taskId) as Array<{ status: string; run_at: string }>;
const queued = (taskId: string) => reminderJobs(taskId).filter((j) => j.status === "queued");
const taskId = (title: string) => (getDb().prepare(`SELECT id FROM tasks WHERE title = ?`).get(title) as { id: string }).id;

before(() => {
  process.env.MAIL_TO = "owner@example.org";
  resetConfigCache();
  migrateAll();
  createOwner(hashPassword("rem-test-pass"));
  const { token, session } = createSession(1);
  sessionToken = token;
  csrfToken = session.csrfToken;
  setMailerForTests({ async send(mail) { sent.push(mail); return { ok: true, response: "captured" }; } });
});
after(() => {
  setMailerForTests(null);
  setNowForTests(null);
});

test("安静时段：落在 22:00–08:00 的提醒顺延到早上；顺延会越过截止就提前到安静时段之前；都不行则不发", () => {
  const p = DEFAULT_REMINDER_POLICY;
  const iso = (local: string) => new Date(`${local}:00+08:00`).toISOString();
  assert.equal(adjustForQuiet(iso("2099-03-02T15:00"), iso("2099-03-03T15:00"), iso("2099-03-01T10:00"), p, TZ), iso("2099-03-02T15:00"), "白天不变");
  assert.equal(adjustForQuiet(iso("2099-03-02T23:30"), iso("2099-03-03T23:30"), iso("2099-03-01T10:00"), p, TZ), iso("2099-03-03T08:00"), "夜里的顺延到早上八点");
  assert.equal(adjustForQuiet(iso("2099-03-03T02:00"), iso("2099-03-04T02:00"), iso("2099-03-01T10:00"), p, TZ), iso("2099-03-03T08:00"));
  assert.equal(adjustForQuiet(iso("2099-03-02T23:30"), iso("2099-03-03T07:00"), iso("2099-03-01T10:00"), p, TZ), iso("2099-03-02T21:59"), "早上七点就截止：提前到安静时段之前");
  assert.equal(adjustForQuiet(iso("2099-03-02T23:30"), iso("2099-03-03T07:00"), iso("2099-03-02T23:00"), p, TZ), null, "已经在安静时段里、又等不到早上：不擅自打扰");
  assert.equal(adjustForQuiet(iso("2099-03-02T23:30"), null, iso("2099-03-01T10:00"), { ...p, quietEnabled: false }, TZ), iso("2099-03-02T23:30"));
});

test("E23/E35：经统一操作创建的任务按策略建提醒；改截止旧提醒失效并重建；完成后取消；卡片入口同一套", async () => {
  const created = executeCommand({ command: "create_or_update_task", title: "课程论文", estimateMinutes: 120, dueLocalDate: "2099-03-10", dueLocalTime: "15:00" }, CTX);
  assert.ok(created.ok);
  const id = taskId("课程论文");
  assert.deepEqual(queued(id).map((j) => j.run_at), ["2099-03-09T07:00:00.000Z"], "时刻型截止默认提前 24 小时");

  executeCommand({ command: "create_or_update_task", taskId: id, dueLocalDate: "2099-03-12", dueLocalTime: "23:30" }, CTX);
  assert.deepEqual(reminderJobs(id).map((j) => j.status), ["cancelled", "queued"], "改期：旧提醒取消，不会再发");
  assert.equal(queued(id)[0]!.run_at, "2099-03-12T00:00:00.000Z", "新触发点 3/11 23:30 落在安静时段 → 顺延到 3/12 08:00");

  const done = await actionRoute(req("/api/v2/actions", "POST", { operation: "complete_task", args: { taskId: id } }));
  assert.equal(done.status, 200);
  assert.equal(queued(id).length, 0, "完成后未发的提醒取消（卡片按钮与对话同一执行器）");
});

test("E34：自然语言设置“工作日晚八点给摘要、其他只提醒临近截止、报告提前一天提醒”→ 策略与既有提醒任务一致；随后改为不发摘要", async () => {
  executeCommand({ command: "create_or_update_task", title: "实验报告", estimateMinutes: 60, dueLocalDate: "2099-04-20", dueLocalTime: "18:00" }, CTX);
  const id = taskId("实验报告");
  assert.equal(queued(id)[0]!.run_at, "2099-04-19T10:00:00.000Z");

  const r = await say("工作日晚八点给我摘要，其他只提醒临近截止");
  assert.equal(r.state, "applied", JSON.stringify(r.items));
  assert.match(r.summary, /工作日 20:00 发今日摘要/);
  assert.match(r.summary, /只发到已配置的主人邮箱/);
  const digest = getDigestSettings().settings;
  assert.deepEqual([digest.dailyEnabled, digest.dailyTime, digest.dailyWeekdaysOnly], [true, "20:00", true]);

  const lead = await say("实验报告提前一天提醒");
  assert.equal(lead.state, "applied", JSON.stringify(lead.items));
  assert.match(lead.summary, /「实验报告」提前 1 天提醒/);
  assert.equal(queued(id).length, 1, "同一任务只有一个有效提醒");
  assert.equal(queued(id)[0]!.run_at, "2099-04-19T10:00:00.000Z");
  const lead2 = await say("实验报告提前两小时提醒");
  assert.equal(lead2.state, "applied");
  assert.equal(queued(id)[0]!.run_at, "2099-04-20T08:00:00.000Z", "既有提醒任务随策略重排");

  // 摘要只在工作日到点排：周六不排，周一排；发给主人
  const db = getDb();
  const digestJobs = () => (db.prepare(`SELECT COUNT(*) AS n FROM jobs WHERE type = 'digest'`).get() as { n: number }).n;
  scheduleDigests(new Date("2026-10-17T19:00:00+08:00")); // 周六，建立日程
  scheduleDigests(new Date("2026-10-17T20:05:00+08:00"));
  assert.equal(digestJobs(), 0, "周六不发");
  scheduleDigests(new Date("2026-10-19T20:05:00+08:00")); // 周一
  assert.equal(digestJobs(), 1);

  const off = await say("不发摘要了");
  assert.equal(off.state, "applied");
  assert.match(off.summary, /不再发每日摘要（已经发出的收不回，以后不发）/, "不假称撤回已发邮件");
  assert.equal(getDigestSettings().settings.dailyEnabled, false);
  sent.length = 0;
  setNowForTests(null);
  for (let i = 0; i < 3; i++) await runDueJobsOnce();
  assert.equal(sent.filter((m) => /今日摘要/.test(m.subject)).length, 0, "已排队的那封在准入时发现已关闭：不发");
});

test("E34：关掉截止提醒 → 已排的提醒一并取消；撤销后恢复；安静时段可一句话修改", async () => {
  const id = taskId("实验报告");
  const off = await say("别再提醒我了");
  assert.equal(off.state, "applied", JSON.stringify(off.items));
  assert.match(off.summary, /不再发截止提醒/);
  assert.equal(queued(id).length, 0, "worker 读到的是同一份策略：已排的提醒取消");
  executeCommand({ command: "create_or_update_task", title: "关提醒后新建的任务", dueLocalDate: "2099-05-01" }, CTX);
  assert.equal(queued(taskId("关提醒后新建的任务")).length, 0);

  const batch = getDb().prepare(`SELECT id FROM agent_action_batches WHERE command = 'update_reminder_policy' AND status = 'applied' ORDER BY rowid DESC LIMIT 1`).get() as { id: string };
  assert.equal(undoWithFollowUps(batch.id).kind, "undone");
  assert.equal(queued(id).length, 1, "撤销后提醒按恢复的策略重建");

  const quiet = await say("晚上11点到早上7点别发邮件");
  assert.equal(quiet.state, "applied", JSON.stringify(quiet.items));
  assert.match(quiet.summary, /23:00–07:00 不发邮件/);
});
