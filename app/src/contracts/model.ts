import { z } from "zod";

/**
 * ModelProvider 窄接口（计划 v1.2 第 3 节）。
 * 输入输出全部由 Zod 校验，绝不返回未校验的可执行操作。
 */

export type ModelWorkflow = string;

export interface ModelRequest {
  workflow: ModelWorkflow;
  /** 已脱敏的上下文载荷，结构由具体 workflow 的 schema 决定 */
  context: unknown;
  /** 期望输出的 schema 版本号 */
  outputSchemaVersion: number;
  timeoutMs: number;
  /** workflow 的固定指令（系统提示）；上下文里的外部文本只作数据，不作指令 */
  instructions: string;
  /** 输出 schema：provider 用它校验并最多修复 1 次（7.2） */
  schema: z.ZodType;
  signal?: AbortSignal;
}

export type ModelSuccess = {
  ok: true;
  validatedResult: unknown;
  usage?: { inputTokens?: number; outputTokens?: number };
  providerRequestId?: string;
  /** 实际发出的请求数（含结构修复）；缺省为 1 */
  attempts?: number;
};

export type ModelFailure = {
  ok: false;
  error: {
    code:
      | "NOT_CONFIGURED"
      | "TIMEOUT"
      | "PROTOCOL_UNSUPPORTED"
      | "HTTP_ERROR"
      | "SCHEMA_INVALID"
      | "UNKNOWN";
    message: string;
    retryable: boolean;
  };
  attempts?: number;
};

export type ModelResult = ModelSuccess | ModelFailure;

export interface ModelProvider {
  readonly protocol: string;
  call(request: ModelRequest): Promise<ModelResult>;
}

/** 每个 workflow 绑定一个输出 schema；fake 与真实 provider 共用 */
export type WorkflowSchemaRegistry = Map<
  ModelWorkflow,
  { outputSchemaVersion: number; schema: z.ZodType }
>;

export const DEFAULT_MODEL_TIMEOUT_MS = 45_000;
