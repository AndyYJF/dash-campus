// 本地真实网页走查（隔离开发库 + 示例模型）：登录 → 统一输入投课表/回答/建任务/下指令 → 三页截图。
// 用法：BASE=http://localhost:3100 PASSWORD=... OUT=<截图目录> node scripts/dev/web-walkthrough.mjs
// 需要 chromium；只对 BASE 指向的实例操作，不要指向生产。
import { chromium } from "playwright-core";
import fs from "node:fs";

const BASE = process.env.BASE ?? "http://localhost:3100";
const PASSWORD = process.env.PASSWORD ?? "dev-password-123";
const OUT = process.env.OUT ?? "./shots";
const SETUP_TOKEN = process.env.SETUP_TOKEN ?? "dev-setup-token";
const EXEC = process.env.CHROMIUM ?? "/usr/local/bin/chromium";
fs.mkdirSync(OUT, { recursive: true });

const log = (...a) => console.log("[walk]", ...a);
const setup = await fetch(`${BASE}/api/v1/setup`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: SETUP_TOKEN, password: PASSWORD }) });
log("setup", setup.status);

const browser = await chromium.launch({ executablePath: EXEC, args: ["--no-sandbox"] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "zh-CN", timezoneId: "Asia/Shanghai" });
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));

await page.goto(`${BASE}/login`);
await page.fill('input[type="password"]', PASSWORD);
await page.click('button[type="submit"]');
await page.waitForURL("**/today");
log("logged in");

const box = page.locator("#intake textarea");
async function say(text, { waitFor = /已更新|已保存|需要你回答|没有办成|部分完成/ } = {}) {
  await box.fill(text);
  await page.click('#intake button:has-text("发送")');
  await page.waitForFunction((t) => !document.querySelector("#intake textarea").value, null, { timeout: 15000 });
  // 等这条的结果卡落定（worker 每 5 秒轮询一次）
  await page.waitForFunction(
    ([re]) => {
      const first = document.querySelector("#intake ul li");
      return first && new RegExp(re).test(first.textContent ?? "");
    },
    [waitFor.source],
    { timeout: 40000 },
  );
  const head = await page.locator("#intake ul li").first().innerText();
  log("said:", text.split("\n")[0].slice(0, 30), "→", head.replace(/\n/g, " | ").slice(0, 160));
}
async function answerFirst(text) {
  const q = page.locator("#intake input[aria-label='回答这个问题']").first();
  await q.fill(text);
  await q.press("Enter");
  await page.waitForTimeout(7000);
  log("answered:", text);
}

const SDCT = ["SDCT1", "T=18", "P=1,08:15-09:00;2,09:10-09:55;3,10:15-11:00;4,11:10-11:55;5,14:00-14:45;6,14:55-15:40;7,16:00-16:45;8,16:55-17:40", "C=高等数学|张老师|A101|1|1-2|1-18|A|-", "C=大学物理|王老师|C303|1|3-4|1-18|A|-", "C=线性代数|赵老师|D404|2|1-2|1-18|A|-", "C=程序设计基础（含一个很长的课程名称用来检查换行）|李老师|实验楼B座305机房|3|1-4|1-18|A|-", "C=大学英语|陈老师|E201|3|5-6|1-18|A|-", "C=形势与政策|周老师|报告厅|3|5-6|6,10|A|-", "C=体育|吴老师|操场|4|7-8|1-18|A|-", "C=离散数学|郑老师|A203|5|3-4|1-18|A|-"].join("\n");
await say(SDCT, { waitFor: /需要你回答/ });
await answerFirst("第6周");
await page.waitForTimeout(3000);
await say("明天前要交操作系统实验报告，预计两小时");
await say("这周复现一个分类基线，预计一小时");
await say("这学期先打好数学基础");
await page.screenshot({ path: `${OUT}/01-today-desktop.png`, fullPage: true });

await page.goto(`${BASE}/week`);
await page.waitForSelector("text=课程占用");
await page.waitForTimeout(800);
await page.screenshot({ path: `${OUT}/02-week-desktop.png`, fullPage: true });
// 点一门课看详情
await page.locator('button[aria-label^="课：高等数学"]').first().click();
await page.waitForSelector("text=这次停课");
await page.screenshot({ path: `${OUT}/03-week-course-detail.png`, fullPage: false });

await page.goto(`${BASE}/direction`);
await page.waitForSelector("text=当前主要方向");
await page.screenshot({ path: `${OUT}/04-direction-desktop.png`, fullPage: true });

// 自然语言修改 + 回答作息问题
await page.goto(`${BASE}/today`);
await page.waitForSelector("text=下一步");
const routine = page.locator("#intake button:has-text('按你推荐的来')");
if (await routine.count()) {
  await routine.first().click();
  await page.waitForTimeout(7000);
  log("routine confirmed");
}
await say("以后周三少排点，最多一小时");
await say("今晚不学了");
await page.screenshot({ path: `${OUT}/05-today-after-commands.png`, fullPage: true });

for (const [w, h, tag] of [[390, 844, "390"], [320, 640, "320"]]) {
  await page.setViewportSize({ width: w, height: h });
  for (const path of ["today", "week", "direction"]) {
    await page.goto(`${BASE}/${path}`);
    await page.waitForTimeout(1500);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    log(`${path}@${tag} 横向溢出像素:`, overflow);
    await page.screenshot({ path: `${OUT}/m${tag}-${path}.png`, fullPage: true });
  }
}
log("page errors:", errors.length ? errors.slice(0, 5) : "none");
await browser.close();
