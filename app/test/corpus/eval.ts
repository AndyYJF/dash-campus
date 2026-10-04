import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { NextRequest } from "next/server";
import { getDb, closeDb } from "@/repositories/db";
import { resetConfigCache } from "@/config";
import { createSession, SESSION_COOKIE } from "@/domain/session";
import { setNowForTests } from "@/domain/clock";
import { setProvidersForTests } from "@/integrations";
import { OpenAIChatProvider } from "@/integrations/openai-chat";
import type { CapabilityState } from "@/contracts/model-capabilities";
import { READ_ONLY_INTENTS } from "@/domain/intent-catalog";
import { appendTurn, currentConversationId } from "@/repositories/conversations";
import { POST as postIntake } from "@/app/api/v2/intakes/route";
import { runDueJobsOnce } from "@/worker/runner";
import type { CorpusEntry } from "./schema";
import { fixtureFingerprint, resolveSelected, seedFixture } from "./fixtures";

/**
 * 语料评测（Agent 方案 §6 P3）：每条样本在种子库的独立副本上走真实投递管线，按期望核对结果。
 * - live：真实端点，按当前提示词推理；可同时录制每次 HTTP 的响应与“提示词指纹”。
 * - recorded：用录制的响应回放同一套协议/解析/绑定代码；提示词、工具、结构或种子指纹变了的样本标 stale，
 *   不冒充当前推理通过。录制只证明兼容，推理效果只看 live。
 * 只收合成语料与种子数据；录制只存响应正文与哈希，不存请求原文与凭证。
 */

export type ModelConfig = { endpoint: string; apiKey: string; model: string; jsonSchema?: CapabilityState; tools?: CapabilityState };
export type RecordedRequest = { prompt: string; status: number; body: unknown };
export type Recording = { id: string; text: string; requests: RecordedRequest[]; verdict: CaseStatus };
export type RecordingHeader = { kind: "header"; model: string; fixture: string; jsonSchema?: CapabilityState; tools?: CapabilityState; createdAt: string };
export type CaseStatus = "pass" | "fail" | "not_run" | "stale" | "error";
export type ObservedKind = "act" | "decide" | "ask" | "material" | "rejected" | "none";

export type CaseResult = {
  id: string;
  split: CorpusEntry["split"];
  tags: string[];
  text: string;
  expectKind: CorpusEntry["expect"]["kind"];
  status: CaseStatus;
  reasons: string[];
  observed: { kind: ObservedKind; ops: string[]; routedBy: string | null; questions: number; confirms?: number; writes: string[]; state: string; failed: number; errors: string[]; traceErrors?: string[]; routeTools?: string[] };
  requests: number;
  latencyMs: number;
  readOnlyViolation: boolean;
  clockRejection: boolean;
};

export type EvalOptions = {
  /** rules：不配置模型，只量规则快路径与降级（不发 HTTP） */
  mode: "live" | "recorded" | "rules";
  entries: CorpusEntry[];
  workDir: string;
  /** live：本次评测最多发出的 HTTP 请求数（含能力探测）；不足一份投递上限时剩余样本记 not_run */
  budget: number;
  model?: ModelConfig;
  recordings?: { header: RecordingHeader; cases: Map<string, Recording> };
  record?: boolean;
  onCase?: (r: CaseResult) => void;
};

/** 每份投递的请求上限（方案 §3.3）；剩余额度不够一份投递时不再开新样本 */
const PER_INTAKE_MAX = 10;
/** 只保存资料、不改业务事实的写入（资料原文、来源关联、通知待判断） */
const MATERIAL_ONLY_COMMANDS = new Set(["link_resource", "store_material", "save_resource", "upsert_notice_rule", "apply_notice"]);

const sha = (s: string) => crypto.createHash("sha256").update(s).digest("hex").slice(0, 16);

/** 一次请求的提示词指纹：系统提示 + 工具定义 + 结构化输出要求（不含随样本变化的上下文） */
export function promptFingerprint(body: string): string {
  const b = JSON.parse(body) as { messages?: Array<{ role: string; content: unknown }>; tools?: unknown; response_format?: unknown };
  return sha(JSON.stringify({ system: b.messages?.[0]?.content ?? null, tools: b.tools ?? null, format: b.response_format ?? null }));
}

function migrate(): void {
  const db = getDb();
  const dir = path.resolve(process.cwd(), "migrations");
  const files = fs.readdirSync(dir).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();
  db.transaction(() => {
    for (const f of files) {
      db.exec(fs.readFileSync(path.join(dir, f), "utf8"));
      db.prepare(`INSERT INTO schema_version (id, version, applied_at) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET version = excluded.version, applied_at = excluded.applied_at`).run(Number(f.slice(0, 4)), new Date().toISOString());
    }
  })();
}

export function switchDb(file: string): void {
  closeDb();
  process.env.DATABASE_PATH = file;
  resetConfigCache();
}

function removeDb(file: string): void {
  for (const f of [file, `${file}-wal`, `${file}-shm`]) fs.rmSync(f, { force: true });
}

/**
 * 种子模板库：迁移 + 种子，落盘后各样本复制使用。
 * 种子期间 UUID 按序生成：工具结果里的对象 ID 每次建库都相同，录制的模型响应引用这些 ID 时回放仍能绑定。
 */
export function buildTemplate(workDir: string, fixture = "week-basic"): string {
  fs.mkdirSync(workDir, { recursive: true });
  const file = path.join(workDir, `template-${fixture}.db`);
  removeDb(file);
  switchDb(file);
  migrate();
  const original = crypto.randomUUID;
  const originalGlobal = globalThis.crypto.randomUUID;
  let n = 0;
  const seeded = (() => `00000000-0000-4000-8000-${(++n).toString(16).padStart(12, "0")}`) as typeof crypto.randomUUID;
  crypto.randomUUID = seeded;
  globalThis.crypto.randomUUID = seeded;
  try {
    seedFixture(fixture);
  } finally {
    crypto.randomUUID = original;
    globalThis.crypto.randomUUID = originalGlobal;
  }
  getDb().pragma("wal_checkpoint(TRUNCATE)");
  closeDb();
  return file;
}

function businessWrites(intakeId: string): string[] {
  const rows = getDb().prepare(`SELECT command FROM agent_action_batches WHERE intake_id = ?`).all(intakeId) as Array<{ command: string }>;
  return rows.map((r) => r.command).filter((c) => !MATERIAL_ONLY_COMMANDS.has(c));
}

function observe(intakeId: string): CaseResult["observed"] {
  const db = getDb();
  const intake = db.prepare(`SELECT status FROM intakes WHERE id = ?`).get(intakeId) as { status: string } | undefined;
  const items = db.prepare(`SELECT kind, state, payload_json, evidence_json FROM intake_items WHERE intake_id = ?`).all(intakeId) as Array<{ kind: string; state: string; payload_json: string; evidence_json: string | null }>;
  const route = db.prepare(`SELECT content_text FROM extracted_documents WHERE intake_id = ? AND source_kind = 'owner-route'`).get(intakeId) as { content_text: string } | undefined;
  const questions = (db.prepare(`SELECT COUNT(*) AS n FROM clarification_questions WHERE intake_id = ? AND status = 'open'`).get(intakeId) as { n: number }).n;
  const confirms = (db.prepare(`SELECT COUNT(*) AS n FROM clarification_questions WHERE intake_id = ? AND status = 'open' AND purpose = 'confirm'`).get(intakeId) as { n: number }).n;
  const parsed = items.map((i) => ({ ...i, payload: JSON.parse(i.payload_json) as Record<string, unknown>, evidence: JSON.parse(i.evidence_json ?? "{}") as Record<string, unknown> }));
  const commands = parsed.filter((i) => i.kind === "command");
  // “先别做”在接收时确定性停止当前目标（P4），等同于取消进行中的投递
  const intentsOf = (p: Record<string, unknown>) => [
    ...((p.intents as Array<{ op: string }> | undefined) ?? []),
    ...(((p.pendingDecision as { intents?: Array<{ op: string }> } | undefined)?.intents) ?? []),
    ...(p.goalStop ? [{ op: "cancel_intake" }] : []),
  ];
  const ops = [...new Set(commands.flatMap((i) => intentsOf(i.payload).map((x) => x.op)))];
  // 路由给出的 act 等主人确认（pendingDecision、无 decisionText）仍是 act；decide 指走决策器的事项
  const isDecide = (p: Record<string, unknown>) => Boolean(p.decisionText || (p.needsDecision && !p.pendingDecision));
  let kind: ObservedKind;
  if (commands.some((i) => isDecide(i.payload))) kind = "decide";
  else if (commands.some((i) => intentsOf(i.payload).length)) kind = "act";
  else if (commands.some((i) => i.payload.routeAsk)) kind = "ask";
  else if (commands.length && commands.every((i) => i.state === "failed")) kind = parsed.length > commands.length ? "material" : "rejected";
  else if (parsed.length) kind = "material";
  else kind = "none";
  let routedBy: string | null = null;
  if (route) routedBy = (JSON.parse(route.content_text) as { routedBy?: string }).routedBy ?? null;
  else if (commands.some((i) => i.payload.routedBy === "fast")) routedBy = "fast";
  return {
    kind,
    ops,
    routedBy,
    questions,
    confirms,
    writes: businessWrites(intakeId),
    state: intake?.status ?? "missing",
    failed: parsed.filter((i) => i.state === "failed").length,
    errors: parsed.map((i) => String(i.evidence.error ?? "")).filter(Boolean).map((e) => e.slice(0, 160)),
    routeTools: (db.prepare(`SELECT tool_calls_json FROM agent_traces WHERE intake_id = ? AND workflow = 'agent_route' ORDER BY created_at`).all(intakeId) as Array<{ tool_calls_json: string }>).flatMap((t) => (JSON.parse(t.tool_calls_json) as Array<{ name: string; args?: unknown }>).map((c) => `${c.name}${JSON.stringify(c.args ?? {}).slice(0, 80)}`)),
    traceErrors: (db.prepare(`SELECT workflow, status, error_code, error, exchanges_json FROM agent_traces WHERE intake_id = ? AND status <> 'ok' ORDER BY created_at`).all(intakeId) as Array<{ workflow: string; status: string; error_code: string | null; error: string | null; exchanges_json: string }>).map((t) => {
      const last = (JSON.parse(t.exchanges_json) as Array<{ output?: unknown; raw?: unknown }>).at(-1);
      return `${t.workflow}:${t.status}:${t.error_code ?? ""}:${(t.error ?? "").slice(0, 200)} last=${JSON.stringify(last ?? null).slice(0, 600)}`;
    }),
  };
}

function intentsFor(intakeId: string): Array<Record<string, unknown>> {
  const rows = getDb().prepare(`SELECT payload_json FROM intake_items WHERE intake_id = ? AND kind = 'command'`).all(intakeId) as Array<{ payload_json: string }>;
  return rows.flatMap((r) => {
    const p = JSON.parse(r.payload_json) as { intents?: Array<Record<string, unknown>>; pendingDecision?: { intents?: Array<Record<string, unknown>> } };
    return [...(p.intents ?? []), ...(p.pendingDecision?.intents ?? [])];
  });
}

const readOnlyOp = (op: string) => (READ_ONLY_INTENTS as ReadonlySet<string>).has(op);

/** 按期望核对：查看零写入；kind、op（只读意图互通）与关键字段；allowAsk 时追问也算对 */
export function grade(entry: CorpusEntry, o: CaseResult["observed"], intents: Array<Record<string, unknown>>): { pass: boolean; reasons: string[]; readOnlyViolation: boolean; clockRejection: boolean } {
  const e = entry.expect;
  const reasons: string[] = [];
  const readOnlyViolation = e.readOnly && o.writes.length > 0;
  if (readOnlyViolation) reasons.push(`只读请求产生了写入：${o.writes.join(",")}`);
  const asked = o.questions > 0 || o.kind === "ask";
  const askOk = e.allowAsk && asked && o.writes.length === 0;
  const clockRejection = e.kind === "decide" && o.errors.some((x) => /钟点|几点|具体时间|具体时刻/.test(x));
  if (clockRejection) reasons.push("可行的模糊调整因缺钟点被拒绝");
  if (e.kind === "act") {
    if (!askOk) {
      if (o.kind !== "act") reasons.push(`期望 act，实际 ${o.kind}`);
      else {
        const allReadOnly = e.ops.every(readOnlyOp);
        const missing = e.readOnly && allReadOnly ? (o.ops.length && o.ops.every(readOnlyOp) ? [] : e.ops) : e.ops.filter((op) => !o.ops.includes(op));
        if (missing.length) reasons.push(`缺少意图 ${missing.join(",")}，实际 ${o.ops.join(",") || "无"}`);
        for (const [k, v] of Object.entries(e.fields)) {
          if (!intents.some((i) => JSON.stringify(i[k]) === JSON.stringify(v))) reasons.push(`字段 ${k} 期望 ${JSON.stringify(v)}`);
        }
      }
    }
  } else if (e.kind === "decide") {
    if (o.kind !== "decide" && !askOk) reasons.push(`期望 decide，实际 ${o.kind}`);
  } else if (e.kind === "ask") {
    if (!asked || o.writes.length) reasons.push(`期望追问，实际 ${o.kind}${o.writes.length ? "（有写入）" : ""}`);
  } else if (o.kind === "act" || o.kind === "decide") {
    if (!askOk) reasons.push(`期望资料，实际 ${o.kind}${o.ops.length ? `（${o.ops.join(",")}）` : ""}`);
  }
  return { pass: reasons.length === 0, reasons, readOnlyViolation, clockRejection };
}

type FetchLike = typeof fetch;

function recordingFetch(sink: RecordedRequest[]): FetchLike {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    let res: Response;
    try {
      res = await fetch(url, init);
    } catch (e) {
      // 网络层失败（超时/断连）也要录下：回放时同样抛出，请求次数与重试路径才对得上
      sink.push({ prompt: promptFingerprint(String(init?.body ?? "{}")), status: 0, body: e instanceof Error ? e.message : String(e) });
      throw e;
    }
    const text = await res.text();
    let body: unknown = text.slice(0, 2000);
    if (res.ok) {
      try {
        const j = JSON.parse(text) as { id?: string; choices?: Array<{ message?: unknown; finish_reason?: unknown }>; usage?: unknown };
        body = { id: j.id, choices: j.choices?.slice(0, 1).map((c) => ({ message: c.message, finish_reason: c.finish_reason })), usage: j.usage };
      } catch {
        // 原样保留前 2000 字
      }
    }
    sink.push({ prompt: promptFingerprint(String(init?.body ?? "{}")), status: res.status, body });
    return new Response(text, { status: res.status, headers: { "content-type": res.headers.get("content-type") ?? "application/json" } });
  }) as FetchLike;
}

function replayFetch(rec: Recording, stale: string[]): FetchLike {
  let n = 0;
  return (async (_url: string | URL | Request, init?: RequestInit) => {
    const r = rec.requests[n++];
    if (!r) {
      stale.push(`录制只有 ${rec.requests.length} 次请求，当前代码发出了更多`);
      return new Response(JSON.stringify({ error: "recording exhausted" }), { status: 599 });
    }
    const fp = promptFingerprint(String(init?.body ?? "{}"));
    if (fp !== r.prompt) stale.push(`第 ${n} 次请求的提示词/工具/结构与录制不同`);
    if (r.status === 0) throw new Error(String(r.body));
    return new Response(typeof r.body === "string" ? r.body : JSON.stringify(r.body), { status: r.status, headers: { "content-type": "application/json" } });
  }) as FetchLike;
}

async function submit(entry: CorpusEntry, session: { token: string; csrf: string }, seq: number): Promise<string> {
  const conversationId = currentConversationId(new Date(entry.now));
  for (const t of entry.turns) appendTurn({ conversationId, role: t.role, text: t.text });
  const sel = entry.selected ? resolveSelected(entry.selected) : null;
  const body = { text: entry.text, referenceDate: entry.referenceDate, conversationId, ...(sel?.ref ? { selectedEntityRef: sel.ref } : {}), ...(sel?.slot ? { slot: sel.slot } : {}) };
  const res = await postIntake(new NextRequest("http://localhost/api/v2/intakes", { method: "POST", headers: { cookie: `${SESSION_COOKIE}=${session.token}`, "x-csrf-token": session.csrf, "content-type": "application/json", "idempotency-key": `eval-${entry.id}-${seq}` }, body: JSON.stringify(body) }));
  if (res.status !== 202) throw new Error(`投递被拒 ${res.status}：${(await res.text()).slice(0, 200)}`);
  return ((await res.json()) as { intakeId: string }).intakeId;
}

export async function runEval(opts: EvalOptions): Promise<{ results: CaseResult[]; recordings: Recording[]; requestsUsed: number }> {
  const template = buildTemplate(opts.workDir);
  const results: CaseResult[] = [];
  const recordings: Recording[] = [];
  let used = 0;
  const fixture = fixtureFingerprint();
  const headerStale = opts.mode === "recorded" && opts.recordings && opts.recordings.header.fixture !== fixture ? "种子已变化" : null;
  for (const [i, entry] of opts.entries.entries()) {
    const base = { id: entry.id, split: entry.split, tags: entry.tags, text: entry.text, expectKind: entry.expect.kind };
    const empty: CaseResult["observed"] = { kind: "none", ops: [], routedBy: null, questions: 0, writes: [], state: "-", failed: 0, errors: [] };
    const rec = opts.recordings?.cases.get(entry.id);
    if (opts.mode === "live" && used + PER_INTAKE_MAX > opts.budget) {
      results.push({ ...base, status: "not_run", reasons: ["请求预算已用完"], observed: empty, requests: 0, latencyMs: 0, readOnlyViolation: false, clockRejection: false });
      continue;
    }
    if (opts.mode === "recorded" && (!rec || rec.text !== entry.text || headerStale)) {
      results.push({ ...base, status: "stale", reasons: [headerStale ?? (rec ? "语料原句已变化" : "没有录制")], observed: empty, requests: 0, latencyMs: 0, readOnlyViolation: false, clockRejection: false });
      continue;
    }
    const file = path.join(opts.workDir, `case-${entry.id}.db`);
    removeDb(file);
    fs.copyFileSync(template, file);
    switchDb(file);
    setNowForTests(new Date(entry.now));
    const sink: RecordedRequest[] = [];
    const stale: string[] = [];
    let calls = 0;
    if (opts.mode === "rules") setProvidersForTests({ model: null });
    else {
      const cfg: ModelConfig = opts.mode === "live" ? opts.model! : { endpoint: "https://recorded.invalid/v1", apiKey: "recorded", model: opts.recordings!.header.model, jsonSchema: opts.recordings!.header.jsonSchema, tools: opts.recordings!.header.tools };
      const fetchImpl = opts.mode === "live" ? recordingFetch(sink) : replayFetch(rec!, stale);
      const counted: FetchLike = (async (u: string | URL | Request, init?: RequestInit) => {
        calls++;
        return fetchImpl(u, init);
      }) as FetchLike;
      setProvidersForTests({ model: { mode: "real", provider: new OpenAIChatProvider(cfg, counted) } });
    }
    const started = Date.now();
    let result: CaseResult;
    try {
      const s = createSession(1);
      const intakeId = await submit(entry, { token: s.token, csrf: s.session.csrfToken }, i);
      for (let k = 0; k < 6; k++) await runDueJobsOnce();
      const observed = observe(intakeId);
      const g = grade(entry, observed, intentsFor(intakeId));
      const status: CaseStatus = stale.length ? "stale" : g.pass ? "pass" : "fail";
      result = { ...base, status, reasons: stale.length ? [...new Set(stale)] : g.reasons, observed, requests: calls, latencyMs: Date.now() - started, readOnlyViolation: g.readOnlyViolation, clockRejection: g.clockRejection };
    } catch (e) {
      result = { ...base, status: "error", reasons: [e instanceof Error ? e.message : String(e)], observed: empty, requests: calls, latencyMs: Date.now() - started, readOnlyViolation: false, clockRejection: false };
    } finally {
      setProvidersForTests({ model: undefined });
      closeDb();
      removeDb(file);
    }
    used += calls;
    if (opts.mode === "live" && opts.record) recordings.push({ id: entry.id, text: entry.text, requests: sink, verdict: result.status });
    results.push(result);
    opts.onCase?.(result);
  }
  setNowForTests(null);
  removeDb(template);
  return { results, recordings, requestsUsed: used };
}

function pct(n: number, d: number): string {
  return d ? `${((100 * n) / d).toFixed(1)}%` : "—";
}

function quantile(xs: number[], q: number): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))]!;
}

/** 汇总：分集准确率、按类别 precision/recall、意图/字段、追问/拒绝/完成比例、请求数与延迟 */
export function summarize(results: CaseResult[]) {
  const ran = results.filter((r) => r.status === "pass" || r.status === "fail");
  const bySplit = Object.fromEntries((["dev", "holdout"] as const).map((s) => {
    const rs = results.filter((r) => r.split === s);
    const done = rs.filter((r) => r.status === "pass" || r.status === "fail");
    return [s, { total: rs.length, ran: done.length, pass: done.filter((r) => r.status === "pass").length, accuracy: pct(done.filter((r) => r.status === "pass").length, done.length), notRun: rs.filter((r) => r.status === "not_run").length, stale: rs.filter((r) => r.status === "stale").length, error: rs.filter((r) => r.status === "error").length }];
  }));
  const kinds = ["act", "decide", "ask", "material"] as const;
  const perKind = Object.fromEntries(kinds.map((k) => {
    const predicted = ran.filter((r) => r.observed.kind === k || (k === "ask" && r.observed.kind !== "act" && r.observed.questions > 0 && r.observed.kind !== "decide"));
    const actual = ran.filter((r) => r.expectKind === k);
    const tp = actual.filter((r) => predicted.includes(r)).length;
    return [k, { expected: actual.length, predicted: predicted.length, precision: pct(tp, predicted.length), recall: pct(tp, actual.length) }];
  }));
  const confusion: Record<string, Record<string, number>> = {};
  for (const r of ran) {
    confusion[r.expectKind] ??= {};
    confusion[r.expectKind]![r.observed.kind] = (confusion[r.expectKind]![r.observed.kind] ?? 0) + 1;
  }
  const actRan = ran.filter((r) => r.expectKind === "act" && r.observed.kind === "act");
  const lat = ran.map((r) => r.latencyMs);
  return {
    bySplit,
    perKind,
    confusion,
    intentAccuracy: pct(actRan.filter((r) => !r.reasons.some((x) => x.startsWith("缺少意图"))).length, actRan.length),
    fieldAccuracy: pct(actRan.filter((r) => !r.reasons.some((x) => x.startsWith("字段"))).length, actRan.length),
    askRate: pct(ran.filter((r) => r.observed.questions > 0).length, ran.length),
    confirmRate: pct(ran.filter((r) => (r.observed.confirms ?? 0) > 0).length, ran.length),
    rejectRate: pct(ran.filter((r) => r.observed.kind === "rejected").length, ran.length),
    completedRate: pct(ran.filter((r) => ["applied", "answered", "no_change"].includes(r.observed.state)).length, ran.length),
    partialRate: pct(ran.filter((r) => r.observed.state === "partially_applied").length, ran.length),
    routedBy: ran.reduce<Record<string, number>>((m, r) => ((m[r.observed.routedBy ?? "none"] = (m[r.observed.routedBy ?? "none"] ?? 0) + 1), m), {}),
    readOnlyViolations: results.filter((r) => r.readOnlyViolation).map((r) => r.id),
    clockRejections: results.filter((r) => r.clockRejection).map((r) => r.id),
    avgRequests: ran.length ? +(ran.reduce((s, r) => s + r.requests, 0) / ran.length).toFixed(2) : 0,
    latencyP50: quantile(lat, 0.5),
    latencyP95: quantile(lat, 0.95),
    failures: results.filter((r) => r.status === "fail" || r.status === "error").map((r) => ({ id: r.id, text: r.text, reasons: r.reasons, observed: `${r.observed.kind}/${r.observed.ops.join(",")}/${r.observed.routedBy ?? "-"}` })),
  };
}

export function loadRecordings(file: string): EvalOptions["recordings"] | undefined {
  if (!fs.existsSync(file)) return undefined;
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/).filter((l) => l.trim()).map((l) => JSON.parse(l) as RecordingHeader | Recording);
  const header = lines.find((l): l is RecordingHeader => (l as RecordingHeader).kind === "header");
  if (!header) return undefined;
  return { header, cases: new Map(lines.filter((l): l is Recording => (l as RecordingHeader).kind !== "header").map((r) => [r.id, r])) };
}

/** 合并写回录制：新录的覆盖同 id 旧录制；模型或种子变化时整份重写 */
export function saveRecordings(file: string, header: RecordingHeader, fresh: Recording[]): void {
  const old = loadRecordings(file);
  const keep = old && old.header.model === header.model && old.header.fixture === header.fixture ? old.cases : new Map<string, Recording>();
  for (const r of fresh) keep.set(r.id, r);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const ordered = [...keep.values()].sort((a, b) => a.id.localeCompare(b.id));
  fs.writeFileSync(file, [JSON.stringify(header), ...ordered.map((r) => JSON.stringify(r))].join("\n") + "\n");
}
