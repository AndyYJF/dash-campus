import assert from "node:assert/strict";
import { before, test } from "node:test";
import { migrateAll, getDb } from "./helpers";
import { insertReview, finishReview, updateOwnerFields } from "@/repositories/reviews";
import { answerReadRequest } from "@/workflows/read-answer";
import { AgentToolbox, TOOL_RESULT_LIMIT } from "@/workflows/agent-tools";

before(() => migrateAll());
const env = { intakeId: null, conversationId: null, referenceDate: "2026-10-12", now: new Date("2026-10-12T08:00:00+08:00"), tz: "Asia/Shanghai", selected: null };
function seed(week: string, summary = "本周主要卡在极限证明") {
  const r = insertReview({ localMonday: week, timezone: env.tz, trigger: "manual" });
  finishReview(r.id, { status: "ready", facts: { completedTasks: 2 }, aiDraft: { factNotes: [{ text: "完成了两项基础练习", evidenceIds: ["synthetic-note"] }], observations: [{ text: "可能需要先练证明", evidenceIds: ["synthetic-note"] }], proposals: [{ title: "先练证明", operations: [{ kind: "create_task", title: "不能执行的草案任务" }] }] }, integrationMode: "fixture" });
  const saved = updateOwnerFields(r.id, r.version, { ownerSummary: summary, ownerNextWeek: "先复习极限" });
  assert.ok(typeof saved === "object", "种子修订必须成功");
  return saved;
}
function businessState() {
  return ["reviews", "review_edits", "tasks", "jobs", "agent_action_batches", "agent_step_executions"].map((table) => getDb().prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
}
test("已有上周复盘读取本人结论和草案，保留来源，绝不重新生成或采纳建议", () => {
  seed("2026-10-05");
  const before = businessState();
  const r = answerReadRequest("上周的复盘写了啥", env);
  assert.match(r.text, /2026-10-05–2026-10-11/);
  assert.match(r.text, /本人总结：本周主要卡在极限证明/);
  assert.match(r.text, /不是本人结论/);
  assert.match(r.text, /不代表已采纳或执行/);
  assert.match(r.text, /冻结的程序事实/);
  assert.equal(r.links[0]!.href, "/reviews");
  assert.deepEqual(businessState(), before);
});
test("没有指定周的复盘读最近已有；不存在或仍生成就如实回答，不开新任务", () => {
  seed("2026-10-12", "最近这一周");
  const pending = insertReview({ localMonday: "2026-10-19", timezone: env.tz, trigger: "manual" });
  const before = businessState();
  assert.match(answerReadRequest("看看复盘", env).text, /原有生成任务尚未完成/);
  assert.match(answerReadRequest("下周的复盘", env).text, new RegExp(pending.localMonday));
  assert.match(answerReadRequest("2026年11月2日的复盘", env).text, /没有找到/);
  assert.deepEqual(businessState(), before);
});
test("复盘工具：真实分页、未见ID拒绝、长原文有界完整拼接、更新拒绝旧游标", async () => {
  const large = '长段落"\\\n'.repeat(1600);
  const target = seed("2026-10-26", large);
  for (let i = 0; i < 8; i++) seed("2026-10-26", `其他复盘 ${i}`);
  const tools = new AgentToolbox(env);
  assert.ok(tools.specs().some((s) => s.function.name === "get_reviews"));
  assert.equal((await tools.run("get_reviews", { id: target.id })).ok, false);
  const ids: string[] = [];
  let cursor: string | undefined;
  do {
    const result = await tools.run("get_reviews", { dateFrom: "2026-10-26", dateTo: "2026-11-01", limit: 2, ...(cursor ? { cursor } : {}) });
    assert.equal(result.ok, true, result.content);
    assert.ok(result.content.length <= TOOL_RESULT_LIMIT);
    const body = JSON.parse(result.content);
    assert.equal(body.total, 9);
    ids.push(...body.items.map((r: { id: string }) => r.id));
    if (body.nextCursor) assert.notEqual(body.nextCursor, cursor);
    cursor = body.nextCursor ?? undefined;
  } while (cursor);
  assert.equal(new Set(ids).size, 9);
  const before = businessState();
  let full = "";
  let firstCursor: string | null = null;
  do {
    const result = await tools.run("get_reviews", { id: target.id, ...(cursor ? { cursor } : {}) });
    assert.equal(result.ok, true, result.content);
    assert.ok(result.content.length <= TOOL_RESULT_LIMIT);
    const body = JSON.parse(result.content);
    full += body.text;
    if (!firstCursor) firstCursor = body.nextCursor;
    if (body.nextCursor) assert.notEqual(body.nextCursor, cursor);
    cursor = body.nextCursor ?? undefined;
  } while (cursor);
  assert.ok(full.includes(large));
  assert.deepEqual(businessState(), before);
  assert.equal((await tools.run("get_reviews", { dateFrom: "2026-10-12", cursor: firstCursor })).ok, false);
  updateOwnerFields(target.id, target.version, { ownerSummary: "新版本" });
  assert.equal((await tools.run("get_reviews", { id: target.id, cursor: firstCursor })).ok, false);
  assert.equal((await tools.run("get_reviews", { dateFrom: "2026-02-31" })).ok, false);
  assert.equal((await tools.run("get_reviews", { id: target.id, dateFrom: "2026-10-26" })).ok, false);
});
