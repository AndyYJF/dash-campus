import assert from "node:assert/strict";
import { test, before } from "node:test";
import { migrateAll, getDb } from "./helpers";
import { setMailerForTests, type Mailer, type MailPayload, type MailSendResult } from "@/integrations/mailer";
import { createTask, getTask, updateTask, archiveTask } from "@/repositories/planning";
import {
  claimDueJobs,
  completeJob,
  getJob,
  listJobs,
  renewLease,
  requestCancel,
} from "@/repositories/jobs";
import { listDeliveries, getDelivery } from "@/repositories/deliveries";
import { reminderTriggerUtc } from "@/domain/reminders";
import { runReminderJob } from "@/worker/handlers";
import { recoverOnStartup, runDueJobsOnce } from "@/worker/runner";
import { REMINDER_JOB_TYPE } from "@/contracts/jobs";

/** 捕获型 fake mailer：记录发送；可配置失败 */
class FakeMailer implements Mailer {
  sent: MailPayload[] = [];
  fail: boolean;
  constructor(opts: { fail?: boolean } = {}) {
    this.fail = opts.fail ?? false;
  }
  async send(mail: MailPayload): Promise<MailSendResult> {
    if (this.fail) {
      return { ok: false, error: { code: "SMTP_ERROR", message: "模拟失败", retryable: true } };
    }
    this.sent.push(mail);
    return { ok: true, response: "250 ok" };
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

/** 未来若干小时的 instant due */
function dueInHours(h: number): { kind: "instant"; at: string; timezone: string } {
  return { kind: "instant", at: new Date(Date.now() + h * 3600_000).toISOString(), timezone: "UTC" };
}

function makeTask(overrides: Record<string, unknown> = {}) {
  return createTask({
    title: "提醒测试任务",
    description: "说明",
    projectId: null,
    goalId: null,
    status: "todo",
    priority: "normal",
    estimateMinutes: 30,
    plannedWeek: null,
    scheduledStart: null,
    scheduledEnd: null,
    due: dueInHours(48),
    ...overrides,
  });
}

function queuedReminderJobs(taskId: string) {
  return listJobs({ type: REMINDER_JOB_TYPE, status: "queued" }).filter((j) => j.taskId === taskId);
}

/** 把 job 的 run_at 拨到过去使其可被领取（测试用） */
function forceDue(jobId: string): void {
  getDb()
    .prepare(`UPDATE jobs SET run_at = ? WHERE id = ?`)
    .run("2020-01-01T00:00:00.000Z", jobId);
}

before(() => {
  migrateAll();
});

test("触发点计算：date 型当天 09:00 当地；instant 型默认提前 24 小时", () => {
  const t1 = reminderTriggerUtc({ kind: "date", localDate: "2026-10-01", timezone: "Asia/Shanghai" });
  assert.equal(t1, "2026-10-01T01:00:00.000Z"); // 09:00 +08:00
  const t2 = reminderTriggerUtc({ kind: "instant", at: "2026-10-02T10:00:00.000Z", timezone: "UTC" });
  assert.equal(t2, "2026-10-01T10:00:00.000Z");
  assert.equal(reminderTriggerUtc({ kind: "none" }), null);
});

test("F22：done→todo 重开恰好一组未来提醒；重复请求幂等；due 清空无残留", () => {
  const task = makeTask(); // due +48h，触发点 +24h 在未来
  let jobs = queuedReminderJobs(task.id);
  assert.equal(jobs.length, 1, "初建恰好一个提醒 job");
  assert.equal((jobs[0].payload as { reminderRevision: number }).reminderRevision, 0);

  // done → 取消提醒
  let r = updateTask(task.id, { status: "done" }, getTask(task.id)!.version);
  assert.ok(r !== "conflict");
  assert.equal(getTask(task.id)!.reminderRevision, 1, "进入终态递增 revision");
  assert.equal(queuedReminderJobs(task.id).length, 0, "终态后无排队提醒");

  // 重开 done→todo → 恰好一组新的未来提醒
  r = updateTask(task.id, { status: "todo" }, getTask(task.id)!.version);
  assert.equal(getTask(task.id)!.reminderRevision, 2, "重开递增 revision");
  jobs = queuedReminderJobs(task.id);
  assert.equal(jobs.length, 1, "重开恰好一个新提醒 job");
  assert.equal((jobs[0].payload as { reminderRevision: number }).reminderRevision, 2);

  // 重复打开同一状态：status 值相同 → revision 不变，job 不重复
  r = updateTask(task.id, { status: "todo" }, getTask(task.id)!.version);
  assert.ok(r !== "conflict");
  assert.equal(getTask(task.id)!.reminderRevision, 2, "重复打开同一状态不递增 revision");
  assert.equal(queuedReminderJobs(task.id).length, 1, "不重复建 job");

  // due 清空 → 无未准入提醒
  r = updateTask(task.id, { due: { kind: "none" } }, getTask(task.id)!.version);
  assert.ok(r !== "conflict");
  assert.equal(queuedReminderJobs(task.id).length, 0, "due 清空后无未准入提醒");
});

test("标题变化不递增 revision、不重建提醒；归档取消提醒", () => {
  const task = makeTask();
  assert.equal(queuedReminderJobs(task.id).length, 1);
  updateTask(task.id, { title: "改标题" }, getTask(task.id)!.version);
  assert.equal(getTask(task.id)!.reminderRevision, 0, "标题变化不递增 revision");
  assert.equal(queuedReminderJobs(task.id).length, 1, "提醒不重建");

  const archived = archiveTask(task.id, getTask(task.id)!.version);
  assert.ok(archived !== "conflict");
  assert.equal(queuedReminderJobs(task.id).length, 0, "归档取消未准入提醒");
});

test("F11：租约隔离 —— A 过期、B 领取，A 不能提交结果；B 正常发送", async () => {
  const mailer = new FakeMailer();
  setMailerForTests(mailer);
  const task = makeTask();
  const job = queuedReminderJobs(task.id)[0];
  forceDue(job.id);

  const [jobA] = claimDueJobs(nowIso(), 5);
  assert.ok(jobA, "A 领取成功");
  assert.equal(jobA.id, job.id);

  // A 的租约过期（直接改库模拟长时间停顿）
  getDb()
    .prepare(`UPDATE jobs SET lease_until = ? WHERE id = ?`)
    .run("2020-01-01T00:00:00.000Z", job.id);

  // B 领取（重领：generation+1，新 token）
  const [jobB] = claimDueJobs(nowIso(), 5);
  assert.ok(jobB);
  assert.equal(jobB.id, job.id);
  assert.equal(jobB.generation, jobA.generation + 1);
  assert.notEqual(jobB.leaseToken, jobA.leaseToken);

  // A 用旧 token 提交结果 → 被 fencing 拒绝
  const aCommit = completeJob(
    job.id,
    jobA.leaseToken!,
    jobA.generation,
    { kind: "cancelled" },
    nowIso(),
  );
  assert.equal(aCommit, false, "A 不能提交结果");

  // B 正常执行并发送
  const outcome = await runReminderJob(jobB);
  assert.equal(outcome.kind, "done");
  assert.equal(mailer.sent.length, 1, "B 完成发送");
  assert.equal(listDeliveries()[0].status, "accepted");
  assert.equal(getJob(job.id)!.status, "done");
  setMailerForTests(null);
});

test("F11 后半：发送后才丢租约 → 重领不再发第二封，投递标 unknown", async () => {
  const task = makeTask();
  const job = queuedReminderJobs(task.id)[0];
  forceDue(job.id);
  const [jobA] = claimDueJobs(nowIso(), 5);
  // A 发送时 SMTP 已接受，但返回前租约过期（机器休眠 / 进程停顿）
  const stall: Mailer = {
    async send() {
      getDb().prepare(`UPDATE jobs SET lease_until = ? WHERE id = ?`).run("2020-01-01T00:00:00.000Z", job.id);
      return { ok: true, response: "250 ok" };
    },
  };
  setMailerForTests(stall);
  assert.equal((await runReminderJob(jobA)).kind, "fenced");
  // 已过期的租约不能续回来
  assert.equal(renewLease(job.id, jobA.leaseToken!, jobA.generation, nowIso()), false);

  const mailer = new FakeMailer();
  setMailerForTests(mailer);
  const [jobB] = claimDueJobs(nowIso(), 5);
  assert.equal(jobB.id, job.id);
  assert.equal((await runReminderJob(jobB)).kind, "done");
  assert.equal(mailer.sent.length, 0, "不自动重发");
  const ds = listDeliveries().filter((d) => d.jobId === job.id);
  assert.equal(ds.length, 1);
  assert.equal(ds[0].status, "unknown");
  assert.equal(getJob(job.id)!.result?.kind, "unknown");
  setMailerForTests(null);
});

test("F12 前半：改期发生在准入之前 → 旧邮件不发", async () => {
  const mailer = new FakeMailer();
  setMailerForTests(mailer);
  const task = makeTask();
  const job = queuedReminderJobs(task.id)[0];
  forceDue(job.id);
  const [claimed] = claimDueJobs(nowIso(), 5);
  assert.ok(claimed);

  // 改期：due 变化 → revision 递增，旧 job 的 revision 失配
  updateTask(task.id, { due: dueInHours(72) }, getTask(task.id)!.version);

  const outcome = await runReminderJob(claimed);
  assert.equal(outcome.kind, "done");
  assert.equal(mailer.sent.length, 0, "旧邮件不发");
  const finished = getJob(job.id)!;
  assert.equal(finished.status, "done");
  assert.equal(finished.result?.kind, "skipped");
  assert.equal((finished.result as { reason: string }).reason, "stale_revision");
  assert.equal(listDeliveries({ taskId: task.id }).length, 0, "未创建任何投递");
  setMailerForTests(null);
});

test("F12 后半：改期发生在准入之后 → 在途旧邮件允许到达（不谎称撤回）", async () => {
  // GatedMailer：send 挂起直到外部放行，模拟 SMTP 在途
  let startedResolve: () => void = () => {};
  let sendResolve: (r: MailSendResult) => void = () => {};
  const started = new Promise<void>((res) => (startedResolve = res));
  const gated: Mailer = {
    async send() {
      startedResolve();
      return new Promise<MailSendResult>((res) => (sendResolve = res));
    },
  };
  setMailerForTests(gated);

  const task = makeTask();
  const job = queuedReminderJobs(task.id)[0];
  forceDue(job.id);
  const [claimed] = claimDueJobs(nowIso(), 5);
  assert.ok(claimed);

  const runPromise = runReminderJob(claimed);
  await started; // 准入完成，delivery 正在 submitting（在途）

  // 改期发生在准入之后：取消的是未准入提醒，在途的允许到达
  updateTask(task.id, { due: dueInHours(96) }, getTask(task.id)!.version);
  const delivery = listDeliveries({ taskId: task.id })[0];
  assert.ok(delivery, "准入已创建投递");
  assert.equal(delivery.status, "submitting", "在途投递未被取消");

  sendResolve({ ok: true, response: "250 ok" });
  const outcome = await runPromise;
  assert.equal(outcome.kind, "done");
  assert.equal(getDelivery(delivery.id)!.status, "accepted", "在途旧邮件允许到达");
  assert.equal(queuedReminderJobs(task.id).length, 1, "改期建立新提醒 job");
  setMailerForTests(null);
});

test("F13：外部接受后进程退出、结果未落库 → unknown，恢复不自动重发", () => {
  const task = makeTask();
  const job = queuedReminderJobs(task.id)[0];
  forceDue(job.id);
  const [claimed] = claimDueJobs(nowIso(), 5);
  assert.ok(claimed);

  // 模拟崩溃：准入完成（delivery submitting）后进程消失，没有任何结果落库。
  // 直接手工构造 admission 后状态：创建 delivery 并置 submitting。
  getDb()
    .prepare(
      `INSERT INTO deliveries (id, job_id, task_id, request_id, lease_token, reminder_revision,
         recipient, subject, snapshot_json, status, attempt, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'submitting', 1, ?, ?)`,
    )
    .run(
      "f13-delivery",
      job.id,
      task.id,
      "f13-request",
      claimed.leaseToken,
      0,
      "master@example.com",
      "主题",
      "{}",
      nowIso(),
      nowIso(),
    );
  const deliveryId = "f13-delivery";
  assert.equal(getDelivery(deliveryId)!.status, "submitting");

  // worker 恢复：submitting → unknown，不自动重发
  const recovered = recoverOnStartup();
  assert.equal(recovered.unknownDeliveries, 1);
  assert.equal(getDelivery(deliveryId)!.status, "unknown");

  // 恢复后该 job 落为 done（带 unknown 结果），不再重试 → 不会有第二次发送
  const finished = getJob(job.id)!;
  assert.equal(finished.status, "done");
  assert.equal(finished.result?.kind, "unknown");
  // 没有可重新领取的 job：unknown 不自动重发
  assert.equal(claimDueJobs(nowIso(), 5).length, 0, "unknown 不自动重发");
});

test("取消语义：queued 直接取消；running 记取消请求且发送前生效", async () => {
  const mailer = new FakeMailer();
  setMailerForTests(mailer);

  // queued 取消
  const t1 = makeTask();
  const j1 = queuedReminderJobs(t1.id)[0];
  assert.equal(requestCancel(j1.id), "cancelled");
  assert.equal(getJob(j1.id)!.status, "cancelled");

  // running：发送前检查取消请求 → 不发
  const t2 = makeTask();
  const j2 = queuedReminderJobs(t2.id)[0];
  forceDue(j2.id);
  const [claimed] = claimDueJobs(nowIso(), 5);
  assert.ok(claimed);
  assert.equal(requestCancel(j2.id), "cancel_requested");
  const outcome = await runReminderJob(claimed);
  assert.equal(outcome.kind, "cancelled");
  assert.equal(mailer.sent.length, 0, "发送前取消：不发");
  assert.equal(getJob(j2.id)!.status, "cancelled");
  setMailerForTests(null);
});

test("worker 重启恢复：孤儿 running job 重新排队并被再次执行完成", async () => {
  const mailer = new FakeMailer();
  setMailerForTests(mailer);
  const task = makeTask();
  const job = queuedReminderJobs(task.id)[0];
  forceDue(job.id);
  // 领取后模拟崩溃（无 delivery）
  const [claimed] = claimDueJobs(nowIso(), 5);
  assert.ok(claimed);
  assert.equal(getJob(job.id)!.status, "running");

  const recovered = recoverOnStartup();
  assert.equal(recovered.requeuedJobs, 1, "孤儿 job 重新排队");
  assert.equal(getJob(job.id)!.status, "queued");

  const stats = await runDueJobsOnce();
  assert.ok(stats.claimed >= 1, "重启后可领取");
  assert.equal(getJob(job.id)!.status, "done", "重跑完成");
  assert.equal(mailer.sent.length, 1, "提醒最终发出");
  setMailerForTests(null);
});

test("SMTP 未配置：job 失败报 INTEGRATION_UNAVAILABLE，不冒充已发送", async () => {
  setMailerForTests(null); // resolveMailer 返回 null（无 override 且 env 无 SMTP）
  const task = makeTask();
  const job = queuedReminderJobs(task.id)[0];
  forceDue(job.id);
  const [claimed] = claimDueJobs(nowIso(), 5);
  const outcome = await runReminderJob(claimed);
  assert.equal(outcome.kind, "failed");
  assert.equal(outcome.error, "INTEGRATION_UNAVAILABLE");
  assert.equal(getJob(job.id)!.status, "failed");
  assert.match(getJob(job.id)!.lastError ?? "", /INTEGRATION_UNAVAILABLE/);
  assert.equal(listDeliveries({ taskId: task.id }).length, 0, "未配置不创建投递");
});

test("触发点已过去的任务不建 job（进入待处理）；due=none 不建", () => {
  const past = makeTask({ due: dueInHours(-1) });
  assert.equal(queuedReminderJobs(past.id).length, 0, "过去触发点不建 job");
  const none = makeTask({ due: { kind: "none" } });
  assert.equal(queuedReminderJobs(none.id).length, 0, "due=none 不建提醒");
});
