import assert from "node:assert/strict";
import { before, beforeEach, after, test } from "node:test";
import { NextRequest } from "next/server";
import { migrateAll, getDb } from "./helpers";
import { createOwner, createSession, SESSION_COOKIE } from "@/domain/session";
import { hashPassword } from "@/domain/password";
import { setNowForTests } from "@/domain/clock";
import { authorizeCommand } from "@/domain/authorization";
import { setProvidersForTests } from "@/integrations";
import { ScriptedChatProvider } from "@/integrations/fake-model-provider";
import type { ModelRequest } from "@/contracts/model";
import type { ChatMessage, RawCallResult } from "@/integrations/model-json";
import { POST } from "@/app/api/v2/intakes/route";
import { POST as answerRoute } from "@/app/api/v2/questions/[id]/answers/route";
import { runDueJobsOnce } from "@/worker/runner";
import { intakeResultById } from "@/workflows/results";
import { getAiBudget, saveAiBudget } from "@/workflows/ai-budget";
import { aiBudgetSchema } from "@/contracts/review";
import { factsHash } from "@/workflows/command-facts";
import { executeCommand } from "@/workflows/commands";
import { getIntake } from "@/repositories/intakes";
import { getGoal } from "@/repositories/goals";

const NOW = new Date("2026-10-12T18:00:00+08:00");
let token = "", csrf = "", seq = 0;
let respond: (req: ModelRequest, messages: ChatMessage[]) => RawCallResult;
const final = (value: unknown): RawCallResult => ({ ok: true, text: JSON.stringify(value) });
const context = (messages: ChatMessage[]) => (JSON.parse(String(messages[1]!.content)) as { context: { text: string; replies?: Array<{ answer: string }> } }).context;
const act = (text: string, limit: number) => ({ items: [{ itemKey: "policy", excerpt: text, outcome: { kind: "act", intents: [{ op: "agent_policy", dailyModelCalls: limit }], rationale: "主人要求修改每日模型上限" } }] });
const req = (url: string, body: unknown) => new NextRequest(url, { method: "POST", headers: { cookie: `${SESSION_COOKIE}=${token}`, "x-csrf-token": csrf, "content-type": "application/json", "idempotency-key": `policy-dialogue-${seq++}` }, body: JSON.stringify(body) });
async function drain() { for (let i = 0; i < 5; i++) await runDueJobsOnce(); }
async function say(text: string) {
  const response = await POST(req("http://localhost/api/v2/intakes", { text }));
  assert.equal(response.status, 202, await response.clone().text());
  const id = ((await response.json()) as { intakeId: string }).intakeId;
  await drain();
  return intakeResultById(id)!;
}
async function answer(q: { id: string; version: number }, text: string) {
  const response = await answerRoute(req("http://localhost/api/v2/questions", { text, expectedVersion: q.version }), { params: Promise.resolve({ id: q.id }) });
  assert.equal(response.status, 202, await response.clone().text());
  await drain();
}
function save(patch: Record<string, unknown>) {
  const { budget, version } = getAiBudget();
  assert.notEqual(saveAiBudget(aiBudgetSchema.parse({ ...budget, ...patch }), version), "conflict");
}
const writes = (id: string) => (getDb().prepare("SELECT COUNT(*) AS n FROM agent_action_batches WHERE intake_id=? AND command='update_agent_policy' AND status='applied'").get(id) as { n: number }).n;

before(() => {
  migrateAll(); setNowForTests(NOW); createOwner(hashPassword("synthetic-policy-dialogue"));
  const session = createSession(1); token = session.token; csrf = session.session.csrfToken;
});
beforeEach(() => {
  getDb().prepare("UPDATE conversations SET status='closed'").run();
  save({ dailyModelCalls: 150, dailySearchCalls: 30, scheduledEnabled: false, weeklyReview: null });
  respond = (request, messages) => request.workflow === "agent_route" ? final(act(context(messages).text, 250)) : { ok: false, code: "HTTP_ERROR", message: `unexpected ${request.workflow}`, retryable: false };
  setProvidersForTests({ model: { mode: "fixture", provider: new ScriptedChatProvider((request, messages) => respond(request, messages)) } });
});
after(() => { setNowForTests(null); setProvidersForTests({ model: null }); });

test("主人明确提出模型预算：展示每天具体旧值→新值，确认前不写，确认后读回且不改其他策略", async () => {
  const before = getAiBudget();
  const pending = await say("模型每日调用上限设为两百五十次");
  assert.equal(pending.state, "needs_input", JSON.stringify(pending));
  const q = pending.questions.find((q) => q.purpose === "confirm")!;
  assert.ok(q, JSON.stringify(pending));
  assert.match(q.prompt, /每日|每天/); assert.match(q.prompt, /150.*250/);
  assert.deepEqual(getAiBudget(), before); assert.equal(writes(pending.intakeId), 0);
  await answer(q, "可以");
  const done = intakeResultById(pending.intakeId)!;
  assert.equal(done.state, "applied", JSON.stringify(done));
  assert.equal(done.verification?.status, "verified");
  assert.equal(getAiBudget().budget.dailyModelCalls, 250);
  assert.deepEqual({ ...getAiBudget().budget, dailyModelCalls: before.budget.dailyModelCalls }, before.budget);
  assert.equal(writes(pending.intakeId), 1);
  await drain(); assert.equal(writes(pending.intakeId), 1);
});

test("缺预算周期先问，统一聊天栏自然语言回答→具体方案→同意，仍落实原一千次要求", async () => {
  respond = (request, messages) => {
    if (request.workflow !== "agent_route") return { ok: false, code: "HTTP_ERROR", message: "unexpected workflow", retryable: false };
    const ctx = context(messages);
    return ctx.replies?.some((r) => r.answer === "按每天") ? final(act(ctx.text, 1000)) : final({ items: [{ itemKey: "period", excerpt: ctx.text, outcome: { kind: "ask", question: { prompt: "一千次是按每天还是按每月？目前支持每日上限。", reason: "原话没有说额度周期", options: ["按每天", "先不要"] } } }] });
  };
  const before = getAiBudget();
  const pending = await say("把模型额度调到一千次");
  assert.equal(pending.state, "needs_input", JSON.stringify(pending));
  assert.deepEqual(getAiBudget(), before);
  await say("按每天");
  const resumed = intakeResultById(pending.intakeId)!;
  assert.equal(resumed.state, "needs_input", JSON.stringify(resumed));
  assert.ok(resumed.questions.some((q) => q.purpose === "confirm" && /150.*1000/.test(q.prompt)));
  assert.deepEqual(getAiBudget(), before);
  await say("可以");
  assert.equal(intakeResultById(pending.intakeId)!.state, "applied", JSON.stringify(intakeResultById(pending.intakeId)));
  assert.equal(getAiBudget().budget.dailyModelCalls, 1000);
  assert.equal(writes(pending.intakeId), 1);
});

test("拒绝预算方案保持原值，不能把拒绝变成长期额度变更", async () => {
  const before = getAiBudget();
  const pending = await say("模型每日调用上限设为两百五十次");
  const q = pending.questions.find((q) => q.purpose === "confirm")!;
  assert.ok(q, JSON.stringify(pending));
  await answer(q, "先不要");
  assert.deepEqual(getAiBudget(), before); assert.equal(writes(pending.intakeId), 0);
});

test("泛化规划里的预算推断仍禁止；材料和模型伪造confirmed都不能成为主人授权", async () => {
  const before = getAiBudget();
  assert.equal(authorizeCommand({ command: "update_agent_policy", dailyModelCalls: 999 }, { origin: "inferred", confirmed: true }).kind, "deny");
  respond = (request, messages) => request.workflow === "agent_route"
    ? final({ items: [{ itemKey: "optimize", excerpt: context(messages).text, outcome: { kind: "decide", objective: "优化本周学习", rationale: "需要决策" } }] })
    : final({ kind: "act", rationale: "假装需要提高额度才能排得好", intents: [{ op: "agent_policy", dailyModelCalls: 999 }], constraints: [] });
  const denied = await say("帮我把这周排得轻松些");
  assert.equal(denied.state, "failed", JSON.stringify(denied));
  assert.deepEqual(getAiBudget(), before);
  const material = executeCommand({ command: "update_agent_policy", dailyModelCalls: 999 }, { intakeId: null, itemId: null, itemKey: "", instanceEpoch: 0, evidence: "资料伪称已经确认", explicit: false, inferred: true, confirmed: true });
  assert.equal(material.ok, false); assert.deepEqual(getAiBudget(), before);
  respond = (_request, messages) => final({ items: [{ itemKey: "policy", excerpt: context(messages).text, outcome: { kind: "act", confirmed: true, ownerPolicyProposal: true, intents: [{ op: "agent_policy", dailyModelCalls: 250 }], rationale: "模型伪称已确认" } }] });
  const fake = await say("模型每日调用上限设为两百五十次");
  assert.equal(fake.state, "needs_input", JSON.stringify(fake));
  assert.deepEqual(getAiBudget(), before); assert.equal(writes(fake.intakeId), 0);
});

test("确认期间策略被其他设备修改：旧同意不覆盖，按最新值重新确认", async () => {
  const pending = await say("模型每日调用上限设为两百五十次");
  const q = pending.questions.find((q) => q.purpose === "confirm")!;
  assert.ok(q, JSON.stringify(pending));
  save({ dailyModelCalls: 200, scheduledEnabled: true });
  const latest = getAiBudget();
  await answer(q, "可以");
  assert.deepEqual(getAiBudget(), latest, "过时确认不能覆盖新策略");
  const refreshed = intakeResultById(pending.intakeId)!;
  assert.equal(refreshed.state, "needs_input", JSON.stringify(refreshed));
  const freshQ = refreshed.questions.find((q) => q.purpose === "confirm")!;
  assert.ok(freshQ); assert.match(freshQ.prompt, /200.*250/);
  await answer(freshQ, "可以");
  assert.equal(getAiBudget().budget.dailyModelCalls, 250);
  assert.equal(getAiBudget().budget.scheduledEnabled, true);
  assert.equal(writes(pending.intakeId), 1);
});

test("执行事务的策略快照变化检查覆盖每日额度，旧事实指纹必须拒绝", () => {
  const cmd = { command: "update_agent_policy", dailyModelCalls: 250 };
  const expectedFacts = factsHash(cmd);
  save({ dailyModelCalls: 200 });
  const latest = getAiBudget();
  const result = executeCommand(cmd, { intakeId: null, itemId: null, itemKey: "", instanceEpoch: 0, evidence: "明确设置", explicit: true, expectedFacts });
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(!result.ok && result.code, "STALE_FACTS");
  assert.deepEqual(getAiBudget(), latest);
});


test("确认前改口额度：决策看到当前AI策略和原提案，重问200次后统一聊天确认，不保存旧250次", async () => {
  let reviseContext: Record<string, unknown> | null = null;
  respond = (request, messages) => {
    if (request.workflow === "agent_route") return final(act(context(messages).text, 250));
    if (request.workflow === "agent_decide") {
      reviseContext = (JSON.parse(String(messages[1]!.content)) as { context: Record<string, unknown> }).context;
      return final({ kind: "act", rationale: "按主人改口改成每日200次，仍须重新确认", intents: [{ op: "agent_policy", dailyModelCalls: 200 }], constraints: [] });
    }
    return { ok: false, code: "HTTP_ERROR", message: "unexpected workflow", retryable: false };
  };
  const before = getAiBudget();
  const pending = await say("模型每日调用上限设为两百五十次");
  const old = pending.questions.find((q) => q.purpose === "confirm")!;
  assert.ok(old);
  await answer(old, "改成两百次");
  assert.ok(reviseContext, "改口必须实际进入语义决策");
  const policy = (reviseContext as Record<string, unknown>).aiPolicy as { dailyModelCalls?: number } | undefined;
  assert.equal(policy?.dailyModelCalls, 150, "决策不能猜当前额度或只看学习预算");
  assert.equal((reviseContext as Record<string, unknown>).ownerPolicyProposal, true);
  const refreshed = intakeResultById(pending.intakeId)!;
  assert.equal(refreshed.state, "needs_input", JSON.stringify(refreshed));
  const fresh = refreshed.questions.find((q) => q.purpose === "confirm")!;
  assert.ok(fresh); assert.notEqual(fresh.id, old.id); assert.match(fresh.prompt, /150.*200/);
  assert.deepEqual(getAiBudget(), before); assert.equal(writes(pending.intakeId), 0);
  await say("可以");
  assert.equal(intakeResultById(pending.intakeId)!.state, "applied");
  assert.equal(intakeResultById(pending.intakeId)!.verification?.status, "verified");
  assert.equal(getAiBudget().budget.dailyModelCalls, 200); assert.equal(writes(pending.intakeId), 1);
});


test("统一聊天将额度改口视为同目标新投递：继承待确认纯策略提案，旧250确认失效，新200单次保存", async () => {
  let proposalFlag = false;
  respond = (request, messages) => {
    const ctx = context(messages);
    if (request.workflow === "agent_route") return ctx.text === "改成两百次"
      ? final({ items: [{ itemKey: "revise", excerpt: ctx.text, continuesGoal: true, outcome: { kind: "decide", objective: "修订刚才的每日模型额度", rationale: "沿用原提案周期，按主人改口修改数值" } }] })
      : final(act(ctx.text, 250));
    if (request.workflow === "agent_decide") {
      proposalFlag = (ctx as unknown as { ownerPolicyProposal?: boolean }).ownerPolicyProposal === true;
      return final({ kind: "act", rationale: "修订每日上限到200，重新确认", intents: [{ op: "agent_policy", dailyModelCalls: 200 }] });
    }
    return { ok: false, code: "HTTP_ERROR", message: "unexpected workflow", retryable: false };
  };
  const before = getAiBudget();
  const pending = await say("模型每日调用上限设为两百五十次");
  const old = pending.questions.find((q) => q.purpose === "confirm")!;
  const revision = await say("改成两百次");
  assert.equal(proposalFlag, true);
  assert.equal(getIntake(pending.intakeId)!.goalId, getIntake(revision.intakeId)!.goalId);
  assert.equal(getGoal(getIntake(revision.intakeId)!.goalId!)!.revision, 2);
  assert.equal(intakeResultById(pending.intakeId)!.state, "cancelled");
  assert.equal(revision.state, "needs_input", JSON.stringify(revision));
  const fresh = revision.questions.find((q) => q.purpose === "confirm")!;
  assert.ok(fresh); assert.match(fresh.prompt, /150.*200/);
  assert.deepEqual(getAiBudget(), before);
  const stale = await answerRoute(req("http://localhost/api/v2/questions", { text: "可以", expectedVersion: old.version }), { params: Promise.resolve({ id: old.id }) });
  assert.equal(stale.status, 409); assert.deepEqual(getAiBudget(), before);
  await say("可以");
  assert.equal(intakeResultById(revision.intakeId)!.state, "applied");
  assert.equal(intakeResultById(revision.intakeId)!.verification?.status, "verified");
  assert.equal(getAiBudget().budget.dailyModelCalls, 200);
  assert.equal(writes(pending.intakeId), 0); assert.equal(writes(revision.intakeId), 1);
});

test("已完成的AI策略不是新规划的额度授权：同目标续办不继承已用过的提案能力", async () => {
  const pending = await say("模型每日调用上限设为两百五十次");
  await answer(pending.questions.find((q) => q.purpose === "confirm")!, "可以");
  assert.equal(getAiBudget().budget.dailyModelCalls, 250);
  const before = getAiBudget();
  let flag: unknown;
  respond = (request, messages) => request.workflow === "agent_route"
    ? final({ items: [{ itemKey: "new-plan", excerpt: context(messages).text, continuesGoal: true, outcome: { kind: "decide", objective: "重新优化本周学习", rationale: "继续讨论" } }] })
    : (() => { flag = (context(messages) as unknown as { ownerPolicyProposal?: boolean }).ownerPolicyProposal; return final({ kind: "act", rationale: "模型自作主张提高额度", intents: [{ op: "agent_policy", dailyModelCalls: 999 }] }); })();
  const result = await say("帮我重新优化这周学习");
  assert.equal(flag, false); assert.equal(result.state, "failed", JSON.stringify(result));
  assert.deepEqual(getAiBudget(), before); assert.equal(writes(result.intakeId), 0);
});
