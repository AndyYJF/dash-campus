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
  /** 实际 HTTP 请求闸门（由 meteredModel 注入）：每次发请求前原子占用额度，结束后结算 */
  gate?: ModelHttpGate;
  /** 有界只读工具：provider 走工具循环（原生 tool_calls 或 JSON next-tool 兼容协议） */
  tools?: ToolRuntime;
}

/** 每次模型决策最多 4 次 HTTP（首次、工具后续、结构修复与重试合计） */
export const MAX_REQUESTS_PER_DECISION = 4;
/** 工具循环最多 3 轮；第 4 次请求必须终结，不再申请工具 */
export const TOOL_MAX_ROUNDS = 3;
export const TOOL_MAX_CALLS_PER_ROUND = 5;

export type ToolSpec = { type: "function"; function: { name: string; description: string; parameters: Record<string, unknown> } };

export type ToolRunResult = { content: string; ok: boolean; observationId?: string | null; truncated?: boolean };

export interface ToolRuntime {
  specs: ToolSpec[];
  /** 服务端只读执行；不抛错，未知工具/非法参数返回 ok=false 的说明 */
  run(name: string, args: unknown): ToolRunResult;
}

export type ToolCallRecord = { round: number; name: string; args: unknown; ok: boolean; chars: number; truncated: boolean; observationId: string | null; resultDigest: string };

export type HttpReservation = { ok: true; requestId: string } | { ok: false; message: string };

export interface ModelHttpGate {
  /** 每次实际 HTTP 请求发出前调用；拒绝时不得发出请求 */
  beforeRequest(info: { attempt: number }): HttpReservation;
  /** 请求结束后调用；sent=false 仅用于确认没有发出的情况（释放预留） */
  afterRequest(
    requestId: string,
    outcome: { sent: boolean; ok: boolean; latencyMs: number; rawText?: string; error?: string },
  ): void;
}

export type ModelSuccess = {
  ok: true;
  validatedResult: unknown;
  usage?: { inputTokens?: number; outputTokens?: number };
  providerRequestId?: string;
  /** 实际发出的请求数（含结构修复）；缺省为 1 */
  attempts?: number;
  toolCalls?: ToolCallRecord[];
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
      | "BUDGET_EXCEEDED"
      | "UNKNOWN";
    message: string;
    retryable: boolean;
  };
  attempts?: number;
  toolCalls?: ToolCallRecord[];
};

export type ModelResult = ModelSuccess | ModelFailure;

export interface ModelProvider {
  readonly protocol: string;
  /** 支持带只读工具的模型路由；不支持的 provider 只走规则与分类通路 */
  readonly toolRouting?: boolean;
  call(request: ModelRequest): Promise<ModelResult>;
}

/** 每个 workflow 绑定一个输出 schema；fake 与真实 provider 共用 */
export type WorkflowSchemaRegistry = Map<
  ModelWorkflow,
  { outputSchemaVersion: number; schema: z.ZodType }
>;

export const DEFAULT_MODEL_TIMEOUT_MS = 45_000;
