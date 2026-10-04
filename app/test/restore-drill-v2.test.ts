import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { after, before, test } from "node:test";
import { NextRequest } from "next/server";
import { migrateAll, getDb, closeDb } from "./helpers";
import { createOwner, createSession, SESSION_COOKIE } from "@/domain/session";
import { hashPassword } from "@/domain/password";
import { setNowForTests } from "@/domain/clock";
import { setProvidersForTests } from "@/integrations";
import { FakeModelProvider } from "@/integrations/fake-model-provider";
import { runDueJobsOnce } from "@/worker/runner";
import { snapshotDatabase } from "@/scripts/ops-lib";
import { runMigrations } from "@/scripts/migrate-lib";
import { applyRestoreHold, resumeAfterRestore } from "@/workflows/restore";
import { executeOperation, undoWithFollowUps } from "@/workflows/commands";
import { setCalendarFetcherForTests } from "@/workflows/calendar-sync";
import { weekSnapshot } from "@/workflows/snapshot";
import { buildFullJson } from "@/workflows/exports";
import { getInstanceState } from "@/repositories/instance";
import { FULL_JSON_TABLES } from "@/contracts/exports";
import { POST as createIntakeRoute } from "@/app/api/v2/intakes/route";
import { GET as getIntakeRoute } from "@/app/api/v2/intakes/[id]/route";
import { GET as questionsRoute } from "@/app/api/v2/questions/route";
import { POST as answerRoute } from "@/app/api/v2/questions/[id]/answers/route";

/**
 * E22 恢复演练（隔离环境）：用真实的备份函数做快照 → 之后继续改 → 把快照恢复回来 → 保持期 → 解除。
 * 覆盖 V2 新增的数据：课程语义层、校历/假日、规则、对话与问题、附件原件、资料关联、学习安排。
 * 规划时钟固定在 2026-10-12（周一）18:30。不涉及生产库、不涉及旧 Todo 服务；真实邮件与真实模型都没有参与。
 */

const NOW = new Date("2026-10-12T18:30:00+08:00");
const TZ = "Asia/Shanghai";
const SDCT = ["SDCT1", "T=18", "P=1,08:15-09:00;2,09:10-09:55;3,10:15-11:00;4,11:10-11:55", "C=高等数学|张老师|A101|3|1-2|1-18|A|-", "C=线性代数|赵老师|D404|5|3-4|1-18|A|-"].join("\n");
const ctx = () => ({ intakeId: null, itemId: null, itemKey: "", instanceEpoch: 0, evidence: "", explicit: true, now: NOW });

let sessionToken = "";
let csrfToken = "";
let seq = 0;
let modelCalls = 0;
let fetches = 0;
let backupFile = "";
let attachmentHash = "";
let pendingIntake = "";
let ruleBatch = "";
let taskBatch = "";
let weekBefore = "";
let exportBefore: Record<string, unknown[]> = {};

function req(url: string, method: string, body?: unknown): NextRequest {
  return new NextRequest(`http://localhost${url}`, {
    method,
    headers: { cookie: `${SESSION_COOKIE}=${sessionToken}`, "x-csrf-token": csrfToken, "content-type": "application/json", ...(method === "POST" ? { "idempotency-key": `drill-${seq++}` } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}
async function drain() {
  for (let i = 0; i < 4; i++) await runDueJobsOnce();
}
async function say(text: string): Promise<{ intakeId: string; state: string; error: string }> {
  const res = await createIntakeRoute(req("/api/v2/intakes", "POST", { text }));
  assert.equal(res.status, 202, await res.clone().text());
  const { intakeId } = (await res.json()) as { intakeId: string };
  await drain();
  const got = (await (await getIntakeRoute(req(`/api/v2/intakes/${intakeId}`, "GET"), { params: Promise.resolve({ id: intakeId }) })).json()) as { result: { state: string; items: Array<{ error: string | null }> } };
  return { intakeId, state: got.result.state, error: got.result.items.map((i) => i.error ?? "").join("") };
}
const count = (sql: string, ...args: unknown[]) => (getDb().prepare(sql).get(...args) as { n: number }).n;
/** 与恢复点比较时不看的易变字段（时间戳、租约） */
const stable = (week: unknown) => JSON.stringify(week, (k, v) => (k === "generatedAt" ? undefined : v));
const tables = () => (JSON.parse(buildFullJson("x")) as { tables: Record<string, unknown[]> }).tables;

before(async () => {
  migrateAll();
  setNowForTests(NOW);
  createOwner(hashPassword("drill-test-pass"));
  const { token, session } = createSession(1);
  sessionToken = token;
  csrfToken = session.csrfToken;
  setProvidersForTests({
    model: {
      mode: "fixture",
      provider: new FakeModelProvider((r) => {
        modelCalls++;
        const text = ((r.context as { text?: string }).text ?? "").trim();
        return { ok: true, validatedResult: { items: [{ itemKey: "item-1", kind: "task", summary: text.slice(0, 40), excerpt: text.slice(0, 100) }] } };
      }),
    },
  });
  setCalendarFetcherForTests(async () => {
    fetches++;
    return { ok: false, error: "offline" } as never;
  });
});
after(() => {
  setNowForTests(null);
  setCalendarFetcherForTests(null);
});

test("准备：课程、校历、规则、任务与安排、资料、带附件的投递、一条还在等回答的投递；然后用真实备份函数做快照", async () => {
  const course = executeOperation({ command: "upsert_course_set", sdctText: SDCT, firstMonday: "2026-08-31", timezone: TZ }, ctx());
  assert.ok(course.result.ok, course.result.ok ? "" : course.result.error);
  const cal = executeOperation(
    { command: "upsert_academic_calendar", school: "演练大学", academicYear: "2026-2027", termLabel: "秋季学期", firstTeachingMonday: "2026-08-31", totalWeeks: 18, origin: "user", events: [{ kind: "other", title: "运动会停课", startDate: "2026-10-16", endDate: "2026-10-16", cancelsClasses: true }] },
    ctx(),
  );
  assert.ok(cal.result.ok, cal.result.ok ? "" : cal.result.error);
  const rule = executeOperation({ command: "update_planning_policy", rules: [{ kind: "weekday_limit", weekday: 3, value: { limitMinutes: 60 } }] }, ctx());
  assert.ok(rule.result.ok, rule.result.ok ? "" : rule.result.error);
  ruleBatch = rule.result.ok ? rule.result.batchId! : "";
  const task = executeOperation({ command: "create_or_update_task", title: "操作系统实验报告", estimateMinutes: 120, dueLocalDate: "2026-10-18" }, ctx());
  assert.ok(task.result.ok);
  taskBatch = task.result.ok ? task.result.batchId! : "";
  const res = executeOperation({ command: "link_resource", title: "实验要求", body: "按模板提交，含源码与截图", role: "requirement", origin: "user" }, ctx());
  assert.ok(res.result.ok, res.result.ok ? "" : res.result.error);

  // 带附件的投递：原件进 blob
  const form = new FormData();
  form.append("text", "这是实验指导书");
  form.append("files", new File(["第一章 实验环境\n第二章 提交要求"], "指导书.txt", { type: "text/plain" }));
  const up = await createIntakeRoute(new NextRequest("http://localhost/api/v2/intakes", { method: "POST", headers: { cookie: `${SESSION_COOKIE}=${sessionToken}`, "x-csrf-token": csrfToken, "idempotency-key": "drill-file" }, body: form }));
  assert.equal(up.status, 202);
  await drain();
  attachmentHash = (getDb().prepare(`SELECT blob_hash FROM intake_attachments LIMIT 1`).get() as { blob_hash: string }).blob_hash;

  // 一条停在提问上的投递（两个同名固定活动 → 只问选哪一个）
  for (const [wd, s, e] of [[2, "19:00", "20:00"], [6, "10:00", "11:00"]] as const) {
    getDb().prepare(`INSERT INTO fixed_events (id, title, weekday, local_start, local_end, timezone) VALUES (?, '家教', ?, ?, ?, ?)`).run(crypto.randomUUID(), wd, s, e, TZ);
  }
  const pending = await say("以后不去家教了");
  assert.equal(pending.state, "needs_input");
  pendingIntake = pending.intakeId;

  assert.ok(count(`SELECT COUNT(*) AS n FROM plan_sessions WHERE status IN ('planned','tentative')`) >= 1, "已有学习安排");
  weekBefore = stable(weekSnapshot("2026-10-12", NOW));
  exportBefore = tables();

  backupFile = path.join(path.dirname(process.env.DATABASE_PATH!), "drill-backup.db");
  await snapshotDatabase(process.env.DATABASE_PATH!, backupFile);
  assert.ok(fs.statSync(backupFile).size > 0);
});

test("备份之后继续使用，再把快照恢复回来：数据回到备份那一刻，课程/计划/规则/资料/原件的关联一致", async () => {
  // 备份之后的改动（恢复后不应存在）
  const later = executeOperation({ command: "create_or_update_task", title: "备份之后才加的任务", estimateMinutes: 30 }, ctx());
  assert.ok(later.result.ok);
  assert.notEqual(stable(weekSnapshot("2026-10-12", NOW)), weekBefore);

  // 恢复：与 scripts/restore 相同的步骤——原库改名保留、复制备份、迁移、写入保持状态
  const dbPath = process.env.DATABASE_PATH!;
  closeDb();
  for (const ext of ["", "-wal", "-shm"]) if (fs.existsSync(`${dbPath}${ext}`)) fs.renameSync(`${dbPath}${ext}`, `${dbPath}.pre-restore${ext}`);
  fs.copyFileSync(backupFile, dbPath, fs.constants.COPYFILE_EXCL);
  const m = runMigrations(getDb());
  assert.notEqual(m.kind, "too_new");
  const epochBefore = getInstanceState().deploymentEpoch;
  const hold = applyRestoreHold(getDb(), "drill-backup");
  assert.equal(hold.deploymentEpoch, epochBefore + 1);
  assert.ok(fs.existsSync(`${dbPath}.pre-restore`), "原数据库改名保留，没有删除");

  assert.equal(count(`SELECT COUNT(*) AS n FROM tasks WHERE title = '备份之后才加的任务'`), 0);
  assert.equal(stable(weekSnapshot("2026-10-12", NOW)), weekBefore, "本周快照（课程、预算、学习安排、规则）与备份时完全一致");
  const now = tables();
  for (const t of Object.keys(FULL_JSON_TABLES)) {
    if (t === "settings") continue;
    assert.equal(now[t]?.length ?? 0, exportBefore[t]?.length ?? 0, `${t} 行数与备份时一致`);
  }
  for (const t of ["academic_calendars", "academic_calendar_events", "planning_policy_rules", "conversations", "conversation_turns", "resource_links", "course_meeting_projections"]) {
    assert.ok((now[t]?.length ?? 0) > 0, `${t} 有数据且随备份回来了`);
  }
  // 原件可恢复：按内容哈希取回的字节与当初上传的一致
  const blob = getDb().prepare(`SELECT content FROM intake_blobs WHERE hash = ?`).get(attachmentHash) as { content: Buffer };
  assert.equal(blob.content.toString("utf8"), "第一章 实验环境\n第二章 提交要求");
  assert.equal(crypto.createHash("sha256").update(blob.content).digest("hex"), attachmentHash);
  // 课程投影没有悬空：每条投影都指向存在的固定活动与课程时段
  assert.equal(count(`SELECT COUNT(*) AS n FROM course_meeting_projections p WHERE NOT EXISTS (SELECT 1 FROM fixed_events f WHERE f.id = p.fixed_event_id) OR NOT EXISTS (SELECT 1 FROM course_meetings m WHERE m.id = p.meeting_id)`), 0);
  assert.equal(count(`SELECT COUNT(*) AS n FROM plan_sessions s WHERE NOT EXISTS (SELECT 1 FROM tasks t WHERE t.id = s.task_id)`), 0);
});

test("保持期：后台不跑任何任务——不调模型、不抓校历、不发邮件；页面读数据照常；过期的问题回答不会被执行", async () => {
  const [calls, fetched] = [modelCalls, fetches];
  const tick = await runDueJobsOnce();
  assert.equal(tick.held, true);
  assert.equal(tick.claimed, 0);
  // 保持期内新发的材料只被接收，不处理
  const res = await createIntakeRoute(req("/api/v2/intakes", "POST", { text: "保持期里发的一句话，预计二十分钟" }));
  assert.equal(res.status, 202);
  await drain();
  assert.deepEqual([modelCalls, fetches], [calls, fetched], "没有任何对外调用");
  assert.equal(count(`SELECT COUNT(*) AS n FROM deliveries WHERE status IN ('queued','submitting')`), 0);
  const digest = executeOperation({ command: "request_owner_digest", kind: "daily" }, ctx()).result;
  assert.deepEqual([digest.ok, digest.ok ? "" : digest.code], [false, "RESTORED_HOLD"]);
  assert.ok(JSON.parse(weekBefore).days.length === 7 && stable(weekSnapshot("2026-10-12", NOW)) === weekBefore, "读页面不受影响");

  // 备份里那条等回答的投递：现在回答，旧 epoch 的事项不执行
  const qs = ((await (await questionsRoute(req("/api/v2/questions", "GET"))).json()) as { questions: Array<{ id: string; version: number; options: string[] }> }).questions;
  const q = qs.find((x) => x.options.some((o) => o.startsWith("家教")))!;
  assert.ok(q, "问题随备份恢复出来了，上下文还在");
  await answerRoute(req(`/api/v2/questions/${q.id}/answers`, "POST", { text: q.options[0], expectedVersion: q.version }), { params: Promise.resolve({ id: q.id }) });
  await drain();
  assert.equal(count(`SELECT COUNT(*) AS n FROM fixed_events WHERE title = '家教'`), 2, "保持期内没有执行删除");
});

test("解除保持：旧后台任务取消、恢复前没处理完的投递停止并说明；之后新投递正常；撤销按版本核对，不覆盖后来的修改", async () => {
  const jobsHeld = count(`SELECT COUNT(*) AS n FROM jobs WHERE hold_state = 'restored_pending'`);
  const r = resumeAfterRestore(new Date());
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal(r.cancelledJobs, jobsHeld);
  assert.equal(getInstanceState().restoredHold, false);
  assert.equal(count(`SELECT COUNT(*) AS n FROM jobs WHERE hold_state = 'restored_pending'`), 0);

  // 恢复前挂着的那条：不再等回答、不会再执行，状态和原因看得见
  const stale = getDb().prepare(`SELECT status FROM intakes WHERE id = ?`).get(pendingIntake) as { status: string };
  assert.ok(["cancelled", "partially_applied"].includes(stale.status), stale.status);
  assert.equal(count(`SELECT COUNT(*) AS n FROM clarification_questions WHERE intake_id = ? AND status = 'open'`, pendingIntake), 0);
  assert.equal(count(`SELECT COUNT(*) AS n FROM fixed_events WHERE title = '家教'`), 2, "过期的选择没有被执行");
  assert.equal(count(`SELECT COUNT(*) AS n FROM intake_blobs WHERE hash = ?`, attachmentHash), 1, "原件还在");

  // 保持期里发的那句话现在被处理；新指令也正常
  await drain();
  assert.ok(count(`SELECT COUNT(*) AS n FROM tasks WHERE title LIKE '%保持期里发的一句话%'`) >= 1, "保持期内接收的材料在解除后处理");
  const fresh = await say("以后周五最多一小时");
  assert.equal(fresh.state, "applied", fresh.error);

  // 撤销恢复前的批次：规则那一批没人动过 → 可撤；任务那一批之后被改过 → 冲突，整体不动
  assert.equal(undoWithFollowUps(ruleBatch).kind, "undone");
  assert.equal(count(`SELECT COUNT(*) AS n FROM planning_policy_rules WHERE kind = 'weekday_limit' AND status = 'active' AND weekday = 3`), 0);
  const taskId = (getDb().prepare(`SELECT id FROM tasks WHERE title = '操作系统实验报告'`).get() as { id: string }).id;
  const edit = executeOperation({ command: "create_or_update_task", taskId, title: "操作系统实验报告（终稿）" }, ctx());
  assert.ok(edit.result.ok, edit.result.ok ? "" : edit.result.error);
  const undo = undoWithFollowUps(taskBatch);
  assert.equal(undo.kind, "conflict", "之后有新修改：撤销不覆盖它");
  assert.equal((getDb().prepare(`SELECT title FROM tasks WHERE id = ?`).get(taskId) as { title: string }).title, "操作系统实验报告（终稿）");
});
