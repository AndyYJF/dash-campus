import type { ModelProvider } from "@/contracts/model";
import type { SearchProvider } from "@/contracts/search";
import { getConfig, SUPPORTED_MODEL_PROTOCOLS } from "@/config";
import { OpenAIChatProvider } from "@/integrations/openai-chat";
import { TavilySearchProvider } from "@/integrations/tavily";
import { fixtureModelProvider, fixtureSearchProvider } from "@/integrations/fixtures";
import { currentModelCapabilities } from "@/workflows/model-capabilities";

/**
 * provider 工厂。真实协议：模型 openai-chat、搜索 tavily。
 * "fake" 只用于本地 fixture，结果标记 integration_mode=fixture，不冒充真实联网。
 * 未配置返回 null，调用方报 503 INTEGRATION_UNAVAILABLE 或降级为"仅粘贴资料"。
 */

export type Resolved<T> = { provider: T; mode: "real" | "fixture" } | null;

let modelOverride: Resolved<ModelProvider> | undefined;
let searchOverride: Resolved<SearchProvider> | undefined;

/** 测试注入；传 undefined 清除 */
export function setProvidersForTests(p: {
  model?: Resolved<ModelProvider>;
  search?: Resolved<SearchProvider>;
}): void {
  modelOverride = p.model;
  searchOverride = p.search;
}

export function resolveModelProvider(): Resolved<ModelProvider> {
  if (modelOverride !== undefined) return modelOverride;
  const cfg = getConfig();
  if (!cfg.MODEL_PROTOCOL) return null;
  if (cfg.MODEL_PROTOCOL === "fake") return { provider: fixtureModelProvider(), mode: "fixture" };
  if (!SUPPORTED_MODEL_PROTOCOLS.includes(cfg.MODEL_PROTOCOL)) return null;
  if (!cfg.MODEL_ENDPOINT || !cfg.MODEL_API_KEY || !cfg.MODEL_NAME) return null;
  return {
    provider: new OpenAIChatProvider({
      endpoint: cfg.MODEL_ENDPOINT,
      apiKey: cfg.MODEL_API_KEY,
      model: cfg.MODEL_NAME,
      // 协议分支按实测能力：未探测或配置已变化时为 undefined，走 json_object 兼容路径
      jsonSchema: currentModelCapabilities(cfg)?.jsonSchema,
    }),
    mode: "real",
  };
}

export function resolveSearchProvider(): Resolved<SearchProvider> {
  if (searchOverride !== undefined) return searchOverride;
  const cfg = getConfig();
  if (cfg.SEARCH_PROVIDER === "fake") return { provider: fixtureSearchProvider(), mode: "fixture" };
  if (cfg.SEARCH_PROVIDER === "tavily" && cfg.TAVILY_API_KEY) {
    return { provider: new TavilySearchProvider(cfg.TAVILY_API_KEY), mode: "real" };
  }
  return null;
}
