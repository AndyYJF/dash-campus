/**
 * 界面截图小工具（开发时看效果用，不做断言）。
 * 用法：UI_BASE=http://127.0.0.1:3000 npx tsx scripts/ui-shot.mts /today,/plan 1440,390 light,dark
 * 需要 Chromium 系浏览器：EDGE_PATH 指定可执行文件；登录密码用 UI_PASSWORD。输出到 data/ui-shots/。
 */
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright-core";

const BASE = process.env.UI_BASE ?? "http://localhost:3217";
const BROWSER = process.env.EDGE_PATH ?? "/usr/bin/google-chrome";
const PASSWORD = process.env.UI_PASSWORD ?? "smoke-pass-123";
const OUT = path.resolve("data/ui-shots");

const pages = (process.argv[2] ?? "/today").split(",");
const widths = (process.argv[3] ?? "1440").split(",").map(Number);
const schemes = (process.argv[4] ?? "light").split(",") as Array<"light" | "dark">;
// 第 5 个参数为 "fold" 时只截首屏，否则整页
const fullPage = process.argv[5] !== "fold";

fs.mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ executablePath: BROWSER, headless: true });
for (const scheme of schemes) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: scheme, reducedMotion: "reduce" });
  const page = await ctx.newPage();
  if (!pages.every((p) => p === "/login" || p === "/setup")) {
    await page.goto(`${BASE}/login`);
    await page.fill("input[type=password]", PASSWORD);
    await page.click("button[type=submit]");
    await page.waitForURL(/\/today/);
  }
  for (const w of widths) {
    await page.setViewportSize({ width: w, height: w < 768 ? 800 : 900 });
    for (const p of pages) {
      await page.goto(`${BASE}${p}`);
      await page.waitForLoadState("networkidle");
      await page.waitForTimeout(300);
      const name = `${scheme}-${w}-${p.replace(/^\//, "").replace(/[^\w-]+/g, "_") || "root"}.png`;
      await page.screenshot({ path: path.join(OUT, name), fullPage });
      console.log(name);
    }
  }
  await ctx.close();
}
await browser.close();
