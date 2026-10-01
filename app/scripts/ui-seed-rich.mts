/**
 * 更丰富的界面示例数据（在 ui-seed.mts 之后运行）：逾期/高优先/进行中任务、本周重点、
 * 收件箱通知、一次探索、一次卡点分析、一次周复盘。
 * 探索、卡点分析、复盘要有 worker 在跑，并且 MODEL_PROTOCOL=fake / SEARCH_PROVIDER=fake（示例数据，不调真实服务）。
 * 每一步独立容错：某类数据建不出来不影响其他数据。最后打印详情页路径，方便截图。
 */
const BASE = process.env.UI_BASE ?? "http://localhost:3217";
const B = `${BASE}/api/v1`;
const TZ = "Asia/Shanghai";
const PASSWORD = process.env.UI_PASSWORD ?? "smoke-pass-123";

let cookie = "";
let csrf = "";

async function call(
  method: string,
  path: string,
  body?: unknown,
  extra: Record<string, string> = {},
): Promise<Record<string, unknown>> {
  const res = await fetch(`${B}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(cookie ? { cookie, "x-csrf-token": csrf } : {}),
      ...extra,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const setCookie = res.headers.get("set-cookie");
  if (setCookie) cookie = setCookie.split(";")[0];
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new Error(`${method} ${path} ${res.status} ${JSON.stringify(json).slice(0, 200)}`);
  return json;
}

async function step(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`✔ ${name}`);
  } catch (e) {
    console.log(`✖ ${name}：${e instanceof Error ? e.message : String(e)}`);
  }
}

const addDays = (date: string, n: number) => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const today = new Date().toLocaleDateString("en-CA", { timeZone: TZ });
const monday = addDays(today, -((new Date(`${today}T00:00:00Z`).getUTCDay() + 6) % 7));
const week = { localMonday: monday, timezone: TZ };

csrf = (await call("POST", "/auth/login", { password: PASSWORD })).csrfToken as string;
const projects = (await call("GET", "/projects")).projects as Array<{ id: string }>;
const pid = projects[0]?.id;
const paths: string[] = [];
if (pid) paths.push(`/projects/${pid}`);

await step("本周重点", async () => {
  await call(
    "PUT",
    "/planning/week/focus",
    { localMonday: monday, timezone: TZ, title: "让温湿度记录器连续跑满三天", goalId: null, projectId: pid ?? null },
    { "idempotency-key": "ui-rich-focus" },
  );
});

await step("逾期的高优先任务", async () => {
  await call(
    "POST",
    "/tasks",
    { title: "交实验报告初稿", priority: "high", estimateMinutes: 90, plannedWeek: week, due: { kind: "date", localDate: addDays(today, -1), timezone: TZ } },
    { "idempotency-key": "ui-rich-t-overdue" },
  );
});

await step("进行中的任务 + 今天的时段", async () => {
  const created = await call(
    "POST",
    "/tasks",
    { title: "焊接传感器排针并测试读数", projectId: pid ?? null, estimateMinutes: 45, plannedWeek: week },
    { "idempotency-key": "ui-rich-t-doing" },
  );
  const task = (await call("GET", `/tasks/${created.id as string}`)).task as { id: string; version: number };
  await call("PATCH", `/tasks/${task.id}`, { expectedVersion: task.version, status: "doing" });
});

await step("三天后截止的任务", async () => {
  await call(
    "POST",
    "/tasks",
    { title: "整理一周的温湿度数据并画图", projectId: pid ?? null, estimateMinutes: 60, due: { kind: "date", localDate: addDays(today, 3), timezone: TZ } },
    { "idempotency-key": "ui-rich-t-soon" },
  );
});

await step("收件箱：来源 + 两条通知", async () => {
  const src = await call("POST", "/inbox/sources", { id: "weixin-group", title: "班级群" });
  const auth = { authorization: `Bearer ${src.token as string}` };
  const notice = (externalId: string, text: string, title: string, level: string) => ({
    schemaVersion: 1,
    source: "weixin-group",
    externalId,
    revisionKey: "r1",
    revisionOrder: 1,
    occurredAt: new Date().toISOString(),
    text,
    structured: {
      noticeType: "campus_event",
      condition: { kind: "leaf", field: "education_level", op: "eq", value: level, quote: text.slice(0, 12) },
      action: { actionKey: `${externalId}-a`, title, description: "", required: true },
    },
  });
  const first = await call("POST", "/inbox/import", notice("ui-n1", "面向所有本科一年级学生，周五前提交实验室安全培训回执。", "提交安全培训回执", "本科一年级"), auth);
  await call("POST", "/inbox/import", notice("ui-n2", "研究生奖学金申请本周开放，需在系统内填写申请表并上传成绩单。", "填写奖学金申请表", "研究生"), auth);
  if (first.messageId) paths.push(`/inbox/${first.messageId as string}`);
});

await step("一次探索（示例模型）", async () => {
  const r = await call("POST", "/explorations", { query: "我想了解机器学习入门实践" }, { "idempotency-key": "ui-rich-explore" });
  const id = (r.id ?? r.runId) as string | undefined;
  if (id) paths.push(`/explore/${id}`);
});

await step("带卡点的记录 + 卡点分析（示例模型）", async () => {
  const log = (await call("POST", "/logs", {
    clientEntryId: "c0ffee00-0000-4000-8000-00000000ab01",
    occurredOn: today,
    progress: "读完了传感器数据手册",
    blocker: "不确定上拉电阻该用多大",
    projectId: pid ?? null,
  })).log as { id: string };
  if (pid) {
    await call("POST", "/assistant/requests", { scopeType: "project", scopeId: pid, logId: log.id }, { "idempotency-key": "ui-rich-assist" });
  }
});

await step("本周复盘", async () => {
  const r = await call("POST", "/reviews/generate", { localMonday: monday }, { "idempotency-key": "ui-rich-review" });
  const id = (r.id ?? r.reviewId) as string | undefined;
  if (id) paths.push(`/reviews/${id}`);
});

console.log(`详情页：${paths.join(",")}`);
