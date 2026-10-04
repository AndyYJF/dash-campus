import assert from "node:assert/strict";
import { test } from "node:test";
import { intentSchema, parseInstruction } from "@/domain/intent";
import { parseAgentText } from "@/domain/agent-input";
import { loadCorpus } from "./corpus/schema";

/**
 * 语料种子（Agent 方案 §6 P0）：格式、规模与降级子集。
 * 这里只验证语料本身和规则降级路径；模型路由效果由 P3 的 recorded/live 评测报告，不在此证明。
 */

const corpus = loadCorpus();
/** P1 计划补齐的意图（§6 P1）；落地前语料可以引用，P1 起由 intentSchema 覆盖 */
const PLANNED_OPS = ["create_task", "practice", "schedule_at", "session_state", "resolve_notice", "archive"];
const KNOWN_OPS = new Set([...intentSchema.options.map((o) => o.shape.op.value as string), ...PLANNED_OPS]);

test("语料规模与格式：≥200 条（开发≥150、验收≥50）、ID 唯一、op 都是已知或计划中的意图", () => {
  assert.ok(corpus.length >= 200, `当前 ${corpus.length} 条`);
  const dev = corpus.filter((e) => e.split === "dev").length;
  assert.ok(dev >= 150, `开发集 ${dev} 条`);
  assert.equal(new Set(corpus.map((e) => e.id)).size, corpus.length);
  assert.equal(new Set(corpus.map((e) => e.text + JSON.stringify(e.turns) + JSON.stringify(e.selected))).size, corpus.length, "没有重复样本");
  for (const e of corpus) for (const op of e.expect.ops) assert.ok(KNOWN_OPS.has(op), `${e.id} 未知 op：${op}`);
  const holdout = corpus.filter((e) => e.split === "holdout").length;
  assert.ok(holdout >= 50, `独立验收集 ${holdout} 条`);
  for (const kind of ["act", "decide", "ask", "material"]) assert.ok(corpus.some((e) => e.expect.kind === kind), `缺少 ${kind}`);
  assert.ok(corpus.some((e) => e.turns.length > 0), "包含多轮");
  assert.ok(corpus.some((e) => e.tags.includes("injection")), "包含材料内指令");
});

test("降级子集：fallback=true 的条目，规则解析给出同样结果", () => {
  const TZ = "Asia/Shanghai";
  const problems: string[] = [];
  for (const e of corpus.filter((x) => x.fallback)) {
    const { body } = parseAgentText(e.text);
    const parsed = parseInstruction(body, e.referenceDate, new Date(e.now), TZ);
    const intents = parsed.intents.map((i) => i.intent as Record<string, unknown>);
    if (e.expect.kind === "material") {
      if (intents.length) problems.push(`${e.id} 材料被规则识别为指令：${JSON.stringify(intents)}`);
      continue;
    }
    const ops = intents.map((i) => i.op);
    for (const op of e.expect.ops) if (!ops.includes(op)) problems.push(`${e.id}「${e.text}」缺少 ${op}，实际 ${JSON.stringify(ops)}`);
    for (const [k, v] of Object.entries(e.expect.fields)) {
      if (!intents.some((i) => JSON.stringify(i[k]) === JSON.stringify(v))) problems.push(`${e.id} 字段 ${k} 期望 ${JSON.stringify(v)}，实际 ${JSON.stringify(intents)}`);
    }
  }
  assert.deepEqual(problems, []);
});
