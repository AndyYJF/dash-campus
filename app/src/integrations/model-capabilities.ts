import crypto from "node:crypto";
import zlib from "node:zlib";
import type { ModelHttpGate } from "@/contracts/model";
import {
  MODEL_CAPABILITIES_PROBE_VERSION,
  type CapabilityKey,
  type CapabilityState,
  type ModelCapabilities,
} from "@/contracts/model-capabilities";
import { gatedCall, type ChatMessage, type RawCallResult } from "@/integrations/model-json";
import { chatCompletionsUrl, OpenAIChatProvider, type ExchangeOptions } from "@/integrations/openai-chat";

/**
 * 实测 OpenAI 兼容端点的能力（Agent 方案 §6 P0）：文本基准、strict json_schema、工具调用（含 role=tool 回填）、图片输入。
 * 判定规则：
 * - 文本基准失败 → 全部 unknown（鉴权/网络问题不能推出“不支持”）。
 * - 基准成功后，同一端点对能力参数返回 400/404/415/422 → unsupported；接受参数但输出不符合 → unsupported 并记原因。
 * - 超时、网络错误、401/403/429/5xx → unknown。
 * 每次 HTTP 都经 gate 计入额度；不打印、不保存 key。
 */

export type ProbeTarget = { endpoint: string; apiKey: string; model: string };

export function endpointFingerprint(protocol: string, endpoint: string, model: string): string {
  return crypto.createHash("sha256").update(`${protocol}|${chatCompletionsUrl(endpoint)}|${model}`).digest("hex").slice(0, 16);
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** 16×16 纯红 PNG（部分端点拒收 1×1 图片） */
export function redPngDataUrl(size = 16): string {
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(size * 3, Buffer.from([255, 0, 0]))]);
  const raw = Buffer.concat(Array.from({ length: size }, () => row));
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolor
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
  return `data:image/png;base64,${png.toString("base64")}`;
}

function httpStatus(raw: RawCallResult): number | null {
  if (raw.ok) return null;
  const m = /返回 (\d{3})/.exec(raw.message);
  return m ? Number(m[1]) : null;
}

/** 失败的能力请求：参数被拒 → unsupported；其他（含额度）→ unknown */
function failureState(raw: RawCallResult | { ok: false; code: "BUDGET_EXCEEDED"; message: string }): CapabilityState {
  if (raw.ok || raw.code === "BUDGET_EXCEEDED") return "unknown";
  const status = httpStatus(raw);
  return status !== null && [400, 404, 415, 422].includes(status) ? "unsupported" : "unknown";
}

function describe(raw: RawCallResult | { ok: false; code: "BUDGET_EXCEEDED"; message: string }): string {
  return raw.ok ? "ok" : `${raw.code}: ${raw.message}`.slice(0, 300);
}

const JSON_PROBE_FORMAT = {
  type: "json_schema",
  json_schema: {
    name: "capability_probe",
    strict: true,
    schema: { type: "object", properties: { answer: { type: "string", enum: ["ok"] } }, required: ["answer"], additionalProperties: false },
  },
};

const ECHO_TOOL = {
  type: "function" as const,
  function: {
    name: "echo_probe",
    description: "能力探测：原样回传 value",
    parameters: { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false },
  },
};

export async function probeModelCapabilities(
  target: ProbeTarget,
  opts: { fetchImpl?: typeof fetch; gateFor?: (capability: CapabilityKey) => ModelHttpGate | undefined; timeoutMs?: number; now?: Date } = {},
): Promise<ModelCapabilities> {
  const provider = new OpenAIChatProvider({ endpoint: target.endpoint, apiKey: target.apiKey, model: target.model }, opts.fetchImpl ?? fetch);
  const timeoutMs = opts.timeoutMs ?? 45_000;
  const exchange = (capability: CapabilityKey, attempt: number, messages: ChatMessage[], options: ExchangeOptions) =>
    gatedCall({ gate: opts.gateFor?.(capability) }, attempt, () => provider.rawExchange(messages, { timeoutMs }, { temperature: 0, ...options }));

  const details: Record<string, string> = {};
  const result: ModelCapabilities = {
    probeVersion: MODEL_CAPABILITIES_PROBE_VERSION,
    protocol: provider.protocol,
    model: target.model,
    endpointFingerprint: endpointFingerprint(provider.protocol, target.endpoint, target.model),
    probedAt: (opts.now ?? new Date()).toISOString(),
    text: "unknown",
    tools: "unknown",
    jsonSchema: "unknown",
    vision: "unknown",
    details,
  };

  const text = await exchange("text", 0, [{ role: "user", content: "只回答两个字：正常" }], { responseFormat: null });
  if (!text.ok) {
    details.text = describe(text);
    details.note = "文本基准请求没有成功，其余能力未测（unknown 不是“不支持”）";
    return result;
  }
  result.text = "supported";

  const json = await exchange("jsonSchema", 0, [{ role: "user", content: '输出 JSON：{"answer":"ok"}' }], { responseFormat: JSON_PROBE_FORMAT });
  if (!json.ok) {
    result.jsonSchema = failureState(json);
    details.jsonSchema = describe(json);
  } else {
    let answer: unknown;
    try {
      answer = (JSON.parse(json.text) as { answer?: unknown }).answer;
    } catch {
      answer = undefined;
    }
    result.jsonSchema = answer === "ok" ? "supported" : "unsupported";
    if (answer !== "ok") details.jsonSchema = `端点接受了 json_schema 参数但输出不符合：${json.text.slice(0, 200)}`;
  }

  const user: ChatMessage = { role: "user", content: "请调用 echo_probe 工具，value 填 ok。" };
  const call = await exchange("tools", 0, [user], { responseFormat: null, tools: [ECHO_TOOL], toolChoice: "required" });
  const toolCall = call.ok ? call.toolCalls?.find((c) => c.function?.name === "echo_probe") : undefined;
  if (!call.ok) {
    result.tools = failureState(call);
    details.tools = describe(call);
  } else if (!toolCall) {
    result.tools = "unsupported";
    details.tools = "端点接受了 tools 参数但没有返回 tool_calls";
  } else {
    let argsOk = false;
    try {
      argsOk = typeof JSON.parse(toolCall.function.arguments) === "object";
    } catch {
      argsOk = false;
    }
    // 回填 role=tool 消息：P2 的多轮只读工具循环依赖这一步
    const followUp = await exchange("tools", 1, [
      user,
      { role: "assistant", content: null, tool_calls: [toolCall] },
      { role: "tool", tool_call_id: toolCall.id, content: JSON.stringify({ value: "ok", echo: "pong-7341" }) },
    ], { responseFormat: null, tools: [ECHO_TOOL], toolChoice: "none" });
    if (!followUp.ok) {
      result.tools = failureState(followUp);
      details.tools = `tool 结果回填失败：${describe(followUp)}`;
    } else if (!argsOk) {
      result.tools = "unsupported";
      details.tools = "tool_calls 的 arguments 不是合法 JSON";
    } else {
      result.tools = "supported";
      if (!followUp.text.includes("pong-7341")) details.tools = "回填被接受，但最终回答未引用工具结果（仍判为支持）";
    }
  }

  const vision = await exchange("vision", 0, [
    {
      role: "user",
      content: [
        { type: "text", text: "这张图片主要是什么颜色？只回答颜色名。" },
        { type: "image_url", image_url: { url: redPngDataUrl() } },
      ],
    },
  ], { responseFormat: null });
  if (!vision.ok) {
    result.vision = failureState(vision);
    details.vision = describe(vision);
  } else if (/红|red/i.test(vision.text)) {
    result.vision = "supported";
  } else {
    result.vision = "unknown";
    details.vision = `端点接受了图片但回答不符：${vision.text.slice(0, 120)}`;
  }
  return result;
}
