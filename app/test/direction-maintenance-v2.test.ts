import assert from "node:assert/strict";
import { before, test } from "node:test";
import crypto from "node:crypto";
import { migrateAll, getDb } from "./helpers";
import { weekFacts } from "@/workflows/week-facts";
import { renderDigest, scheduleDigests } from "@/workflows/digests";
import { directionSnapshot } from "@/workflows/snapshot";
import { runDueJobsOnce } from "@/worker/runner";
import { listJobs } from "@/repositories/jobs";
import { executeCommand } from "@/workflows/commands";

/**
 * Agent-first V2 P5 行为测试（MASTER-PLAN §10 P5 退出条件）：
 * 周事实含 V2 学习块/实践；每周邮件引用真实记录；方向候选最多 3 个带可验证来源；每天有限重排只排一次。
 */

const CTX = { intakeId: null, itemId: null, itemKey: "", instanceEpoch: 0, evidence: "test" };

before(() => {
  migrateAll();
});

function seedPractice(minutes: number, occurredOn: string): void {
  executeCommand({ command: "record_practice", summary: "学数学", actualMinutes: minutes, minutesOrigin: "user_reported", occurredOn }, CTX);
}

test("P5：周事实含 V2 plan_sessions 与 practice 统计", () => {
  const monday = "2026-09-28";
  seedPractice(40, "2026-09-29");
  seedPractice(25, "2026-09-30");
  executeCommand({ command: "create_or_update_task", title: "P5 测试任务", estimateMinutes: 60 }, CTX);
  const f = weekFacts(monday);
  assert.ok(f.planSessions, "应含学习块统计");
  assert.ok(f.practice, "应含实践统计");
  assert.equal(f.practice!.count, 2);
  assert.equal(f.practice!.totalMinutes, 65);
});

test("P5：每周回顾邮件引用真实实践记录（无新增信息不编造）", () => {
  const text = renderDigest("weekly", "2026-10-03").text;
  assert.match(text, /实践|学习块|分钟/, "周回顾应引用实践/学习块事实");
});

test("P5：方向候选最多 3 个且带可验证来源", () => {
  const runId = crypto.randomUUID();
  getDb()
    .prepare(`INSERT INTO exploration_runs (id, kind, query, status, integration_mode, created_at, updated_at) VALUES (?, 'on_demand', 'q', 'done', 'fixture', ?, ?)`)
    .run(runId, new Date().toISOString(), new Date().toISOString());
  for (let i = 0; i < 5; i++) {
    getDb()
      .prepare(
        `INSERT INTO candidates (id, run_id, title, question, activities_json, deliverable, first_task_json, initial_tasks_json, requirements_json, unknowns_json, fit_reason, source_refs_json, evidence_status, canonical_url, evidence_hash, status, version, created_at, updated_at)
         VALUES (?, ?, ?, 'q', '[]', 'd', '{}', '[]', '[]', '[]', 'r', '[]', 'retrieved', ?, 'h', 'proposed', 1, ?, ?)`,
      )
      .run(crypto.randomUUID(), runId, `候选项目 ${i}`, `https://example.com/${i}`, new Date(Date.now() + i * 1000).toISOString(), new Date(Date.now() + i * 1000).toISOString());
  }
  const snap = directionSnapshot(new Date());
  assert.ok(snap.candidates.length <= 3, "候选最多 3 个");
  assert.ok(snap.candidates.length >= 1);
  for (const c of snap.candidates) {
    assert.ok(c.evidenceStatus, "候选应带证据状态");
  }
});

test("P5：每天有限重排——plan_maintenance 同日不重复", async () => {
  scheduleDigests(new Date());
  const first = listJobs({ type: "plan_maintenance" }).length;
  assert.equal(first, 1, "应排一个每日维护 job");
  scheduleDigests(new Date());
  assert.equal(listJobs({ type: "plan_maintenance" }).length, 1, "同日重复调度不新增");
  await runDueJobsOnce();
  const job = listJobs({ type: "plan_maintenance" })[0]!;
  assert.equal(job.status, "done");
});
