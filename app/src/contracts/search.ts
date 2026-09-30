/**
 * SearchProvider 接口（计划 v1.2 第 3 节）。
 * 生产首个适配器为 Tavily /search 与 /extract。
 */

export type SearchHit = {
  id: string;
  title: string;
  url: string;
  snippet: string | null;
  publishedAt: string | null;
};

export type EvidenceDocument = {
  id: string;
  url: string;
  /** 提取到的正文；提取失败时为 null */
  text: string | null;
  /** snippet=仅有摘要；retrieved=成功取得原文；user_supplied=用户粘贴 */
  status: "snippet" | "retrieved" | "user_supplied";
  retrievedAt: string;
};

/** 搜索/提取失败：retryable 决定是否可在预算内重试 1 次（7.2、F15） */
export class SearchError extends Error {
  constructor(
    public readonly code: "TIMEOUT" | "RATE_LIMITED" | "HTTP_ERROR" | "QUOTA_EXCEEDED" | "UNAUTHORIZED" | "UNKNOWN",
    message: string,
    public readonly retryable: boolean,
  ) {
    super(message);
  }
}

export interface SearchProvider {
  readonly provider: string;
  /** 失败抛 SearchError */
  search(args: { query: string; maxResults: number; signal?: AbortSignal }): Promise<SearchHit[]>;
  /** 只返回成功取得正文的文档（status=retrieved）；部分 URL 失败不抛错。整体失败抛 SearchError */
  extract(args: { urls: string[]; signal?: AbortSignal }): Promise<EvidenceDocument[]>;
}

export const DEFAULT_SEARCH_MAX_RESULTS = 5;
export const DEFAULT_EXTRACT_MAX_URLS = 6;
