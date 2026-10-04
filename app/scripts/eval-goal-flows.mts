/**
 * Agent 方案 P4：目标续办的真实模型核对（多轮）。
 *   MODEL_PROTOCOL/MODEL_ENDPOINT/MODEL_API_KEY/MODEL_NAME 由环境变量给出：npx tsx scripts/eval-goal-flows.mts [--only id,id]
 * 每个流程在种子库副本上：先用脚本化模型把前置状态（已执行的方案、待答问题）走真实管线建出来，
 * 再换成真实模型只说“被考的那一句”，按目标/修订/问题状态核对。只用合成语料；报告写到 .planning/（不入库）。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { buildTemplate, switchDb } from "../test/corpus/eval";
import { FIXTURE_NOW } from "../test/corpus/fixtures";
import { closeDb, getDb } from "../src/repositories/db";
import { setNowForTests } from "../src/domain/clock";
import { setProvidersForTests } from "../src/integrations";
import { OpenAIChatProvider } from "../src/integrations/openai-chat";
import { ScriptedChatProvider } from "../src/integrations/fake-model-provider";
import { probeModelCapabilities } from "../src/integrations/model-capabilities";
import { createSession, SESSION_COOKIE } from "../src/domain/session";
import { POST } from "../src/app/api/v2/intakes/route";
import { POST as answerRoute } from "../src/app/api/v2/questions/[id]/answers/route";
import { runDueJobsOnce } from "../src/worker/runner";
import { intakeResultById } from "../src/workflows/results";
import { getQuestion, listQuestionsForIntake } from "../src/repositories/questions";
import { getIntake } from "../src/repositories/intakes";
import { getGoal } from "../src/repositories/goals";
import { INTAKE_JOB_TYPE } from "../src/contracts/intake";
import { executeOperation } from "../src/workflows/commands";
import type { ChatMessage } from "../src/integrations/model-json";

const { MODEL_PROTOCOL, MODEL_ENDPOINT, MODEL_API_KEY, MODEL_NAME } = process.env;
if (MODEL_PROTOCOL !== "openai-chat" || !MODEL_ENDPOINT || !MODEL_API_KEY || !MODEL_NAME) {
  console.log("RESULT: not_configured — 需要 MODEL_PROTOCOL=openai-chat、MODEL_ENDPOINT、MODEL_API_KEY、MODEL_NAME");
  process.exit(1);
}
const only = (() => { const i = process.argv.indexOf("--only"); return i >= 0 ? new Set(process.argv[i + 1]!.split(",")) : null; })();

type Setup = { text: string; decide: unknown };
type Ctx = { setup: string[]; live: string; lives: string[]; question: (setupIndex: number) => string | null; before: Record<string, string> };
/** live 为数组时按顺序都由真实模型理解；confirm 时像点结果卡上的按钮一样逐个确认“可以” */
type Flow = { id: string; what: string; setup: Setup[]; live: string | string[]; confirm?: boolean; prepare?: () => void; check: (c: Ctx) => string[] };

const thisWeek = { kind: "act", rationale: "按课程与预算重排本周剩余时间", intents: [{ op: "replan", dateFrom: "2026-10-12", dateTo: "2026-10-18" }] };
const ask = (question: string, options: string[]) => ({ kind: "ask", question, reason: "几种安排差别明显", options });

const snapshot = () => {
  const db = getDb();
  return {
    facts: JSON.stringify([db.prepare(`SELECT id, status, version, priority, paused_until, due_local_date FROM tasks ORDER BY id`).all(), db.prepare(`SELECT id, start_utc, status, version, locked FROM plan_sessions ORDER BY id`).all()]),
    courses: JSON.stringify(db.prepare(`SELECT * FROM courses ORDER BY id`).all()),
    budget: JSON.stringify([db.prepare(`SELECT * FROM planning_policy_rules ORDER BY id`).all(), db.prepare(`SELECT * FROM planning_preferences`).all()]),
    weekend: weekend(),
  };
};
function weekend(): string {
  return JSON.stringify(getDb().prepare(`SELECT id, start_utc, end_utc, status FROM plan_sessions WHERE status IN ('tentative','planned') AND start_utc >= '2026-10-16T16:00:00Z' AND start_utc < '2026-10-18T16:00:00Z' ORDER BY start_utc, id`).all());
}
const batchesOf = (intakeId: string) => (getDb().prepare(`SELECT COUNT(*) AS n FROM agent_action_batches WHERE intake_id = ?`).get(intakeId) as { n: number }).n;
const taskOf = (title: string) => getDb().prepare(`SELECT * FROM tasks WHERE title = ? AND archived_at IS NULL`).get(title) as Record<string, unknown> | undefined;
const verificationOf = (intakeId: string) => intakeResultById(intakeId)?.verification ?? null;
const goalOf = (intakeId: string) => getIntake(intakeId)?.goalId ?? null;
const revOf = (intakeId: string) => getIntake(intakeId)?.goalRevision ?? null;
const stateOf = (intakeId: string) => intakeResultById(intakeId)?.state ?? "missing";

const FLOWS: Flow[] = [
  {
    id: "g02-next-week", what: "结果后改口“改成下周”= 同一目标第 2 版、范围下周",
    setup: [{ text: "帮我把这周的学习安排优化一下", decide: thisWeek }], live: "改成下周吧",
    check: (c) => {
      const out: string[] = [];
      if (goalOf(c.live) !== goalOf(c.setup[0]!)) out.push("没有续到同一目标");
      if (revOf(c.live) !== 2) out.push(`修订号 ${revOf(c.live)}，期望 2`);
      const scope = getGoal(goalOf(c.setup[0]!)!)?.summary.scope;
      if (stateOf(c.live) !== "needs_input" && scope?.dateFrom !== "2026-10-19") out.push(`范围 ${JSON.stringify(scope)}，期望下周`);
      if (stateOf(c.live) === "failed") out.push("执行失败");
      return out;
    },
  },
  {
    id: "g02-less-math", what: "结果后补约束“周末别排数学”= 同一目标第 2 版、沿用本周范围",
    setup: [{ text: "这周学习帮我重新排一下", decide: thisWeek }], live: "周末别排数学",
    check: (c) => {
      const out: string[] = [];
      if (goalOf(c.live) !== goalOf(c.setup[0]!)) out.push("没有续到同一目标");
      if (revOf(c.live) !== 2) out.push(`修订号 ${revOf(c.live)}，期望 2`);
      if (stateOf(c.live) === "failed") out.push(`执行失败：${intakeResultById(c.live)?.summary}`);
      return out;
    },
  },
  {
    id: "new-request", what: "结果后说不相干的新事 = 新目标，不改旧目标",
    setup: [{ text: "帮我把这周的学习安排优化一下", decide: thisWeek }], live: "记一下今天跑步跑了30分钟",
    check: (c) => {
      const out: string[] = [];
      if (goalOf(c.live) === goalOf(c.setup[0]!)) out.push("误续到了上一个目标");
      if (revOf(c.setup[0]!) !== 1 || getGoal(goalOf(c.setup[0]!)!)?.revision !== 1) out.push("旧目标被改了版本");
      return out;
    },
  },
  {
    id: "reply-paraphrase", what: "有问题在等时用自己的话回答 = 答那个问题，原投递继续",
    setup: [{ text: "帮我规划一下这周学习", decide: ask("这周优先数学还是英语？", ["数学", "英语"]) }], live: "那就先顾数学吧，英语往后放放",
    check: (c) => {
      const out: string[] = [];
      const q = c.question(0);
      if (!q || getQuestion(q)?.status !== "answered") out.push(`问题没有被回答（${q ? getQuestion(q)?.status : "无问题"}）`);
      if (stateOf(c.setup[0]!) === "needs_input" && listQuestionsForIntake(c.setup[0]!).every((x) => x.id === q)) out.push("原投递没有继续");
      return out;
    },
  },
  {
    id: "not-a-reply", what: "有问题在等时问别的 = 不当作回答，问题保持待答",
    setup: [{ text: "帮我规划一下这周学习", decide: ask("这周优先数学还是英语？", ["数学", "英语"]) }], live: "明天有什么课",
    check: (c) => {
      const out: string[] = [];
      const q = c.question(0);
      if (!q || getQuestion(q)?.status !== "open") out.push(`问题被当作回答了（${q ? getQuestion(q)?.status : "无问题"}）`);
      if (stateOf(c.live) !== "answered") out.push(`查看没有直接回答：${stateOf(c.live)}`);
      return out;
    },
  },
  {
    id: "reply-which", what: "两个问题在等时回答其中一个 = 只答对应的那个",
    setup: [
      { text: "帮我规划一下这周学习", decide: ask("这周优先数学还是英语？", ["数学", "英语"]) },
      { text: "周末的时间怎么安排比较好", decide: ask("周末要不要留出半天休息？", ["留半天", "不用留"]) },
    ],
    live: "周末留半天休息吧",
    check: (c) => {
      const out: string[] = [];
      const q0 = c.question(0), q1 = c.question(1);
      if (!q1 || getQuestion(q1)?.status !== "answered") out.push(`周末问题没有被回答（${q1 ? getQuestion(q1)?.status : "无"}）`);
      if (!q0 || getQuestion(q0)?.status !== "open") out.push(`数学/英语问题被误答（${q0 ? getQuestion(q0)?.status : "无"}）`);
      return out;
    },
  },
  {
    id: "g04-revise-before-confirm", what: "确认前改口“周末别动”= 旧确认作废、同一目标第 2 版，旧方案不执行，周末与课程保留",
    setup: [{ text: "晚上安排太满了", decide: { kind: "act", rationale: "建议长期把每天学习结束时间提前到 22:00", intents: [{ op: "window_end", time: "22:00" }] } }],
    live: "周末别动", confirm: true,
    prepare: () => { executeOperation({ command: "schedule_session", title: "英语阅读", date: "2026-10-17", startLocalTime: "10:00", durationMinutes: 60 }, { intakeId: null, itemId: null, itemKey: "", instanceEpoch: 0, evidence: "", explicit: true, now: new Date(FIXTURE_NOW) }); },
    check: (c) => {
      if (c.before.weekend === "[]") return ["前置没有周末学习块，核对无意义"];
      const out: string[] = [];
      const old = c.question(0);
      if (!old) out.push("前置没有产生待确认方案");
      else if (getQuestion(old)?.status !== "superseded") out.push(`旧确认仍是 ${getQuestion(old)?.status}`);
      if (goalOf(c.live) !== goalOf(c.setup[0]!)) out.push("没有续到同一目标");
      if (revOf(c.live) !== 2) out.push(`修订号 ${revOf(c.live)}，期望 2`);
      if (batchesOf(c.setup[0]!)) out.push(`旧一轮写入了 ${batchesOf(c.setup[0]!)} 个批次`);
      if (weekend() !== c.before.weekend) out.push("周末的学习块被改了");
      if (snapshot().courses !== c.before.courses) out.push("课程被改了");
      if (stateOf(c.live) === "failed") out.push(`执行失败：${intakeResultById(c.live)?.summary}`);
      return out;
    },
  },
  {
    id: "g01-readonly", what: "P5 两轮只读：查看安排再问为什么周三少 = 都直接回答，没有业务批次，任务/学习块逐行不变",
    setup: [], live: ["看一下目前每天的安排", "为什么周三排得少"],
    check: (c) => {
      const out: string[] = [];
      for (const id of c.lives) {
        if (stateOf(id) !== "answered") out.push(`${getIntake(id)?.text}：${stateOf(id)}，期望直接回答`);
        if (batchesOf(id)) out.push(`${getIntake(id)?.text}：产生了 ${batchesOf(id)} 个业务批次`);
        const v = verificationOf(id);
        if (v && v.status !== "verified") out.push(`核验 ${v.status}`);
      }
      if (snapshot().facts !== c.before.facts) out.push("任务/学习块被改了");
      return out;
    },
  },
  {
    id: "g03-pause-refocus", what: "P5 两步依赖：暂停科研项目再把空出的时间用于数学 = 两步都落实或如实部分完成，核验与结果一致",
    setup: [], live: "暂停科研项目，再把空出的时间用于数学", confirm: true,
    check: (c) => {
      const out: string[] = [];
      const id = c.lives[0]!;
      const r = intakeResultById(id);
      const v = r?.verification ?? null;
      if ((getDb().prepare(`SELECT status FROM projects WHERE title = ?`).get("分类基线（科研项目）") as { status: string }).status !== "paused") out.push("科研项目没有暂停");
      const applied = (getDb().prepare(`SELECT COUNT(*) AS n FROM intake_items WHERE intake_id = ? AND state = 'applied'`).get(id) as { n: number }).n;
      if (applied < 2 && r?.state !== "partly_applied" && r?.state !== "needs_input") out.push(`只落实了 ${applied} 步却显示 ${r?.state}`);
      if (!v) out.push("没有核验记录");
      else {
        if (v.status === "partial" && r?.state !== "partly_applied") out.push(`核验 partial 但结果显示 ${r?.state}`);
        if (v.status === "blocked") out.push(`受阻：${v.checks.filter((x) => x.ok === false).map((x) => x.detail).join("；")}`);
      }
      if (snapshot().courses !== c.before.courses) out.push("课程被改了");
      return out;
    },
  },
  {
    id: "g05-deadline-gap", what: "P5 截止前排不下：给出具体取舍、核验不声称完成，不改截止/课程/学习预算",
    setup: [], live: "概率论大作业明天就要交了，帮我优先安排", confirm: true,
    prepare: () => { executeOperation({ command: "create_or_update_task", title: "概率论大作业", taskKind: "study", estimateMinutes: 900, dueLocalDate: "2026-10-13" }, { intakeId: null, itemId: null, itemKey: "", instanceEpoch: 0, evidence: "", explicit: true, now: new Date(FIXTURE_NOW) }); },
    check: (c) => {
      const out: string[] = [];
      const id = c.lives[0]!;
      const r = intakeResultById(id);
      const v = r?.verification ?? null;
      if (taskOf("概率论大作业")?.due_local_date !== "2026-10-13") out.push(`截止被改成 ${taskOf("概率论大作业")?.due_local_date}`);
      if (snapshot().courses !== c.before.courses) out.push("课程被改了");
      if (snapshot().budget !== c.before.budget) out.push("规则或学习预算被改了");
      const tradeoff = listQuestionsForIntake(id).some((q) => q.purpose === "tradeoff" && (q.options?.length ?? 0) >= 2);
      if (r?.state === "applied" && v?.status === "verified") out.push("排不下却显示已完成且核验通过");
      if (!tradeoff && v?.status !== "needs_action" && r?.state !== "needs_input") out.push(`没有给出取舍（state=${r?.state} 核验=${v?.status ?? "无"}）`);
      return out;
    },
  },
];

const caps = await probeModelCapabilities({ endpoint: MODEL_ENDPOINT, apiKey: MODEL_API_KEY, model: MODEL_NAME });
console.log(`probe: tools=${caps.tools} jsonSchema=${caps.jsonSchema}`);
const cfg = { endpoint: MODEL_ENDPOINT, apiKey: MODEL_API_KEY, model: MODEL_NAME, jsonSchema: caps.jsonSchema, tools: caps.tools };
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "dash-goals-"));
const template = buildTemplate(workDir);
const report: Array<{ id: string; what: string; pass: boolean; failures: string[]; requests: number; liveState: string; liveSummary: string; ms: number }> = [];
let seq = 0;

for (const flow of FLOWS.filter((f) => !only || only.has(f.id))) {
  const file = path.join(workDir, `flow-${flow.id}.db`);
  fs.copyFileSync(template, file);
  switchDb(file);
  setNowForTests(new Date(FIXTURE_NOW));
  const s = createSession(1);
  const post = async (text: string) => {
    const res = await POST(new NextRequest("http://localhost/api/v2/intakes", { method: "POST", headers: { cookie: `${SESSION_COOKIE}=${s.token}`, "x-csrf-token": s.session.csrfToken, "content-type": "application/json", "idempotency-key": `goal-${seq++}` }, body: JSON.stringify({ text }) }));
    if (res.status !== 202) throw new Error(`投递被拒 ${res.status}：${(await res.text()).slice(0, 200)}`);
    const { intakeId } = (await res.json()) as { intakeId: string };
    for (let k = 0; k < 6; k++) await runDueJobsOnce();
    return intakeId;
  };
  const setupIds: string[] = [];
  let current: Setup | null = null;
  const scripted = new ScriptedChatProvider((req, messages: ChatMessage[]) => {
    const text = current!.text;
    if (req.workflow === "agent_route") return { ok: true, text: JSON.stringify({ items: [{ itemKey: "goal", excerpt: text, outcome: { kind: "decide", objective: text, rationale: "需要权衡" }, continuesGoal: false }] }) };
    if (req.workflow === "agent_decide") return { ok: true, text: JSON.stringify(current!.decide) };
    if (req.workflow === INTAKE_JOB_TYPE) return { ok: true, text: JSON.stringify({ items: [] }) };
    void messages;
    return { ok: false, code: "HTTP_ERROR", message: `脚本没有处理 ${req.workflow}`, retryable: false };
  });
  setProvidersForTests({ model: { mode: "fixture", provider: scripted } });
  for (const step of flow.setup) {
    current = step;
    setupIds.push(await post(step.text));
  }
  flow.prepare?.();
  const questionIds = setupIds.map((id) => listQuestionsForIntake(id).find((q) => q.status === "open")?.id ?? null);
  const before = snapshot();
  let calls = 0;
  const counted = (async (u: string | URL | Request, init?: RequestInit) => { calls++; return fetch(u, init); }) as typeof fetch;
  setProvidersForTests({ model: { mode: "real", provider: new OpenAIChatProvider(cfg, counted) } });
  const started = Date.now();
  let failures: string[];
  let liveId = "";
  const lives: string[] = [];
  try {
    for (const text of typeof flow.live === "string" ? [flow.live] : flow.live) lives.push(await post(text));
    liveId = lives[0]!;
    for (let n = 0; flow.confirm && n < 6; n++) {
      const q = listQuestionsForIntake(liveId).find((x) => x.status === "open" && x.purpose === "confirm");
      if (!q) break;
      const res = await answerRoute(new NextRequest(`http://localhost/api/v2/questions/${q.id}/answers`, { method: "POST", headers: { cookie: `${SESSION_COOKIE}=${s.token}`, "x-csrf-token": s.session.csrfToken, "content-type": "application/json", "idempotency-key": `goal-${seq++}` }, body: JSON.stringify({ text: "可以", expectedVersion: q.version }) }), { params: Promise.resolve({ id: q.id }) });
      if (res.status >= 300) throw new Error(`确认被拒 ${res.status}`);
      for (let k = 0; k < 6; k++) await runDueJobsOnce();
    }
    failures = flow.check({ setup: setupIds, live: liveId, lives, question: (i) => questionIds[i] ?? null, before });
  } catch (e) {
    failures = [`异常：${e instanceof Error ? e.message : String(e)}`];
  }
  const live = liveId ? intakeResultById(liveId) : null;
  const items = liveId ? (getDb().prepare(`SELECT state, payload_json FROM intake_items WHERE intake_id = ?`).all(liveId) as Array<{ state: string; payload_json: string }>) : [];
  const shape = items.map((i) => { const p = JSON.parse(i.payload_json) as Record<string, unknown>; return `${i.state}${p.reply ? ":reply" : p.needsDecision || p.decisionText ? ":decide" : p.intents ? `:act(${(p.intents as Array<{ op: string }>).map((x) => x.op).join(",")})` : p.routeAsk ? ":ask" : ""}`; }).join(" ");
  const row = { id: flow.id, what: flow.what, pass: failures.length === 0, failures, requests: calls, liveState: live?.state ?? "-", liveSummary: `${shape} | 核验=${live?.verification?.status ?? "无"} | ${(live?.summary ?? "").slice(0, 200)}${liveId ? listQuestionsForIntake(liveId).filter((q) => q.status === "open").map((q) => ` | 问[${q.purpose}] ${q.prompt.slice(0, 120)} ${JSON.stringify(q.options ?? [])}`).join("") : ""}`, ms: Date.now() - started };
  report.push(row);
  console.log(`${row.pass ? "pass" : "FAIL"} ${flow.id} req=${calls} ${row.ms}ms state=${row.liveState} ${row.liveSummary} ${failures.join("；")}`);
  setProvidersForTests({ model: undefined });
  closeDb();
  for (const f of [file, `${file}-wal`, `${file}-shm`]) fs.rmSync(f, { force: true });
}
setNowForTests(null);
fs.rmSync(workDir, { recursive: true, force: true });
const out = path.resolve(".planning", `eval-goals-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify({ model: MODEL_NAME, report }, null, 2));
console.log(`report: ${out}`);
console.log(`RESULT: goals=${report.filter((r) => r.pass).length}/${report.length} requests=${report.reduce((n, r) => n + r.requests, 0)}`);
