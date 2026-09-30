/** 界面检查的示例数据（fixture 库，独立端口）。node fetch 发送，保证中文是 UTF-8。 */
const BASE = process.env.UI_BASE ?? "http://localhost:3217";
const B = `${BASE}/api/v1`;
const TZ = "Asia/Shanghai";

let cookie = "";
let csrf = "";

async function call(path: string, body: unknown, key?: string): Promise<Record<string, unknown>> {
  const res = await fetch(`${B}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(cookie ? { cookie, "x-csrf-token": csrf } : {}),
      ...(key ? { "idempotency-key": key } : {}),
    },
    body: JSON.stringify(body),
  });
  const setCookie = res.headers.get("set-cookie");
  if (setCookie) cookie = setCookie.split(";")[0];
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok && res.status !== 409) throw new Error(`${path} ${res.status} ${JSON.stringify(json)}`);
  return json;
}

const today = new Date().toLocaleDateString("en-CA", { timeZone: TZ });
const d = new Date(`${today}T00:00:00Z`);
d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
const monday = d.toISOString().slice(0, 10);

await call("/setup", { token: "ui-check-token", password: "smoke-pass-123" }).catch(() => {});
csrf = (await call("/auth/login", { password: "smoke-pass-123" })).csrfToken as string;

const project = await call(
  "/projects",
  {
    title: "用树莓派做一个宿舍温湿度记录器（验证嵌入式方向）",
    question: "我是否喜欢硬件调试",
    expectedOutcome: "能连续记录一周数据",
    prerequisites: "",
    reviewQuestions: "",
  },
  "ui-p",
);
const pid = project.id as string;
for (const i of [1, 2, 3]) {
  await call(
    "/tasks",
    {
      title: `任务 ${i}：一个相当长的中文任务标题，用来检查窄屏下是否会换行而不是横向溢出 https://example.org/a/very/long/path/that/should/wrap/${i}`,
      projectId: pid,
      estimateMinutes: i * 30,
      plannedWeek: { localMonday: monday, timezone: TZ },
      due: { kind: "date", localDate: today, timezone: TZ },
    },
    `ui-t${i}`,
  );
}
await call("/tasks", { title: "没有估时的任务", plannedWeek: { localMonday: monday, timezone: TZ } }, "ui-t4");
await call("/logs", { clientEntryId: "ui-log-1", occurredOn: today, progress: "接好了传感器", blocker: "I2C 地址读不到", projectId: pid });
await call(
  "/artifacts",
  {
    projectId: pid,
    kind: "link",
    title: "接线笔记",
    body: "",
    url: "https://example.org/notes/a-really-long-url-without-any-breaks-0123456789abcdefghijklmnopqrstuvwxyz",
  },
  "ui-a",
);
for (const w of [1, 2, 3, 4, 5, 6, 7]) {
  await call("/availability?kind=availability", { title: "晚上", weekday: w, localStart: "19:00", localEnd: "22:00", timezone: TZ }, `ui-av${w}`);
}
console.log("示例数据已写入");
