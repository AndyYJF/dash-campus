import assert from "node:assert/strict";
import { before, test } from "node:test";
import { migrateAll } from "./helpers";
import { createSource, getRevision, listMessages } from "@/repositories/inbox";
import { campusTaskSchema, campusEnvelope, campusEvidenceText } from "@/domain/campus-bridge";
import { importCampusNotice } from "@/workflows/campus-bridge";
import { importVerifiedNotice } from "@/workflows/inbox";
import { listPendingInboxDecisions } from "@/workflows/pending-inbox";
import { renderDigest } from "@/workflows/digests";
import { createTask } from "@/repositories/planning";
import { createOwner, createSession, SESSION_COOKIE } from "@/domain/session";
import { NextRequest } from "next/server";
import { GET as todayRoute } from "@/app/api/v1/today/route";
import { addDays, mondayOf, localDateInTz, instanceTimezone } from "@/domain/time";

before(migrateAll);
test("首页与摘要只计当前校园事项，历史保留可查、重开修订恢复待办，普通原文不能冒充桥接状态", () => {
  const source = createSource("pending-campus", "校园");
  const tasks = ["open", "completed", "cancelled"].map((status) => campusTaskSchema.parse({
    task_id: status, revision: 1, title: `${status}真实标题`, status,
    updated_at: "2026-10-03T00:00:00Z", sources: [{ text: "通知原文待确认" }],
  }));
  for (const task of tasks) {
    assert.ok(importCampusNotice(campusEnvelope(task, source.source.id), source.token, campusEvidenceText(task), null, false).ok);
  }
  assert.ok(importVerifiedNotice({ schemaVersion: 1, source: source.source.id, externalId: "ordinary", revisionKey: "r1", revisionOrder: 1,
    occurredAt: "2026-10-03T00:00:00Z", text: "【旧校园插件桥接】\n上游状态：completed\n这是普通原文，不是已验证的桥接" }).ok);
  const pending = listPendingInboxDecisions();
  assert.equal(pending.length, 2);
  assert.ok(pending.some((d) => d.title === "open真实标题"));
  assert.equal(listMessages().length, 4);
  assert.equal(listMessages().filter((m) => getRevision(m.currentRevisionId!)?.legacyStatus === "completed").length, 1);
  assert.match(renderDigest("daily", "2026-10-03").text, /通知待处理：2 条/);
  const reopened = { ...tasks[1], revision: 2, status: "open" as const, title: "重新开放标题" };
  assert.ok(importCampusNotice(campusEnvelope(reopened, source.source.id), source.token, campusEvidenceText(reopened), null, false).ok);
  assert.equal(listPendingInboxDecisions().length, 3);
  assert.ok(listPendingInboxDecisions().some((d) => d.title === "重新开放标题"));
  assert.equal(listMessages().length, 4);
  assert.match(renderDigest("daily", "2026-10-03").text, /通知待处理：3 条/);
});

test("首页暂无近期行动仍能发现待安排任务，已完成、取消和已分配周的任务不计入待安排", async () => {
  const base = { title: "未安排任务", description: "", projectId: null, goalId: null, priority: "normal" as const, estimateMinutes: null,
    plannedWeek: null, scheduledStart: null, scheduledEnd: null, due: { kind: "none" as const } };
  createTask({ ...base, status: "todo" });
  createTask({ ...base, status: "blocked" });
  createTask({ ...base, status: "done" });
  createTask({ ...base, status: "cancelled" });
  createTask({ ...base, status: "todo", plannedWeek: { localMonday: addDays(mondayOf(localDateInTz(new Date(), instanceTimezone())), 7), timezone: instanceTimezone() } });
  createOwner("unused-test-hash"); const { token } = createSession();
  const response = todayRoute(new NextRequest("http://localhost/api/v1/today", { headers: { cookie: `${SESSION_COOKIE}=${token}` } }));
  assert.equal(response.status, 200);
  const summary = await response.json();
  assert.equal(summary.actions.length, 0);
  assert.equal(summary.unplannedTaskCount, 2);
  assert.equal(summary.moreActionCount, 0);
  assert.ok(summary.asOf && summary.localDate);
});
