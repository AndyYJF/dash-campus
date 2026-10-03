import { campusFeedSchema } from "@/domain/campus-bridge";

/** 单次全量轮询；交给用户自己的 timer 调度。无状态游标，失败项下次重试不会丢。 */
function env(name: string): string { const v = process.env[name]; if (!v) throw new Error(`缺少 ${name}`); return v; }
function base(name: string): URL {
  const url = new URL(env(name));
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error(`${name} 仅接受无凭证的 http(s) 基础地址`);
  return url;
}
async function main() {
  const upstream = base("CAMPUS_BRIDGE_UPSTREAM_URL"), target = base("CAMPUS_BRIDGE_TARGET_URL");
  const feedUrl = new URL("/api/todo/v1/tasks?status=all", upstream);
  const feed = await fetch(feedUrl, { headers: { Authorization: `Bearer ${env("CAMPUS_BRIDGE_UPSTREAM_TOKEN")}` }, signal: AbortSignal.timeout(20000), redirect: "error" });
  if (!feed.ok) throw new Error(`上游 HTTP ${feed.status}`);
  // 流式上限，防止反复轮询带回无界 JSON；错误不打印含 token 的 URL/响应正文。
  const reader = feed.body?.getReader(); if (!reader) throw new Error("上游无正文");
  const chunks: Uint8Array[] = []; let size = 0;
  for (;;) {
    const part = await reader.read(); if (part.done) break;
    size += part.value.byteLength; if (size > 10 * 1024 * 1024) { await reader.cancel(); throw new Error("上游正文超过10 MiB"); }
    chunks.push(part.value);
  }
  const parsed = campusFeedSchema.safeParse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
  if (!parsed.success) throw new Error("上游任务格式不兼容");
  const source = env("CAMPUS_BRIDGE_SOURCE_ID"), token = env("CAMPUS_BRIDGE_IMPORT_TOKEN");
  const counts = { total: parsed.data.tasks.length, created: 0, replay: 0, history: 0, revision_conflict: 0, linked: 0, failed: 0 };
  // Import older revisions first so a first full history pull leaves current items at the top.
  for (const task of parsed.data.tasks.slice().sort((a, b) => Date.parse(a.updated_at) - Date.parse(b.updated_at) || a.task_id.localeCompare(b.task_id))) {
    try {
      const response = await fetch(new URL("/api/v1/legacy/campus", target), { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ source, task }), signal: AbortSignal.timeout(20000), redirect: "error" });
      if (!response.ok) { counts.failed++; console.error(`桥接事项 ${task.task_id}：HTTP ${response.status}`); continue; }
      const body = await response.json() as { kind: string; linked?: boolean };
      if (body.kind === "created" || body.kind === "replay" || body.kind === "history" || body.kind === "revision_conflict") counts[body.kind]++;
      else counts.failed++;
      if (body.linked) counts.linked++;
    } catch { counts.failed++; console.error(`桥接事项 ${task.task_id}：请求失败，下次轮询重试`); }
  }
  console.log(JSON.stringify(counts));
  if (counts.failed) process.exitCode = 1;
}
main().catch(() => { console.error("校园桥接失败：检查私有环境文件、服务连通性、来源 token 和插件接口版本；未回写上游。"); process.exitCode = 1; });
