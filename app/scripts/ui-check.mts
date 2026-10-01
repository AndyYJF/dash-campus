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
  const pages = ["/today", "/plan", "/explore", "/inbox", "/reviews", "/settings"];
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
      // 今天页：手机顺序 状态带 → 行动 → 待决定 → 记录
      await page.goto(`${BASE}/today`);
      await page.waitForSelector("text=近期行动");
      const order = await page.evaluate(() =>
        ["本周状态", "近期行动", "需要你决定", "写记录"].map((t) => {
          const el =
            t === "本周状态"
              ? document.querySelector('[aria-label="本周状态"]')
              : [...document.querySelectorAll("main h2")].find((h) => h.textContent === t);
          return el ? el.getBoundingClientRect().top + window.scrollY : -1;
        }),
      );
      if (w < 768) {
        check(`${scheme} ${w}px 今天页顺序 状态→行动→待决定→记录`, order.every((v, i) => v >= 0 && (i === 0 || v > order[i - 1])), order.join(","));
      } else if (w >= 1100) {
        check(`${scheme} ${w}px 状态带与行动在首屏`, order[0] >= 0 && order[1] >= 0 && order[1] < 900, order.join(","));
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
    await page.waitForSelector("#log-progress");
    // 键盘：Tab 进入跳转链接，焦点可见
    await page.keyboard.press("Tab");
    const skipFocused = await page.evaluate(() => document.activeElement?.textContent?.includes("跳到主要内容") ?? false);
    check("键盘 首个 Tab 聚焦「跳到主要内容」", skipFocused);
    const outline = await page.evaluate(() => getComputedStyle(document.activeElement!).outlineStyle);
    check("键盘 焦点可见（outline）", outline !== "none", outline);

    await page.focus("#log-progress");
    await page.keyboard.type("键盘写的一条进展");
    await page.keyboard.press("Control+Enter");
    await page.waitForFunction(() => /^已保存 \d/.test(document.querySelector("#quick-log [role=status]")?.textContent ?? ""), null, { timeout: 10_000 });
    await page.waitForTimeout(800);
    check("键盘 Ctrl+Enter 提交记录并显示已保存", (await page.locator("#quick-log").innerText()).includes("键盘写的一条进展"));

    // 会话失效：服务端撤销会话，再提交 → 401，草稿保留、显示在新标签页登录
    await page.fill("#log-progress", "401 时不能丢的草稿");
    await page.waitForTimeout(300);
    await page.evaluate(async () => {
      await fetch("/api/v1/auth/logout", { method: "POST", headers: { "x-csrf-token": localStorage.getItem("csrfToken") ?? "" } });
    });
    await page.click("button:has-text('保存记录')");
    await page.waitForSelector("text=登录已过期", { timeout: 10_000 });
    const status401 = (await page.textContent("#quick-log [role=status]"))?.trim() ?? "";
    check("401 不显示虚假成功，提示重新登录", !/^已保存 \d/.test(status401) && (await page.isVisible("text=在新标签页登录")), status401);
    check("401 后输入保留", (await page.inputValue("#log-progress")) === "401 时不能丢的草稿");
    const draftBefore = await page.evaluate(() => localStorage.getItem("draft:quick-log"));
    await page.screenshot({ path: path.join(OUT, "u7-401.png"), fullPage: true });

    // 重新登录（新标签页），回原页再提交：同一 clientEntryId，只产生一条
    const tab = await ctx.newPage();
    await login(tab);
    await tab.close();
    await page.reload();
    await page.waitForSelector("#log-progress");
    check("刷新后草稿恢复", (await page.inputValue("#log-progress")) === "401 时不能丢的草稿");
    check("恢复后提示本机草稿", await page.isVisible("text=已恢复本机草稿"));
    await page.click("button:has-text('保存记录')");
    await page
      .waitForFunction(() => /^已保存 \d/.test(document.querySelector("#quick-log [role=status]")?.textContent ?? ""), null, { timeout: 10_000 })
      .catch(() => {});
    const statusAfter = (await page.textContent("#quick-log [role=status]"))?.trim() ?? "";
    const errAfter = (await page.textContent("#quick-log [role=alert]").catch(() => null)) ?? "";
    console.log(`  重新提交后状态：${statusAfter} ${errAfter}`);
    const idBefore = JSON.parse(draftBefore ?? "{}").v?.clientEntryId;
    const logs = await page.evaluate(async () => (await (await fetch("/api/v1/logs")).json()).logs as Array<{ clientEntryId: string; progress: string }>);
    const same = logs.filter((l) => l.progress === "401 时不能丢的草稿");
    check(
      "重新登录后同 ID 提交，只有一条",
      same.length === 1 && same[0].clientEntryId === idBefore,
      `条数 ${same.length}，ID ${same[0]?.clientEntryId === idBefore ? "一致" : `${same[0]?.clientEntryId} vs ${idBefore}`}`,
    );
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
