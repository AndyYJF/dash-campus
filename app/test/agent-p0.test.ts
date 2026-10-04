import assert from "node:assert/strict";
import { before, beforeEach, test } from "node:test";
import { z } from "zod";
import { migrateAll, getDb } from "./helpers";
import { resetConfigCache } from "@/config";
import type { ModelProvider, ModelRequest } from "@/contracts/model";
import { AI_BUDGET_SETTINGS_KEY, aiBudgetSchema } from "@/contracts/review";
import { MODEL_CAPABILITIES_SETTINGS_KEY } from "@/contracts/model-capabilities";
import { getSetting, updateSetting } from "@/repositories/settings";
import { setProvidersForTests } from "@/integrations";
import { OpenAIChatProvider } from "@/integrations/openai-chat";
import { toProviderJsonSchema } from "@/integrations/json-schema";
import { probeModelCapabilities, redPngDataUrl } from "@/integrations/model-capabilities";
import {
  getAiBudget,
  intakeBudgetCheck,
  intakeRequestUsage,
  meteredModel,
  reserveRequest,
  saveAiBudget,
  savedDailyBelowDefault,
  settleRequest,
  usageToday,
} from "@/workflows/ai-budget";
import { capJson, sweepAgentDiagnostics } from "@/workflows/agent-trace";
import { currentModelCapabilities, modelCapabilitiesView, runModelCapabilityProbe } from "@/workflows/model-capabilities";
import { receiveIntake } from "@/workflows/intake";
import { runDueJobsOnce } from "@/worker/runner";
import { listItems } from "@/repositories/intakes";
import { INTAKE_JOB_TYPE } from "@/contracts/intake";
import { NOTICE_EXTRACTION_JOB_TYPE } from "@/contracts/notice-extraction";

/**
 * Agent 方案 P0（§3.3、§6 P0）隔离行为：请求级持久预算、脱敏 trace、结构化输出协议、能力探测。
 * 模型全部是假件或假 fetch；不证明真实端点能力。
 */

const SECRET = "test-model-secret-9f8e7d6c";
process.env.MODEL_API_KEY = SECRET;

const schema = z.object({ answer: z.string() });

function req(extra: Partial<ModelRequest> = {}): ModelRequest {
  return { workflow: "p0.test", context: { text: "你好" }, outputSchemaVersion: 1, timeoutMs: 5000, instructions: "测试指令", schema, ...extra };
}

/** OpenAI 兼容假端点：按调用序号返回内容 */
function fakeEndpoint(replies: Array<string | ((body: Record<string, unknown>) => Response | Promise<Response>)>) {
  const bodies: Array<Record<string, unknown>> = [];
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    bodies.push(body);
    const reply = replies[Math.min(bodies.length - 1, replies.length - 1)]!;
    if (typeof reply === "function") return reply(body);
    return new Response(JSON.stringify({ id: `r${bodies.length}`, choices: [{ message: { content: reply } }], usage: { prompt_tokens: 3, completion_tokens: 2 } }), { status: 200 });
  }) as unknown as typeof fetch;
  return { fetchImpl, bodies };
}

function setDailyLimit(n: number, perIntake?: number) {
  const { budget, version } = getAiBudget();
  assert.notEqual(saveAiBudget({ ...budget, dailyModelCalls: n, ...(perIntake ? { perIntakeModelRequests: perIntake } : {}) }, version), "conflict");
}

function ledger(where = "1=1", ...params: unknown[]) {
  return getDb().prepare(`SELECT * FROM ai_request_ledger WHERE ${where} ORDER BY created_at`).all(...params) as Array<{ id: string; status: string; intake_id: string | null; decision_id: string; duration_ms: number | null }>;
}

function traces() {
  return getDb().prepare(`SELECT * FROM agent_traces ORDER BY created_at`).all() as Array<Record<string, string | number | null>>;
}

before(() => {
  resetConfigCache();
  migrateAll();
});

beforeEach(() => {
  setDailyLimit(1000, 10);
});

test("预算默认值：新实例日额度 150、单投递 10；已保存的旧设置不被覆盖并提示可上调", () => {
  assert.deepEqual([aiBudgetSchema.parse({}).dailyModelCalls, aiBudgetSchema.parse({}).perIntakeModelRequests], [150, 10]);
  const { version } = getSetting(AI_BUDGET_SETTINGS_KEY);
  assert.notEqual(updateSetting(AI_BUDGET_SETTINGS_KEY, { dailyModelCalls: 40, dailySearchCalls: 30, scheduledEnabled: true, weeklyReview: null }, version), "conflict");
  assert.equal(getAiBudget().budget.dailyModelCalls, 40, "旧设置保留");
  assert.equal(getAiBudget().budget.perIntakeModelRequests, 10, "新字段取默认");
  assert.equal(savedDailyBelowDefault(), true);
  setDailyLimit(1000);
  assert.equal(savedDailyBelowDefault(), false);
});

test("结构修复按实际 HTTP 计数：两次请求各占一条账目，ai_usage 两条，trace 一条", async () => {
  const before = usageToday().modelCalls;
  const { fetchImpl } = fakeEndpoint(["不是 JSON", '{"answer":"好"}']);
  const p = meteredModel(new OpenAIChatProvider({ endpoint: "https://x/v1", apiKey: SECRET, model: "m" }, fetchImpl), { type: "unit", id: "a" });
  const traceCount = traces().length;
  const r = await p.call(req());
  assert.ok(r.ok);
  assert.equal(r.attempts, 2);
  assert.equal(usageToday().modelCalls, before + 2);
  const t = traces().slice(traceCount);
  assert.equal(t.length, 1);
  assert.equal(t[0]!.status, "ok");
  assert.equal(t[0]!.attempts, 2);
  assert.equal(JSON.parse(String(t[0]!.request_ids_json)).length, 2);
  const rows = ledger("id IN (SELECT value FROM json_each(?))", t[0]!.request_ids_json);
  assert.deepEqual(rows.map((x) => x.status).sort(), ["ok", "ok"]);
});

test("最后一次结构修复也受硬额度约束：额度只剩 1 次时不发第二次请求", async () => {
  setDailyLimit(usageToday().modelCalls + 1);
  const { fetchImpl, bodies } = fakeEndpoint(["不是 JSON", '{"answer":"好"}']);
  const p = meteredModel(new OpenAIChatProvider({ endpoint: "https://x/v1", apiKey: SECRET, model: "m" }, fetchImpl));
  const r = await p.call(req());
  assert.ok(!r.ok);
  assert.equal(r.error.code, "BUDGET_EXCEEDED");
  assert.equal(bodies.length, 1, "第二次请求没有发出");
  assert.equal(usageToday().modelCalls, getAiBudget().budget.dailyModelCalls, "用量恰好等于上限，不超出");
  assert.equal(traces().at(-1)!.status, "budget");
});

test("并发请求不超额：额度剩 3 次时 6 个并发决策只有 3 个发出", async () => {
  setDailyLimit(usageToday().modelCalls + 3);
  const { fetchImpl, bodies } = fakeEndpoint([
    async () => {
      await new Promise((r) => setTimeout(r, 20));
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"answer":"ok"}' } }] }), { status: 200 });
    },
  ]);
  const p = meteredModel(new OpenAIChatProvider({ endpoint: "https://x/v1", apiKey: SECRET, model: "m" }, fetchImpl));
  const results = await Promise.all(Array.from({ length: 6 }, () => p.call(req())));
  assert.equal(results.filter((r) => r.ok).length, 3);
  assert.equal(results.filter((r) => !r.ok && r.error.code === "BUDGET_EXCEEDED").length, 3);
  assert.equal(bodies.length, 3);
  assert.equal(usageToday().modelCalls, getAiBudget().budget.dailyModelCalls);
});

test("单次决策最多 4 次 HTTP：第 5 次被闸门拒绝", async () => {
  let sent = 0;
  const looping: ModelProvider = {
    protocol: "openai-chat",
    async call(r) {
      for (let attempt = 0; attempt < 6; attempt++) {
        const g = r.gate!.beforeRequest({ attempt });
        if (!g.ok) return { ok: false, error: { code: "BUDGET_EXCEEDED", message: g.message, retryable: false }, attempts: attempt };
        sent++;
        r.gate!.afterRequest(g.requestId, { sent: true, ok: true, latencyMs: 1 });
      }
      return { ok: true, validatedResult: { answer: "x" }, attempts: 6 };
    },
  };
  const r = await meteredModel(looping).call(req());
  assert.ok(!r.ok);
  assert.match(r.error.message, /最多 4 次/);
  assert.equal(sent, 4);
});

test("单投递额度持久化：上限 2 时第 3 次被拒；换新的包装实例（模拟重启/恢复）仍不重置", async () => {
  setDailyLimit(1000, 2);
  let calls = 0;
  const fake: ModelProvider = { protocol: "fake", async call() { calls++; return { ok: true, validatedResult: { answer: "x" } }; } };
  const intake = { type: "intake", id: "intake-persist-1" };
  assert.ok((await meteredModel(fake, intake).call(req())).ok);
  assert.ok((await meteredModel(fake, intake).call(req())).ok);
  const third = await meteredModel(fake, intake).call(req());
  assert.ok(!third.ok && third.error.code === "BUDGET_EXCEEDED");
  assert.match(third.error.message, /单次处理的模型请求额度/);
  assert.equal(calls, 2, "被拒时不调用 provider");
  assert.equal(intakeRequestUsage("intake-persist-1").requests, 2);
  assert.equal(intakeBudgetCheck("intake-persist-1").ok, false);
});

test("单投递累计执行时间 180 秒：账目耗时累计到上限后拒绝", () => {
  const r = reserveRequest({ decisionId: "d-time", workflow: "w", intakeId: "intake-time-1", related: null }, 0);
  assert.ok(r.ok);
  settleRequest(r.requestId, { sent: true, ok: true, latencyMs: 180_000 });
  const check = intakeBudgetCheck("intake-time-1");
  assert.ok(!check.ok);
  assert.match(check.message, /180 秒/);
});

test("占用与结算：崩溃遗留的预留照常计数；确认未发出才释放；重复结算不改结果", async () => {
  const before = usageToday().modelCalls;
  const orphan = reserveRequest({ decisionId: "d-orphan", workflow: "w", intakeId: null, related: null }, 0);
  assert.ok(orphan.ok);
  assert.equal(usageToday().modelCalls, before + 1, "未结算（进程中断）的预留保留占用");
  settleRequest(orphan.requestId, { sent: true, ok: false, latencyMs: 10 });
  settleRequest(orphan.requestId, { sent: false, ok: false, latencyMs: 0 });
  assert.equal(ledger("id = ?", orphan.requestId)[0]!.status, "error", "第二次结算被忽略");

  // 发起前已中断：请求确认没有发出 → 释放
  const controller = new AbortController();
  controller.abort();
  const { fetchImpl, bodies } = fakeEndpoint(['{"answer":"x"}']);
  const p = meteredModel(new OpenAIChatProvider({ endpoint: "https://x/v1", apiKey: SECRET, model: "m" }, fetchImpl));
  const r = await p.call(req({ signal: controller.signal }));
  assert.ok(!r.ok);
  assert.equal(bodies.length, 0);
  assert.equal(usageToday().modelCalls, before + 1, "未发出的请求不占额度");
});

test("不经闸门的假件按报告的 attempts 记账", async () => {
  const before = usageToday().modelCalls;
  const fake: ModelProvider = { protocol: "fake", async call() { return { ok: true, validatedResult: { answer: "x" }, attempts: 2 }; } };
  assert.ok((await meteredModel(fake).call(req())).ok);
  assert.equal(usageToday().modelCalls, before + 2);
});

test("trace 脱敏：不含 key、base64 图片；图片换成摘要；超长标截断；超额也有记录", async () => {
  const image = redPngDataUrl();
  const { fetchImpl } = fakeEndpoint(['{"answer":"好"}']);
  const p = meteredModel(new OpenAIChatProvider({ endpoint: "https://x/v1", apiKey: SECRET, model: "m" }, fetchImpl), { type: "intake", id: "intake-trace-1" }, { itemId: "item-1", conversationId: "conv-1" });
  const r = await p.call(req({ context: { text: `我的密钥是 ${SECRET}，另一个 sk-abcdefghijklmnop`, images: [image], apiKey: "plain" } }));
  assert.ok(r.ok);
  const t = traces().at(-1)!;
  const all = JSON.stringify(t);
  assert.equal(all.includes(SECRET), false);
  assert.equal(all.includes("sk-abcdefghijklmnop"), false);
  assert.equal(all.includes(image.slice(30, 80)), false, "base64 不入 trace");
  assert.match(String(t.request_json), /image\/png sha256=[0-9a-f]{16} bytes=\d+/);
  assert.deepEqual([t.intake_id, t.item_id, t.conversation_id], ["intake-trace-1", "item-1", "conv-1"]);
  assert.match(String(t.prompt_version), /^[0-9a-f]{12}$/);

  const big = capJson({ text: "长".repeat(30_000) });
  assert.equal(big.truncated, true);
  assert.ok(big.text.length <= 20_000);

  setDailyLimit(usageToday().modelCalls);
  let called = false;
  const denied = await meteredModel({ protocol: "fake", async call() { called = true; return { ok: true, validatedResult: {} }; } }).call(req());
  assert.ok(!denied.ok && denied.error.code === "BUDGET_EXCEEDED");
  assert.equal(called, false);
  assert.equal(traces().at(-1)!.status, "budget");
  assert.equal(traces().at(-1)!.attempts, 0);
});

test("TTL：trace 30 天、反馈 90 天后由 worker 清理", () => {
  const db = getDb();
  const old = new Date(Date.now() - 31 * 86_400_000).toISOString();
  db.prepare(`UPDATE agent_traces SET created_at = ? WHERE id = (SELECT id FROM agent_traces LIMIT 1)`).run(old);
  db.prepare(`INSERT INTO agent_feedback (id, created_at, intake_id, owner_text, routed_json, verdict) VALUES ('f-new', ?, 'i', 't', '{}', 'other'), ('f-old', ?, 'i', 't', '{}', 'other')`).run(old, new Date(Date.now() - 91 * 86_400_000).toISOString());
  const n = sweepAgentDiagnostics();
  assert.equal(n.traces, 1);
  assert.equal(n.feedback, 1);
  assert.deepEqual((db.prepare(`SELECT id FROM agent_feedback`).all() as Array<{ id: string }>).map((r) => r.id), ["f-new"]);
});

test("结构化输出：strict 子集判定；jsonSchema=supported 才发 json_schema，否则 json_object", async () => {
  const strictOk = toProviderJsonSchema("route.v1", z.object({ a: z.string(), b: z.array(z.object({ c: z.number() })) }));
  assert.equal(strictOk?.strict, true);
  assert.equal(strictOk?.name, "route_v1");
  assert.equal((strictOk?.schema as { additionalProperties?: unknown }).additionalProperties, false);
  assert.equal(toProviderJsonSchema("w", z.object({ a: z.string().optional() }))?.strict, false);
  assert.equal(toProviderJsonSchema("w", z.object({ a: z.string().default("x") }))?.strict, false);

  const on = fakeEndpoint(['{"answer":"好"}']);
  await new OpenAIChatProvider({ endpoint: "https://x/v1", apiKey: "k", model: "m", jsonSchema: "supported" }, on.fetchImpl).call(req());
  const rf = on.bodies[0]!.response_format as { type: string; json_schema: { strict: boolean; schema: unknown } };
  assert.equal(rf.type, "json_schema");
  assert.equal(rf.json_schema.strict, true);

  for (const state of [undefined, "unknown", "unsupported"] as const) {
    const off = fakeEndpoint(['{"answer":"好"}']);
    await new OpenAIChatProvider({ endpoint: "https://x/v1", apiKey: "k", model: "m", jsonSchema: state }, off.fetchImpl).call(req());
    assert.deepEqual(off.bodies[0]!.response_format, { type: "json_object" });
  }
});

/** 能力探测用的假端点：按请求参数分别模拟各项能力 */
function capabilityEndpoint(opts: { text?: number; jsonSchema?: "ok" | "reject" | "ignore"; tools?: "ok" | "ignore" | "reject" | "timeout"; vision?: "ok" | "reject" }) {
  const seen: string[] = [];
  const reply = (content: string | null, extra: Record<string, unknown> = {}) =>
    new Response(JSON.stringify({ id: "x", choices: [{ message: { content, ...extra } }] }), { status: 200 });
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    const auth = (init.headers as Record<string, string>).authorization;
    assert.equal(auth, `Bearer ${SECRET}`);
    const body = JSON.parse(init.body as string) as { messages: Array<{ role: string; content: unknown }>; response_format?: { type: string }; tools?: unknown[]; tool_choice?: unknown };
    const last = body.messages.at(-1)!;
    if (body.response_format?.type === "json_schema") {
      seen.push("jsonSchema");
      if (opts.jsonSchema === "reject") return new Response("response_format json_schema not supported", { status: 400 });
      return reply(opts.jsonSchema === "ignore" ? "ok" : '{"answer":"ok"}');
    }
    if (body.tools) {
      seen.push(last.role === "tool" ? "tool-followup" : "tools");
      if (opts.tools === "reject") return new Response("tools not supported", { status: 400 });
      if (opts.tools === "timeout") throw new TypeError("fetch failed");
      if (last.role === "tool") return reply("工具返回 pong-7341");
      if (opts.tools === "ignore") return reply("好的");
      return reply(null, { tool_calls: [{ id: "call_1", type: "function", function: { name: "echo_probe", arguments: '{"value":"ok"}' } }] });
    }
    if (Array.isArray(last.content)) {
      seen.push("vision");
      if (opts.vision === "reject") return new Response("image input not supported", { status: 400 });
      return reply("红色");
    }
    seen.push("text");
    if (opts.text && opts.text !== 200) return new Response("unauthorized", { status: opts.text });
    return reply("正常");
  }) as unknown as typeof fetch;
  return { fetchImpl, seen };
}

const TARGET = { endpoint: "https://probe.example/v1", apiKey: SECRET, model: "probe-model" };

test("能力探测：全部支持（含 role=tool 回填）；结果不含 key", async () => {
  const { fetchImpl, seen } = capabilityEndpoint({ jsonSchema: "ok", tools: "ok", vision: "ok" });
  const c = await probeModelCapabilities(TARGET, { fetchImpl });
  assert.deepEqual([c.text, c.jsonSchema, c.tools, c.vision], ["supported", "supported", "supported", "supported"]);
  assert.deepEqual(seen, ["text", "jsonSchema", "tools", "tool-followup", "vision"]);
  assert.equal(JSON.stringify(c).includes(SECRET), false);
  assert.match(c.endpointFingerprint, /^[0-9a-f]{16}$/);
});

test("能力探测：参数被拒/被忽略 → unsupported；网络失败 → unknown；基准失败 → 全部 unknown", async () => {
  const a = await probeModelCapabilities(TARGET, { fetchImpl: capabilityEndpoint({ jsonSchema: "reject", tools: "ignore", vision: "reject" }).fetchImpl });
  assert.deepEqual([a.jsonSchema, a.tools, a.vision], ["unsupported", "unsupported", "unsupported"]);
  assert.match(a.details.tools!, /没有返回 tool_calls/);

  const b = await probeModelCapabilities(TARGET, { fetchImpl: capabilityEndpoint({ jsonSchema: "ignore", tools: "timeout", vision: "ok" }).fetchImpl });
  assert.deepEqual([b.jsonSchema, b.tools, b.vision], ["unsupported", "unknown", "supported"]);

  const probe = capabilityEndpoint({ text: 401 });
  const c = await probeModelCapabilities(TARGET, { fetchImpl: probe.fetchImpl });
  assert.deepEqual([c.text, c.jsonSchema, c.tools, c.vision], ["unknown", "unknown", "unknown", "unknown"]);
  assert.deepEqual(probe.seen, ["text"], "基准失败后不再继续探测");
  assert.match(c.details.note!, /不是“不支持”/);
});

test("能力持久化：探测计入额度并写 trace；配置变化后结论失效；settings 不含 key", async () => {
  process.env.MODEL_PROTOCOL = "openai-chat";
  process.env.MODEL_ENDPOINT = TARGET.endpoint;
  process.env.MODEL_NAME = TARGET.model;
  resetConfigCache();
  try {
    assert.equal(modelCapabilitiesView().state, "not_probed");
    const before = usageToday().modelCalls;
    const traceCount = traces().length;
    const r = await runModelCapabilityProbe({ fetchImpl: capabilityEndpoint({ jsonSchema: "ok", tools: "ok", vision: "ok" }).fetchImpl });
    assert.ok(r.ok);
    assert.equal(usageToday().modelCalls, before + 5, "5 次 HTTP 都计入日额度");
    assert.equal(traces().length, traceCount + 1);
    assert.equal(currentModelCapabilities()?.jsonSchema, "supported");
    assert.equal(JSON.stringify(getSetting(MODEL_CAPABILITIES_SETTINGS_KEY).value).includes(SECRET), false);

    process.env.MODEL_NAME = "another-model";
    resetConfigCache();
    assert.equal(modelCapabilitiesView().state, "stale");
    assert.equal(currentModelCapabilities(), null, "配置变化后不再使用旧结论");

    setDailyLimit(usageToday().modelCalls);
    const denied = await runModelCapabilityProbe({ fetchImpl: capabilityEndpoint({}).fetchImpl });
    assert.ok(denied.ok);
    assert.equal(denied.capabilities.text, "unknown", "额度不足时不发请求，结论为 unknown 而不是不支持");
  } finally {
    delete process.env.MODEL_PROTOCOL;
    delete process.env.MODEL_ENDPOINT;
    delete process.env.MODEL_NAME;
    resetConfigCache();
  }
});

test("投递管线按持久账目计数：单投递上限 1 时分类后不再做通知提取，原文保留并说明额度", async () => {
  setDailyLimit(1000, 1);
  let calls = 0;
  setProvidersForTests({
    model: {
      mode: "fixture",
      provider: {
        protocol: "fake",
        async call(r) {
          calls++;
          if (r.workflow === INTAKE_JOB_TYPE) {
            const text = (r.context as { text: string }).text;
            return { ok: true, validatedResult: { items: [{ itemKey: "notice-1", kind: "notice", summary: "讲座通知", excerpt: text.slice(0, 20) }] } };
          }
          assert.notEqual(r.workflow, NOTICE_EXTRACTION_JOB_TYPE, "额度用完后不应再调用提取");
          return { ok: false, error: { code: "PROTOCOL_UNSUPPORTED", message: "x", retryable: false } };
        },
      },
    },
  });
  const { intakeId } = receiveIntake({ channel: "web", text: "学院通知：本周五下午在图书馆举办讲座，欢迎参加。" });
  await runDueJobsOnce();
  assert.equal(calls, 1);
  assert.equal(intakeRequestUsage(intakeId).requests, 1);
  const notice = listItems(intakeId).find((i) => i.kind === "notice")!;
  assert.match(String((notice.payload.notice as { reason: string }).reason), /BUDGET_EXCEEDED：这份投递已用完单次处理的模型请求额度/);
  setProvidersForTests({});
});
