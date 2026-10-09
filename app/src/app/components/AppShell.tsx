import Link from "next/link";
import type { ReactNode } from "react";
import styles from "./AppShell.module.css";
import BrandMark from "./BrandMark";
import Icon, { type IconName } from "./Icon";
import SessionGuard from "./SessionGuard";
import ShellExtras, { RestoreHoldBanner } from "./ShellExtras";
import ThemeToggle from "./ThemeToggle";
import AgentLauncher from "./AgentLauncher";
import DemoBar from "./DemoBar";

/** 主导航为今天、本周、方向、AI资讯、对话；收件箱/回顾/探索记录入口放在方向页底部 */
const NAV_ITEMS: Array<{ href: string; label: string; icon: IconName }> = [
  { href: "/today", label: "今天", icon: "today" },
  { href: "/week", label: "本周", icon: "calendar" },
  { href: "/direction", label: "方向", icon: "target" },
  { href: "/news", label: "AI资讯", icon: "inbox" },
  { href: "/chat", label: "对话", icon: "pencil" },
];

/**
 * AppShell（纸面/手册风）：
 * - ≥1024px：左侧一栏直接印在纸面上（刊名、五个栏目、近期项目、设置与主题），与正文之间只有一条细线。
 * - <1024px：顶部一行刊头——刊标、栏目标签、设置；工作台底部保留 Agent 入口。
 * 正文不再套圆角面板；Agent 输入由根布局里的 GlobalAgent 固定在底部。
 */
export default function AppShell({
  children,
  currentPath,
}: {
  children: ReactNode;
  currentPath: string;
}) {
  const settingsActive = currentPath === "/settings";
  return (
    <div className={styles.shell}>
      <a href="#main" className={styles.skip}>
        跳到主要内容
      </a>
      <aside className={styles.sidebar}>
        <div className={styles.brandRow}>
          <Link href="/today" className={styles.brand} aria-label="Dash Campus 首页">
            <BrandMark />
            <span className={styles.brandName}>Dash Campus</span>
          </Link>
          <div className={styles.topActions}>
            <Link
              href="/settings"
              className={settingsActive ? `${styles.iconLink} ${styles.iconLinkActive}` : styles.iconLink}
              aria-label="设置"
              aria-current={settingsActive ? "page" : undefined}
            >
              <Icon name="settings" size={20} />
            </Link>
          </div>
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
                <span className={styles.navIcon}>
                  <Icon name={item.icon} size={17} />
                </span>
                <span>{item.label}</span>
              </Link>
            );
          })}
        </nav>
        <AgentLauncher className={styles.quickLog}>
          <span className={styles.navIcon}>
            <Icon name="pencil" size={16} />
          </span>
          <span>说一句</span>
          <kbd className={styles.kbd}>Ctrl K</kbd>
        </AgentLauncher>
        <ShellExtras />
        <div className={styles.sidebarFoot}>
          <Link
            href="/settings"
            className={settingsActive ? `${styles.settingsLink} ${styles.navActive}` : styles.settingsLink}
            aria-current={settingsActive ? "page" : undefined}
          >
            <span className={styles.navIcon}>
              <Icon name="settings" size={17} />
            </span>
            <span>设置</span>
          </Link>
          <ThemeToggle />
        </div>
      </aside>
      <SessionGuard />
      <main id="main" className={styles.main} tabIndex={-1}>
        <div className={styles.content}>
          <RestoreHoldBanner />
          <DemoBar />
          {children}
        </div>
      </main>
    </div>
  );
}
