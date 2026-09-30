import assert from "node:assert/strict";
import { test, before, beforeEach } from "node:test";
import { migrateAll, getDb } from "./helpers";
import { setProvidersForTests } from "@/integrations";
import { fixtureModelProvider, fixtureModelResponder } from "@/integrations/fixtures";
import type { ModelProvider } from "@/contracts/model";
import { MODEL_WORKFLOW_BLOCKER, MODEL_WORKFLOW_REVIEW, blockerOutputSchema, reviewOutputSchema } from "@/contracts/review";
import { claimDueJobs } from "@/repositories/jobs";
import { createProject, createTask, getTask, listTasks } from "@/repositories/planning";
import { createLog } from "@/repositories/logs";
import { getAssistantRequest, getReview, updateOwnerFields, listReviewEdits } from "@/repositories/reviews";
import { getProposal } from "@/repositories/proposals";
import { rejectProposal } from "@/repositories/proposal-decisions";
import { applyProposal } from "@/workflows/apply-proposal";
import { runAssistantJob, runReviewJob, startAssistant, startReview, lastWeekMonday, proposalsFrom } from "@/workflows/review";
import { saveAiBudget, getAiBudget, usageToday } from "@/workflows/ai-budget";
import { startExploration } from "@/workflows/exploration";
import { addDays } from "@/domain/time";

before(migrateAll);
beforeEach(() => setProvidersForTests({ model: { provider: fixtureModelProvider(), mode: "fixture" }, search: undefined }));

async function runJob(jobId: string, runner: (j: import("@/contracts/jobs").JobRow) => Promise<{ kind: string }>) {
  getDb().prepare(`UPDATE jobs SET run_at = ? WHERE id = ?`).run("2020-01-01T00:00:00.000Z", jobId);
  const job = claimDueJobs(new Date().toISOString(), 20).find((j) => j.id === jobId);
  assert.ok(job, "job 已领取");
  return runner(job);
}

function project(title = "项目") {
  return createProject({ title, question: "", expectedOutcome: "", prerequisites: "", reviewQuestions: "", goalIds: [] });
}

function task(title: string, projectId: string | null = null) {
  return createTask({
    title,
    description: "",
    projectId,
    goalId: null,
    status: "todo",
    priority: "normal",
    estimateMinutes: 60,
    plannedWeek: null,
    scheduledStart: null,
    scheduledEnd: null,
    due: { kind: "none" },
  });
}

function log(occurredOn: string, blocker: string, taskId: string | null, projectId: string | null) {
  const r = createLog({ clientEntryId: crypto.randomUUID(), occurredOn, progress: "做了一点", blocker, taskId, projectId });
  assert.ok(r !== "content_conflict");
  return r.log;
}

test("没有记录时输出资料不足：不调用模型、不编成长结论", async () => {
  let calls = 0;
  const spy: ModelProvider = { protocol: "fake", call: async (r) => (calls++, fixtureModelProvider().call(r)) };
  setProvidersForTests({ model: { provider: spy, mode: "fixture" } });
  const r = startReview("2025-01-06");
  assert.ok(r.ok);
  assert.equal((await runJob(r.jobId, runReviewJob)).kind, "done");
  const rev = getReview(r.review.id)!;
  assert.equal(rev.status, "insufficient");
  assert.equal(rev.aiSkippedReason, "no_records");
  assert.equal(rev.aiDraft, null);
  assert.equal(calls, 0, "无记录不调用模型");
  assert.equal(proposalsFrom("review", rev.id).length, 0);
});

test("卡点→带依据建议→确认→更新计划（主闭环）；读取范围只含本项目 7 天内记录", async () => {
  const p = project("检索实践");
  const other = project("别的项目");
  const t = task("实现 BM25", p.id);
  const today = new Date().toISOString().slice(0, 10);
  const l = log(today, "不知道怎么切分中文", t.id, p.id);
  const old = log(addDays(today, -30), "很久以前的卡点", t.id, p.id);
  const foreign = log(today, "别的项目卡点", null, other.id);

  const s = startAssistant({ scopeType: "project", scopeId: p.id, question: "分析这个卡点", logId: l.id, rerun: false });
  assert.ok(s.ok);
  assert.equal((await runJob(s.jobId, runAssistantJob)).kind, "done");
  const req = getAssistantRequest(s.requestId)!;
  assert.equal(req.status, "done");
  const result = req.result as { explanations: Array<{ evidenceIds: string[] }>; proposalIds: string[]; readScope: { logIds: string[] } };
  assert.ok(result.readScope.logIds.includes(l.id));
  assert.ok(!result.readScope.logIds.includes(old.id), "7 天外不读");
  assert.ok(!result.readScope.logIds.includes(foreign.id), "别的项目不读");
  assert.equal(result.proposalIds.length, 1, "最多 1 份建议");

  const proposal = getProposal(result.proposalIds[0])!;
  assert.equal(proposal.sourceKind, "assistant");
  assert.ok(proposal.contextRefs.includes(l.id), "依据引用真实记录");
  const before = listTasks({ projectId: p.id }).length;
  const applied = applyProposal(proposal.id);
  assert.ok(applied.ok);
  assert.equal(listTasks({ projectId: p.id }).length, before + 1, "确认后计划更新");
});

test("模型编造 ID：引用不存在的记录或范围外任务 → 整份提案丢弃，诊断可见", async () => {
  const p = project();
  const t = task("任务", p.id);
  const outside = task("范围外任务");
  const l = log(new Date().toISOString().slice(0, 10), "卡住了", t.id, p.id);
  const lying: ModelProvider = {
    protocol: "fake",
    async call(r) {
      if (r.workflow !== MODEL_WORKFLOW_BLOCKER) return fixtureModelProvider().call(r);
      return {
        ok: true,
        validatedResult: blockerOutputSchema.parse({
          explanations: [{ text: "编的", evidenceIds: ["no-such-log"] }],
          nextSteps: ["试试"],
          proposal: { reason: "改范围外任务", evidenceIds: [l.id], operations: [{ kind: "set_task_status", taskId: outside.id, status: "done" }] },
        }),
      };
    },
  };
  setProvidersForTests({ model: { provider: lying, mode: "fixture" } });
  const s = startAssistant({ scopeType: "project", scopeId: p.id, question: "q", logId: l.id, rerun: false });
  assert.ok(s.ok);
  await runJob(s.jobId, runAssistantJob);
  const res = getAssistantRequest(s.requestId)!.result as { explanations: unknown[]; proposalIds: string[]; dropped: string[] };
  assert.equal(res.explanations.length, 0, "引用不存在记录的解释被删除");
  assert.equal(res.proposalIds.length, 0, "范围外任务 → 整份丢弃");
  assert.ok(res.dropped.length >= 2);
  assert.equal(getTask(outside.id)!.status, "todo", "没有被改");
});

test("拒绝冷却：同项目同操作类型同证据 14 天内不自动重复；主人主动重跑不受限", async () => {
  const p = project();
  const t = task("写报告", p.id);
  const l = log(new Date().toISOString().slice(0, 10), "写不下去", t.id, p.id);
  const ask = (rerun: boolean) => startAssistant({ scopeType: "project", scopeId: p.id, question: "q", logId: l.id, rerun });

  const s1 = ask(false);
  assert.ok(s1.ok);
  await runJob(s1.jobId, runAssistantJob);
  const first = (getAssistantRequest(s1.requestId)!.result as { proposalIds: string[] }).proposalIds;
  assert.equal(first.length, 1);
  assert.equal(rejectProposal(first[0], "not_useful"), "ok");

  const s2 = ask(false);
  assert.ok(s2.ok);
  await runJob(s2.jobId, runAssistantJob);
  const r2 = getAssistantRequest(s2.requestId)!.result as { proposalIds: string[]; dropped: string[] };
  assert.equal(r2.proposalIds.length, 0, "冷却期内不重复");
  assert.ok(r2.dropped.some((d) => d.includes("14 天")));

  const s3 = ask(true);
  assert.ok(s3.ok);
  await runJob(s3.jobId, runAssistantJob);
  assert.equal((getAssistantRequest(s3.requestId)!.result as { proposalIds: string[] }).proposalIds.length, 1, "主动重跑可以");
});

test("周复盘：事实/推测/提案分开；最多 3 份独立提案；主人修订另存且可追溯", async () => {
  const monday = lastWeekMonday();
  const t = task("周任务");
  getDb().prepare(`UPDATE tasks SET planned_week_monday = ?, planned_week_timezone = 'Asia/Shanghai' WHERE id = ?`).run(monday, t.id);
  const l = log(addDays(monday, 2), "时间不够", t.id, null);
  const many: ModelProvider = {
    protocol: "fake",
    async call(r) {
      if (r.workflow !== MODEL_WORKFLOW_REVIEW) return fixtureModelProvider().call(r);
      const base = fixtureModelResponder(r) as { ok: true; validatedResult: import("zod").infer<typeof reviewOutputSchema> };
      const one = base.validatedResult.proposals[0];
      // 模型给 5 份：schema 限 3 份，超出即 SCHEMA_INVALID —— 这里给 3 份独立的
      base.validatedResult.proposals = [one, { ...one, reason: "第二份", operations: [{ ...one.operations[0], title: "b" }] as typeof one.operations }, { ...one, reason: "第三份", evidenceIds: [l.id, t.id], operations: [{ kind: "set_task_status", taskId: t.id, status: "doing" }] }];
      return { ok: true, validatedResult: reviewOutputSchema.parse(base.validatedResult) };
    },
  };
  setProvidersForTests({ model: { provider: many, mode: "fixture" } });
  const r = startReview(monday);
  assert.ok(r.ok);
  await runJob(r.jobId, runReviewJob);
  const rev = getReview(r.review.id)!;
  assert.equal(rev.status, "ready");
  const facts = rev.facts as { counts: { logs: number } };
  assert.equal(facts.counts.logs, 1, "事实由程序汇总");
  const draft = rev.aiDraft as { factNotes: unknown[]; observations: unknown[]; proposalIds: string[] };
  assert.ok(draft.observations.length >= 1);
  const ps = proposalsFrom("review", rev.id);
  // 第一、二份指纹相同（同操作类型同证据）→ 第二份作为重复不再生成
  assert.equal(ps.length, 2);
  assert.ok(ps.every((p) => p.groupId === ps[0].groupId), "同一次复盘同一 group");

  const edited = updateOwnerFields(rev.id, rev.version, { ownerSummary: "我觉得这周主要是时间估少了" });
  assert.ok(edited !== "conflict" && edited !== "not_found");
  assert.equal(edited.ownerSummary, "我觉得这周主要是时间估少了");
  assert.deepEqual(edited.aiDraft, rev.aiDraft, "主人修订不改 AI 草案");
  assert.equal(updateOwnerFields(rev.id, rev.version, { ownerSummary: "x" }), "conflict");
  assert.equal(listReviewEdits(rev.id).length, 1);
});

test("模型未配置：复盘仍给事实，AI 部分标明未配置；卡点分析 503", async () => {
  setProvidersForTests({ model: null });
  const monday = lastWeekMonday();
  log(addDays(monday, 1), "", null, null);
  const r = startReview(monday);
  assert.ok(r.ok);
  await runJob(r.jobId, runReviewJob);
  const rev = getReview(r.review.id)!;
  assert.equal(rev.status, "ready");
  assert.equal(rev.aiSkippedReason, "not_configured");
  const a = startAssistant({ scopeType: "week", scopeId: null, question: "q", logId: null, rerun: false });
  assert.ok(!a.ok && a.status === 503);
});

test("预算：达到每日模型次数上限 → 探索/卡点 429，复盘只出事实；用量记录次数与 token", async () => {
  const { version } = getAiBudget();
  const used = usageToday().modelCalls;
  assert.ok(used > 0, "前面的测试已记录用量");
  assert.notEqual(saveAiBudget({ ...getAiBudget().budget, dailyModelCalls: used }, version), "conflict");

  const a = startAssistant({ scopeType: "week", scopeId: null, question: "q", logId: null, rerun: false });
  assert.ok(!a.ok && a.status === 429 && a.code === "BUDGET_EXCEEDED");
  const e = startExploration({ query: "q", topicId: null, projectId: null, background: "", materials: [{ title: "", url: null, text: "资料。" }] });
  assert.ok(!e.ok && e.code === "BUDGET_EXCEEDED");

  const monday = addDays(lastWeekMonday(), -7);
  log(addDays(monday, 1), "有卡点", null, null);
  const r = startReview(monday);
  assert.ok(r.ok);
  await runJob(r.jobId, runReviewJob);
  const rev = getReview(r.review.id)!;
  assert.equal(rev.status, "ready");
  assert.equal(rev.aiSkippedReason, "budget");
  assert.equal(usageToday().modelCalls, used, "超额后没有再调用");
});
