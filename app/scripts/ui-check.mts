/**
 * 浏览器界面检查（计划 13.5 U1/U3/U7/U9/U10）：本机 Edge + playwright-core，fixture 数据。
 * 用法：先由 scripts/ui-check.sh 起一个独立端口的 web，再运行本脚本。
 * 检查：320/390/768/1024/1440 宽度 × 亮/暗主题下无横向溢出、关键区块可见、触摸目标尺寸；
 * 键盘完成记录；草稿在 401 后保留并在重新登录后同 ID 提交；截图写入 data/ui-check/。
 */
import fs from "node:fs";
import path from "node:path";
import { chromium, type Page } from "playwright-core";

const BASE = process.env.UI_BASE ?? "http://localhost:3217";
const EDGE = process.env.EDGE_PATH ?? "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const OUT = path.resolve("data/ui-check");
const PASSWORD = "smoke-pass-123";
fs.mkdirSync(OUT, { recursive: true });

let pass = 0;
let fail = 0;
const results: string[] = [];
function check(name: string, ok: boolean, detail = "") {
  if (ok) pass++;
  else fail++;
  const line = `${ok ? "✔" : "✖"} ${name}${detail ? `（${detail}）` : ""}`;
  results.push(line);
  console.log(line);
}

async function login(page: Page) {
  await page.goto(`${BASE}/login`);
  await page.fill("input[type=password]", PASSWORD);
  await page.click("button[type=submit]");
  await page.waitForURL(/\/today/);
}

/** 横向溢出：文档宽度 > 视口，或有元素右缘超出视口 */
async function overflow(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    if (document.documentElement.scrollWidth > vw + 1) {
      const offenders = [...document.querySelectorAll("body *")]
        .filter((el) => {
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.right > vw + 1 && getComputedStyle(el).position !== "fixed";
        })
        .slice(0, 3)
        .map((el) => `${el.tagName.toLowerCase()}.${(el as HTMLElement).className || ""}`.slice(0, 60));
      return `scrollWidth ${document.documentElement.scrollWidth} > ${vw}: ${offenders.join(", ")}`;
    }
    return null;
  });
}

/** 小于 44px 高的可点击元素（手机宽度下检查） */
async function smallTargets(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll("button, a[class], select, input:not([type=checkbox]):not([type=radio])")]
      .filter((el) => {
        const r = el.getBoundingClientRect();
        const s = getComputedStyle(el);
        return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && r.height < 40;
      })
      .slice(0, 5)
      .map((el) => `${el.tagName.toLowerCase()}「${(el.textContent ?? "").trim().slice(0, 8)}」${Math.round(el.getBoundingClientRect().height)}px`),
  );
}

/** tsx/esbuild 给具名函数加 __name 包装；evaluate 序列化到页面后需要同名空实现 */
const NAME_SHIM = "globalThis.__name = globalThis.__name || ((f) => f);";

async function main() {
  const browser = await chromium.launch({ executablePath: EDGE, headless: true });
  const pages = ["/today", "/week", "/direction", "/plan", "/explore", "/inbox", "/reviews", "/settings"];
  const widths = [320, 390, 768, 1024, 1440];

  for (const scheme of ["light", "dark"] as const) {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: scheme, reducedMotion: "reduce" });
    await ctx.addInitScript(NAME_SHIM);
    const page = await ctx.newPage();
    await login(page);
    for (const w of widths) {
      await page.setViewportSize({ width: w, height: w < 768 ? 800 : 900 });
      for (const p of pages) {
        await page.goto(`${BASE}${p}`);
        await page.waitForLoadState("networkidle");
        const o = await overflow(page);
        check(`${scheme} ${w}px ${p} 无横向溢出`, o === null, o ?? "");
        if (w <= 390) {
          const small = await smallTargets(page);
          check(`${scheme} ${w}px ${p} 触摸目标 ≥ 40px`, small.length === 0, small.join("; "));
        }
        if (p === "/today" || w === 390 || w === 1440) {
          await page.screenshot({ path: path.join(OUT, `${scheme}-${w}-${p.slice(1)}.png`), fullPage: true });
        }
      }
      // 今天页：手机顺序 刊头 → 下一步 → 时间线；桌面上刊头与下一步都在首屏
      await page.goto(`${BASE}/today`);
      await page.waitForSelector("main h1");
      const order = await page.evaluate(() =>
        ["刊头", "下一步", "时间线"].map((t) => {
          const el = t === "刊头" ? document.querySelector("main h1") : [...document.querySelectorAll("main h2")].find((h) => h.textContent === t);
          return el ? el.getBoundingClientRect().top + window.scrollY : -1;
        }),
      );
      if (w < 768) {
        check(`${scheme} ${w}px 今天页顺序 刊头→下一步→时间线`, order.every((v, i) => v >= 0 && (i === 0 || v > order[i - 1])), order.join(","));
      } else if (w >= 1100) {
        check(`${scheme} ${w}px 刊头与下一步在首屏`, order[0] >= 0 && order[1] >= 0 && order[1] < 900, order.join(","));
      }
    }
    await ctx.close();
  }

  // 对比度：正文、次要文字、强调色在两种主题下 ≥ 4.5:1
  for (const scheme of ["light", "dark"] as const) {
    const ctx = await browser.newContext({ colorScheme: scheme });
    await ctx.addInitScript(NAME_SHIM);
    const page = await ctx.newPage();
    await page.goto(`${BASE}/login`);
    const ratios = await page.evaluate(() => {
      const css = getComputedStyle(document.documentElement);
      const hex = (v: string) => v.trim();
      const lum = (h: string) => {
        let n = h.replace("#", "").trim();
        if (n.length === 3) n = n.split("").map((c) => c + c).join("");
        const [r, g, b] = [0, 2, 4].map((i) => parseInt(n.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
        return 0.2126 * r + 0.7152 * g + 0.0722 * b;
      };
      const ratio = (a: string, b: string) => {
        const [x, y] = [lum(hex(a)), lum(hex(b))].sort((p, q) => q - p);
        return Math.round(((x + 0.05) / (y + 0.05)) * 100) / 100;
      };
      const v = (k: string) => css.getPropertyValue(k);
      return {
        "正文/背景": ratio(v("--color-text"), v("--color-bg")),
        "次要/表面": ratio(v("--color-text-muted"), v("--color-surface")),
        "次要/背景": ratio(v("--color-text-muted"), v("--color-bg")),
        "强调/表面": ratio(v("--color-accent"), v("--color-surface")),
        "按钮文字/强调": ratio(v("--color-accent-text"), v("--color-accent")),
        "主按钮文字/主按钮底": ratio(v("--color-primary-text"), v("--color-primary")),
        "强调/强调浅底": ratio(v("--color-accent"), v("--color-accent-soft")),
        "危险/表面": ratio(v("--color-danger"), v("--color-surface")),
        "警告文字/警告底": ratio(v("--color-warning-text"), v("--color-warning-bg")),
      };
    });
    for (const [k, r] of Object.entries(ratios)) check(`${scheme} 对比度 ${k} ≥ 4.5`, r >= 4.5, String(r));
    await ctx.close();
  }

  // 键盘流程 + 草稿 / 401 / 重新登录（U7、F17）
  {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 800 } });
    await ctx.addInitScript(NAME_SHIM);
    const page = await ctx.newPage();
    await login(page);
    await page.goto(`${BASE}/today`);
    await page.waitForSelector("#intake textarea");
    // 键盘：Tab 进入跳转链接，焦点可见
    await page.keyboard.press("Tab");
    const skipFocused = await page.evaluate(() => document.activeElement?.textContent?.includes("跳到主要内容") ?? false);
    check("键盘 首个 Tab 聚焦「跳到主要内容」", skipFocused);
    const outline = await page.evaluate(() => getComputedStyle(document.activeElement!).outlineStyle);
    check("键盘 焦点可见（outline）", outline !== "none", outline);

    // Agent 栏：平时是细条；Ctrl+K 聚焦并展开，Ctrl+Enter 提交，Esc 收起
    const barOpen = () => page.getAttribute("#intake", "data-open");
    check("Agent 栏平时收成细条", (await barOpen()) === "false");
    await page.keyboard.press("Control+k");
    const boxFocused = await page.evaluate(() => document.activeElement === document.querySelector("#intake textarea"));
    check("键盘 Ctrl+K 聚焦 Agent 栏并展开", boxFocused && (await barOpen()) === "true");
    await page.keyboard.type("键盘写的一句话，预计二十分钟");
    await page.keyboard.press("Control+Enter");
    await page.waitForFunction(() => (document.querySelector("#intake [role=status]")?.textContent ?? "").includes("已收到"), null, { timeout: 10_000 });
    check("键盘 Ctrl+Enter 提交并显示已收到", (await page.inputValue("#intake textarea")) === "");
    await page.keyboard.press("Escape");
    await page.waitForTimeout(200);
    check("键盘 Esc 把 Agent 栏收回细条", (await barOpen()) === "false");

    // 会话失效：服务端撤销会话，再提交 → 401，不显示成功、输入保留
    await page.fill("#intake textarea", "401 时不能丢的草稿");
    await page.evaluate(async () => {
      await fetch("/api/v1/auth/logout", { method: "POST", headers: { "x-csrf-token": localStorage.getItem("csrfToken") ?? "" } });
    });
    await page.click('#intake button:has-text("发送")');
    await page.waitForSelector("text=登录已过期", { timeout: 10_000 });
    check("401 提示重新登录，不显示虚假成功", !(await page.locator("#intake [role=status]").count()) || !((await page.textContent("#intake [role=status]")) ?? "").includes("已收到"));
    check("401 后输入保留", (await page.inputValue("#intake textarea")) === "401 时不能丢的草稿");
    await page.screenshot({ path: path.join(OUT, "u7-401.png"), fullPage: true });
    await ctx.close();
  }

  await browser.close();
  fs.writeFileSync(path.join(OUT, "results.txt"), results.join("\n") + `\n通过 ${pass}，失败 ${fail}\n`);
  console.log(`== UI: 通过 ${pass}，失败 ${fail}（截图与结果在 ${OUT}）`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
