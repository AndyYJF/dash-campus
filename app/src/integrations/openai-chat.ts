import type { ModelProvider, ModelRequest, ModelResult, ToolSpec } from "@/contracts/model";
import type { CapabilityState } from "@/contracts/model-capabilities";
import { completeWithSchema, completeWithTools, type ChatMessage, type RawCallResult, type ToolCall } from "@/integrations/model-json";
import { toProviderJsonSchema } from "@/integrations/json-schema";

export type { ToolSpec };

/**
 * OpenAI 兼容 Chat Completions 适配器（MODEL_PROTOCOL=openai-chat）。
 * MODEL_ENDPOINT 为 base URL（如 https://api.example.com/v1），自动补 /chat/completions；
 * 已以 /chat/completions 结尾时原样使用。
 * 结构化输出按已探测能力选择：jsonSchema=supported 时发 json_schema，否则 json_object（兼容路径）。
 * 工具消息（tools / tool_calls / role=tool）由 rawExchange 支持，只在能力探测为 supported 时由上层使用。
 */

export function chatCompletionsUrl(endpoint: string): string {
  const base = endpoint.replace(/\/+$/, "");
  return base.endsWith("/chat/completions") ? base : `${base}/chat/completions`;
}

export type ExchangeOptions = {
  responseFormat?: Record<string, unknown> | null;
  tools?: ToolSpec[];
  toolChoice?: "auto" | "none" | "required" | { type: "function"; function: { name: string } };
  temperature?: number;
};

export class OpenAIChatProvider implements ModelProvider {
  readonly protocol = "openai-chat";
  readonly toolRouting = true;

  constructor(
    private readonly cfg: { endpoint: string; apiKey: string; model: string; jsonSchema?: CapabilityState; tools?: CapabilityState },
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  call(request: ModelRequest): Promise<ModelResult> {
    if (request.tools) {
      // 原生 tool_calls 只在探测确认支持时使用；否则走 JSON next-tool 兼容协议。工具轮不发 response_format，终结轮只要求 JSON 对象：
      // 意图是几十个分支的大联合，按 json_schema 约束解码时真实端点会偏到第一个分支（inspect），丢掉前几轮已经形成的判断
      return completeWithTools(
        request,
        (messages, o) => this.rawExchange(messages, request, { responseFormat: o.final ? { type: "json_object" } : null, tools: o.tools, toolChoice: o.toolChoice }),
        this.cfg.tools === "supported",
      );
    }
    return completeWithSchema(request, (messages) => this.rawExchange(messages, request, { responseFormat: this.responseFormat(request) }));
  }

  /** 结构化输出格式：只有探测确认支持时才发 json_schema */
  responseFormat(request: ModelRequest): Record<string, unknown> {
    if (this.cfg.jsonSchema === "supported") {
      const js = toProviderJsonSchema(request.workflow, request.schema);
      if (js) return { type: "json_schema", json_schema: js };
    }
    return { type: "json_object" };
  }

  async rawExchange(
    messages: ChatMessage[],
    request: Pick<ModelRequest, "timeoutMs" | "signal">,
    options: ExchangeOptions = {},
  ): Promise<RawCallResult> {
    if (request.signal?.aborted) {
      return { ok: false, code: "TIMEOUT", message: "已中断（预算或租约）", retryable: false, notSent: true };
    }
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
          temperature: options.temperature ?? 0.2,
          ...(options.responseFormat ? { response_format: options.responseFormat } : {}),
          ...(options.tools?.length ? { tools: options.tools, tool_choice: options.toolChoice ?? "auto" } : {}),
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
        choices?: Array<{ message?: { content?: string | null; tool_calls?: ToolCall[] } }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      const message = body.choices?.[0]?.message;
      const text = message?.content;
      const toolCalls = Array.isArray(message?.tool_calls) && message.tool_calls.length ? message.tool_calls : undefined;
      if ((typeof text !== "string" || !text.trim()) && !toolCalls) {
        return { ok: false, code: "UNKNOWN", message: "模型响应没有文本内容", retryable: false };
      }
      return {
        ok: true,
        text: typeof text === "string" ? text : "",
        toolCalls,
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
