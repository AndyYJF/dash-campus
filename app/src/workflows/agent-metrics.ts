import { getDb } from "@/repositories/db";
import { addDays, instanceTimezone, localDateInTz } from "@/domain/time";

/**
 * 七天试用只读指标卡（Agent 方案 §6 P6）：只从已有记录聚合，不写任何表、不调模型。
 * 样本小或数据缺失时如实给出，不为好看隐藏失败；比例在样本为 0 时为 null。
 */
export type TrialMetrics = {
  window: { from: string; to: string; days: number; timezone: string };
  /** 主人在统一栏的投递（channel=web） */
  intakes: number;
  routing: { model: number; rules: number; fast: number; other: number; fallbackReasons: Array<{ reason: string; n: number }> };
  asking: { intakesAsked: number; rate: number | null; byPurpose: Array<{ purpose: string; n: number }> };
  feedback: { total: number; byVerdict: Array<{ verdict: string; n: number }> };
  outcomes: { verified: number; partial: number; needs_action: number; blocked: number; pending: number; unverified: number; failed: number; cancelled: number };
  repairs: { total: number; intakes: number; stoppedByLimit: number };
  /**
   * 每条投递经历过哪些环节（同一条可以同时计入多项，不是互斥分类）：
   * 理解失败（模型没给出可用理解、降级到规则）、追问、确认、范围/保护拒绝（统一门）、确认后事实变化重问、
   * 执行失败（门以外的失败）、异步等待（最后一轮核验在等任务）、核验通过、部分完成、自动修正、主人改口（目标新修订）。
   */
  stages: { understandFailed: number; clarified: number; confirmed: number; scopeRejected: number; staleReconfirmed: number; execFailed: number; asyncWaiting: number; verified: number; partial: number; repaired: number; ownerCorrected: number };
  /** 每条投递的模型 HTTP 累计耗时（ai_request_ledger.duration_ms 之和）；不含排队、工具查询、业务写入与等待主人 */
  modelTime: { p50Ms: number | null; p95Ms: number | null; maxMs: number | null };
  /** 每条投递的主动执行时间（intakes.active_ms：模型、查询、执行、核验与修正，不含排队和等主人）；samples 是有记录的投递数，旧投递没有记录不计入 */
  activeTime: { p50Ms: number | null; p95Ms: number | null; maxMs: number | null; samples: number };
  daily: Array<{ date: string; requests: number; errors: number; decisions: number; p50Ms: number | null; p95Ms: number | null }>;
  notes: string[];
};

const SMALL_SAMPLE = 20;

function percentile(sorted: number[], p: number): number | null {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]!;
}

function counts<T extends string>(values: T[]): Array<{ key: T; n: number }> {
  const m = new Map<T, number>();
  for (const v of values) m.set(v, (m.get(v) ?? 0) + 1);
  return [...m.entries()].map(([key, n]) => ({ key, n })).sort((a, b) => b.n - a.n);
}

export function trialMetrics(opts: { days?: number; now?: Date } = {}): TrialMetrics {
  const db = getDb();
  const days = Math.min(30, Math.max(1, Math.trunc(opts.days ?? 7)));
  const tz = instanceTimezone();
  const to = localDateInTz(opts.now ?? new Date(), tz);
  const from = addDays(to, -(days - 1));
  const intakes = db.prepare(`SELECT id, status FROM intakes WHERE channel = 'web' AND reference_date BETWEEN ? AND ?`).all(from, to) as Array<{ id: string; status: string }>;
  const ids = intakes.map((i) => i.id);
  const inIds = (sql: string) => (ids.length ? db.prepare(sql.replace("(?)", `(${ids.map(() => "?").join(",")})`)).all(...ids) : []);

  const routeDocs = new Map<string, { routedBy?: string; fallbackReason?: string }>();
  for (const d of inIds(`SELECT intake_id, content_text FROM extracted_documents WHERE source_kind = 'owner-route' AND intake_id IN (?) ORDER BY created_at`) as Array<{ intake_id: string; content_text: string }>) {
    try {
      routeDocs.set(d.intake_id, JSON.parse(d.content_text));
    } catch {
      routeDocs.set(d.intake_id, {});
    }
  }
  const fastIntakes = new Set((inIds(`SELECT DISTINCT intake_id FROM intake_items WHERE json_extract(payload_json, '$.routedBy') = 'fast' AND intake_id IN (?)`) as Array<{ intake_id: string }>).map((r) => r.intake_id));
  const routing = { model: 0, rules: 0, fast: 0, other: 0 };
  const reasons: string[] = [];
  for (const id of ids) {
    const doc = routeDocs.get(id);
    if (doc?.routedBy === "model") routing.model++;
    else if (doc?.routedBy === "rules") {
      routing.rules++;
      reasons.push((doc.fallbackReason ?? "未注明").slice(0, 60));
    } else if (fastIntakes.has(id)) routing.fast++;
    else routing.other++;
  }

  const questions = inIds(`SELECT intake_id, purpose FROM clarification_questions WHERE intake_id IN (?)`) as Array<{ intake_id: string; purpose: string }>;
  const asked = new Set(questions.map((q) => q.intake_id));

  const feedback = db.prepare(`SELECT f.verdict FROM agent_feedback f JOIN intakes i ON i.id = f.intake_id WHERE i.channel = 'web' AND i.reference_date BETWEEN ? AND ?`).all(from, to) as Array<{ verdict: string }>;

  const rounds = inIds(`SELECT intake_id, round, status, checks_json, repair_json FROM agent_verifications WHERE intake_id IN (?) ORDER BY intake_id, round`) as Array<{ intake_id: string; round: number; status: string; checks_json: string; repair_json: string | null }>;
  const last = new Map<string, (typeof rounds)[number]>();
  for (const r of rounds) last.set(r.intake_id, r);
  const outcomes = { verified: 0, partial: 0, needs_action: 0, blocked: 0, pending: 0, unverified: 0, failed: 0, cancelled: 0 };
  for (const i of intakes) {
    if (i.status === "failed") outcomes.failed++;
    else if (i.status === "cancelled") outcomes.cancelled++;
    else if (i.status === "waiting_input" && (!last.has(i.id) || last.get(i.id)!.status === "pending")) outcomes.pending++;
    else {
      const v = last.get(i.id)?.status as keyof typeof outcomes | undefined;
      if (v && v in outcomes) outcomes[v]++;
      else outcomes.unverified++;
    }
  }
  const repairRows = rounds.filter((r) => r.repair_json);
  const stoppedByLimit = [...last.values()].filter((r) => r.status === "blocked" && r.checks_json.includes('"repair_limit"')).length;

  const failedItems = inIds(`SELECT intake_id, json_extract(evidence_json, '$.code') AS code FROM intake_items WHERE state = 'failed' AND intake_id IN (?)`) as Array<{ intake_id: string; code: string | null }>;
  const staleAsked = inIds(`SELECT DISTINCT intake_id FROM intake_items WHERE json_extract(payload_json, '$.staleReconfirms') > 0 AND intake_id IN (?)`) as Array<{ intake_id: string }>;
  const corrected = inIds(`SELECT DISTINCT intake_id FROM agent_goal_revisions WHERE cause = 'revise' AND intake_id IN (?)`) as Array<{ intake_id: string }>;
  const distinct = (rows: Array<{ intake_id: string }>) => new Set(rows.map((r) => r.intake_id)).size;
  const stages: TrialMetrics["stages"] = {
    understandFailed: routing.rules,
    clarified: new Set(questions.filter((q) => q.purpose !== "confirm").map((q) => q.intake_id)).size,
    confirmed: new Set(questions.filter((q) => q.purpose === "confirm").map((q) => q.intake_id)).size,
    scopeRejected: distinct(failedItems.filter((f) => f.code === "GATE_REJECTED")),
    staleReconfirmed: distinct(staleAsked),
    execFailed: distinct(failedItems.filter((f) => f.code !== "GATE_REJECTED")),
    asyncWaiting: [...last.values()].filter((r) => r.status === "pending").length,
    verified: outcomes.verified,
    partial: outcomes.partial,
    repaired: new Set(repairRows.map((r) => r.intake_id)).size,
    ownerCorrected: distinct(corrected),
  };
  const perIntakeMs = (inIds(`SELECT intake_id, SUM(COALESCE(duration_ms, 0)) AS ms FROM ai_request_ledger WHERE status <> 'released' AND intake_id IN (?) GROUP BY intake_id`) as Array<{ ms: number }>).map((r) => r.ms).sort((a, b) => a - b);
  const modelTime = { p50Ms: percentile(perIntakeMs, 50), p95Ms: percentile(perIntakeMs, 95), maxMs: perIntakeMs.at(-1) ?? null };
  const perIntakeActive = (inIds(`SELECT active_ms FROM intakes WHERE active_ms > 0 AND id IN (?)`) as Array<{ active_ms: number }>).map((r) => r.active_ms).sort((a, b) => a - b);
  const activeTime = { p50Ms: percentile(perIntakeActive, 50), p95Ms: percentile(perIntakeActive, 95), maxMs: perIntakeActive.at(-1) ?? null, samples: perIntakeActive.length };

  const ledger = db.prepare(`SELECT local_date, COUNT(*) AS n, SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS e FROM ai_request_ledger WHERE status <> 'released' AND local_date BETWEEN ? AND ? GROUP BY local_date`).all(from, to) as Array<{ local_date: string; n: number; e: number }>;
  const traces = db.prepare(`SELECT local_date, latency_ms FROM agent_traces WHERE workflow IN ('agent_route', 'agent_decide') AND local_date BETWEEN ? AND ?`).all(from, to) as Array<{ local_date: string; latency_ms: number }>;
  const daily: TrialMetrics["daily"] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) {
    const l = ledger.find((x) => x.local_date === d);
    const lat = traces.filter((t) => t.local_date === d).map((t) => t.latency_ms).sort((a, b) => a - b);
    daily.push({ date: d, requests: l?.n ?? 0, errors: l?.e ?? 0, decisions: lat.length, p50Ms: percentile(lat, 50), p95Ms: percentile(lat, 95) });
  }

  const notes: string[] = [];
  if (!intakes.length) notes.push("这段时间没有统一栏投递，下列比例无法计算");
  else if (intakes.length < SMALL_SAMPLE) notes.push(`样本只有 ${intakes.length} 条投递，比例仅供参考`);
  if (outcomes.unverified) notes.push(`${outcomes.unverified} 条没有核验记录：纯回答问题、只存资料、没有可执行的内容，或在执行核验上线前提交`);
  if (routing.other) notes.push(`${routing.other} 条没有经过路由：短答续答、“先别做”、文件或空白投递`);
  notes.push("延迟是单次理解/决策的模型耗时（含工具与重试），不含排队与执行；请求数含探测、复盘等非投递用途");
  notes.push("模型耗时只统计模型 HTTP 时间；主动执行时间是 worker 实际处理投递的时间（模型、查询、执行、核验与修正），不含排队和等你回答。单份投递 180 秒上限按主动执行时间计");
  if (activeTime.samples < intakes.length) notes.push(`${intakes.length - activeTime.samples} 条投递没有主动执行时间记录（计时上线前提交或没有经过 worker 处理），不补算`);
  if (!feedback.length) notes.push("没有“理解错了”反馈不等于没有误解，只说明主人没有点");

  return {
    window: { from, to, days, timezone: tz },
    intakes: intakes.length,
    routing: { ...routing, fallbackReasons: counts(reasons).slice(0, 5).map(({ key, n }) => ({ reason: key, n })) },
    asking: { intakesAsked: asked.size, rate: intakes.length ? asked.size / intakes.length : null, byPurpose: counts(questions.map((q) => q.purpose)).map(({ key, n }) => ({ purpose: key, n })) },
    feedback: { total: feedback.length, byVerdict: counts(feedback.map((f) => f.verdict)).map(({ key, n }) => ({ verdict: key, n })) },
    outcomes,
    repairs: { total: repairRows.length, intakes: new Set(repairRows.map((r) => r.intake_id)).size, stoppedByLimit },
    stages,
    modelTime,
    activeTime,
    daily,
    notes,
  };
}
