import assert from "node:assert/strict";
import { test } from "node:test";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { assertStopped, OpsError, webLooksAlive } from "@/scripts/ops-lib";

/** 起一个只回固定响应的本地服务，返回 baseUrl 与关闭函数 */
async function serve(status: number, contentType: string, body: string): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer((_req, res) => {
    res.writeHead(status, { "content-type": contentType });
    res.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const NO_DB = "/nonexistent/dash-campus.db"; // 不存在的库：worker 心跳检查视为已停止

test("web 已停、反向代理仍回 502 页面：不算运行中，备份检查放行", async () => {
  const proxy = await serve(502, "text/html", "<html><body>502 Bad Gateway</body></html>");
  try {
    assert.equal(await webLooksAlive(proxy.url), false);
    await assertStopped(NO_DB, proxy.url);
  } finally {
    await proxy.close();
  }
});

test("本应用的健康响应（200 或数据库异常 503）都算运行中，备份检查拒绝", async () => {
  for (const status of [200, 503]) {
    const app = await serve(
      status,
      "application/json",
      JSON.stringify({ ok: status === 200, service: "dash-campus", db: status === 200 ? "ok" : "error" }),
    );
    try {
      assert.equal(await webLooksAlive(app.url), true, `status ${status}`);
      await assert.rejects(assertStopped(NO_DB, app.url), OpsError);
    } finally {
      await app.close();
    }
  }
});

test("其他服务的 JSON 不算本应用；端口没有服务也不算运行中", async () => {
  const other = await serve(200, "application/json", JSON.stringify({ ok: true, service: "something-else" }));
  const url = other.url;
  try {
    assert.equal(await webLooksAlive(url), false);
  } finally {
    await other.close();
  }
  assert.equal(await webLooksAlive(url), false, "服务关闭后连接失败");
});
