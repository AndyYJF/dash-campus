import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { before, test } from "node:test";
import { NextRequest } from "next/server";
import { migrateAll, getDb } from "./helpers";
import { resetConfigCache } from "@/config";
import { DEMO_LIMITS, DEMO_SESSION_COOKIE, demoBlockedReason, demoRateHit, demoWriteLimited, resetDemoRateLimits } from "@/domain/demo";
import { SESSION_COOKIE, sessionCookieName } from "@/domain/session";
import { verifyPassword } from "@/domain/password";
import { DEMO_MARKER_KEY, demoResetDue, demoStartupProblem, demoStatus, lastResetPoint, maintainDemo, readDemoMarker, resetDemoData } from "@/workflows/demo";
import { getAiBudget } from "@/workflows/ai-budget";
import { executeCommand } from "@/workflows/commands";
import { resolveMailer } from "@/integrations/mailer";
import { exportsDir } from "@/workflows/exports";
import { MODEL_CAPABILITIES_SETTINGS_KEY } from "@/contracts/model-capabilities";
import { GET as demoRoute } from "@/app/api/v1/demo/route";
import { POST as enterRoute } from "@/app/api/v1/demo/enter/route";
import { POST as resetRoute } from "@/app/api/v1/demo/reset/route";
import { POST as loginRoute } from "@/app/api/v1/auth/login/route";
import { POST as setupRoute } from "@/app/api/v1/setup/route";
import { GET as sessionsRoute } from "@/app/api/v1/auth/sessions/route";
import { DELETE as revokeSessionRoute } from "@/app/api/v1/auth/sessions/[id]/route";
import { POST as mailTestRoute } from "@/app/api/v1/mail/test/route";
import { GET as legacyRoute } from "@/app/api/v1/legacy/route";
import { PATCH as budgetRoute } from "@/app/api/v1/ai-budget/route";
import { GET as dashboardRoute } from "@/app/api/v2/dashboard/route";
import { GET as tasksRoute } from "@/app/api/v1/tasks/route";

/**
 * 展示模式（docs/demo-mode.md）：免登录的演示实例。
 * 最要紧的是两头的保险——演示模式不肯连正式库、重置不肯清正式库；其次是护栏、额度封顶、重置后的数据完整。
 */

const BASE = "http://localhost";
const CTX = { intakeId: null, itemId: null, itemKey: "", instanceEpoch: 0, evidence: "test" };
/** 周五中午：每日恢复点 04:00 已过 */
const NOON = new Date("2026-10-09T12:00:00+08:00");

function setDemo(on: boolean, extra: Record<string, string | undefined> = {}): void {
  if (on) process.env.DEMO_MODE = "1";
  else delete process.env.DEMO_MODE;
  for (const [k, v] of Object.entries(extra)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  resetConfigCache();
}

function count(table: string): number {
  return (getDb().prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get() as { n: number }).n;
}

type Visitor = { cookie: string; csrf: string; sessionId: string };

async function enter(ip = "203.0.113.7"): Promise<Visitor> {
  const res = await enterRoute(new NextRequest(`${BASE}/api/v1/demo/enter`, { method: "POST", headers: { "x-forwarded-for": ip } }));
  assert.equal(res.status, 200);
  const body = (await res.json()) as { csrfToken: string; sessionId: string };
  const cookie = res.cookies.get(DEMO_SESSION_COOKIE);
  assert.ok(cookie, "访客会话写在演示专用的 Cookie 里");
  assert.equal(res.cookies.get(SESSION_COOKIE), undefined, "不覆盖正式实例的会话 Cookie");
  return { cookie: `${DEMO_SESSION_COOKIE}=${cookie.value}`, csrf: body.csrfToken, sessionId: body.sessionId };
}

function as(v: Visitor, path: string, method = "GET", body?: unknown): NextRequest {
  return new NextRequest(`${BASE}${path}`, {
    method,
    headers: { cookie: v.cookie, "x-csrf-token": v.csrf, "content-type": "application/json", "x-forwarded-for": "203.0.113.7" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

before(() => {
  migrateAll();
});

test("正式实例：没有演示入口时什么都不变；配了 DEMO_URL 只多一个公开的入口地址", async () => {
  setDemo(false);
  assert.deepEqual(demoStatus(), { demo: false, demoUrl: null });
  assert.equal(sessionCookieName(), SESSION_COOKIE);
  const res = await enterRoute(new NextRequest(`${BASE}/api/v1/demo/enter`, { method: "POST" }));
  assert.equal(res.status, 404, "正式实例上不能领访客会话");
  assert.equal(count("sessions"), 0);
  const reset = await resetRoute(new NextRequest(`${BASE}/api/v1/demo/reset`, { method: "POST" }));
  assert.equal(reset.status, 404);

  setDemo(false, { DEMO_URL: "https://demo.example.org" });
  const body = (await demoRoute().json()) as { demo: boolean; demoUrl: string | null };
  assert.deepEqual(body, { demo: false, demoUrl: "https://demo.example.org" });
  setDemo(false, { DEMO_URL: undefined });
});

test("保险：演示模式不肯连没有演示标记的库，重置也不肯清已有主人的正式库", async () => {
  setDemo(true);
  assert.match(demoStartupProblem() ?? "", /不是演示库/);
  const early = await enterRoute(new NextRequest(`${BASE}/api/v1/demo/enter`, { method: "POST" }));
  assert.equal(early.status, 503, "没有演示标记的库不发访客会话");
  assert.equal(count("sessions"), 0);

  // 模拟“把演示模式指到了正式库”：库里已有主人和业务数据、没有演示标记
  const db = getDb();
  db.prepare(`INSERT INTO owner (id, password_hash, created_at, setup_completed_at) VALUES (1, 'real-owner-hash', ?, ?)`).run(NOON.toISOString(), NOON.toISOString());
  const created = executeCommand({ command: "create_or_update_task", title: "正式库里的真实任务", taskKind: "study", estimateMinutes: 30 }, CTX);
  assert.ok(created.ok);
  assert.throws(() => resetDemoData(NOON), /拒绝重置/);
  assert.equal(maintainDemo(NOON), false, "没有标记的库不会被定时恢复");
  assert.equal(count("tasks"), 1, "正式数据原样保留");
  assert.equal((db.prepare(`SELECT password_hash FROM owner WHERE id = 1`).get() as { password_hash: string }).password_hash, "real-owner-hash");
  assert.equal(readDemoMarker(), null);

  // 还原成全新的库，后面的用例从空库建演示数据
  db.prepare(`DELETE FROM tasks`).run();
  db.prepare(`DELETE FROM agent_action_changes`).run();
  db.prepare(`DELETE FROM agent_action_batches`).run();
  db.prepare(`DELETE FROM entity_source_links`).run();
  db.prepare(`DELETE FROM jobs`).run();
  db.prepare(`DELETE FROM owner`).run();
});

test("全新的库：恢复示例后有完整的一周数据，主人没有可用密码，启动检查通过", async () => {
  setDemo(true);
  const r = resetDemoData(NOON);
  assert.equal(readDemoMarker()?.seededAt, r.seededAt);
  assert.equal(demoStartupProblem(), null);

  for (const table of ["courses", "course_meetings", "fixed_events", "goals", "projects", "tasks", "plan_sessions", "practice_entries", "daily_logs", "direction_tracks", "roadmap_items", "candidates", "evidence_documents", "inbox_messages", "reviews", "proposals", "conversation_turns", "resources"]) {
    assert.ok(count(table) > 0, `${table} 应该有示例数据`);
  }
  // 学习块是重排算出来的，全部落在恢复时刻之后
  const earliest = (getDb().prepare(`SELECT MIN(start_utc) AS s FROM plan_sessions WHERE status = 'planned'`).get() as { s: string }).s;
  assert.ok(new Date(earliest).getTime() >= NOON.getTime());
  // 事先写好的 AI 内容标为示例，不冒充真实模型的产出
  assert.deepEqual(getDb().prepare(`SELECT DISTINCT integration_mode AS m FROM exploration_runs`).all(), [{ m: "fixture" }]);
  assert.deepEqual(getDb().prepare(`SELECT DISTINCT integration_mode AS m FROM reviews`).all(), [{ m: "fixture" }]);

  const hash = (getDb().prepare(`SELECT password_hash FROM owner WHERE id = 1`).get() as { password_hash: string }).password_hash;
  assert.ok(!verifyPassword("", hash) && !verifyPassword("demo", hash) && !verifyPassword(hash, hash));
  const login = await loginRoute(new NextRequest(`${BASE}/api/v1/auth/login`, { method: "POST", body: JSON.stringify({ password: hash }) }));
  assert.equal(login.status, 403);
  assert.equal(((await login.json()) as { error: { code: string } }).error.code, "DEMO_DISABLED");
  process.env.SETUP_TOKEN = "test-setup-token";
  const setup = await setupRoute(new NextRequest(`${BASE}/api/v1/setup`, { method: "POST", body: JSON.stringify({ token: "test-setup-token", password: "new-password-1" }) }));
  assert.equal(setup.status, 403);

  // 反过来：演示库不能当正式库启动
  setDemo(false);
  assert.match(demoStartupProblem() ?? "", /演示库/);
  setDemo(true);
});

test("访客不输密码就能进入：领到会话后读写接口照常，没有会话仍是 401", async () => {
  setDemo(true);
  resetDemoRateLimits();
  const anonymous = await dashboardRoute(new NextRequest(`${BASE}/api/v2/dashboard`));
  assert.equal(anonymous.status, 401);

  const v = await enter();
  assert.equal((await dashboardRoute(as(v, "/api/v2/dashboard"))).status, 200);
  const tasks = (await (await tasksRoute(as(v, "/api/v1/tasks"))).json()) as { tasks: unknown[] };
  assert.ok(tasks.tasks.length >= 10);

  // 已有访客会话再进一次：沿用同一个，不重复建
  const before = count("sessions");
  const again = await enterRoute(new NextRequest(`${BASE}/api/v1/demo/enter`, { method: "POST", headers: { cookie: v.cookie } }));
  assert.equal(((await again.json()) as { sessionId: string }).sessionId, v.sessionId);
  assert.equal(count("sessions"), before);

  // 访客会话一天有效
  const row = getDb().prepare(`SELECT created_at, expires_at FROM sessions WHERE id = ?`).get(v.sessionId) as { created_at: string; expires_at: string };
  assert.equal(new Date(row.expires_at).getTime() - new Date(row.created_at).getTime(), 24 * 60 * 60 * 1000);
});

test("护栏：对外入口关闭、看不到也动不了别的访客、不发邮件", async () => {
  setDemo(true);
  resetDemoRateLimits();
  const a = await enter("203.0.113.7");
  const b = await enter("203.0.113.8");

  const blocked = async (res: Response) => {
    assert.equal(res.status, 403);
    assert.equal(((await res.json()) as { error: { code: string } }).error.code, "DEMO_DISABLED");
  };
  await blocked(await mailTestRoute(as(a, "/api/v1/mail/test", "POST")));
  await blocked(await legacyRoute(as(a, "/api/v1/legacy?server=1")));
  await blocked(await revokeSessionRoute(as(a, `/api/v1/auth/sessions/${b.sessionId}`, "DELETE"), { params: Promise.resolve({ id: b.sessionId }) }));
  assert.equal((await dashboardRoute(as(b, "/api/v2/dashboard"))).status, 200, "别的访客的会话没有被撤销");

  const mine = (await (await sessionsRoute(as(a, "/api/v1/auth/sessions"))).json()) as { sessions: Array<{ id: string }> };
  assert.deepEqual(mine.sessions.map((s) => s.id), [a.sessionId]);

  for (const [method, path] of [["POST", "/api/v1/legacy/apply"], ["POST", "/api/v1/inbox/sources"], ["PATCH", "/api/v1/inbox/sources/x"], ["POST", "/api/v1/deliveries/abc/resend"], ["POST", "/api/v1/integrations/model-capabilities"]]) {
    assert.ok(demoBlockedReason(method, path), `${method} ${path} 应该关闭`);
  }
  for (const [method, path] of [["POST", "/api/v2/intakes"], ["POST", "/api/v1/tasks"], ["GET", "/api/v1/inbox/sources"], ["GET", "/api/v1/integrations/model-capabilities"], ["POST", "/api/v1/exports"], ["POST", "/api/v1/explorations"]]) {
    assert.equal(demoBlockedReason(method, path), null, `${method} ${path} 应该保留`);
  }

  // 即使环境里误配了 SMTP，演示实例也不发信
  setDemo(true, { SMTP_HOST: "smtp.example.org", SMTP_USER: "u", SMTP_PASSWORD: "p", MAIL_FROM: "a@example.org", MAIL_TO: "b@example.org" });
  assert.equal(resolveMailer(), null);
  setDemo(true, { SMTP_HOST: undefined, SMTP_USER: undefined, SMTP_PASSWORD: undefined, MAIL_FROM: undefined, MAIL_TO: undefined });
});

test("额度：全站每日上限由环境变量封顶，访客调不上去", async () => {
  setDemo(true, { DEMO_DAILY_MODEL_CALLS: "120", DEMO_DAILY_SEARCH_CALLS: "5" });
  resetDemoRateLimits();
  assert.equal(getAiBudget().budget.dailyModelCalls, 120);
  const v = await enter();
  const res = await budgetRoute(as(v, "/api/v1/ai-budget", "PATCH", { expectedVersion: getAiBudget().version, dailyModelCalls: 1000, dailySearchCalls: 1000 }));
  assert.equal(res.status, 200);
  assert.equal(getAiBudget().budget.dailyModelCalls, 120);
  assert.equal(getAiBudget().budget.dailySearchCalls, 5);
  const status = demoStatus();
  assert.ok(status.demo && status.ai.limit === 120);
  // 访客可以调低，调低是生效的
  await budgetRoute(as(v, "/api/v1/ai-budget", "PATCH", { expectedVersion: getAiBudget().version, dailyModelCalls: 10 }));
  assert.equal(getAiBudget().budget.dailyModelCalls, 10);
  setDemo(true, { DEMO_DAILY_MODEL_CALLS: undefined, DEMO_DAILY_SEARCH_CALLS: undefined });
});

test("限速：写入与 AI 请求按访客和来源地址计数，超过后返回 429", async () => {
  setDemo(true);
  resetDemoRateLimits();
  assert.equal(demoRateHit("k", 2, 1000), null);
  assert.equal(demoRateHit("k", 2, 2000), null);
  assert.ok((demoRateHit("k", 2, 3000) ?? 0) > 0);
  assert.equal(demoRateHit("k", 2, 1000 + 10 * 60 * 1000), null, "窗口过去后恢复");

  resetDemoRateLimits();
  for (let i = 0; i < DEMO_LIMITS.session.ai; i++) assert.equal(demoWriteLimited({ sessionId: "s1", client: `c${i}`, pathname: "/api/v2/intakes" }), null);
  assert.ok(demoWriteLimited({ sessionId: "s1", client: "c-new", pathname: "/api/v2/intakes" }) !== null, "同一访客的 AI 请求到上限");
  assert.equal(demoWriteLimited({ sessionId: "s1", client: "c-new", pathname: "/api/v1/tasks" }), null, "普通写入不受 AI 上限影响");
  assert.equal(demoWriteLimited({ sessionId: "s2", client: "c-new", pathname: "/api/v2/intakes" }), null, "别的访客不受影响");

  // 走到接口层：同一来源地址领会话过多被拒
  resetDemoRateLimits();
  for (let i = 0; i < DEMO_LIMITS.enterPerClient; i++) await enter("198.51.100.9");
  const res = await enterRoute(new NextRequest(`${BASE}/api/v1/demo/enter`, { method: "POST", headers: { "x-forwarded-for": "198.51.100.9" } }));
  assert.equal(res.status, 429);
  assert.ok(res.headers.get("retry-after"));
  resetDemoRateLimits();
});

test("恢复示例：访客的改动清掉，会话、当天 AI 账目、模型探测结论和资讯盘点保留", async () => {
  setDemo(true);
  resetDemoRateLimits();
  const db = getDb();
  // 用一个早已过去的日子，最后走接口的那次手动恢复（按真实时钟）才不会撞上最短间隔
  const start = new Date("2026-09-01T12:00:00+08:00");
  const later = new Date(start.getTime() + 60 * 60 * 1000);
  resetDemoData(start);
  const baseline = Object.fromEntries(["tasks", "plan_sessions", "courses", "candidates", "inbox_messages", "goals", "projects", "practice_entries"].map((t) => [t, count(t)]));

  const v = await enter();
  assert.ok(executeCommand({ command: "create_or_update_task", title: "访客乱加的任务", taskKind: "study", estimateMinutes: 600 }, CTX).ok);
  db.prepare(`UPDATE tasks SET title = '被访客改掉的标题'`).run();
  db.prepare(`UPDATE goals SET title = '被访客改掉的目标'`).run();
  const today = "2026-09-01";
  db.prepare(`INSERT INTO ai_request_ledger (id, local_date, created_at, workflow, decision_id, attempt, status) VALUES ('today-1', ?, ?, 'w', 'd1', 1, 'ok'), ('old-1', '2026-08-20', ?, 'w', 'd2', 1, 'ok')`).run(today, start.toISOString(), start.toISOString());
  db.prepare(`INSERT INTO settings (key, value_json, version, updated_at) VALUES (?, '{"probed":true}', 1, ?)`).run(MODEL_CAPABILITIES_SETTINGS_KEY, start.toISOString());
  db.prepare(`DELETE FROM ai_news_runs`).run();
  db.prepare(`INSERT INTO ai_news_runs (id, trigger, status, days, policy_version, sources_json, digest_json, warnings_json, created_at, updated_at, generated_at) VALUES ('news-1', 'scheduled', 'ready', 7, 0, '[]', '{"stories":[]}', '[]', ?, ?, ?)`).run(start.toISOString(), start.toISOString(), start.toISOString());

  const exportFile = path.join(exportsDir(), "visitor-export.json");
  fs.mkdirSync(exportsDir(), { recursive: true });
  fs.writeFileSync(exportFile, "{}");

  resetDemoData(later);
  assert.ok(!fs.existsSync(exportFile), "访客生成的导出文件随恢复删除");
  for (const [table, n] of Object.entries(baseline)) assert.equal(count(table), n, `${table} 恢复成初始数量`);
  assert.equal(db.prepare(`SELECT 1 FROM tasks WHERE title IN ('访客乱加的任务', '被访客改掉的标题')`).get(), undefined);
  assert.equal(db.prepare(`SELECT 1 FROM goals WHERE title = '被访客改掉的目标'`).get(), undefined);
  assert.equal((await dashboardRoute(as(v, "/api/v2/dashboard"))).status, 200, "恢复不踢掉访客");
  assert.deepEqual(db.prepare(`SELECT id FROM ai_request_ledger`).all(), [{ id: "today-1" }], "当天账目保留，不能靠恢复刷新额度");
  assert.ok(db.prepare(`SELECT 1 FROM settings WHERE key = ?`).get(MODEL_CAPABILITIES_SETTINGS_KEY));
  assert.deepEqual(db.prepare(`SELECT id, status, job_id FROM ai_news_runs`).all(), [{ id: "news-1", status: "ready", job_id: null }], "已有盘点保留，不再排一次更新");
  assert.equal(count("idempotency_keys"), 0);
  assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM settings WHERE key = ?`).get(DEMO_MARKER_KEY) as { n: number }).n, 1);

  // 手动恢复有最短间隔
  const soon = await resetRoute(as(v, "/api/v1/demo/reset", "POST"));
  assert.equal(soon.status, 200, "距上次恢复已超过最短间隔");
  const again = await resetRoute(as(v, "/api/v1/demo/reset", "POST"));
  assert.equal(again.status, 429);
});

test("每日恢复：过了恢复钟点且上次恢复在它之前才执行，同一天不重复", () => {
  setDemo(true, { DEMO_RESET_HOUR: "4" });
  resetDemoData(new Date("2026-10-09T03:00:00+08:00"));
  assert.equal(lastResetPoint(new Date("2026-10-09T03:30:00+08:00")).toISOString(), new Date("2026-10-08T04:00:00+08:00").toISOString());
  assert.equal(demoResetDue(new Date("2026-10-09T03:59:00+08:00")), false);
  assert.equal(demoResetDue(new Date("2026-10-09T04:00:01+08:00")), true);
  assert.equal(maintainDemo(new Date("2026-10-09T04:00:01+08:00")), true);
  assert.equal(maintainDemo(new Date("2026-10-09T04:05:00+08:00")), false);
  assert.equal(maintainDemo(new Date("2026-10-09T23:00:00+08:00")), false);
  assert.equal(maintainDemo(new Date("2026-10-10T04:00:30+08:00")), true);
  setDemo(true, { DEMO_RESET_HOUR: undefined });
});

test("示例数据不挑日子：一周七天、学期中任意一天恢复都能完整生成", () => {
  setDemo(true);
  for (let i = 0; i < 7; i++) {
    for (const hour of ["00:10", "13:30", "23:50"]) {
      const at = new Date(new Date(`2026-11-0${2 + i}T${hour}:00+08:00`).getTime());
      assert.doesNotThrow(() => resetDemoData(at), `恢复失败：${at.toISOString()}`);
      assert.ok(count("plan_sessions") > 0, `${at.toISOString()} 没有排出学习块`);
      assert.equal(count("reviews"), 1);
      assert.equal(count("candidates"), 3);
    }
  }
  // 跨年、月底
  for (const iso of ["2026-12-31T22:00:00+08:00", "2027-01-01T09:00:00+08:00", "2027-02-28T09:00:00+08:00"]) {
    assert.doesNotThrow(() => resetDemoData(new Date(iso)), `恢复失败：${iso}`);
  }
});
