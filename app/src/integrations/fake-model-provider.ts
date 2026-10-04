import type { ModelProvider, ModelRequest, ModelResult } from "@/contracts/model";
import { completeWithSchema, completeWithTools, type ChatMessage, type RawCallResult, type ToolExchangeOptions } from "@/integrations/model-json";

/**
 * 本地开发的假模型 provider。
 * 仅用于未配置真实模型时的 fixture 工作流；不得冒充真实模型调用。
 */

export class FakeModelProvider implements ModelProvider {
  readonly protocol = "fake";

  constructor(private readonly responder: (req: ModelRequest) => ModelResult) {}

  call(request: ModelRequest): Promise<ModelResult> {
    return Promise.resolve(this.responder(request));
  }
}

/** 常用：对任何请求返回固定 fixture 结果 */
export function constantResponder(result: ModelResult) {
  return () => result;
}

export type ScriptedExchange = { workflow: string; messages: ChatMessage[]; options: ToolExchangeOptions };

/**
 * 按原始往返回放的假 provider：经过与真实适配器相同的结构修复、工具循环与额度闸门，
 * 只把“发 HTTP”换成脚本。native=false 时模拟 JSON next-tool 兼容协议。
 */
export class ScriptedChatProvider implements ModelProvider {
  readonly protocol = "fake";
  readonly toolRouting = true;
  readonly exchanges: ScriptedExchange[] = [];

  constructor(
    private readonly script: (req: ModelRequest, messages: ChatMessage[], options: ToolExchangeOptions) => RawCallResult | Promise<RawCallResult>,
    private readonly native = true,
  ) {}

  call(request: ModelRequest): Promise<ModelResult> {
    const raw = async (messages: ChatMessage[], options: ToolExchangeOptions) => {
      this.exchanges.push({ workflow: request.workflow, messages: structuredClone(messages), options });
      return this.script(request, messages, options);
    };
    return request.tools ? completeWithTools(request, raw, this.native) : completeWithSchema(request, (m) => raw(m, { final: true }));
  }
}
