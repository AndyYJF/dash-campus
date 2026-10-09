import crypto from "node:crypto";
import {
  SearchError,
  type EvidenceDocument,
  type SearchHit,
  type SearchProvider,
} from "@/contracts/search";

/**
 * Tavily Search + Extract 适配器（计划第 1、3 节）。
 * 接口依据：https://docs.tavily.com/documentation/api-reference/endpoint/search 、/extract
 * - 搜索结果 content 只是摘要 → snippet；Extract 成功且有文本 → retrieved。
 * - Extract 在 HTTP 200 下也可能有 failed_results，只保留成功项。
 * - 不做通用 fetch 兜底（计划第 3 节：抓取失败不自动退回有内网访问能力的 fetch）。
 */

const BASE = "https://api.tavily.com";
const REQUEST_TIMEOUT_MS = 45_000;
/** 单页正文上限，避免把超长页面整页喂给模型 */
const MAX_DOC_CHARS = 20_000;

export class TavilySearchProvider implements SearchProvider {
  readonly provider = "tavily";

  constructor(
    private readonly apiKey: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async search(args: { query: string; maxResults: number; topic?: "general" | "news"; days?: number; signal?: AbortSignal }): Promise<SearchHit[]> {
    const body = await this.post("/search", {
      query: args.query,
      max_results: Math.min(Math.max(args.maxResults, 1), 20),
      search_depth: "basic",
      include_answer: false,
      include_raw_content: false,
      include_published_date: true,
      ...(args.topic ? { topic: args.topic } : {}),
      ...(args.topic === "news" && args.days ? { days: args.days } : {}),
    }, args.signal) as { results?: Array<{ title?: string; url?: string; content?: string; published_date?: string }> };
    return (body.results ?? [])
      .filter((r) => typeof r.url === "string" && /^https?:\/\//.test(r.url))
      .map((r) => ({
        id: crypto.randomUUID(),
        title: (r.title ?? r.url!).slice(0, 300),
        url: r.url!,
        snippet: r.content ? r.content.slice(0, 2000) : null,
        publishedAt: r.published_date ?? null,
      }));
  }

  async extract(args: { urls: string[]; signal?: AbortSignal }): Promise<EvidenceDocument[]> {
    if (args.urls.length === 0) return [];
    const body = await this.post("/extract", {
      urls: args.urls.slice(0, 20),
      extract_depth: "basic",
      format: "text",
    }, args.signal) as { results?: Array<{ url?: string; raw_content?: string }> };
    const retrievedAt = new Date().toISOString();
    return (body.results ?? [])
      .filter((r) => typeof r.url === "string" && typeof r.raw_content === "string" && r.raw_content.trim())
      .map((r) => ({
        id: crypto.randomUUID(),
        url: r.url!,
        text: r.raw_content!.slice(0, MAX_DOC_CHARS),
        status: "retrieved" as const,
        retrievedAt,
      }));
  }

  private async post(path: string, payload: unknown, outer?: AbortSignal): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    const onAbort = () => controller.abort();
    outer?.addEventListener("abort", onAbort);
    try {
      const res = await this.fetchImpl(`${BASE}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      if (!res.ok) throw statusError(res.status);
      return await res.json();
    } catch (e) {
      if (e instanceof SearchError) throw e;
      if (controller.signal.aborted) {
        throw new SearchError("TIMEOUT", outer?.aborted ? "已中断（预算或租约）" : "搜索请求超时", !outer?.aborted);
      }
      throw new SearchError("UNKNOWN", e instanceof Error ? e.message : String(e), true);
    } finally {
      clearTimeout(timer);
      outer?.removeEventListener("abort", onAbort);
    }
  }
}

function statusError(status: number): SearchError {
  if (status === 429) return new SearchError("RATE_LIMITED", "搜索服务限流（429）", true);
  if (status === 401) return new SearchError("UNAUTHORIZED", "TAVILY_API_KEY 无效（401）", false);
  if (status === 432 || status === 433) return new SearchError("QUOTA_EXCEEDED", `搜索额度已用尽（${status}）`, false);
  if (status >= 500) return new SearchError("HTTP_ERROR", `搜索服务错误（${status}）`, true);
  return new SearchError("HTTP_ERROR", `搜索请求被拒绝（${status}）`, false);
}
