import Link from "next/link";
import type { ReactNode } from "react";
import styles from "./AppShell.module.css";
import Icon, { type IconName } from "./Icon";
import SessionGuard from "./SessionGuard";
import ShellExtras, { RestoreHoldBanner } from "./ShellExtras";
import ThemeToggle from "./ThemeToggle";

const NAV_ITEMS: Array<{ href: string; label: string; icon: IconName }> = [
  { href: "/today", label: "今天", icon: "today" },
  { href: "/plan", label: "计划", icon: "plan" },
  { href: "/explore", label: "探索", icon: "explore" },
  { href: "/inbox", label: "收件箱", icon: "inbox" },
  { href: "/reviews", label: "回顾", icon: "reviews" },
];

/**
 * AppShell：
 * - ≥768px：左侧栏（品牌、写记录、五项主导航、近期项目、主题与设置）；768–1099px 侧栏收窄。
 * - <768px：顶部一行（品牌、设置、写记录）+ 底部固定标签栏放五项主导航，拇指够得到。
 * 五项主导航固定；近期项目最多三个；"写记录"入口在任何宽度都看得见。
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
          <Link href="/today" className={styles.brand}>
            <span className={styles.brandMark} aria-hidden="true">
              D
            </span>
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
            <Link href="/today#quick-log" className={styles.quickLog}>
              <Icon name="pencil" size={16} />
              写记录
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
                <Icon name={item.icon} size={20} className={styles.navIcon} />
                <span>{item.label}</span>
              </Link>
            );
          })}
        </nav>
        <ShellExtras />
        <div className={styles.sidebarFoot}>
          <Link
            href="/settings"
            className={settingsActive ? `${styles.settingsLink} ${styles.navActive}` : styles.settingsLink}
            aria-current={settingsActive ? "page" : undefined}
          >
            <Icon name="settings" size={20} className={styles.navIcon} />
            <span>设置</span>
          </Link>
          <ThemeToggle />
        </div>
      </aside>
      <SessionGuard />
      <main id="main" className={styles.main} tabIndex={-1}>
        <RestoreHoldBanner />
        {children}
      </main>
    </div>
  );
}
