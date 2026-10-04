import crypto from "node:crypto";
import type { ModelHttpGate } from "@/contracts/model";
import {
  MODEL_CAPABILITIES_PROBE_VERSION,
  MODEL_CAPABILITIES_SETTINGS_KEY,
  modelCapabilitiesSchema,
  type CapabilityKey,
  type ModelCapabilities,
  type ModelCapabilitiesView,
} from "@/contracts/model-capabilities";
import { getConfig, SUPPORTED_MODEL_PROTOCOLS, type AppConfig } from "@/config";
import { getSetting, updateSetting } from "@/repositories/settings";
import { isRestoredHold } from "@/repositories/instance";
import { endpointFingerprint, probeModelCapabilities } from "@/integrations/model-capabilities";
import { reserveRequest, settleRequest } from "@/workflows/ai-budget";
import { writeTrace } from "@/workflows/agent-trace";

/**
 * 模型能力的持久化与失效（Agent 方案 §6 P0）。
 * 只保存协议、端点指纹、模型、探测版本、时间与结论；不保存 key。配置变化或探测版本升级后旧结论失效。
 */

export const PROBE_WORKFLOW = "model_caps_probe";

function readStored(): { value: ModelCapabilities | null; version: number } {
  const { value, version } = getSetting(MODEL_CAPABILITIES_SETTINGS_KEY);
  const parsed = value ? modelCapabilitiesSchema.safeParse(value) : null;
  return { value: parsed?.success ? parsed.data : null, version };
}

function currentFingerprint(cfg: AppConfig): string | null {
  if (!cfg.MODEL_PROTOCOL || !SUPPORTED_MODEL_PROTOCOLS.includes(cfg.MODEL_PROTOCOL)) return null;
  if (!cfg.MODEL_ENDPOINT || !cfg.MODEL_NAME) return null;
  return endpointFingerprint(cfg.MODEL_PROTOCOL, cfg.MODEL_ENDPOINT, cfg.MODEL_NAME);
}

export function modelCapabilitiesView(cfg: AppConfig = getConfig()): ModelCapabilitiesView {
  const { value } = readStored();
  if (!value) return { state: "not_probed" };
  const fp = currentFingerprint(cfg);
  if (fp !== value.endpointFingerprint || value.probeVersion !== MODEL_CAPABILITIES_PROBE_VERSION) return { state: "stale", previous: value };
  return { state: "current", capabilities: value };
}

/** 与当前配置匹配的能力结论；没有或已失效时为 null（调用方按 unknown 走兼容路径） */
export function currentModelCapabilities(cfg: AppConfig = getConfig()): ModelCapabilities | null {
  try {
    const view = modelCapabilitiesView(cfg);
    return view.state === "current" ? view.capabilities : null;
  } catch {
    return null;
  }
}

export function saveModelCapabilities(c: ModelCapabilities): void {
  const value = modelCapabilitiesSchema.parse(c);
  for (let i = 0; i < 3; i++) {
    if (updateSetting(MODEL_CAPABILITIES_SETTINGS_KEY, value, readStored().version) !== "conflict") return;
  }
  throw new Error("保存模型能力时版本冲突");
}

export type ProbeOutcome =
  | { ok: true; capabilities: ModelCapabilities }
  | { ok: false; code: "INTEGRATION_UNAVAILABLE" | "RESTORED_HOLD"; message: string };

/** 实测并保存；每次 HTTP 都计入日额度（每项能力一个决策），并写一条脱敏 trace */
export async function runModelCapabilityProbe(opts: { fetchImpl?: typeof fetch; cfg?: AppConfig } = {}): Promise<ProbeOutcome> {
  const cfg = opts.cfg ?? getConfig();
  if (isRestoredHold()) return { ok: false, code: "RESTORED_HOLD", message: "从备份恢复后尚未恢复运行，不发起外部请求" };
  if (!currentFingerprint(cfg) || !cfg.MODEL_API_KEY) {
    return { ok: false, code: "INTEGRATION_UNAVAILABLE", message: "需要配置 MODEL_PROTOCOL=openai-chat、MODEL_ENDPOINT、MODEL_NAME 与 MODEL_API_KEY" };
  }
  const startedAt = Date.now();
  const related = { type: "model_caps_probe", id: crypto.randomUUID() };
  const decisions = new Map<CapabilityKey, string>();
  const requestIds: string[] = [];
  const exchanges: Array<{ requestId: string; attempt: number; ok: boolean; latencyMs: number; raw?: string; error?: string }> = [];
  const gateFor = (capability: CapabilityKey): ModelHttpGate => {
    if (!decisions.has(capability)) decisions.set(capability, crypto.randomUUID());
    const scope = { decisionId: decisions.get(capability)!, workflow: `${PROBE_WORKFLOW}.${capability}`, intakeId: null, related };
    let lastAttempt = 0;
    return {
      beforeRequest({ attempt }) {
        lastAttempt = attempt;
        const r = reserveRequest(scope, attempt);
        if (r.ok) requestIds.push(r.requestId);
        return r;
      },
      afterRequest(requestId, o) {
        settleRequest(requestId, o);
        exchanges.push({ requestId, attempt: lastAttempt, ok: o.ok, latencyMs: o.latencyMs, raw: o.rawText?.slice(0, 500), error: o.error });
      },
    };
  };
  const capabilities = await probeModelCapabilities(
    { endpoint: cfg.MODEL_ENDPOINT!, apiKey: cfg.MODEL_API_KEY, model: cfg.MODEL_NAME! },
    { fetchImpl: opts.fetchImpl, gateFor },
  );
  saveModelCapabilities(capabilities);
  writeTrace({
    workflow: PROBE_WORKFLOW,
    related,
    protocol: capabilities.protocol,
    model: capabilities.model,
    instructions: `probe-v${MODEL_CAPABILITIES_PROBE_VERSION}`,
    schemaVersion: MODEL_CAPABILITIES_PROBE_VERSION,
    status: capabilities.text === "supported" ? "ok" : "error",
    attempts: requestIds.length,
    requestIds,
    latencyMs: Date.now() - startedAt,
    request: { probe: ["text", "jsonSchema", "tools", "vision"] },
    response: capabilities,
    exchanges,
  });
  return { ok: true, capabilities };
}
