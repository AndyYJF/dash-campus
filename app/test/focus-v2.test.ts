import assert from "node:assert/strict";
import { before, test } from "node:test";
import { NextRequest } from "next/server";
import { migrateAll, getDb } from "./helpers";
import { createOwner, createSession, SESSION_COOKIE } from "@/domain/session";
import { hashPassword } from "@/domain/password";
import { executeCommand } from "@/workflows/commands";
import { POST as focusStartRoute } from "@/app/api/v2/focus/route";
import { POST as focusActionRoute } from "@/app/api/v2/focus/[id]/[action]/route";

/** P6 focus 计时（MASTER-PLAN §5.1/§6.3、A08）：最多 1 个进行中；停止落 timer 实践；同日手动+计时合并不双计；>4h 需确认。 */

const CTX = { intakeId: null, itemId: null, itemKey: "", instanceEpoch: 0, evidence: "test" };
let sessionToken = "";
let csrfToken = "";

function authedReq(url: string, body: unknown, key: string): NextRequest {
  return new NextRequest(`http://localhost${url}`, {
    method: "POST",
    headers: { cookie: `${SESSION_COOKIE}=${sessionToken}`, "x-csrf-token": csrfToken, "content-type": "application/json", "idempotency-key": key },
    body: JSON.stringify(body),
  });
}

function params(id: string, action: string) {
  return { params: Promise.resolve({ id, action }) };
}

before(() => {
  migrateAll();
  createOwner(hashPassword("focus-test-pass"));
  const { token, session } = createSession(1);
  sessionToken = token;
  csrfToken = session.csrfToken;
});

test("focus：最多 1 个进行中；重复 start 幂等不新增", async () => {
  const r1 = await focusStartRoute(authedReq("/api/v2/focus", { note: "学数学" }, "idem-f1"));
  assert.equal(r1.status, 201);
  const r2 = await focusStartRoute(authedReq("/api/v2/focus", { note: "学语文" }, "idem-f2"));
  assert.equal(r2.status, 409, "已有进行中计时，第二个 start 拒绝");
  const rows = getDb().prepare(`SELECT COUNT(*) AS n FROM focus_sessions WHERE status = 'in_progress'`).get() as { n: number };
  assert.equal(rows.n, 1);
});

test("focus：stop 落 timer 实践记录，分钟数来自计时", async () => {
  const f = getDb().prepare(`SELECT id, version FROM focus_sessions WHERE status = 'in_progress'`).get() as { id: string; version: number };
  getDb().prepare(`UPDATE focus_sessions SET started_at = ? WHERE id = ?`).run(new Date(Date.now() - 40 * 60000).toISOString(), f.id);
  const res = await focusActionRoute(authedReq(`/api/v2/focus/${f.id}/stop`, { expectedVersion: f.version }, "idem-fstop"), params(f.id, "stop"));
  assert.equal(res.status, 200);
  const p = getDb().prepare(`SELECT * FROM practice_entries WHERE minutes_origin = 'timer' ORDER BY created_at DESC LIMIT 1`).get() as { actual_minutes: number } | undefined;
  assert.ok(p, "应落一条 timer 实践");
  assert.ok(p!.actual_minutes >= 39 && p!.actual_minutes <= 41, `分钟数≈40，实际 ${p!.actual_minutes}`);
});

test("A08：同日手动 40min + 计时 38min 合并不双计", async () => {
  const today = new Date().toISOString().slice(0, 10);
  executeCommand({ command: "record_practice", occurredOn: today, actualMinutes: 40, note: "学数学" }, CTX);
  await focusStartRoute(authedReq("/api/v2/focus", { note: "学数学" }, "idem-f3"));
  const f = getDb().prepare(`SELECT id, version FROM focus_sessions WHERE status = 'in_progress'`).get() as { id: string; version: number };
  getDb().prepare(`UPDATE focus_sessions SET started_at = ? WHERE id = ?`).run(new Date(Date.now() - 38 * 60000).toISOString(), f.id);
  const res = await focusActionRoute(authedReq(`/api/v2/focus/${f.id}/stop`, { expectedVersion: f.version }, "idem-fstop2"), params(f.id, "stop"));
  assert.equal(res.status, 200);
  const body = (await res.json()) as { merged: boolean };
  assert.equal(body.merged, true, "应识别为同一实践并合并");
  const manualRows = getDb().prepare(`SELECT actual_minutes, note FROM practice_entries WHERE occurred_on = ? AND minutes_origin = 'user_reported'`).all(today) as Array<{ actual_minutes: number; note: string }>;
  assert.equal(manualRows.length, 1, "合并不新增手动条目");
  assert.equal(manualRows[0]!.actual_minutes, 40, "actual 不翻倍");
  assert.match(manualRows[0]!.note, /计时确认 38 分钟/, "原记录标注计时确认");
});

test("focus：>4h 计时需确认才计入", async () => {
  await focusStartRoute(authedReq("/api/v2/focus", { note: "马拉松" }, "idem-f4"));
  const f = getDb().prepare(`SELECT id, version FROM focus_sessions WHERE status = 'in_progress'`).get() as { id: string; version: number };
  getDb().prepare(`UPDATE focus_sessions SET started_at = ? WHERE id = ?`).run(new Date(Date.now() - 5 * 3600_000).toISOString(), f.id);
  const res = await focusActionRoute(authedReq(`/api/v2/focus/${f.id}/stop`, { expectedVersion: f.version }, "idem-fstop3"), params(f.id, "stop"));
  assert.equal(res.status, 409, "超过 4 小时需要显式确认");
  const still = getDb().prepare(`SELECT status FROM focus_sessions WHERE id = ?`).get(f.id) as { status: string };
  assert.equal(still.status, "in_progress", "未确认前保持进行中");
  const res2 = await focusActionRoute(authedReq(`/api/v2/focus/${f.id}/stop`, { expectedVersion: f.version, confirm: true }, "idem-fstop4"), params(f.id, "stop"));
  assert.equal(res2.status, 200);
});
