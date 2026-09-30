import assert from "node:assert/strict";
import { test, before, beforeEach } from "node:test";
import { migrateAll, getDb } from "./helpers";
import { setProvidersForTests } from "@/integrations";
import { fixtureModelProvider, fixtureSearchProvider, fixtureModelResponder } from "@/integrations/fixtures";
import { completeWithSchema } from "@/integrations/model-json";
import { OpenAIChatProvider, chatCompletionsUrl } from "@/integrations/openai-chat";
import { TavilySearchProvider } from "@/integrations/tavily";
import { SearchError, type SearchProvider } from "@/contracts/search";
import type { ModelProvider, ModelRequest } from "@/contracts/model";
import { candidatesOutputSchema, MODEL_WORKFLOW_CANDIDATES } from "@/contracts/exploration";
import { canonicalUrl, evidenceHash, locateQuote, nextWeeklyRun } from "@/domain/exploration";
import { claimDueJobs, getJob, listJobs } from "@/repositories/jobs";
import { getRun, listCandidatesByRun, listEvidence, getCandidate, getTopic } from "@/repositories/exploration";
import { cancelExploration, runExplorationJob, scheduleDueTopics, startExploration } from "@/workflows/exploration";
import { createProjectFromCandidate, getProjectExploration, saveProjectConclusion } from "@/workflows/candidates";
import { createTopic, updateTopic } from "@/workflows/topics";
import { listTasks, getProject } from "@/repositories/planning";
import { createArtifact } from "@/repositories/logs";
import { EXPLORATION_JOB_TYPE } from "@/contracts/exploration";

before(migrateAll);

const fixtures = () => ({
  model: { provider: fixtureModelProvider(), mode: "fixture" as const },
  search: { provider: fixtureSearchProvider(), mode: "fixture" as const },
});

beforeEach(() => setProvidersForTests(fixtures()));

function req(query = "我想试试机器学习", extra: Partial<Parameters<typeof startExploration>[0]> = {}) {
  return { query, topicId: null, projectId: null, background: "", materials: [], ...extra };
}

async function runOnce(runId: string) {
  const run = getRun(runId)!;
  getDb().prepare(`UPDATE jobs SET run_at = ? WHERE id = ?`).run("2020-01-01T00:00:00.000Z", run.jobId);
  const job = claimDueJobs(new Date().toISOString(), 10).find((j) => j.id === run.jobId);
  assert.ok(job, "job 已领取");
  return runExplorationJob(job);
}

// ===== 纯规则 =====

test("canonical URL：去 fragment/追踪参数/默认端口，保留语义 query", () => {
  assert.equal(
    canonicalUrl("https://Example.edu:443/course?id=42&utm_source=x#part2"),
    "https://example.edu/course?id=42",
  );
  // 不同课程页不能被合并
  assert.notEqual(canonicalUrl("https://a.edu/c?id=1"), canonicalUrl("https://a.edu/c?id=2"));
  assert.equal(canonicalUrl("ftp://x.org/a"), null);
});

test("引用片段验证：空白归一化后必须存在；evidence_hash 与顺序无关", () => {
  assert.ok(locateQuote("需要 一块\nGPU。", "需要 一块 GPU") >= 0);
  assert.equal(locateQuote("原文里没有这句。", "编造的句子"), -1);
  assert.equal(evidenceHash(["a", "b"]), evidenceHash(["b", " a "]));
});

test("定期下一次运行：当地周一 09:00；错过多个周期只取下一个未来时刻", () => {
  // 2026-09-28 是周一。上海 09:00 = 01:00Z
  const next = nextWeeklyRun(new Date("2026-09-28T00:30:00Z"), 1, "09:00", "Asia/Shanghai");
  assert.equal(next, "2026-09-28T01:00:00.000Z");
  const after = nextWeeklyRun(new Date("2026-09-28T01:00:00Z"), 1, "09:00", "Asia/Shanghai");
  assert.equal(after, "2026-10-05T01:00:00.000Z");
  // 很久以前的 next_run 被跳过，不补跑历史
  const late = nextWeeklyRun(new Date("2026-11-20T00:00:00Z"), 1, "09:00", "Asia/Shanghai");
  assert.equal(late, "2026-11-23T01:00:00.000Z");
});

// ===== 适配器 =====

test("OpenAI 兼容适配器：URL 拼接、JSON 解析、schema 失败修复 1 次后报 SCHEMA_INVALID", async () => {
  assert.equal(chatCompletionsUrl("https://api.x.com/v1/"), "https://api.x.com/v1/chat/completions");
  assert.equal(chatCompletionsUrl("https://api.x.com/v1/chat/completions"), "https://api.x.com/v1/chat/completions");

  const bodies: unknown[] = [];
  let n = 0;
  const fakeFetch = (async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(init.body as string));
    n++;
    const content = n === 1 ? "```json\n{\"queries\": []}\n```" : "{\"queries\": [\"逻辑回归 入门\"]}";
    return new Response(JSON.stringify({ id: "r1", choices: [{ message: { content } }], usage: { prompt_tokens: 3, completion_tokens: 2 } }), { status: 200 });
  }) as unknown as typeof fetch;
  const p = new OpenAIChatProvider({ endpoint: "https://api.x.com/v1", apiKey: "k", model: "m" }, fakeFetch);
  const { queryPlanSchema } = await import("@/contracts/exploration");
  const r = await p.call({ workflow: "w", context: {}, outputSchemaVersion: 1, timeoutMs: 5000, instructions: "i", schema: queryPlanSchema });
  assert.ok(r.ok, "修复 1 次后成功");
  assert.deepEqual(r.validatedResult, { queries: ["逻辑回归 入门"] });
  assert.equal(n, 2);
  assert.equal((bodies[0] as { model: string }).model, "m");

  // 两次都无效 → SCHEMA_INVALID，不再重试
  n = 0;
  const bad = (async () =>
    new Response(JSON.stringify({ choices: [{ message: { content: "不是 JSON" } }] }), { status: 200 })) as unknown as typeof fetch;
  const p2 = new OpenAIChatProvider({ endpoint: "https://api.x.com/v1", apiKey: "k", model: "m" }, bad);
  const r2 = await p2.call({ workflow: "w", context: {}, outputSchemaVersion: 1, timeoutMs: 5000, instructions: "i", schema: queryPlanSchema });
  assert.ok(!r2.ok);
  assert.equal(r2.error.code, "SCHEMA_INVALID");

  // 429 可重试
  const limited = (async () => new Response("slow down", { status: 429 })) as unknown as typeof fetch;
  const r3 = await new OpenAIChatProvider({ endpoint: "https://x/v1", apiKey: "k", model: "m" }, limited).call({
    workflow: "w", context: {}, outputSchemaVersion: 1, timeoutMs: 5000, instructions: "i", schema: queryPlanSchema,
  });
  assert.ok(!r3.ok && r3.error.retryable);
});

test("Tavily 适配器：搜索摘要为 snippet；extract 忽略 failed_results；429 可重试", async () => {
  const fakeFetch = (async (url: string) => {
    if (url.endsWith("/search")) {
      return new Response(JSON.stringify({ results: [{ title: "T", url: "https://a.edu/x", content: "摘要", published_date: "2026-01-01" }, { url: "javascript:1" }] }), { status: 200 });
    }
    return new Response(JSON.stringify({ results: [{ url: "https://a.edu/x", raw_content: "正文" }], failed_results: [{ url: "https://b", error: "x" }] }), { status: 200 });
  }) as unknown as typeof fetch;
  const t = new TavilySearchProvider("k", fakeFetch);
  const hits = await t.search({ query: "q", maxResults: 5 });
  assert.equal(hits.length, 1, "非 http 结果被过滤");
  assert.equal(hits[0].snippet, "摘要");
  const docs = await t.extract({ urls: ["https://a.edu/x", "https://b"] });
  assert.equal(docs.length, 1);
  assert.equal(docs[0].status, "retrieved");

  const limited = new TavilySearchProvider("k", (async () => new Response("", { status: 429 })) as unknown as typeof fetch);
  await assert.rejects(limited.search({ query: "q", maxResults: 1 }), (e: unknown) => e instanceof SearchError && e.retryable && e.code === "RATE_LIMITED");
  const quota = new TavilySearchProvider("k", (async () => new Response("", { status: 432 })) as unknown as typeof fetch);
  await assert.rejects(quota.search({ query: "q", maxResults: 1 }), (e: unknown) => e instanceof SearchError && !e.retryable);
});

// ===== 工作流 =====

test("未配置模型 → 503 语义；未配置搜索且无粘贴资料 → 不声称联网", () => {
  setProvidersForTests({ model: null, search: null });
  const r = startExploration(req());
  assert.ok(!r.ok && r.code === "INTEGRATION_UNAVAILABLE");
  setProvidersForTests({ model: fixtures().model, search: null });
  const r2 = startExploration(req());
  assert.ok(!r2.ok && r2.code === "INTEGRATION_UNAVAILABLE");
  const r3 = startExploration(req("q", { materials: [{ title: "我的资料", url: null, text: "练习内容：整理错分样本。所需条件：会写基础 Python。" }] }));
  assert.ok(r3.ok);
  // 模型是 fixture → 整个 run 标 fixture（示例优先于"仅资料"，避免把示例结果当真实）
  assert.equal(r3.run.integrationMode, "fixture");
  const realModel = { provider: fixtureModelProvider(), mode: "real" as const };
  setProvidersForTests({ model: realModel, search: null });
  const r4 = startExploration(req("q", { materials: [{ title: "", url: null, text: "资料正文。" }] }));
  assert.ok(r4.ok);
  assert.equal(r4.run.integrationMode, "materials_only", "未联网只用粘贴资料");
});

test("F7 实践可行性：需 GPU/受限数据且主人条件未知 → unknown，不能标已核实；模型给 met 被降级", async () => {
  // 模型错误地声称 met：必须被降为 unknown
  const lying: ModelProvider = {
    protocol: "fake",
    async call(r: ModelRequest) {
      const base = fixtureModelResponder(r);
      if (!base.ok || r.workflow !== MODEL_WORKFLOW_CANDIDATES) return base;
      const v = base.validatedResult as { candidates: Array<{ requirements: Array<{ status: string }> }> };
      for (const c of v.candidates) for (const q of c.requirements) q.status = "met";
      return { ok: true, validatedResult: r.schema.parse(v) };
    },
  };
  setProvidersForTests({ model: { provider: lying, mode: "fixture" }, search: fixtures().search });
  const s = startExploration(req());
  assert.ok(s.ok);
  assert.equal((await runOnce(s.run.id)).kind, "done");
  const cands = listCandidatesByRun(s.run.id);
  assert.ok(cands.length >= 1 && cands.length <= 3, "最多 3 个候选");
  const gpu = cands.find((c) => c.requirements.some((r) => r.label.includes("GPU")))!;
  assert.ok(gpu, "有需要 GPU 的候选");
  assert.ok(gpu.requirements.every((r) => r.status !== "met" && !r.confirmedByOwner), "模型不能判定满足");
  // 每条引用都能在证据原文中找到
  const ev = new Map(listEvidence(s.run.id).map((e) => [e.id, e]));
  for (const c of cands) for (const ref of c.sourceRefs) assert.ok(locateQuote(ev.get(ref.evidenceId)!.text, ref.quote) >= 0);
  assert.equal(getRun(s.run.id)!.integrationMode, "fixture", "fixture 结果单独标识");

  // 不确认、不接受未知 → 不能开始
  const blocked = createProjectFromCandidate(gpu.id, projectInput(gpu.version));
  assert.equal(blocked.kind, "unknowns_not_accepted");
  assert.equal(getCandidate(gpu.id)!.status, "proposed");
  // 保存为 idea 仍可以（PATCH 路由逻辑直接调用 repo）
});

test("F8 实践闭环：问题→候选→选择→独立项目与任务→成果→本人结论；未反馈不生成结论", async () => {
  const s = startExploration(req("文本检索"));
  assert.ok(s.ok);
  await runOnce(s.run.id);
  const [c] = listCandidatesByRun(s.run.id).filter((x) => !x.requirements.some((r) => r.label.includes("GPU")));
  assert.ok(c);

  // 带未知条件开始：主人显式确认并记录选择
  const r = createProjectFromCandidate(c.id, { ...projectInput(c.version), acceptUnknowns: true, startInclination: "interested" });
  assert.equal(r.kind, "created");
  if (r.kind !== "created") return;
  assert.equal(r.startedWithUnknowns, true);
  assert.equal(r.taskIds.length, 2);
  const project = getProject(r.projectId)!;
  assert.equal(project.title, "我的实践项目", "独立项目对象，标题来自主人编辑");
  assert.equal(listTasks({ projectId: r.projectId }).length, 2);
  // 重复点击不建第二个项目
  assert.equal(createProjectFromCandidate(c.id, { ...projectInput(c.version), acceptUnknowns: true }).kind, "exists");

  // 可追溯开始疑问；未反馈时无结论
  let ex = getProjectExploration(r.projectId)!;
  assert.equal(ex.candidateId, c.id);
  assert.equal(ex.startInclination, "interested");
  assert.equal(ex.conclusion, null, "未反馈就不生成适配结论");

  const art = createArtifact({ projectId: r.projectId, logId: null, kind: "text", title: "记录", body: "做完了", url: null });
  assert.ok(art !== "invalid_url");
  assert.equal(
    saveProjectConclusion(r.projectId, { expectedVersion: 99, experiencedActivities: "", conclusion: "continue", reason: "", artifactIds: [] }),
    "conflict",
  );
  assert.equal(
    saveProjectConclusion(r.projectId, {
      expectedVersion: getProject(r.projectId)!.version,
      experiencedActivities: "跑了两种检索",
      conclusion: "continue",
      reason: "对比结果有意思",
      artifactIds: [art.id],
    }),
    "ok",
  );
  ex = getProjectExploration(r.projectId)!;
  assert.equal(ex.conclusion, "continue");
  assert.deepEqual(ex.conclusionArtifactIds, [art.id]);
});

test("确认条件后可以开始：全部 met 由主人确认 → 不需要 acceptUnknowns", async () => {
  const s = startExploration(req("分类基线"));
  assert.ok(s.ok);
  await runOnce(s.run.id);
  const c = listCandidatesByRun(s.run.id).find((x) => x.requirements.length === 1)!;
  const r = createProjectFromCandidate(c.id, { ...projectInput(c.version), confirmedRequirementIndexes: [0] });
  assert.equal(r.kind, "created");
  if (r.kind === "created") assert.equal(r.startedWithUnknowns, false);
  const after = getCandidate(c.id)!;
  assert.equal(after.requirements[0].status, "met");
  assert.equal(after.requirements[0].confirmedByOwner, true);
});

test("F15 搜索失败：429 有界重试 1 次；只有摘要标 snippet；无效模型 JSON 不编造候选", async () => {
  // 429 两次 → 重试 1 次后放弃，run failed，不编造
  let calls = 0;
  const flaky: SearchProvider = {
    provider: "flaky",
    async search() {
      calls++;
      throw new SearchError("RATE_LIMITED", "429", true);
    },
    async extract() {
      return [];
    },
  };
  setProvidersForTests({ model: fixtures().model, search: { provider: flaky, mode: "fixture" } });
  const s1 = startExploration(req("q1"));
  assert.ok(s1.ok);
  assert.equal((await runOnce(s1.run.id)).kind, "failed");
  // 规划出 1 个 query：首次 + 重试 1 次 = 2 次（重试计入同一预算，整个 run 最多 1 次）
  assert.equal(calls, 2);
  assert.equal(listCandidatesByRun(s1.run.id).length, 0);
  assert.equal(getRun(s1.run.id)!.status, "failed");
  assert.ok(getRun(s1.run.id)!.diagnostics.some((d) => d.message.includes("重试")));

  // 只有摘要（extract 全失败）→ evidence snippet，候选标待核实
  const snippetOnly: SearchProvider = {
    provider: "snippet",
    search: fixtureSearchProvider().search,
    async extract() {
      throw new SearchError("HTTP_ERROR", "500", false);
    },
  };
  setProvidersForTests({ model: fixtures().model, search: { provider: snippetOnly, mode: "fixture" } });
  const s2 = startExploration(req("q2"));
  assert.ok(s2.ok);
  await runOnce(s2.run.id);
  assert.ok(listEvidence(s2.run.id).every((e) => e.status === "snippet"));
  for (const c of listCandidatesByRun(s2.run.id)) {
    assert.equal(c.evidenceStatus, "snippet");
    assert.ok(c.unknowns.some((u) => u.includes("摘要")));
  }

  // 模型持续无效 JSON → SCHEMA_INVALID，run failed，无候选
  const broken: ModelProvider = {
    protocol: "fake",
    call: (r) =>
      r.workflow === MODEL_WORKFLOW_CANDIDATES
        ? completeWithSchema(r, async () => ({ ok: true, text: "{\"candidates\": \"坏\"}" }))
        : fixtureModelProvider().call(r),
  };
  setProvidersForTests({ model: { provider: broken, mode: "fixture" }, search: fixtures().search });
  const s3 = startExploration(req("q3"));
  assert.ok(s3.ok);
  assert.equal((await runOnce(s3.run.id)).kind, "failed");
  assert.equal(getRun(s3.run.id)!.errorCode, "SCHEMA_INVALID");
  assert.equal(listCandidatesByRun(s3.run.id).length, 0);
});

test("引用了不存在的证据 ID 或编造的片段 → 该候选不发布", async () => {
  const fabricating: ModelProvider = {
    protocol: "fake",
    async call(r) {
      if (r.workflow !== MODEL_WORKFLOW_CANDIDATES) return fixtureModelProvider().call(r);
      const ctx = r.context as { evidence: Array<{ id: string }> };
      const base = fixtureModelResponder(r) as { ok: true; validatedResult: { candidates: Array<{ sourceRefs: Array<{ evidenceId: string; quote: string }> }> } };
      base.validatedResult.candidates[0].sourceRefs = [{ evidenceId: "made-up-id", quote: "x" }];
      if (base.validatedResult.candidates[1]) base.validatedResult.candidates[1].sourceRefs = [{ evidenceId: ctx.evidence[0].id, quote: "原文里没有这句话" }];
      return { ok: true, validatedResult: candidatesOutputSchema.parse(base.validatedResult) };
    },
  };
  setProvidersForTests({ model: { provider: fabricating, mode: "fixture" }, search: fixtures().search });
  const s = startExploration(req("q"));
  assert.ok(s.ok);
  assert.equal((await runOnce(s.run.id)).kind, "done");
  assert.equal(listCandidatesByRun(s.run.id).length, 0, "无可验证出处的候选不发布");
  assert.ok(getRun(s.run.id)!.diagnostics.some((d) => d.message.includes("找不到") || d.message.includes("不存在")));
});

test("F16 停用探索：job 已领取时关闭 topic，之后返回结果 → 不发布候选，诊断保留", async () => {
  const topic = createTopic({ title: "机器学习", purpose: "找入门实践", sourcePreference: "", enabled: true, weekday: 1, localTime: "09:00" });
  const s = startExploration(req("机器学习", { topicId: topic.id }), { kind: "scheduled" });
  assert.ok(s.ok);
  const run = getRun(s.run.id)!;
  getDb().prepare(`UPDATE jobs SET run_at = ? WHERE id = ?`).run("2020-01-01T00:00:00.000Z", run.jobId);
  const job = claimDueJobs(new Date().toISOString(), 10).find((j) => j.id === run.jobId)!;

  // 领取后、结果返回前停用 topic（模拟：在模型调用中途停用）
  const slow: ModelProvider = {
    protocol: "fake",
    async call(r) {
      if (r.workflow === MODEL_WORKFLOW_CANDIDATES) {
        const t = getTopic(topic.id)!;
        const u = updateTopic(topic.id, { expectedVersion: t.version, enabled: false });
        assert.notEqual(u, "conflict");
      }
      return fixtureModelProvider().call(r);
    },
  };
  setProvidersForTests({ model: { provider: slow, mode: "fixture" }, search: fixtures().search });
  const out = await runExplorationJob(job);
  assert.equal(out.kind, "cancelled");
  assert.equal(listCandidatesByRun(s.run.id).length, 0, "不发布候选");
  const after = getRun(s.run.id)!;
  assert.equal(after.status, "cancelled");
  assert.ok(after.diagnostics.length > 0, "诊断保留");
  assert.equal(getJob(run.jobId!)!.status, "done");
});

test("取消：queued 直接取消；运行中取消请求在发布前生效", async () => {
  const s = startExploration(req("q"));
  assert.ok(s.ok);
  assert.equal(cancelExploration(s.run.id), "cancelled");
  assert.equal(getRun(s.run.id)!.status, "cancelled");
  assert.equal(getJob(s.jobId)!.status, "cancelled");

  const s2 = startExploration(req("q2"));
  assert.ok(s2.ok);
  const run = getRun(s2.run.id)!;
  getDb().prepare(`UPDATE jobs SET run_at = ? WHERE id = ?`).run("2020-01-01T00:00:00.000Z", run.jobId);
  const job = claimDueJobs(new Date().toISOString(), 10).find((j) => j.id === run.jobId)!;
  const canceller: ModelProvider = {
    protocol: "fake",
    async call(r) {
      if (r.workflow === MODEL_WORKFLOW_CANDIDATES) assert.equal(cancelExploration(s2.run.id), "cancel_requested");
      return fixtureModelProvider().call(r);
    },
  };
  setProvidersForTests({ model: { provider: canceller, mode: "fixture" }, search: fixtures().search });
  assert.equal((await runExplorationJob(job)).kind, "cancelled");
  assert.equal(listCandidatesByRun(s2.run.id).length, 0);
});

test("定期去重：同 topic 同证据不重复提醒；错过周期只入队一个 run；停用后不再入队", async () => {
  const topic = createTopic({ title: "检索", purpose: "", sourcePreference: "", enabled: true, weekday: 1, localTime: "09:00" });
  // 把 next_run_at 拨到很久以前（错过多个周期）
  getDb().prepare(`UPDATE exploration_topics SET next_run_at = ? WHERE id = ?`).run("2026-01-05T01:00:00.000Z", topic.id);
  const before = listJobs({ type: EXPLORATION_JOB_TYPE }).length;
  assert.equal(scheduleDueTopics(), 1);
  assert.equal(scheduleDueTopics(), 0, "同一时刻不重复入队");
  assert.equal(listJobs({ type: EXPLORATION_JOB_TYPE }).length, before + 1, "错过多个周期只生成一个 run");
  const next = getTopic(topic.id)!.nextRunAt!;
  assert.ok(next > new Date().toISOString(), "next_run_at 推进到未来");

  const firstRun = getDb()
    .prepare(`SELECT id FROM exploration_runs WHERE topic_id = ? ORDER BY created_at DESC LIMIT 1`)
    .get(topic.id) as { id: string };
  await runOnce(firstRun.id);
  const n1 = listCandidatesByRun(firstRun.id).length;
  assert.ok(n1 >= 1);

  // 同一 topic 再跑一次，证据相同 → 不重复提醒
  const s2 = startExploration(req("检索", { topicId: topic.id }));
  assert.ok(s2.ok);
  await runOnce(s2.run.id);
  assert.equal(listCandidatesByRun(s2.run.id).length, 0, "同证据候选不重复提醒");
  assert.ok(getRun(s2.run.id)!.diagnostics.some((d) => d.message.includes("不重复提醒")));

  // 停用 → 不再入队
  const t = getTopic(topic.id)!;
  updateTopic(topic.id, { expectedVersion: t.version, enabled: false });
  getDb().prepare(`UPDATE exploration_topics SET next_run_at = ? WHERE id = ?`).run("2020-01-01T00:00:00.000Z", topic.id);
  assert.equal(scheduleDueTopics(), 0);
});

function projectInput(version: number) {
  return {
    expectedVersion: version,
    title: "我的实践项目",
    question: "想验证的问题",
    expectedOutcome: "一页记录",
    prerequisites: "",
    reviewQuestions: "",
    goalIds: [],
    startInclination: "unknown" as const,
    acceptUnknowns: false,
    confirmedRequirementIndexes: [] as number[],
    tasks: [
      { title: "第一步", description: "输入：资料；产出：3 条问题", estimateMinutes: 30 },
      { title: "第二步", description: "", estimateMinutes: null },
    ],
  };
}
