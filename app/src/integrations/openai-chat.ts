import type { ModelProvider, ModelRequest, ModelResult } from "@/contracts/model";
import { completeWithSchema, type ChatMessage, type RawCallResult } from "@/integrations/model-json";

/**
 * OpenAI 兼容 Chat Completions 适配器（MODEL_PROTOCOL=openai-chat）。
 * MODEL_ENDPOINT 为 base URL（如 https://api.example.com/v1），自动补 /chat/completions；
 * 已以 /chat/completions 结尾时原样使用。只用 JSON 输出，不假定支持联网或工具调用。
 */

export function chatCompletionsUrl(endpoint: string): string {
  const base = endpoint.replace(/\/+$/, "");
  return base.endsWith("/chat/completions") ? base : `${base}/chat/completions`;
}

export class OpenAIChatProvider implements ModelProvider {
  readonly protocol = "openai-chat";

  constructor(
    private readonly cfg: { endpoint: string; apiKey: string; model: string },
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  call(request: ModelRequest): Promise<ModelResult> {
    return completeWithSchema(request, (messages) => this.raw(messages, request));
  }

  private async raw(messages: ChatMessage[], request: ModelRequest): Promise<RawCallResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), request.timeoutMs);
    const onOuterAbort = () => controller.abort();
    request.signal?.addEventListener("abort", onOuterAbort);
    try {
      const res = await this.fetchImpl(chatCompletionsUrl(this.cfg.endpoint), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.cfg.apiKey}`,
        },
        body: JSON.stringify({
          model: this.cfg.model,
          messages,
          temperature: 0.2,
          response_format: { type: "json_object" },
        }),
        signal: controller.signal,
      });
      if (!res.ok) {
        // 不回显响应体全文：可能含请求片段；只取错误信息的前 200 字
        const detail = (await res.text().catch(() => "")).slice(0, 200);
        return {
          ok: false,
          code: "HTTP_ERROR",
          message: `模型接口返回 ${res.status}${detail ? `：${detail}` : ""}`,
          retryable: res.status === 429 || res.status >= 500,
        };
      }
      const body = (await res.json()) as {
        id?: string;
        choices?: Array<{ message?: { content?: string | null } }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      const text = body.choices?.[0]?.message?.content;
      if (typeof text !== "string" || !text.trim()) {
        return { ok: false, code: "UNKNOWN", message: "模型响应没有文本内容", retryable: false };
      }
      return {
        ok: true,
        text,
        requestId: body.id,
        usage: body.usage
          ? { inputTokens: body.usage.prompt_tokens, outputTokens: body.usage.completion_tokens }
          : undefined,
      };
    } catch (e) {
      if (controller.signal.aborted) {
        return {
          ok: false,
          code: "TIMEOUT",
          message: request.signal?.aborted ? "已中断（预算或租约）" : `模型请求超时（${request.timeoutMs}ms）`,
          retryable: !request.signal?.aborted,
        };
      }
      return { ok: false, code: "UNKNOWN", message: e instanceof Error ? e.message : String(e), retryable: true };
    } finally {
      clearTimeout(timer);
      request.signal?.removeEventListener("abort", onOuterAbort);
    }
  }
}
