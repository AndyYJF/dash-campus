import type { ModelProvider, ModelRequest, ModelResult } from "@/contracts/model";

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
