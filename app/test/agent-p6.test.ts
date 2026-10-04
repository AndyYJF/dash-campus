import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { NextRequest } from "next/server";
import { migrateAll, getDb } from "./helpers";
import { createSession, SESSION_COOKIE } from "@/domain/session";
import { setNowForTests } from "@/domain/clock";
import { setProvidersForTests } from "@/integrations";
import { ScriptedChatProvider } from "@/integrations/fake-model-provider";
import type { RawCallResult } from "@/integrations/model-json";
import { POST } from "@/app/api/v2/intakes/route";
import { POST as feedbackRoute } from "@/app/api/v2/feedback/route";
import { GET as metricsRoute } from "@/app/api/v2/agent-metrics/route";
import { runDueJobsOnce } from "@/worker/runner";
import { trialMetrics } from "@/workflows/agent-metrics";
import { INTAKE_JOB_TYPE } from "@/contracts/intake";
import { FIXTURE_NOW, seedFixture } from "./corpus/fixtures";

/**
 * Agent 增强 v1.1 P6：七天试用只读指标卡。投递走真实管线（模型为脚本），指标只从已有记录聚合。
 */

const NOW = new Date(FIXTURE_NOW);
let token = "", csrf = "", seq = 0;
let onRoute: () => unknown = () => ({ items: [] });

const final = (value: unknown): RawCallResult => ({ ok: true, text: JSON.stringify(value) });
const named = (text: string) => ({ kind: "named", text, date: null, part: "any" });
const act = (excerpt: string, intents: unknown[]) => ({ items: [{ itemKey: "act", excerpt, outcome: { kind: "act", intents, rationale: "按原话执行" }, continuesGoal: false }] });
const headers = () => ({ cookie: `${SESSION_COOKIE}=${token}`, "x-csrf-token": csrf, "content-type": "application/json", "idempotency-key": `p6-${seq++}` });

async function say(text: string): Promise<string> {
  const res = await POST(new NextRequest("http://localhost/api/v2/intakes", { method: "POST", headers: headers(), body: JSON.stringify({ text }) }));
  assert.equal(res.status, 202);
  const { intakeId } = (await res.json()) as { intakeId: string };
  for (let i = 0; i < 6; i++) await runDueJobsOnce();
  return intakeId;
}
const tableCounts = () => {
  const db = getDb();
  const tables = (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`).all() as Array<{ name: string }>).map((t) => t.name);
  return JSON.stringify(tables.map((t) => [t, (db.prepare(`SELECT COUNT(*) AS n FROM "${t}"`).get() as { n: number }).n]));
};

before(() => {
  migrateAll();
  seedFixture("week-basic");
  setNowForTests(NOW);
  const s = createSession(1);
  token = s.token;
  csrf = s.session.csrfToken;
  const provider = new ScriptedChatProvider((req) => {
    if (req.workflow === "agent_route") return final(onRoute());
    if (req.workflow === INTAKE_JOB_TYPE) return final({ items: [] });
    return { ok: false, code: "HTTP_ERROR", message: `脚本没有处理 ${req.workflow}`, retryable: false };
  });
  setProvidersForTests({ model: { mode: "fixture", provider } });
});
after(() => setNowForTests(null));

test("空窗口：没有投递时如实说明，比例为空，不编数字", () => {
  const m = trialMetrics({ now: NOW });
  assert.equal(m.intakes, 0);
  assert.equal(m.asking.rate, null);
  assert.equal(m.daily.length, 7);
  assert.equal(m.window.to, "2026-10-12");
  assert.equal(m.window.from, "2026-10-06");
  assert.ok(m.notes.some((n) => /没有统一栏投递/.test(n)));
});

test("指标如实计入：路由来源、问过你、核验结果（通过/等确认）、理解错了；计算本身不写任何表", async () => {
  onRoute = () => act("看一下目前每天的安排", [{ op: "inspect", query: "目前每天的安排" }]);
  const read = await say("看一下目前每天的安排");
  onRoute = () => act("先把读论文停一下，物理竞赛题截止改到20号", [{ op: "pause_task", ref: named("读论文"), until: null }, { op: "set_due", ref: named("物理竞赛题"), dueLocalDate: "2026-10-20", dueLocalTime: null }]);
  await say("先把读论文停一下，物理竞赛题截止改到20号");
  const fb = await feedbackRoute(new NextRequest("http://localhost/api/v2/feedback", { method: "POST", headers: headers(), body: JSON.stringify({ intakeId: read, verdict: "wrong_intent" }) }));
  assert.ok(fb.status < 300, `反馈 ${fb.status}`);

  const before = tableCounts();
  const m = trialMetrics({ now: NOW });
  assert.equal(tableCounts(), before, "指标计算不写库");
  assert.equal(m.intakes, 2);
  assert.equal(m.routing.model, 2);
  assert.equal(m.asking.intakesAsked, 1, "推断的修改先确认");
  assert.equal(m.asking.rate, 0.5);
  assert.ok(m.asking.byPurpose.some((p) => p.purpose === "confirm"));
  assert.equal(m.outcomes.verified, 1, "只读那条核验通过");
  assert.equal(m.outcomes.pending, 1, "还在等确认的那条记为等回答");
  assert.equal(m.feedback.total, 1);
  assert.deepEqual(m.feedback.byVerdict, [{ verdict: "wrong_intent", n: 1 }]);
  assert.ok(m.notes.some((n) => /样本只有 2 条/.test(n)));

  // 请求账本与 trace 用真实日期：按当天窗口看得到请求与决策延迟
  const today = trialMetrics();
  const sum = today.daily.reduce((n, d) => n + d.requests, 0);
  assert.ok(sum >= 2, `今日请求 ${sum}`);
  assert.ok(today.daily.some((d) => d.decisions > 0 && d.p50Ms !== null));
});

test("接口只给主人、只读", async () => {
  const anon = await metricsRoute(new NextRequest("http://localhost/api/v2/agent-metrics"));
  assert.equal(anon.status, 401);
  const res = await metricsRoute(new NextRequest("http://localhost/api/v2/agent-metrics?days=3", { headers: { cookie: `${SESSION_COOKIE}=${token}` } }));
  assert.equal(res.status, 200);
  const { metrics } = (await res.json()) as { metrics: { window: { days: number }; daily: unknown[] } };
  assert.equal(metrics.window.days, 3);
  assert.equal(metrics.daily.length, 3);
});
