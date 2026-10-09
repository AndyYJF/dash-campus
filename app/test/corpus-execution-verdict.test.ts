import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { grade, buildTemplate, switchDb, submitCorpusEntry, type CaseResult } from "./corpus/eval";
import { loadCorpus } from "./corpus/schema";
import { getDb, closeDb } from "@/repositories/db";
import { createSession } from "@/domain/session";
import { agentTurnsBefore } from "@/repositories/conversations";
import { setNowForTests } from "@/domain/clock";

test("语义路由正确但执行因范围失败，不能误报 decide 验收通过", () => {
  const entry = loadCorpus().find((e) => e.id === "u125")!;
  const observed: CaseResult["observed"] = { kind: "decide", ops: [], routedBy: "model", questions: 0, confirms: 0, writes: [], state: "failed", failed: 1, errors: ["方案超出了你指定的日期范围，没有执行。"] };
  const result = grade(entry, observed, []);
  assert.equal(result.pass, false);
  assert.ok(result.reasons.some((reason) => reason.includes("执行失败")));
});

test("缺少范围而主动提出具体问题，没有写入，不属于执行失败", () => {
  const entry = loadCorpus().find((e) => e.id === "u125")!;
  const observed: CaseResult["observed"] = { kind: "ask", ops: [], routedBy: "model", questions: 1, confirms: 0, writes: [], state: "waiting_input", failed: 0, errors: [] };
  assert.equal(grade(entry, observed, []).pass, true);
});


test("评测参考日不能切断当前预置对话：投递仍带最近微积分对象", async () => {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "dash-eval-context-"));
  try {
    const entry = loadCorpus().find((e) => e.id === "u037")!;
    switchDb(buildTemplate(workDir));
    const session = createSession(1);
    const intakeId = await submitCorpusEntry(entry, { token: session.token, csrf: session.session.csrfToken }, 1);
    assert.equal((getDb().prepare("SELECT COUNT(*) AS n FROM conversations").get() as { n: number }).n, 1, "参考日期与审计时间分开，不误建新对话");
    const intake = getDb().prepare("SELECT conversation_id FROM intakes WHERE id = ?").get(intakeId) as { conversation_id: string };
    const turns = agentTurnsBefore(intake.conversation_id, intakeId);
    assert.match(turns[0]!.text, /微积分复习/);
    assert.ok(turns[0]!.refs.some((r) => r.kind === "plan_session"));
  } finally {
    closeDb();
    setNowForTests(null);
    fs.rmSync(workDir, { recursive: true, force: true });
  }
});
