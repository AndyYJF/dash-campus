import { isRestoredHold, RESTORED_HOLD_MESSAGE } from "@/repositories/instance";
import crypto from "node:crypto";
import { getDb } from "@/repositories/db";
import { createJob, getJob, leaseValid, renewLease, completeJob, failJob, completeCancellation } from "@/repositories/jobs";
import {
  finishRun,
  getRun,
  getTopic,
  insertCandidate,
  insertEvidence,
  insertHit,
  insertRun,
  latestCandidateFor,
  saveRunDiagnostics,
  setRunJob,
  setRunStage,
  listTemplates,
  listDueTopics,
  advanceTopicNextRun,
  listQueuedRunsForTopic,
  type Diagnostic,
  type EvidenceRow,
  type RequirementRow,
  type RunRow,
} from "@/repositories/exploration";
import {
  candidatesOutputSchema,
  EXPLORATION_BUDGET,
  EXPLORATION_JOB_TYPE,
  explorationJobPayloadSchema,
  MODEL_WORKFLOW_CANDIDATES,
  MODEL_WORKFLOW_PLAN,
  queryPlanSchema,
  type EvidenceStatus,
  type ExplorationRequest,
  type ModelCandidate,
} from "@/contracts/exploration";
import { JOB_RENEW_INTERVAL_MS, JOB_EXTERNAL_TIMEOUT_MS, type JobRow } from "@/contracts/jobs";
import type { ModelProvider, ModelResult } from "@/contracts/model";
import { SearchError, type SearchProvider } from "@/contracts/search";
import { resolveModelProvider, resolveSearchProvider } from "@/integrations";
import { canonicalUrl, contentHash, evidenceHash, locateQuote, nextWeeklyRun } from "@/domain/exploration";
import { budgetCheck, BudgetExceeded, getAiBudget, meteredModel, meteredSearch } from "@/workflows/ai-budget";

/**
 * 方向探索工作流（计划 v1.2 第 7 节）：
 * 规划检索 → 搜索 → 提取原文 → 生成候选（只能引用提供的证据 ID，片段由程序验证）→ 去重 → 发布。
 * 预算：3 query / 6 提取页 / 3 候选 / 180 秒；可重试失败最多重试 1 次且计入同一预算（7.2）。
 * 发布前在同一事务重检：租约仍有效、run 未取消、定期 topic 仍启用且版本未变（F16）。
 */

export type StartResult =
  | { ok: true; run: RunRow; jobId: string }
  | { ok: false; code: "INTEGRATION_UNAVAILABLE" | "NOT_FOUND" | "BUDGET_EXCEEDED" | "RESTORED_HOLD"; message: string };

/** API 入口：建 run + job（202）。模型必需；搜索缺失时只能用粘贴资料 */
export function startExploration(
  req: ExplorationRequest,
  opts: { kind?: "on_demand" | "scheduled" } = {},
): StartResult {
  if (isRestoredHold()) return { ok: false, code: "RESTORED_HOLD", message: RESTORED_HOLD_MESSAGE };
  const model = resolveModelProvider();
  if (!model) {
    return { ok: false, code: "INTEGRATION_UNAVAILABLE", message: "模型未配置，无法生成候选。请在部署配置中设置模型。" };
  }
  const search = resolveSearchProvider();
  if (!search && req.materials.length === 0) {
    return {
      ok: false,
      code: "INTEGRATION_UNAVAILABLE",
      message: "搜索服务未配置。可以粘贴资料原文后再发起探索（不会声称已联网检索）。",
    };
  }
  // 至少要能完成规划 + 生成两次模型调用
  const budget = budgetCheck({ model: 2, search: search ? 1 : 0 });
  if (!budget.ok) return { ok: false, code: "BUDGET_EXCEEDED", message: budget.message };
  let topicVersion: number | null = null;
  if (req.topicId) {
    const topic = getTopic(req.topicId);
    if (!topic || topic.archivedAt) return { ok: false, code: "NOT_FOUND", message: "关注方向不存在" };
    topicVersion = topic.version;
  }
  const mode: RunRow["integrationMode"] =
    model.mode === "fixture" || search?.mode === "fixture" ? "fixture" : search ? "real" : "materials_only";

  const db = getDb();
  const tx = db.transaction(() => {
    const run = insertRun({
      kind: opts.kind ?? "on_demand",
      topicId: req.topicId,
      topicVersion,
      projectId: req.projectId,
      query: req.query,
      integrationMode: mode,
      background: req.background,
    });
    const at = new Date().toISOString();
    for (const m of req.materials) {
      insertEvidence({
        runId: run.id,
        hitId: null,
        url: m.url,
        canonicalUrl: m.url ? canonicalUrl(m.url) : null,
        title: m.title || (m.url ?? "粘贴资料"),
        text: m.text,
        status: "user_supplied",
        contentHash: contentHash(m.text),
        publishedAt: null,
        retrievedAt: at,
      });
    }
    const job = createJob({
      type: EXPLORATION_JOB_TYPE,
      dedupeKey: `exploration:run:${run.id}`,
      runAt: at,
      payload: { runId: run.id, topicId: req.topicId, topicVersion },
    });
    setRunJob(run.id, job.id);
    return { run: getRun(run.id)!, jobId: job.id };
  });
  const r = tx();
  return { ok: true, ...r };
}

/** 取消：queued 直接取消；running 记取消请求，执行者在外部调用前与发布前检查 */
export function cancelExploration(runId: string): "cancelled" | "cancel_requested" | "not_found" | "finished" {
  const run = getRun(runId);
  if (!run) return "not_found";
  if (["done", "failed", "cancelled"].includes(run.status)) return "finished";
  const db = getDb();
  const tx = db.transaction(() => {
    if (run.jobId) {
      const q = db
        .prepare(`UPDATE jobs SET status = 'cancelled', updated_at = ? WHERE id = ? AND status = 'queued'`)
        .run(new Date().toISOString(), run.jobId);
      if (q.changes === 1) {
        finishRun(runId, "cancelled", { errorCode: "CANCELLED", errorMessage: "已取消" });
        return "cancelled" as const;
      }
      db.prepare(`UPDATE jobs SET cancel_requested = 1, updated_at = ? WHERE id = ? AND status = 'running'`).run(
        new Date().toISOString(),
        run.jobId,
      );
      return "cancel_requested" as const;
    }
    finishRun(runId, "cancelled", { errorCode: "CANCELLED", errorMessage: "已取消" });
    return "cancelled" as const;
  });
  return tx();
}

// ===== worker 执行 =====

export type ExplorationOutcome = { kind: "done" | "failed" | "cancelled" | "fenced" };

class Budget {
  readonly startedAt = Date.now();
  queries = 0;
  extractPages = 0;
  retries = 0;
  modelCalls = 0;
  constructor(readonly totalMs: number) {}
  remainingMs(): number {
    return this.totalMs - (Date.now() - this.startedAt);
  }
  snapshot(): Record<string, number> {
    return {
      queries: this.queries,
      extractPages: this.extractPages,
      retries: this.retries,
      modelCalls: this.modelCalls,
      elapsedMs: Date.now() - this.startedAt,
    };
  }
}

class Abort extends Error {
  constructor(readonly reason: "cancelled" | "fenced" | "budget") {
    super(reason);
  }
}

type Ctx = {
  job: JobRow;
  run: RunRow;
  budget: Budget;
  diagnostics: Diagnostic[];
  controller: AbortController;
  isFenced: () => boolean;
};

function diag(ctx: Ctx, stage: string, message: string): void {
  ctx.diagnostics.push({ at: new Date().toISOString(), stage, message: message.slice(0, 500) });
}

/** 外部调用前检查：取消请求、租约、剩余预算 */
function checkpoint(ctx: Ctx): void {
  if (ctx.isFenced() || !leaseValid(ctx.job.id, ctx.job.leaseToken!, ctx.job.generation, new Date().toISOString())) {
    throw new Abort("fenced");
  }
  if (getJob(ctx.job.id)?.cancelRequested || getRun(ctx.run.id)?.status === "cancelled") throw new Abort("cancelled");
  if (ctx.budget.remainingMs() <= 0) throw new Abort("budget");
}

function callTimeout(ctx: Ctx): number {
  return Math.max(1_000, Math.min(JOB_EXTERNAL_TIMEOUT_MS, ctx.budget.remainingMs()));
}

/** 可重试失败最多重试 1 次（整个 run 共用），计入同一预算 */
async function withRetry<T>(ctx: Ctx, stage: string, fn: () => Promise<T>, retryable: (e: unknown) => boolean): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof Abort) throw e;
    if (!retryable(e) || ctx.budget.retries >= EXPLORATION_BUDGET.maxRetries || ctx.budget.remainingMs() < 5_000) throw e;
    ctx.budget.retries++;
    diag(ctx, stage, `可重试失败，重试 1 次：${e instanceof Error ? e.message : String(e)}`);
    checkpoint(ctx);
    return await fn();
  }
}

class ModelCallError extends Error {
  constructor(readonly result: Extract<ModelResult, { ok: false }>) {
    super(result.error.message);
  }
}

async function callModel<T>(ctx: Ctx, model: ModelProvider, workflow: string, schema: import("zod").ZodType<T>, instructions: string, context: unknown): Promise<T> {
  return withRetry(
    ctx,
    "generating",
    async () => {
      checkpoint(ctx);
      ctx.budget.modelCalls++;
      const r = await model.call({
        workflow,
        context,
        outputSchemaVersion: 1,
        timeoutMs: callTimeout(ctx),
        instructions,
        schema,
        signal: ctx.controller.signal,
      });
      if (!r.ok) throw new ModelCallError(r);
      return r.validatedResult as T;
    },
    (e) => e instanceof ModelCallError && e.result.error.retryable,
  );
}

const PLAN_INSTRUCTIONS =
  "你为一名学生规划方向探索的网页检索。根据问题与背景，给出 1–3 个互不重复、具体的检索词，" +
  "优先能找到高校/机构原文、课程官网、作者项目仓库或论文原始页面的写法。输出 {\"queries\": [...]}。";

const CANDIDATE_INSTRUCTIONS = [
  "你根据提供的证据，为学生生成最多 3 个可以动手的小型实践候选。",
  "硬性规则：",
  "1. sourceRefs 只能引用 evidence 列表里给出的 id；quote 必须逐字摘自该证据的 text（不要改写、不要翻译）。",
  "2. requirements 列出所需基础与资源。你不知道学生是否具备，status 只能是 unknown 或 unmet，不要写 met。",
  "3. 证据不足以支撑某个事实时写进 unknowns，不要编造截止时间、资格、数据集或课程内容。",
  "4. firstTask 要给出明确的输入与可检查的产出；initialTasks 最多 5 个。",
  "5. 不要给出'最适合你'之类的结论；fitReason 只说明与问题的关联。",
  "6. 证据不足以形成任何候选时，candidates 为空数组并在 insufficientReason 说明原因。",
  "输出 {\"candidates\": [...], \"insufficientReason\": null}。字段：title, question, activities[], deliverable,",
  "firstTask{title,input,output,estimateMinutes}, initialTasks[], estimatedMinutesRange{min,max}|null,",
  "requirements[{label,status,basis}], unknowns[], fitReason, sourceRefs[{evidenceId,quote}]。",
].join("\n");

const EVIDENCE_CHARS_FOR_MODEL = 4_000;
/** 未取得原文的搜索摘要最多保留几条作为证据 */
const MAX_SNIPPET_EVIDENCE = 6;

export async function runExplorationJob(job: JobRow): Promise<ExplorationOutcome> {
  const token = job.leaseToken!;
  const gen = job.generation;
  const payload = explorationJobPayloadSchema.parse(job.payload);
  const run = getRun(payload.runId);
  const nowIso = () => new Date().toISOString();
  if (!run || ["done", "failed", "cancelled"].includes(run.status)) {
    return completeJob(job.id, token, gen, { kind: "skipped", reason: "run_finished" }, nowIso())
      ? { kind: "done" }
      : { kind: "fenced" };
  }
  if (job.cancelRequested) {
    finishRun(run.id, "cancelled", { errorCode: "CANCELLED", errorMessage: "已取消" });
    return completeCancellation(job.id, token, gen, nowIso()) ? { kind: "cancelled" } : { kind: "fenced" };
  }

  const model = resolveModelProvider();
  const search = run.integrationMode === "materials_only" ? null : resolveSearchProvider();
  if (!model || (!search && run.integrationMode !== "materials_only")) {
    const msg = !model ? "模型未配置" : "搜索服务未配置";
    finishRun(run.id, "failed", { errorCode: "INTEGRATION_UNAVAILABLE", errorMessage: msg });
    return failJob(job.id, token, gen, `INTEGRATION_UNAVAILABLE: ${msg}`, nowIso()) ? { kind: "failed" } : { kind: "fenced" };
  }

  // 每次调用计入每日额度并记录用量（产品计划 12）
  const related = { type: "exploration_run", id: run.id };
  const meteredModelProvider = meteredModel(model.provider, related);
  const meteredSearchProvider = search ? meteredSearch(search.provider, related) : null;

  let fenced = false;
  const controller = new AbortController();
  const budget = new Budget(EXPLORATION_BUDGET.totalMs);
  const ctx: Ctx = { job, run, budget, diagnostics: [], controller, isFenced: () => fenced };
  // 续租；失败即中断外部请求并禁止提交（8.1）
  const renewTimer = setInterval(() => {
    if (!renewLease(job.id, token, gen, nowIso())) {
      fenced = true;
      controller.abort();
    }
  }, JOB_RENEW_INTERVAL_MS);
  const budgetTimer = setTimeout(() => controller.abort(), budget.totalMs);

  try {
    setRunStage(run.id, "searching", { startedAt: nowIso() });
    const evidence = await gatherEvidence(ctx, meteredModelProvider, meteredSearchProvider);
    if (evidence.length === 0) {
      return fail(ctx, "NO_EVIDENCE", "没有取得任何可引用的资料（搜索失败或无结果），未生成候选");
    }

    setRunStage(run.id, "generating");
    const output = await callModel(ctx, meteredModelProvider, MODEL_WORKFLOW_CANDIDATES, candidatesOutputSchema, CANDIDATE_INSTRUCTIONS, {
      question: run.query,
      background: run.background,
      templates: listTemplates().map((t) => ({ direction: t.direction, question: t.question, status: t.status })),
      evidence: evidence.map((e) => ({
        id: e.id,
        status: e.status,
        title: e.title,
        url: e.url,
        text: e.text.slice(0, EVIDENCE_CHARS_FOR_MODEL),
      })),
    });
    const prepared = prepareCandidates(ctx, output.candidates, evidence);
    if (prepared.length === 0 && output.insufficientReason) diag(ctx, "generating", `资料不足：${output.insufficientReason}`);

    checkpoint(ctx);
    return publish(ctx, prepared);
  } catch (e) {
    if (e instanceof Abort) {
      if (e.reason === "fenced") {
        // 丢失租约：不写业务结果；新执行者会重新运行
        return { kind: "fenced" };
      }
      if (e.reason === "cancelled") {
        finishRun(run.id, "cancelled", { errorCode: "CANCELLED", errorMessage: "已取消", budget: budget.snapshot(), diagnostics: ctx.diagnostics });
        saveRunDiagnostics(run.id, budget.snapshot(), ctx.diagnostics);
        return completeCancellation(job.id, token, gen, nowIso()) ||
          completeJob(job.id, token, gen, { kind: "cancelled" }, nowIso())
          ? { kind: "cancelled" }
          : { kind: "fenced" };
      }
      return fail(ctx, "BUDGET_EXCEEDED", "超过单次 180 秒预算，已停止");
    }
    if (fenced) return { kind: "fenced" };
    if (controller.signal.aborted && budget.remainingMs() <= 0) return fail(ctx, "BUDGET_EXCEEDED", "超过单次 180 秒预算，已停止");
    if (e instanceof BudgetExceeded) return fail(ctx, "BUDGET_EXCEEDED", e.message);
    if (e instanceof ModelCallError) {
      const msg = e.result.error.message;
      return msg.startsWith("BUDGET_EXCEEDED: ")
        ? fail(ctx, "BUDGET_EXCEEDED", msg.slice("BUDGET_EXCEEDED: ".length))
        : fail(ctx, e.result.error.code, msg);
    }
    if (e instanceof SearchError) return fail(ctx, e.code, e.message);
    return fail(ctx, "UNKNOWN", e instanceof Error ? e.message : String(e));
  } finally {
    clearInterval(renewTimer);
    clearTimeout(budgetTimer);
  }
}

function fail(ctx: Ctx, code: string, message: string): ExplorationOutcome {
  const { job, run, budget } = ctx;
  diag(ctx, "failed", `${code}: ${message}`);
  if (!leaseValid(job.id, job.leaseToken!, job.generation, new Date().toISOString())) return { kind: "fenced" };
  finishRun(run.id, "failed", { errorCode: code, errorMessage: message, budget: budget.snapshot(), diagnostics: ctx.diagnostics });
  return failJob(job.id, job.leaseToken!, job.generation, `${code}: ${message}`, new Date().toISOString())
    ? { kind: "failed" }
    : { kind: "fenced" };
}

async function gatherEvidence(ctx: Ctx, model: ModelProvider, search: SearchProvider | null): Promise<EvidenceRow[]> {
  const { run, budget } = ctx;
  // 本次 attempt 可用的证据：已粘贴的资料（入队时写入）
  const evidence: EvidenceRow[] = getDb()
    .prepare(`SELECT id FROM evidence_documents WHERE run_id = ? AND status = 'user_supplied'`)
    .all(run.id)
    .map((r) => (r as { id: string }).id)
    .flatMap((id) => {
      const row = getDb().prepare(`SELECT * FROM evidence_documents WHERE id = ?`).get(id) as Record<string, unknown>;
      return [
        {
          id: row.id as string,
          runId: row.run_id as string,
          hitId: null,
          url: (row.url as string | null) ?? null,
          canonicalUrl: (row.canonical_url as string | null) ?? null,
          title: row.title as string,
          text: row.text as string,
          status: "user_supplied" as const,
          contentHash: row.content_hash as string,
          publishedAt: null,
          retrievedAt: row.retrieved_at as string,
        },
      ];
    });
  if (!search) {
    diag(ctx, "searching", "未配置搜索服务，仅使用粘贴资料");
    return evidence;
  }

  // 1. 规划检索词
  let queries = [run.query];
  try {
    const plan = await callModel(ctx, model, MODEL_WORKFLOW_PLAN, queryPlanSchema, PLAN_INSTRUCTIONS, {
      question: run.query,
      background: run.background,
      sourcePreference: run.topicId ? getTopic(run.topicId)?.sourcePreference ?? "" : "",
    });
    queries = [...new Set(plan.queries.map((q) => q.trim()).filter(Boolean))].slice(0, EXPLORATION_BUDGET.maxQueries);
  } catch (e) {
    if (e instanceof Abort) throw e;
    diag(ctx, "searching", `检索词规划失败，改用原问题检索：${e instanceof Error ? e.message : String(e)}`);
  }

  // 2. 搜索
  type Hit = { id: string; query: string; title: string; url: string; snippet: string | null; publishedAt: string | null; canonical: string };
  const hits: Hit[] = [];
  const seen = new Set<string>();
  let searchFailures = 0;
  for (const q of queries) {
    checkpoint(ctx);
    budget.queries++;
    try {
      const results = await withRetry(
        ctx,
        "searching",
        () => search.search({ query: q, maxResults: EXPLORATION_BUDGET.resultsPerQuery, signal: ctx.controller.signal }),
        (e) => e instanceof SearchError && e.retryable,
      );
      for (const h of results) {
        const canonical = canonicalUrl(h.url);
        if (!canonical || seen.has(canonical)) continue;
        seen.add(canonical);
        insertHit(run.id, { ...h, query: q });
        hits.push({ ...h, query: q, canonical });
      }
    } catch (e) {
      if (e instanceof Abort) throw e;
      searchFailures++;
      diag(ctx, "searching", `检索"${q}"失败：${e instanceof Error ? e.message : String(e)}`);
      // 不可重试（额度/鉴权）时不再继续打后续 query
      if (e instanceof SearchError && !e.retryable) break;
    }
  }
  if (hits.length === 0) {
    if (searchFailures > 0 && evidence.length === 0) {
      throw new SearchError("HTTP_ERROR", ctx.diagnostics.filter((d) => d.stage === "searching").at(-1)?.message ?? "搜索失败", false);
    }
    return evidence;
  }

  // 3. 提取原文（合计最多 6 页）
  setRunStage(run.id, "extracting");
  const toExtract = hits.slice(0, EXPLORATION_BUDGET.maxExtractPages);
  const extracted = new Map<string, { text: string; retrievedAt: string }>();
  try {
    checkpoint(ctx);
    budget.extractPages += toExtract.length;
    const docs = await withRetry(
      ctx,
      "extracting",
      () => search.extract({ urls: toExtract.map((h) => h.url), signal: ctx.controller.signal }),
      (e) => e instanceof SearchError && e.retryable,
    );
    for (const d of docs) if (d.text) extracted.set(canonicalUrl(d.url) ?? d.url, { text: d.text, retrievedAt: d.retrievedAt });
    const missing = toExtract.length - extracted.size;
    if (missing > 0) diag(ctx, "extracting", `${missing} 个页面未取得原文，只保留搜索摘要（snippet）`);
  } catch (e) {
    if (e instanceof Abort) throw e;
    diag(ctx, "extracting", `提取原文失败，只使用搜索摘要：${e instanceof Error ? e.message : String(e)}`);
  }

  // 4. 落证据：取得原文 → retrieved；只有摘要 → snippet。
  // 摘要只保留前若干条（原文页优先），避免大量摘要挤占模型上下文
  const at = new Date().toISOString();
  const withDoc = hits.filter((h) => extracted.has(h.canonical));
  const snippetOnly = hits.filter((h) => !extracted.has(h.canonical)).slice(0, MAX_SNIPPET_EVIDENCE);
  for (const h of [...withDoc, ...snippetOnly]) {
    const doc = extracted.get(h.canonical);
    const text = doc?.text ?? h.snippet;
    if (!text) continue;
    evidence.push(
      insertEvidence({
        runId: run.id,
        hitId: h.id,
        url: h.url,
        canonicalUrl: h.canonical,
        title: h.title,
        text,
        status: doc ? "retrieved" : "snippet",
        contentHash: contentHash(text),
        publishedAt: h.publishedAt,
        retrievedAt: doc?.retrievedAt ?? at,
      }),
    );
  }
  return evidence;
}

type PreparedCandidate = Parameters<typeof insertCandidate>[0];

const EVIDENCE_RANK: Record<EvidenceStatus, number> = { snippet: 0, user_supplied: 1, retrieved: 2 };

/** 校验引用、降级 met、计算证据状态与去重键 */
function prepareCandidates(ctx: Ctx, candidates: ModelCandidate[], evidence: EvidenceRow[]): PreparedCandidate[] {
  const byId = new Map(evidence.map((e) => [e.id, e]));
  const out: PreparedCandidate[] = [];
  for (const c of candidates.slice(0, EXPLORATION_BUDGET.maxCandidates)) {
    const refs = c.sourceRefs.filter((r) => {
      const ev = byId.get(r.evidenceId);
      if (!ev) {
        diag(ctx, "generating", `候选"${c.title}"引用了不存在的证据 ID，已丢弃该引用`);
        return false;
      }
      if (locateQuote(ev.text, r.quote) < 0) {
        diag(ctx, "generating", `候选"${c.title}"的引用片段在原文中找不到，已丢弃该引用`);
        return false;
      }
      return true;
    });
    if (refs.length === 0) {
      diag(ctx, "generating", `候选"${c.title}"没有可验证的出处，未发布`);
      continue;
    }
    const refEvidence = refs.map((r) => byId.get(r.evidenceId)!);
    const best = refEvidence.reduce((a, b) => (EVIDENCE_RANK[b.status] > EVIDENCE_RANK[a.status] ? b : a));
    const requirements: RequirementRow[] = c.requirements.map((r) => ({
      label: r.label,
      // 模型不能判定已满足；met 只能来自主人确认（7.1）
      status: r.status === "met" ? "unknown" : r.status,
      basis: r.basis,
      confirmedByOwner: false,
    }));
    const unknowns = [...c.unknowns];
    if (best.status === "snippet") unknowns.push("只有搜索摘要，原文未取得，条件与内容待核实");
    out.push({
      runId: ctx.run.id,
      topicId: ctx.run.topicId,
      title: c.title,
      question: c.question,
      activities: c.activities,
      deliverable: c.deliverable,
      firstTask: c.firstTask,
      initialTasks: c.initialTasks.slice(0, 5),
      estimatedMinutesRange: c.estimatedMinutesRange,
      requirements,
      unknowns,
      fitReason: c.fitReason,
      sourceRefs: refs,
      evidenceStatus: best.status,
      canonicalUrl: refEvidence.find((e) => e.canonicalUrl)?.canonicalUrl ?? null,
      evidenceHash: evidenceHash(refs.map((r) => r.quote)),
      supersedesId: null,
    });
  }
  return out;
}

/** 发布事务：租约 + 取消 + topic 启用与版本重检（F16）；同 topic+URL 同证据不重复发布 */
function publish(ctx: Ctx, prepared: PreparedCandidate[]): ExplorationOutcome {
  const { job, run, budget } = ctx;
  const db = getDb();
  const tx = db.transaction((): ExplorationOutcome => {
    const nowIso = new Date().toISOString();
    if (!leaseValid(job.id, job.leaseToken!, job.generation, nowIso)) return { kind: "fenced" };
    const fresh = getJob(job.id);
    const freshRun = getRun(run.id);
    if (fresh?.cancelRequested || freshRun?.status === "cancelled") {
      diag(ctx, "publish", "已取消：候选未发布");
      finishRun(run.id, "cancelled", { errorCode: "CANCELLED", errorMessage: "已取消", budget: budget.snapshot(), diagnostics: ctx.diagnostics });
      // run 可能已由 API 置为 cancelled（finishRun 不覆盖终态），诊断单独保存（F16：取消后可保留诊断）
      saveRunDiagnostics(run.id, budget.snapshot(), ctx.diagnostics);
      if (!completeCancellation(job.id, job.leaseToken!, job.generation, nowIso)) {
        completeJob(job.id, job.leaseToken!, job.generation, { kind: "cancelled" }, nowIso);
      }
      return { kind: "cancelled" };
    }
    if (run.kind === "scheduled" && run.topicId) {
      const topic = getTopic(run.topicId);
      if (!topic || !topic.enabled || topic.archivedAt || topic.version !== run.topicVersion) {
        diag(ctx, "publish", "关注方向已停用或已修改：候选未发布，不发摘要");
        finishRun(run.id, "cancelled", { errorCode: "TOPIC_DISABLED", errorMessage: "关注方向已停用或已修改", budget: budget.snapshot(), diagnostics: ctx.diagnostics });
        completeJob(job.id, job.leaseToken!, job.generation, { kind: "skipped", reason: "topic_disabled" }, nowIso);
        return { kind: "cancelled" };
      }
    }
    let published = 0;
    for (const c of prepared) {
      if (run.topicId && c.canonicalUrl) {
        const prev = latestCandidateFor(run.topicId, c.canonicalUrl);
        if (prev && prev.evidenceHash === c.evidenceHash) {
          diag(ctx, "publish", `候选"${c.title}"与已有候选证据相同，不重复提醒`);
          continue;
        }
        if (prev) c.supersedesId = prev.id;
      }
      insertCandidate(c);
      published++;
    }
    if (published === 0 && prepared.length === 0) diag(ctx, "publish", "资料不足，未形成候选");
    finishRun(run.id, "done", { budget: budget.snapshot(), diagnostics: ctx.diagnostics });
    const ok = completeJob(job.id, job.leaseToken!, job.generation, { kind: "skipped", reason: `published:${published}` }, nowIso);
    if (!ok) throw new Error("FENCED_AT_COMMIT");
    return { kind: "done" };
  });
  try {
    return tx.immediate();
  } catch (e) {
    if (e instanceof Error && e.message === "FENCED_AT_COMMIT") return { kind: "fenced" };
    throw e;
  }
}

/**
 * 定期调度（worker 每趟调用）：到期且启用的 topic 入队一个 run，并把 next_run_at 推进到"现在之后"的下一个周期。
 * 错过多个周期只生成一个当前 run（7.2）；条件推进 next_run_at 防止重复入队。
 */
export function scheduleDueTopics(now: Date = new Date()): number {
  let queued = 0;
  // 主人关闭了定期 AI 任务：推进 next_run_at 但不入队（错过的周期不补跑）
  const scheduledAllowed = getAiBudget().budget.scheduledEnabled;
  for (const topic of listDueTopics(now.toISOString())) {
    if (!scheduledAllowed) {
      advanceTopicNextRun(topic.id, topic.nextRunAt!, nextWeeklyRun(now, topic.weekday, topic.localTime, topic.timezone));
      continue;
    }
    const next = nextWeeklyRun(now, topic.weekday, topic.localTime, topic.timezone);
    const db = getDb();
    const tx = db.transaction(() => {
      if (!advanceTopicNextRun(topic.id, topic.nextRunAt!, next)) return false;
      if (listQueuedRunsForTopic(topic.id).length > 0) return false; // 上一次还没跑完，不叠加
      const r = startExploration(
        {
          query: topic.purpose ? `${topic.title}：${topic.purpose}` : topic.title,
          topicId: topic.id,
          projectId: null,
          background: "",
          materials: [],
        },
        { kind: "scheduled" },
      );
      return r.ok;
    });
    if (tx()) queued++;
  }
  return queued;
}

/** topic 停用/修改：未开始的旧 run 失效（7.2：topic 版本变更使未开始旧 job 失效） */
export function invalidateQueuedTopicRuns(topicId: string): void {
  for (const r of listQueuedRunsForTopic(topicId)) {
    if (r.kind === "scheduled" && r.status === "queued") cancelExploration(r.id);
  }
}

export function scheduledSlotKey(topicId: string): string {
  return `exploration:topic:${topicId}:${crypto.randomUUID()}`;
}
