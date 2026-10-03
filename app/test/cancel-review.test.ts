import assert from "node:assert/strict";
import { before, test } from "node:test";
import { NextRequest } from "next/server";
import { migrateAll, getDb } from "./helpers";
import { setProvidersForTests } from "@/integrations";
import { fixtureModelProvider } from "@/integrations/fixtures";
import { createLog } from "@/repositories/logs";
import { createJob, claimDueJobs, getJob } from "@/repositories/jobs";
import { getReview, getAssistantRequest } from "@/repositories/reviews";
import { startReview, startAssistant, runReviewJob, runAssistantJob, proposalsFrom } from "@/workflows/review";
import { cancelOwnerJob } from "@/workflows/cancel-job";
import { localDateInTz, mondayOf, instanceTimezone } from "@/domain/time";
import { createOwner, createSession, SESSION_COOKIE } from "@/domain/session";
import { POST as cancelRoute } from "@/app/api/v1/jobs/[id]/cancel/route";
import { HttpError } from "@/workflows/http";
import { createSource } from "@/repositories/inbox";
import { importNotice } from "@/workflows/inbox";
import { extractionFor, enqueueNoticeExtraction } from "@/workflows/notice-extraction";

before(() => {
  migrateAll();
  createOwner("unused-test-hash");
  setProvidersForTests({ model: { mode: "fixture", provider: fixtureModelProvider() } });
  const date = localDateInTz(new Date(), instanceTimezone());
  createLog({ clientEntryId: crypto.randomUUID(), occurredOn: date, progress: "测试进展", blocker: "测试卡点", taskId: null, projectId: null });
});

test("排队原文提取取消后可重新提取，取消状态不会让详情一直排队", () => {
  const source = createSource("cancel-extraction", "取消提取测试");
  const imported = importNotice({ schemaVersion: 1, source: source.source.id, externalId: "one", revisionKey: "r1", revisionOrder: 1,
    occurredAt: "2026-10-03T00:00:00Z", text: "请于10月8日前报名。" }, source.token); assert.ok(imported.ok);
  const state = extractionFor(imported.revisionId) as { jobId: string; status: string };
  assert.equal(state.status, "queued"); assert.equal(cancelOwnerJob(state.jobId), "cancelled");
  const cancelled = extractionFor(imported.revisionId) as { status: string; error: string };
  assert.equal(cancelled.status, "failed"); assert.match(cancelled.error, /已取消/);
  const retried = enqueueNoticeExtraction(imported.revisionId, true); assert.ok(retried.jobId);
  assert.notEqual(retried.jobId, state.jobId); assert.equal(getJob(state.jobId)?.status, "cancelled");
  cancelOwnerJob(retried.jobId);
});

function start(kind: "review" | "assistant") {
  if (kind === "review") {
    const result = startReview(mondayOf(localDateInTz(new Date(), instanceTimezone()))); assert.ok(result.ok);
    return { id: result.review.id, jobId: result.jobId, run: runReviewJob };
  }
  const result = startAssistant({ scopeType: "week", scopeId: null, question: "测试卡点", logId: null, rerun: true }); assert.ok(result.ok);
  return { id: result.requestId, jobId: result.jobId, run: runAssistantJob };
}

function status(kind: "review" | "assistant", id: string) { return kind === "review" ? getReview(id)?.status : getAssistantRequest(id)?.status; }

test("排队复盘和卡点分析可取消且重试幂等，业务状态一并终止，没有模型调用", async () => {
  let calls = 0;
  setProvidersForTests({ model: { mode: "fixture", provider: { protocol: "fake", async call(input) { calls++; return fixtureModelProvider().call(input); } } } });
  for (const kind of ["review", "assistant"] as const) {
    const work = start(kind);
    assert.equal(cancelOwnerJob(work.jobId), "cancelled");
    assert.equal(cancelOwnerJob(work.jobId), "cancelled");
    assert.equal(status(kind, work.id), "cancelled");
    assert.equal(getJob(work.jobId)?.status, "cancelled");
    assert.ok(!claimDueJobs(new Date().toISOString(), 50).some((job) => job.id === work.jobId));
    assert.equal(proposalsFrom(kind, work.id).length, 0);
  }
  assert.equal(calls, 0);
});

for (const kind of ["review", "assistant"] as const) test(`${kind} 模型调用已经开始再取消：接收请求但不发布返回的草案与提案`, async () => {
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const started = new Promise<void>((resolve) => { entered = resolve; });
  setProvidersForTests({ model: { mode: "fixture", provider: { protocol: "fake", async call(input) { entered(); await gate; return fixtureModelProvider().call(input); } } } });
  const work = start(kind);
  const job = claimDueJobs(new Date().toISOString(), 50).find((row) => row.id === work.jobId)!; assert.ok(job);
  const running = work.run(job);
  await started;
  assert.equal(cancelOwnerJob(work.jobId), "cancel_requested");
  assert.equal(cancelOwnerJob(work.jobId), "cancel_requested");
  assert.equal(getJob(work.jobId)?.status, "running", "不假称在途调用已经结束");
  release();
  assert.equal((await running).kind, "cancelled");
  assert.equal(status(kind, work.id), "cancelled");
  assert.equal(getJob(work.jobId)?.status, "cancelled");
  assert.equal(proposalsFrom(kind, work.id).length, 0);
  if (kind === "review") assert.equal(getReview(work.id)?.aiDraft, null);
  else assert.equal(getAssistantRequest(work.id)?.result, null);
});

test("取消 API 登录与 CSRF 保护，不扩大到系统作业；过期执行者不能替当前租约发布取消结果", async () => {
  setProvidersForTests({ model: { mode: "fixture", provider: fixtureModelProvider() } });
  const work = start("assistant");
  const { session, token } = createSession();
  const request = (csrf: string) => new NextRequest(`http://localhost/api/v1/jobs/${work.jobId}/cancel`, { method: "POST", headers: { cookie: `${SESSION_COOKIE}=${token}`, "x-csrf-token": csrf } });
  const params = { params: Promise.resolve({ id: work.jobId }) };
  assert.equal((await cancelRoute(new NextRequest("http://localhost/cancel", { method: "POST" }), params)).status, 401);
  assert.equal((await cancelRoute(request("wrong"), params)).status, 403);
  const first = claimDueJobs(new Date().toISOString(), 50).find((job) => job.id === work.jobId)!;
  getDb().prepare("UPDATE jobs SET lease_until='2020-01-01T00:00:00Z' WHERE id=?").run(first.id);
  const second = claimDueJobs(new Date().toISOString(), 50).find((job) => job.id === work.jobId)!;
  const response = await cancelRoute(request(session.csrfToken), params);
  assert.equal(response.status, 200);
  const body = await response.json(); assert.equal(body.result, "cancel_requested"); assert.equal(body.job.leaseToken, undefined);
  assert.equal((await runAssistantJob(first)).kind, "fenced");
  assert.equal(getAssistantRequest(work.id)?.status, "queued");
  assert.equal((await runAssistantJob(second)).kind, "cancelled");
  const unsupported = createJob({ type: "system-maintenance", dedupeKey: crypto.randomUUID(), runAt: new Date().toISOString(), payload: {} });
  assert.throws(() => cancelOwnerJob(unsupported.id), (error) => error instanceof HttpError && error.code === "NOT_CANCELLABLE");
  assert.equal(getJob(unsupported.id)?.status, "queued");
});
