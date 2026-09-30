import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import crypto from "node:crypto";
import { NextRequest } from "next/server";
import { migrateAll, getDb } from "./helpers";
import { hashPassword } from "@/domain/password";
import { createOwner, createSession, SESSION_COOKIE } from "@/domain/session";
import { setMailerForTests, type Mailer, type MailPayload, type MailSendResult } from "@/integrations/mailer";
import { createDelivery, getDelivery, type DeliveryStatus } from "@/repositories/deliveries";
import { createTask, updateTask, type TaskRow } from "@/repositories/planning";
import { POST as resend } from "@/app/api/v1/deliveries/[id]/resend/route";

class FakeMailer implements Mailer {
  sent: MailPayload[] = [];
  async send(mail: MailPayload): Promise<MailSendResult> {
    this.sent.push(mail);
    return { ok: true, response: "250 ok" };
  }
}

const mailer = new FakeMailer();
let cookie = "";
let csrf = "";

before(() => {
  migrateAll();
  createOwner(hashPassword("password-123"));
  const { session, token } = createSession(1);
  cookie = `${SESSION_COOKIE}=${token}`;
  csrf = session.csrfToken;
  setMailerForTests(mailer);
});

after(() => setMailerForTests(null));

function resendReq(id: string, body: unknown = { confirmDuplicateRisk: true }): [NextRequest, { params: Promise<{ id: string }> }] {
  return [
    new NextRequest(`http://localhost/api/v1/deliveries/${id}/resend`, {
      method: "POST",
      headers: { cookie, "x-csrf-token": csrf, "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) },
  ];
}

function futureTask(): TaskRow {
  return createTask({
    title: "交报告",
    description: "",
    projectId: null,
    goalId: null,
    status: "todo",
    priority: "normal",
    estimateMinutes: null,
    plannedWeek: null,
    scheduledStart: null,
    scheduledEnd: null,
    due: { kind: "instant", at: new Date(Date.now() + 86_400_000).toISOString(), timezone: "Asia/Shanghai" },
  });
}

function delivery(task: TaskRow, status: DeliveryStatus) {
  const d = createDelivery({
    jobId: null,
    taskId: task.id,
    leaseToken: crypto.randomUUID(),
    reminderRevision: task.reminderRevision,
    recipient: "owner@example.org",
    subject: `提醒：${task.title}`,
    snapshot: {
      html: "<p>原快照</p>",
      text: "原快照",
      taskId: task.id,
      taskTitle: task.title,
      dueLabel: "",
      generatedAt: new Date().toISOString(),
      kind: "reminder",
    },
  });
  getDb().prepare(`UPDATE deliveries SET status = ? WHERE id = ?`).run(status, d.id);
  return d;
}

test("unknown 投递显式重发：新 attempt、沿用原快照；重复点击 409 不再发", async () => {
  const task = futureTask();
  const original = delivery(task, "unknown");
  const before = mailer.sent.length;

  const res = await resend(...resendReq(original.id));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.delivery.status, "accepted");
  assert.equal(body.delivery.attempt, 2);
  assert.equal(body.delivery.resentFrom, original.id);
  assert.equal(body.delivery.leaseToken, undefined);
  assert.equal(mailer.sent.length, before + 1);
  assert.equal(mailer.sent.at(-1)!.text, "原快照");
  assert.notEqual(mailer.sent.at(-1)!.requestId, original.requestId, "新 attempt 用新 requestId");
  assert.equal(getDelivery(original.id)!.status, "unknown", "原投递状态不改写");

  const again = await resend(...resendReq(original.id));
  assert.equal(again.status, 409);
  assert.equal((await again.json()).error.code, "ALREADY_RESENT");
  assert.equal(mailer.sent.length, before + 1);
});

test("未确认重复风险 422；accepted 投递不可重发", async () => {
  const task = futureTask();
  const unknown = delivery(task, "unknown");
  assert.equal((await resend(...resendReq(unknown.id, {}))).status, 422);

  const accepted = delivery(task, "accepted");
  const res = await resend(...resendReq(accepted.id));
  assert.equal(res.status, 409);
  assert.equal((await res.json()).error.code, "NOT_RESENDABLE");
});

test("改期后的旧提醒与已完成任务的提醒不重发", async () => {
  const task = futureTask();
  const stale = delivery(task, "failed");
  const moved = updateTask(
    task.id,
    { due: { kind: "instant", at: new Date(Date.now() + 2 * 86_400_000).toISOString(), timezone: "Asia/Shanghai" } },
    task.version,
  );
  assert.ok(moved !== "conflict" && moved !== "not_found");
  const r1 = await resend(...resendReq(stale.id));
  assert.equal((await r1.json()).error.code, "STALE_REMINDER");

  const done = futureTask();
  const d = delivery(done, "unknown");
  updateTask(done.id, { status: "done" }, done.version);
  const r2 = await resend(...resendReq(d.id));
  assert.equal((await r2.json()).error.code, "TASK_INACTIVE");
});

test("恢复暂停期间不重发", async () => {
  const task = futureTask();
  const d = delivery(task, "unknown");
  getDb().prepare(`UPDATE instance_state SET restored_hold = 1 WHERE id = 1`).run();
  try {
    const res = await resend(...resendReq(d.id));
    assert.equal(res.status, 503);
    assert.equal((await res.json()).error.code, "RESTORED_HOLD");
  } finally {
    getDb().prepare(`UPDATE instance_state SET restored_hold = 0 WHERE id = 1`).run();
  }
});
