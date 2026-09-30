import Link from "next/link";
import type { ReactNode } from "react";
import styles from "./AppShell.module.css";
import SessionGuard from "./SessionGuard";
import ShellExtras, { RestoreHoldBanner } from "./ShellExtras";

const NAV_ITEMS = [
  { href: "/today", label: "今天" },
  { href: "/plan", label: "计划" },
  { href: "/explore", label: "探索" },
  { href: "/inbox", label: "收件箱" },
  { href: "/reviews", label: "回顾" },
];

/**
 * AppShell（产品计划 5.2、5.6）：
 * ≥1100px 侧栏约 200px；768–1099px 侧栏约 152px；<768px 顶部五项横向主导航 + 单栏。
 * 五项主导航固定；近期项目最多三个快捷入口；设置在侧栏底部。全局"写记录"入口固定可找。
 */
export default function AppShell({
  children,
  currentPath,
}: {
  children: ReactNode;
  currentPath: string;
}) {
  return (
    <div className={styles.shell}>
      <a href="#main" className={styles.skip}>
        跳到主要内容
      </a>
      <aside className={styles.sidebar}>
        <div className={styles.brandRow}>
          <Link href="/today" className={styles.brand}>
            Dash Campus
          </Link>
          <Link href="/today#quick-log" className={styles.quickLog}>
            写记录
          </Link>
        </div>
        <nav className={styles.nav} aria-label="主导航">
          {NAV_ITEMS.map((item) => {
            const active = currentPath === item.href;
            return (
              <Link
                key={item.href}
                href={item.href}
                className={active ? `${styles.navLink} ${styles.navActive}` : styles.navLink}
                aria-current={active ? "page" : undefined}
              >
                {item.label}
              </Link>
            );
          })}
        </nav>
        <ShellExtras />
        <Link
          href="/settings"
          className={currentPath === "/settings" ? `${styles.settingsLink} ${styles.navActive}` : styles.settingsLink}
          aria-current={currentPath === "/settings" ? "page" : undefined}
        >
          设置
        </Link>
      </aside>
      <SessionGuard />
      <main id="main" className={styles.main} tabIndex={-1}>
        <RestoreHoldBanner />
        {children}
      </main>
    </div>
  );
}
