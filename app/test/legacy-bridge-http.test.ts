import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { before, test } from "node:test";
import { NextRequest } from "next/server";
import { migrateAll, getDb } from "./helpers";
import { createSource } from "@/repositories/inbox";
import { POST as campusRoute } from "@/app/api/v1/legacy/campus/route";

before(migrateAll);
test("真实 CLI 子进程经 HTTP mock 插件→实际兼容 route：Bearer、重放、部分失败可重试，日志不含 token", async () => {
  const source = createSource("http-campus", "HTTP示例来源"); let changed = false; let failOne = false;
  const upstreamSecret = "synthetic-upstream-secret";
  const upstream = http.createServer((req, res) => {
    assert.equal(req.headers.authorization, `Bearer ${upstreamSecret}`);
    assert.equal(req.url, "/api/todo/v1/tasks?status=all");
    const task = (id: string) => ({ task_id: id, revision: 1, title: changed && id === "a" ? "相同 revision 的不同正文" : "通知", description: "旧插件摘要", status: "open", updated_at: "2026-10-03T00:00:00Z", sources: [{ text: "研究生讲座，请报名。" }] });
    res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ tasks: [task("a"), task("b")] }));
  });
  const target = http.createServer(async (req, res) => {
    assert.equal(req.url, "/api/v1/legacy/campus");
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString("utf8");
    if (failOne && JSON.parse(body).task.task_id === "b") { res.writeHead(503); res.end("unavailable"); return; }
    try {
      const response = await campusRoute(new NextRequest("http://localhost/api/v1/legacy/campus", { method: "POST", headers: { authorization: req.headers.authorization ?? "", "content-type": "application/json" }, body }));
      res.writeHead(response.status, { "Content-Type": "application/json" }); res.end(await response.text());
    } catch { res.writeHead(500); res.end(); }
  });
  upstream.listen(0, "127.0.0.1"); target.listen(0, "127.0.0.1");
  await Promise.all([once(upstream, "listening"), once(target, "listening")]);
  const url = (server: http.Server) => `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  async function run() {
    const child = spawn(process.execPath, ["node_modules/tsx/dist/cli.mjs", "src/scripts/campus-bridge.ts"], { env: { ...process.env,
      CAMPUS_BRIDGE_UPSTREAM_URL: url(upstream), CAMPUS_BRIDGE_UPSTREAM_TOKEN: upstreamSecret,
      CAMPUS_BRIDGE_TARGET_URL: url(target), CAMPUS_BRIDGE_IMPORT_TOKEN: source.token, CAMPUS_BRIDGE_SOURCE_ID: source.source.id }, stdio: ["ignore", "pipe", "pipe"] });
    let out = "", errors = "";
    child.stdout.on("data", (d) => { out += d; }); child.stderr.on("data", (d) => { errors += d; });
    const [exit] = await once(child, "close");
    assert.equal((out + errors).includes(upstreamSecret), false); assert.equal((out + errors).includes(source.token), false);
    return { exit, counts: JSON.parse(out.trim()), errors };
  }
  try {
    failOne = true; const partial = await run(); assert.equal(partial.exit, 1); assert.equal(partial.counts.created, 1); assert.equal(partial.counts.failed, 1);
    failOne = false; const retry = await run(); assert.equal(retry.exit, 0); assert.equal(retry.counts.replay, 1); assert.equal(retry.counts.created, 1);
    const replay = await run(); assert.equal(replay.exit, 0); assert.equal(replay.counts.replay, 2);
    changed = true; const collision = await run(); assert.equal(collision.exit, 1); assert.equal(collision.counts.failed, 1); assert.match(collision.errors, /409/);
    assert.equal((getDb().prepare("SELECT count(*) AS n FROM inbox_messages").get() as { n: number }).n, 2);
    assert.equal((getDb().prepare("SELECT count(*) AS n FROM tasks").get() as { n: number }).n, 0);
  } finally {
    await Promise.all([new Promise<void>((resolve) => upstream.close(() => resolve())), new Promise<void>((resolve) => target.close(() => resolve()))]);
  }
});
