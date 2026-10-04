import crypto from "node:crypto";
import { getDb } from "@/repositories/db";
import { getConfig } from "@/config";
import { instanceTimezone, localDateInTz } from "@/domain/time";

/**
 * 模型决策的脱敏诊断记录（Agent 方案 §6 P0、§8）。
 * - 不记录授权头、key、base64 图片（换成 sha256+字节数）或隐藏思维链；文本整体封顶 20k 字符并标截断。
 * - 是诊断资料，不保证完整回放；不入业务导出；30 天 TTL，删除 trace 不影响正式业务记录。
 */

export const TRACE_TEXT_LIMIT = 20_000;
export const TRACE_TTL_DAYS = 30;
export const FEEDBACK_TTL_DAYS = 90;
/** 请求账目只用于日/单投递计数；保留期覆盖等待主人回答的投递 */
export const REQUEST_LEDGER_TTL_DAYS = 90;

const SECRET_PATTERN = /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{8,}|Bearer\s+[A-Za-z0-9._~+/=-]{8,}/g;

export function promptVersion(instructions: string): string {
  return crypto.createHash("sha256").update(instructions).digest("hex").slice(0, 12);
}

function redactString(s: string, secrets: string[]): string {
  const data = /^data:([\w/+.-]+);base64,([\s\S]*)$/.exec(s);
  if (data) {
    const bytes = Buffer.from(data[2]!, "base64");
    return `[${data[1]} sha256=${crypto.createHash("sha256").update(bytes).digest("hex").slice(0, 16)} bytes=${bytes.length}]`;
  }
  let out = s.replace(SECRET_PATTERN, "[redacted]");
  for (const secret of secrets) if (secret.length >= 6) out = out.split(secret).join("[redacted]");
  return out;
}

/** 递归脱敏：图片 data URL、key 形态的字符串与已配置的 key 值 */
export function redact(value: unknown, secrets: string[] = configuredSecrets()): unknown {
  if (typeof value === "string") return redactString(value, secrets);
  if (Array.isArray(value)) return value.map((v) => redact(v, secrets));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (/^(authorization|api[_-]?key|apikey|password|token)$/i.test(k)) out[k] = "[redacted]";
      else out[k] = redact(v, secrets);
    }
    return out;
  }
  return value;
}

function configuredSecrets(): string[] {
  const cfg = getConfig();
  return [cfg.MODEL_API_KEY, cfg.TAVILY_API_KEY, cfg.SMTP_PASSWORD].filter((s): s is string => Boolean(s));
}

/** 脱敏后序列化并封顶；超出时保留开头并标 truncated */
export function capJson(value: unknown, limit = TRACE_TEXT_LIMIT): { text: string; truncated: boolean } {
  const text = JSON.stringify(redact(value)) ?? "null";
  if (text.length <= limit) return { text, truncated: false };
  return { text: JSON.stringify({ truncated: true, chars: text.length, head: text.slice(0, limit - 100) }), truncated: true };
}

export type TraceStatus = "ok" | "schema_invalid" | "error" | "budget" | "timeout";

export type TraceInput = {
  workflow: string;
  routedBy?: "model" | "rules" | "fast" | null;
  intakeId?: string | null;
  itemId?: string | null;
  conversationId?: string | null;
  goalId?: string | null;
  related?: { type: string; id: string } | null;
  protocol: string;
  model: string | null;
  instructions: string;
  schemaVersion: number;
  status: TraceStatus;
  errorCode?: string | null;
  error?: string | null;
  attempts: number;
  requestIds: string[];
  latencyMs: number;
  request: unknown;
  response: unknown;
  exchanges: Array<{ requestId: string; attempt: number; ok: boolean; latencyMs: number; raw?: string; error?: string }>;
  toolCalls?: Array<{ name: string; args: unknown; resultDigest: string; chars: number; round?: number; ok?: boolean; truncated?: boolean; observationId?: string | null }>;
};

/** 写一条 trace；诊断写入失败不影响业务结果 */
export function writeTrace(t: TraceInput): string | null {
  try {
    const id = crypto.randomUUID();
    const now = new Date();
    const req = capJson(t.request);
    const res = t.response === undefined ? null : capJson(t.response);
    const exchanges = capJson(t.exchanges.map((e) => ({ ...e, raw: e.raw === undefined ? undefined : e.raw.slice(0, 4000) })));
    const tools = capJson(t.toolCalls ?? []);
    getDb()
      .prepare(
        `INSERT INTO agent_traces (id, created_at, local_date, workflow, routed_by, intake_id, item_id, conversation_id, goal_id,
           related_type, related_id, protocol, model, prompt_version, schema_version, status, error_code, error, attempts,
           request_ids_json, latency_ms, request_json, response_json, exchanges_json, tool_calls_json, truncated)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        now.toISOString(),
        localDateInTz(now, instanceTimezone()),
        t.workflow,
        t.routedBy ?? null,
        t.intakeId ?? null,
        t.itemId ?? null,
        t.conversationId ?? null,
        t.goalId ?? null,
        t.related?.type ?? null,
        t.related?.id ?? null,
        t.protocol,
        t.model,
        promptVersion(t.instructions),
        t.schemaVersion,
        t.status,
        t.errorCode ?? null,
        t.error ? redactString(t.error, configuredSecrets()).slice(0, 1000) : null,
        t.attempts,
        JSON.stringify(t.requestIds),
        t.latencyMs,
        req.text,
        res?.text ?? null,
        exchanges.text,
        tools.text,
        req.truncated || res?.truncated || exchanges.truncated || tools.truncated ? 1 : 0,
      );
    return id;
  } catch {
    return null;
  }
}

/** worker 每趟清理：trace 30 天、反馈 90 天、请求账目 90 天 */
export function sweepAgentDiagnostics(now: Date = new Date()): { traces: number; feedback: number; ledger: number } {
  const db = getDb();
  const before = (days: number) => new Date(now.getTime() - days * 86_400_000).toISOString();
  return {
    traces: db.prepare(`DELETE FROM agent_traces WHERE created_at < ?`).run(before(TRACE_TTL_DAYS)).changes,
    feedback: db.prepare(`DELETE FROM agent_feedback WHERE created_at < ?`).run(before(FEEDBACK_TTL_DAYS)).changes,
    ledger: db.prepare(`DELETE FROM ai_request_ledger WHERE created_at < ?`).run(before(REQUEST_LEDGER_TTL_DAYS)).changes,
  };
}
