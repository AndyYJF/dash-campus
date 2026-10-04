import { z } from "zod";

/**
 * 模型端点能力（Agent 方案 §6 P0）：实测结果，不把声明当验证。
 * unknown 表示没测出结论（超时、网络、5xx、鉴权失败等），不是“不支持”。
 * 端点指纹 = 协议 + 端点 + 模型的摘要（不含 key）；配置变化后旧结果失效，需重探。
 */

export const MODEL_CAPABILITIES_SETTINGS_KEY = "modelCapabilities";
export const MODEL_CAPABILITIES_PROBE_VERSION = 1;

export const capabilityStateSchema = z.enum(["supported", "unsupported", "unknown"]);
export type CapabilityState = z.infer<typeof capabilityStateSchema>;

export const CAPABILITY_KEYS = ["text", "tools", "jsonSchema", "vision"] as const;
export type CapabilityKey = (typeof CAPABILITY_KEYS)[number];

export const modelCapabilitiesSchema = z.object({
  probeVersion: z.number().int(),
  protocol: z.string(),
  model: z.string(),
  endpointFingerprint: z.string(),
  probedAt: z.string(),
  text: capabilityStateSchema,
  tools: capabilityStateSchema,
  jsonSchema: capabilityStateSchema,
  vision: capabilityStateSchema,
  /** 每项能力的简短诊断（HTTP 状态、截断后的错误片段），不含 key 与请求原文 */
  details: z.record(z.string(), z.string().max(300)).default({}),
});
export type ModelCapabilities = z.infer<typeof modelCapabilitiesSchema>;

/** 设置页展示：stale 表示存有旧结果但配置已变化或探测版本过期 */
export type ModelCapabilitiesView =
  | { state: "not_probed" }
  | { state: "stale"; previous: ModelCapabilities }
  | { state: "current"; capabilities: ModelCapabilities };
