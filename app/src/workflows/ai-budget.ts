import crypto from "node:crypto";
import { getDb } from "@/repositories/db";
import { getSetting, updateSetting } from "@/repositories/settings";
import { AI_BUDGET_SETTINGS_KEY, aiBudgetSchema, type AiBudget } from "@/contracts/review";
import type { ModelProvider } from "@/contracts/model";
import type { SearchProvider } from "@/contracts/search";
import { getConfig } from "@/config";
import { instanceTimezone, localDateInTz } from "@/domain/time";

/**
 * AI 用量与预算（产品计划第 12 节）：
 * - 记录每次调用的模型、耗时、可获得的 token、状态与关联对象；不记录请求原文。
 * - 次数额度按实例时区的自然日计；达到后暂停非必要 AI 任务（探索/复盘/卡点），截止提醒不受影响。
 * - 金额不猜：只记次数与 token，费用由主人按自己的账单判断。
 */

export function getAiBudget(): { budget: AiBudget; version: number } {
  const { value, version } = getSetting(AI_BUDGET_SETTINGS_KEY);
  return { budget: aiBudgetSchema.parse(value ?? {}), version };
}

export function saveAiBudget(value: AiBudget, expectedVersion: number): { version: number } | "conflict" {
  return updateSetting(AI_BUDGET_SETTINGS_KEY, aiBudgetSchema.parse(value), expectedVersion);
}

function today(): string {
  return localDateInTz(new Date(), instanceTimezone());
}

export type UsageToday = { modelCalls: number; searchCalls: number; inputTokens: number; outputTokens: number; localDate: string };

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
    modelCalls: m?.n ?? 0,
    searchCalls: s?.n ?? 0,
    inputTokens: m?.i ?? 0,
    outputTokens: m?.o ?? 0,
    localDate,
  };
}

/** 本次工作流开始前的额度检查：需要的调用次数是否还放得下 */
export function budgetCheck(need: { model?: number; search?: number } = { model: 1 }):
  | { ok: true }
  | { ok: false; message: string } {
  const { budget } = getAiBudget();
  const u = usageToday();
  if ((need.model ?? 0) > 0 && u.modelCalls + (need.model ?? 0) > budget.dailyModelCalls) {
    return { ok: false, message: `今日模型调用已达上限（${u.modelCalls}/${budget.dailyModelCalls}），非必要 AI 任务已暂停；截止提醒不受影响` };
  }
  if ((need.search ?? 0) > 0 && u.searchCalls + (need.search ?? 0) > budget.dailySearchCalls) {
    return { ok: false, message: `今日搜索调用已达上限（${u.searchCalls}/${budget.dailySearchCalls}）` };
  }
  return { ok: true };
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

/** 包装模型 provider：每次调用前查额度、调用后记用量 */
export function meteredModel(inner: ModelProvider, related?: { type: string; id: string }): ModelProvider {
  const model = inner.protocol === "fake" ? "fixture" : (getConfig().MODEL_NAME ?? null);
  return {
    protocol: inner.protocol,
    async call(req) {
      const check = budgetCheck({ model: 1 });
      if (!check.ok) {
        return { ok: false, error: { code: "UNKNOWN", message: `BUDGET_EXCEEDED: ${check.message}`, retryable: false } };
      }
      const startedAt = Date.now();
      const r = await inner.call(req);
      // 结构修复会多发一次请求：按实际请求数计入额度（token 记在第一条上）
      const attempts = Math.max(1, r.attempts ?? 1);
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
