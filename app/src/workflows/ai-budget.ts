import crypto from "node:crypto";
import { getDb } from "@/repositories/db";
import { getSetting, updateSetting } from "@/repositories/settings";
import { AI_BUDGET_SETTINGS_KEY, aiBudgetSchema, type AiBudget } from "@/contracts/review";
import { MAX_REQUESTS_PER_DECISION, type HttpReservation, type ModelHttpGate, type ModelProvider, type ModelResult } from "@/contracts/model";
import type { SearchProvider } from "@/contracts/search";
import { getConfig } from "@/config";
import { instanceTimezone, localDateInTz } from "@/domain/time";
import { writeTrace, type TraceStatus } from "@/workflows/agent-trace";

/**
 * AI 用量与预算（产品计划第 12 节；Agent 方案 §3.3）：
 * - 模型额度按实际 HTTP 请求计：每次请求发出前在 ai_request_ledger 原子占用（BEGIN IMMEDIATE，web/worker 共享）；
 *   发出后即使超时/崩溃也保留占用，只有确认没有发出时才释放。日额度、单决策、单投递与累计执行时间都从账目计数。
 * - ai_usage 照旧记录每次调用的模型、耗时、token 与状态（展示与诊断），不记录请求原文。
 * - 达到日额度后暂停非必要 AI 任务（探索/复盘/卡点），截止提醒不受影响。
 * - 金额不猜：只记次数与 token，费用由主人按自己的账单判断。
 */

/** 每次模型决策最多 4 次 HTTP（首次、工具后续、结构修复与重试合计） */
export const PER_DECISION_MAX_REQUESTS = MAX_REQUESTS_PER_DECISION;
/**
 * 同一投递的主动执行时间上限：worker 实际处理它的累计时间（模型请求、只读工具、绑定、写入、核验与修正），
 * 跨恢复累计（intakes.active_ms + 本进程正在进行的这一段）；不含排队、等主人回答和两次处理之间的空闲。
 */
export const INTAKE_ACTIVE_MS_LIMIT = 180_000;

/** 本进程里正在处理的投递：从哪一刻起的时间还没记进 active_ms */
const runningSince = new Map<string, number>();

/** worker 开始/记完检查点时调用：since=null 表示这段处理已结束 */
export function markIntakeRun(intakeId: string, since: number | null): void {
  if (since === null) runningSince.delete(intakeId);
  else runningSince.set(intakeId, since);
}

/** 检查点：把从上一个检查点到现在的处理时间记进 active_ms（进程退出只丢最后一段） */
export function checkpointIntakeRun(intakeId: string): void {
  const since = runningSince.get(intakeId);
  if (since === undefined) return;
  const t = Date.now();
  getDb().prepare(`UPDATE intakes SET active_ms = active_ms + ? WHERE id = ?`).run(Math.max(0, t - since), intakeId);
  runningSince.set(intakeId, t);
}

/** 主动执行时间：已记下的 + 本进程正在进行、尚未记下的那一段 */
export function intakeActiveMs(intakeId: string): number {
  const row = getDb().prepare(`SELECT active_ms FROM intakes WHERE id = ?`).get(intakeId) as { active_ms: number } | undefined;
  const since = runningSince.get(intakeId);
  return (row?.active_ms ?? 0) + (since === undefined ? 0 : Math.max(0, Date.now() - since));
}

/** 剩余的主动执行时间：每次模型调用的超时不超过它 */
export function intakeActiveRemainingMs(intakeId: string): number {
  const u = intakeRequestUsage(intakeId);
  return INTAKE_ACTIVE_MS_LIMIT - Math.max(u.activeMs, u.modelMs);
}

export function getAiBudget(): { budget: AiBudget; version: number } {
  const { value, version } = getSetting(AI_BUDGET_SETTINGS_KEY);
  const budget = aiBudgetSchema.parse(value ?? {});
  // 演示实例：全站每日上限由环境变量封顶，访客在设置页或对话里调高也不会超过它
  const cfg = getConfig();
  if (cfg.DEMO_MODE) {
    budget.dailyModelCalls = Math.min(budget.dailyModelCalls, cfg.DEMO_DAILY_MODEL_CALLS);
    budget.dailySearchCalls = Math.min(budget.dailySearchCalls, cfg.DEMO_DAILY_SEARCH_CALLS);
  }
  return { budget, version };
}

export function saveAiBudget(value: AiBudget, expectedVersion: number): { version: number } | "conflict" {
  return updateSetting(AI_BUDGET_SETTINGS_KEY, aiBudgetSchema.parse(value), expectedVersion);
}

/** 主人保存过的日额度低于当前默认值时，设置页提示可上调（不强行覆盖） */
export function savedDailyBelowDefault(): boolean {
  const { value } = getSetting(AI_BUDGET_SETTINGS_KEY);
  const saved = (value as { dailyModelCalls?: unknown } | null)?.dailyModelCalls;
  return typeof saved === "number" && saved < aiBudgetSchema.parse({}).dailyModelCalls;
}

function today(): string {
  return localDateInTz(new Date(), instanceTimezone());
}

export type UsageToday = { modelCalls: number; searchCalls: number; inputTokens: number; outputTokens: number; localDate: string };

function countedRequestsOn(localDate: string): number {
  return (getDb().prepare(`SELECT COUNT(*) AS n FROM ai_request_ledger WHERE local_date = ? AND status <> 'released'`).get(localDate) as { n: number }).n;
}

export function usageToday(): UsageToday {
  const localDate = today();
  const rows = getDb()
    .prepare(
      `SELECT kind, COUNT(*) AS n, COALESCE(SUM(input_tokens), 0) AS i, COALESCE(SUM(output_tokens), 0) AS o
       FROM ai_usage WHERE local_date = ? GROUP BY kind`,
    )
    .all(localDate) as Array<{ kind: string; n: number; i: number; o: number }>;
  const m = rows.find((r) => r.kind === "model");
  const s = rows.find((r) => r.kind === "search");
  return {
    modelCalls: countedRequestsOn(localDate),
    searchCalls: s?.n ?? 0,
    inputTokens: m?.i ?? 0,
    outputTokens: m?.o ?? 0,
    localDate,
  };
}

/** 本次工作流开始前的额度检查：需要的调用次数是否还放得下（只是预检，真正占用在每次 HTTP 前） */
export function budgetCheck(need: { model?: number; search?: number } = { model: 1 }):
  | { ok: true }
  | { ok: false; message: string } {
  const { budget } = getAiBudget();
  const u = usageToday();
  if ((need.model ?? 0) > 0 && u.modelCalls + (need.model ?? 0) > budget.dailyModelCalls) {
    return { ok: false, message: dailyMessage(u.modelCalls, budget.dailyModelCalls) };
  }
  if ((need.search ?? 0) > 0 && u.searchCalls + (need.search ?? 0) > budget.dailySearchCalls) {
    return { ok: false, message: `今日搜索调用已达上限（${u.searchCalls}/${budget.dailySearchCalls}）` };
  }
  return { ok: true };
}

function dailyMessage(used: number, limit: number): string {
  return `今日模型调用已达上限（${used}/${limit}），非必要 AI 任务已暂停；截止提醒不受影响`;
}

/** modelMs：模型 HTTP 时间；activeMs：主动执行时间（含模型时间）。旧投递没有 active_ms 记录，按两者较大者计 */
export type IntakeRequestUsage = { requests: number; modelMs: number; activeMs: number; limit: number };

export function intakeRequestUsage(intakeId: string): IntakeRequestUsage {
  const row = getDb()
    .prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(duration_ms), 0) AS ms FROM ai_request_ledger WHERE intake_id = ? AND status <> 'released'`)
    .get(intakeId) as { n: number; ms: number };
  return { requests: row.n, modelMs: row.ms, activeMs: intakeActiveMs(intakeId), limit: getAiBudget().budget.perIntakeModelRequests };
}

/** 主动执行时间是否已用完（与模型时间取较大者） */
export function intakeTimeSpent(u: IntakeRequestUsage): boolean {
  return Math.max(u.activeMs, u.modelMs) >= INTAKE_ACTIVE_MS_LIMIT;
}

/** 单份投递的预检：请求数与累计主动执行时间 */
export function intakeBudgetCheck(intakeId: string): { ok: true } | { ok: false; message: string } {
  const u = intakeRequestUsage(intakeId);
  if (u.requests >= u.limit) return { ok: false, message: intakeCountMessage(u.limit) };
  if (intakeTimeSpent(u)) return { ok: false, message: intakeTimeMessage() };
  return { ok: true };
}

function intakeCountMessage(limit: number): string {
  return `这份投递已用完单次处理的模型请求额度（${limit} 次），剩余部分已保留；可以明确要求继续，或分开投递`;
}
function intakeTimeMessage(): string {
  return `这份投递的处理已累计 ${INTAKE_ACTIVE_MS_LIMIT / 1000} 秒（模型请求、查询与执行，不含排队和等你回答），已完成的部分保留，剩余部分没有继续；可以明确要求继续，或分开投递`;
}

export type RequestScope = { decisionId: string; workflow: string; intakeId: string | null; related: { type: string; id: string } | null };

/**
 * 原子占用一次 HTTP 请求额度。web 与 worker 共用同一 SQLite 文件，IMMEDIATE 事务保证计数与插入不交错。
 * force=true 只用于不经闸门的 provider（fixture/测试假件）事后记账：如实记录已经发生的请求，不做拒绝。
 */
export function reserveRequest(scope: RequestScope, attempt: number, force = false): HttpReservation {
  const db = getDb();
  return db
    .transaction((): HttpReservation => {
      const { budget } = getAiBudget();
      const localDate = today();
      if (!force) {
        const daily = countedRequestsOn(localDate);
        if (daily >= budget.dailyModelCalls) return { ok: false, message: dailyMessage(daily, budget.dailyModelCalls) };
        const perDecision = (db.prepare(`SELECT COUNT(*) AS n FROM ai_request_ledger WHERE decision_id = ? AND status <> 'released'`).get(scope.decisionId) as { n: number }).n;
        if (perDecision >= PER_DECISION_MAX_REQUESTS) return { ok: false, message: `单次模型决策最多 ${PER_DECISION_MAX_REQUESTS} 次请求，已停止继续请求` };
        if (scope.intakeId) {
          const u = intakeRequestUsage(scope.intakeId);
          if (u.requests >= budget.perIntakeModelRequests) return { ok: false, message: intakeCountMessage(budget.perIntakeModelRequests) };
          if (intakeTimeSpent(u)) return { ok: false, message: intakeTimeMessage() };
        }
      }
      const id = crypto.randomUUID();
      db.prepare(
        `INSERT INTO ai_request_ledger (id, local_date, created_at, workflow, decision_id, attempt, intake_id, related_type, related_id, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'reserved')`,
      ).run(id, localDate, new Date().toISOString(), scope.workflow, scope.decisionId, attempt, scope.intakeId, scope.related?.type ?? null, scope.related?.id ?? null);
      return { ok: true, requestId: id };
    })
    .immediate();
}

/** 结算：只改仍是 reserved 的行，同一 requestId 重复结算不重复计数；sent=false 才释放 */
export function settleRequest(requestId: string, outcome: { sent: boolean; ok: boolean; latencyMs: number }): void {
  getDb()
    .prepare(`UPDATE ai_request_ledger SET status = ?, duration_ms = ?, settled_at = ? WHERE id = ? AND status = 'reserved'`)
    .run(outcome.sent ? (outcome.ok ? "ok" : "error") : "released", outcome.sent ? outcome.latencyMs : 0, new Date().toISOString(), requestId);
}

function record(row: {
  kind: "model" | "search";
  workflow: string;
  provider: string;
  model: string | null;
  startedAt: number;
  ok: boolean;
  errorCode?: string | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  related?: { type: string; id: string };
}): void {
  getDb()
    .prepare(
      `INSERT INTO ai_usage (id, kind, workflow, provider, model, local_date, started_at, duration_ms, status, error_code,
         input_tokens, output_tokens, related_type, related_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      crypto.randomUUID(),
      row.kind,
      row.workflow,
      row.provider,
      row.model,
      today(),
      new Date(row.startedAt).toISOString(),
      Date.now() - row.startedAt,
      row.ok ? "ok" : "error",
      row.errorCode ?? null,
      row.inputTokens ?? null,
      row.outputTokens ?? null,
      row.related?.type ?? null,
      row.related?.id ?? null,
    );
}

/** 超出每日额度：调用前抛出，不发出请求 */
export class BudgetExceeded extends Error {}

/** 计量与诊断的关联对象；related.type === "intake" 时自动按投递计数 */
export type MeterContext = {
  itemId?: string | null;
  conversationId?: string | null;
  goalId?: string | null;
  routedBy?: "model" | "rules" | "fast" | null;
};

function traceStatus(r: ModelResult): TraceStatus {
  if (r.ok) return "ok";
  if (r.error.code === "SCHEMA_INVALID") return "schema_invalid";
  if (r.error.code === "BUDGET_EXCEEDED") return "budget";
  if (r.error.code === "TIMEOUT") return "timeout";
  return "error";
}

/**
 * 包装模型 provider：每次实际 HTTP 前经闸门占用额度、结束后结算；成功/失败/超额都写脱敏 trace。
 * 不经闸门的 provider（fixture/测试假件）按其报告的 attempts 事后记账，首个请求仍在调用前占用。
 */
export function meteredModel(inner: ModelProvider, related?: { type: string; id: string }, meter: MeterContext = {}): ModelProvider {
  const model = inner.protocol === "fake" ? "fixture" : (getConfig().MODEL_NAME ?? null);
  const intakeId = related?.type === "intake" ? related.id : null;
  return {
    protocol: inner.protocol,
    toolRouting: inner.toolRouting,
    async call(req) {
      const startedAt = Date.now();
      const scope: RequestScope = { decisionId: crypto.randomUUID(), workflow: req.workflow, intakeId, related: related ?? null };
      const requestIds: string[] = [];
      const exchanges: Array<{ requestId: string; attempt: number; ok: boolean; latencyMs: number; raw?: string; error?: string }> = [];
      const trace = (r: ModelResult, attempts: number) =>
        writeTrace({
          workflow: req.workflow,
          routedBy: meter.routedBy ?? null,
          intakeId,
          itemId: meter.itemId ?? null,
          conversationId: meter.conversationId ?? null,
          goalId: meter.goalId ?? null,
          related: related ?? null,
          protocol: inner.protocol,
          model,
          instructions: req.instructions,
          schemaVersion: req.outputSchemaVersion,
          status: traceStatus(r),
          errorCode: r.ok ? null : r.error.code,
          error: r.ok ? null : r.error.message,
          attempts,
          requestIds,
          latencyMs: Date.now() - startedAt,
          request: { workflow: req.workflow, schemaVersion: req.outputSchemaVersion, context: req.context },
          response: r.ok ? r.validatedResult : undefined,
          exchanges,
          toolCalls: (r.toolCalls ?? []).map((c) => ({ name: c.name, args: c.args, resultDigest: c.resultDigest, chars: c.chars, round: c.round, ok: c.ok, truncated: c.truncated, observationId: c.observationId })),
        });

      // 首个请求在调用前占用：拒绝时不调用 provider
      const first = reserveRequest(scope, 0);
      if (!first.ok) {
        const denied: ModelResult = { ok: false, error: { code: "BUDGET_EXCEEDED", message: `BUDGET_EXCEEDED: ${first.message}`, retryable: false }, attempts: 0 };
        trace(denied, 0);
        return denied;
      }
      let preReserved: string | null = first.requestId;
      let gateUsed = false;
      const attemptOf = new Map<string, number>();
      const gate: ModelHttpGate = {
        beforeRequest({ attempt }) {
          gateUsed = true;
          let r: HttpReservation;
          if (preReserved) {
            r = { ok: true, requestId: preReserved };
            preReserved = null;
          } else r = reserveRequest(scope, attempt);
          if (r.ok) {
            requestIds.push(r.requestId);
            attemptOf.set(r.requestId, attempt);
          }
          return r;
        },
        afterRequest(requestId, o) {
          settleRequest(requestId, o);
          exchanges.push({ requestId, attempt: attemptOf.get(requestId) ?? 0, ok: o.ok, latencyMs: o.latencyMs, raw: o.rawText, error: o.error });
        },
      };

      let r: ModelResult;
      try {
        r = await inner.call({ ...req, gate });
      } catch (e) {
        // 异常时不知道请求是否已发出：保留占用
        if (preReserved) settleRequest(preReserved, { sent: true, ok: false, latencyMs: Date.now() - startedAt });
        throw e;
      }

      let attempts: number;
      if (gateUsed) {
        if (preReserved) settleRequest(preReserved, { sent: false, ok: false, latencyMs: 0 });
        attempts = (getDb().prepare(`SELECT COUNT(*) AS n FROM ai_request_ledger WHERE decision_id = ? AND status <> 'released'`).get(scope.decisionId) as { n: number }).n;
      } else {
        attempts = Math.max(1, r.attempts ?? 1);
        requestIds.push(preReserved!);
        settleRequest(preReserved!, { sent: true, ok: r.ok, latencyMs: Date.now() - startedAt });
        for (let i = 1; i < attempts; i++) {
          const extra = reserveRequest(scope, i, true);
          if (extra.ok) {
            requestIds.push(extra.requestId);
            settleRequest(extra.requestId, { sent: true, ok: i === attempts - 1 ? r.ok : false, latencyMs: 0 });
          }
        }
      }

      // ai_usage：按实际请求数记录（token 记在第一条上）
      for (let i = 0; i < attempts; i++) {
        record({
          kind: "model",
          workflow: i === 0 ? req.workflow : `${req.workflow}.repair`,
          provider: inner.protocol,
          model,
          startedAt,
          ok: i === attempts - 1 ? r.ok : false,
          errorCode: i === attempts - 1 ? (r.ok ? null : r.error.code) : "SCHEMA_INVALID",
          inputTokens: i === 0 && r.ok ? (r.usage?.inputTokens ?? null) : null,
          outputTokens: i === 0 && r.ok ? (r.usage?.outputTokens ?? null) : null,
          related,
        });
      }
      trace(r, attempts);
      return r;
    },
  };
}

export function meteredSearch(inner: SearchProvider, related?: { type: string; id: string }): SearchProvider {
  const wrap = <A, R>(workflow: string, fn: (a: A) => Promise<R>) =>
    async (a: A): Promise<R> => {
      const check = budgetCheck({ search: 1 });
      if (!check.ok) throw new BudgetExceeded(check.message);
      const startedAt = Date.now();
      try {
        const r = await fn(a);
        record({ kind: "search", workflow, provider: inner.provider, model: null, startedAt, ok: true, related });
        return r;
      } catch (e) {
        record({
          kind: "search",
          workflow,
          provider: inner.provider,
          model: null,
          startedAt,
          ok: false,
          errorCode: (e as { code?: string }).code ?? "UNKNOWN",
          related,
        });
        throw e;
      }
    };
  return {
    provider: inner.provider,
    search: wrap("search", (a) => inner.search(a)),
    extract: wrap("extract", (a) => inner.extract(a)),
  };
}
