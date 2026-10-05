import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { NextRequest } from "next/server";
import { migrateAll, getDb } from "./helpers";
import { createOwner, createSession, SESSION_COOKIE } from "@/domain/session";
import { hashPassword } from "@/domain/password";
import { setNowForTests } from "@/domain/clock";
import { executeCommand, undoWithFollowUps } from "@/workflows/commands";
import { directionSnapshot } from "@/workflows/snapshot";
import { buildFullJson } from "@/workflows/exports";
import { createProject } from "@/repositories/planning";
import { catalogProblems } from "@/domain/intent-catalog";
import { GET as directionRoute } from "@/app/api/v2/direction/route";
import { POST as actionsRoute } from "@/app/api/v2/actions/route";
import { STAGES, TRACKS } from "@/content/direction";
import { FULL_JSON_TABLES } from "@/contracts/exports";
import { createBatch, addChange, type ChangeInput } from "@/repositories/journal";
import { applyDirectionTrack, applyLinkDirectionProject } from "@/workflows/ops/direction-workspace";

/**
 * 方向页打磨 D0/D1：阶段模板与工作样本是编辑内容；主人确认的阶段/去向、关注方向、阶段项、项目关联、感受走注册操作；GET 只读。
 */

const NOW = new Date("2026-10-12T09:00:00+08:00");
const CTX = { intakeId: null, itemId: null, itemKey: "", instanceEpoch: 0, evidence: "", explicit: true, now: NOW };
let sessionToken = "";
let csrfToken = "";
let seq = 0;

function req(url: string): NextRequest {
  return new NextRequest(`http://localhost${url}`, { method: "GET", headers: { cookie: `${SESSION_COOKIE}=${sessionToken}` } });
}
function actionReq(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/v2/actions", {
    method: "POST",
    headers: { cookie: `${SESSION_COOKIE}=${sessionToken}`, "x-csrf-token": csrfToken, "content-type": "application/json", "idempotency-key": `dir-ws-${seq++}` },
    body: JSON.stringify(body),
  });
}
function run(command: Record<string, unknown>) {
  const r = executeCommand(command, CTX);
  assert.ok(r.ok, JSON.stringify(r));
  return r;
}
function n(table: string): number {
  return (getDb().prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

before(() => {
  migrateAll();
  setNowForTests(NOW);
  createOwner(hashPassword("dir-ws-pass"));
  const s = createSession(1);
  sessionToken = s.token;
  csrfToken = s.session.csrfToken;
});
after(() => setNowForTests(null));

test("内容目录：四年阶段与工作样本都是示例，不含学校硬政策或伪造个人经历", () => {
  assert.equal(STAGES.length, 4);
  assert.ok(TRACKS.length >= 4 && TRACKS.length <= 6);
  const blob = JSON.stringify({ STAGES, TRACKS });
  assert.doesNotMatch(blob, /录取率|保研|GPA|绩点|核心期刊|导师名额|竞赛获奖/);
  assert.ok(STAGES.every((s) => s.purpose && s.foundations.length && s.choices.length && s.outputs.length));
  assert.ok(TRACKS.every((t) => t.problem && t.sample.output && t.trial.verifies && t.basics.some((b) => !b.needed)));
});

test("意图目录与五个新操作对齐", () => {
  assert.deepEqual(catalogProblems(), []);
});

test("年级未知也能打开四年地图；GET 不建目标或任务", async () => {
  const before = { goals: n("goals"), tasks: n("tasks"), practice: n("practice_entries"), batches: n("agent_action_batches") };
  const snap = directionSnapshot(NOW);
  assert.equal(snap.profile.confirmedStage, null);
  assert.equal(snap.profile.entryYear, null);
  assert.equal(snap.roadmap.length, 4);
  assert.ok(snap.roadmap.every((s) => s.adopted.length === 0));
  assert.ok(snap.workSamples.length >= 4);
  const res = await directionRoute(req("/api/v2/direction"));
  assert.equal(res.status, 200);
  const body = (await res.json()) as typeof snap;
  assert.equal(body.roadmap.length, 4);
  assert.equal(body.candidates.length, 0);
  assert.deepEqual({ goals: n("goals"), tasks: n("tasks"), practice: n("practice_entries"), batches: n("agent_action_batches") }, before);
});

test("主人说偏科研并保留就业：保存并存偏好，不建全年待办", () => {
  const r = run({ command: "update_direction_profile", confirmedStage: "year1", pathPreferences: ["research", "employment", "undecided"] });
  assert.match(!r.ok ? "" : r.summary, /大一/);
  assert.match(!r.ok ? "" : r.summary, /科研/);
  assert.match(!r.ok ? "" : r.summary, /工程与就业/);
  const snap = directionSnapshot(NOW);
  assert.equal(snap.profile.confirmedStage, "year1");
  assert.deepEqual(snap.profile.pathPreferences, ["research", "employment"]);
  assert.equal(n("goals"), 0);
  assert.equal(n("tasks"), 0);
  const y1 = snap.roadmap.find((s) => s.key === "year1")!;
  assert.ok(y1.pathHints.research && y1.pathHints.employment);
});

test("采用阶段项不生成目标或任务；同一标题不重复", () => {
  const r = run({ command: "update_roadmap_item", stageKey: "year1", title: "做一个能讲清过程的小实验", purpose: "先体验提出问题到解释结果" });
  assert.match(!r.ok ? "" : r.summary, /没有生成任务/);
  const again = run({ command: "update_roadmap_item", stageKey: "year1", title: "做一个能讲清过程的小实验" });
  assert.match(!again.ok ? "" : again.summary, /已经采用过/);
  assert.equal(n("roadmap_items"), 1);
  assert.equal(n("goals"), 0);
  assert.equal(n("tasks"), 0);
});

test("关注方向、先不看了只改状态；关联项目保留", () => {
  const follow = run({ command: "upsert_direction_track", templateKey: "reliable_agents" });
  assert.match(!follow.ok ? "" : follow.summary, /没有建项目/);
  const track = getDb().prepare(`SELECT id, status FROM direction_tracks WHERE template_key = 'reliable_agents'`).get() as { id: string; status: string };
  assert.equal(track.status, "exploring");
  const project = createProject({ title: "失败用例分类", question: "Agent 为什么这次对下次错", expectedOutcome: "分类表", prerequisites: "", reviewQuestions: "", goalIds: [] });
  run({ command: "link_direction_project", projectId: project.id, trackId: track.id });
  const pause = run({ command: "upsert_direction_track", trackId: track.id, status: "paused" });
  assert.match(!pause.ok ? "" : pause.summary, /先不看了/);
  assert.match(!pause.ok ? "" : pause.summary, /没有暂停项目/);
  const p = getDb().prepare(`SELECT status FROM projects WHERE id = ?`).get(project.id) as { status: string };
  assert.equal(p.status, "active");
  const linked = getDb().prepare(`SELECT COUNT(*) AS n FROM direction_project_links WHERE track_id = ?`).get(track.id) as { n: number };
  assert.equal(linked.n, 1);
});

test("实践感受保存原话，同一段话重试不重复；不另记分钟", () => {
  const track = getDb().prepare(`SELECT id FROM direction_tracks WHERE template_key = 'reliable_agents'`).get() as { id: string };
  const r = run({ command: "record_direction_reflection", text: "做了四十分钟，但不喜欢一直调环境", trackId: track.id, occurredOn: "2026-10-11" });
  assert.match(!r.ok ? "" : r.summary, /原话/);
  const again = run({ command: "record_direction_reflection", text: "做了四十分钟，但不喜欢一直调环境", trackId: track.id, occurredOn: "2026-10-11" });
  assert.match(!again.ok ? "" : again.summary, /已经记过/);
  assert.equal(n("direction_reflections"), 1);
  assert.equal(n("practice_entries"), 0);
  const row = getDb().prepare(`SELECT original_text FROM direction_reflections`).get() as { original_text: string };
  assert.equal(row.original_text, "做了四十分钟，但不喜欢一直调环境");
});

test("资料记为线索不建任务；撤销阶段偏好能回到未确认", () => {
  const track = getDb().prepare(`SELECT id FROM direction_tracks WHERE template_key = 'reliable_agents'`).get() as { id: string };
  const tasksBefore = n("tasks");
  run({ command: "link_resource", title: "老师个人主页", url: "https://example.org/teacher", trackId: track.id, stageKey: "year1", noteKind: "advice", origin: "user" });
  assert.equal(n("tasks"), tasksBefore);
  const notes = directionSnapshot(NOW).notes;
  assert.equal(notes[0]?.noteKind, "advice");
  const profile = run({ command: "update_direction_profile", confirmedStage: null, expectedVersion: directionSnapshot(NOW).profile.version });
  assert.ok(profile.ok && profile.batchId);
  const undone = undoWithFollowUps(profile.batchId!);
  assert.equal(undone.kind, "undone");
  assert.equal(directionSnapshot(NOW).profile.confirmedStage, "year1");
});

test("导出包含新表白名单；快照里候选上限为 3", () => {
  for (const t of ["direction_profile", "direction_tracks", "roadmap_items", "direction_project_links", "direction_reflections"]) {
    assert.ok(FULL_JSON_TABLES[t], t);
  }
  const json = JSON.parse(buildFullJson(NOW.toISOString())) as { tables: Record<string, unknown[]> };
  assert.equal(json.tables.direction_profile.length, 1);
  assert.ok(json.tables.direction_tracks.length >= 1);
  assert.ok(json.tables.direction_reflections.length >= 1);
  assert.equal(directionSnapshot(NOW).candidates.length, 0);
});

test("F01 未建配置时 expectedVersion=0 与页面首次点击一致；已被别人创建则冲突", async () => {
  getDb().prepare(`DELETE FROM direction_profile`).run();
  assert.equal(directionSnapshot(NOW).profile.version, 0);
  const res = await actionsRoute(actionReq({ operation: "update_direction_profile", args: { expectedVersion: 0, confirmedStage: "year1" } }));
  assert.equal(res.status, 200, await res.clone().text());
  assert.equal(directionSnapshot(NOW).profile.confirmedStage, "year1");
  const raced = executeCommand({ command: "update_direction_profile", expectedVersion: 0, pathPreferences: ["research"] }, CTX);
  assert.equal(raced.ok, false);
  assert.equal(!raced.ok && raced.code, "STALE_VERSION");
  assert.equal(directionSnapshot(NOW).profile.confirmedStage, "year1");
  assert.deepEqual(directionSnapshot(NOW).profile.pathPreferences, []);
});

test("F03 关注后工作样本步骤和基础仍在目录里", () => {
  const snap = directionSnapshot(NOW);
  assert.equal(snap.workSamples.length, TRACKS.length);
  const followed = snap.workSamples.find((s) => s.templateKey === "reliable_agents");
  assert.ok(followed?.follow);
  assert.ok(followed!.sample.steps.length >= 3);
  assert.ok(followed!.basics.some((b) => b.needed));
  assert.ok(followed!.trial.title);
  run({ command: "upsert_direction_track", trackId: followed!.follow!.id, status: "paused" });
  const after = directionSnapshot(NOW).workSamples.find((s) => s.templateKey === "reliable_agents")!;
  assert.equal(after.follow?.status, "paused");
  assert.deepEqual(after.sample.steps, followed!.sample.steps);
});

test("F02 后续单独关联后撤销创建返回冲突，不抛外键；同批次创建并关联可整批撤销", () => {
  const created = run({ command: "upsert_direction_track", templateKey: "data_quality" });
  assert.ok(created.ok && created.batchId);
  const trackId = (getDb().prepare(`SELECT id FROM direction_tracks WHERE template_key = 'data_quality'`).get() as { id: string }).id;
  const project = createProject({ title: "数据集检查", question: "数据里有没有标错", expectedOutcome: "检查报告", prerequisites: "", reviewQuestions: "", goalIds: [] });
  run({ command: "link_direction_project", projectId: project.id, trackId });
  const blocked = undoWithFollowUps(created.batchId!);
  assert.equal(blocked.kind, "conflict");
  if (blocked.kind === "conflict") assert.match(blocked.conflicts.join("；"), /关联|感受|线索|阶段项/);
  assert.equal((getDb().prepare(`SELECT COUNT(*) AS n FROM direction_tracks WHERE id = ?`).get(trackId) as { n: number }).n, 1);
  assert.equal((getDb().prepare(`SELECT COUNT(*) AS n FROM direction_project_links WHERE track_id = ?`).get(trackId) as { n: number }).n, 1);

  const changes: ChangeInput[] = [];
  const other = createProject({ title: "图像认错分析", question: "哪些图会认错", expectedOutcome: "认错记录", prerequisites: "", reviewQuestions: "", goalIds: [] });
  getDb().transaction(() => {
    applyDirectionTrack({ command: "upsert_direction_track", trackId: null, expectedVersion: null, templateKey: "vision", title: undefined, status: undefined, ownerNotes: undefined }, CTX, changes);
    const visionId = (getDb().prepare(`SELECT id FROM direction_tracks WHERE template_key = 'vision'`).get() as { id: string }).id;
    applyLinkDirectionProject({ command: "link_direction_project", projectId: other.id, trackId: visionId, roadmapItemId: undefined, remove: false }, CTX, changes);
  })();
  const batchId = createBatch({ command: "upsert_direction_track", reason: "同批次关注并关联", intakeId: null, itemId: null, policyVersion: "v2-p2", instanceEpoch: 0, conversationId: null });
  for (const c of changes) addChange(batchId, c);
  const undone = undoWithFollowUps(batchId);
  assert.equal(undone.kind, "undone", JSON.stringify(undone));
  assert.equal((getDb().prepare(`SELECT COUNT(*) AS n FROM direction_tracks WHERE template_key = 'vision'`).get() as { n: number }).n, 0);
  assert.equal((getDb().prepare(`SELECT COUNT(*) AS n FROM direction_project_links WHERE project_id = ?`).get(other.id) as { n: number }).n, 0);
});

