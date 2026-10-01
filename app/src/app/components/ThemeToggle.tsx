"use client";

import { useSyncExternalStore } from "react";
import Icon, { type IconName } from "./Icon";
import styles from "./AppShell.module.css";

type Theme = "system" | "light" | "dark";

const OPTIONS: Array<{ value: Theme; label: string; icon: IconName }> = [
  { value: "light", label: "亮色", icon: "sun" },
  { value: "system", label: "跟随系统", icon: "monitor" },
  { value: "dark", label: "暗色", icon: "moon" },
];

const THEME_EVENT = "dash-theme-change";

function subscribe(onChange: () => void): () => void {
  // 本页切换用自定义事件通知；其他标签页的切换通过 storage 事件同步过来
  window.addEventListener(THEME_EVENT, onChange);
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(THEME_EVENT, onChange);
    window.removeEventListener("storage", onChange);
  };
}

function savedTheme(): Theme {
  try {
    const saved = localStorage.getItem("theme");
    return saved === "light" || saved === "dark" ? saved : "system";
  } catch {
    return "system"; // 本机存储不可用时保持跟随系统
  }
}

/** 主题切换：亮色 / 跟随系统 / 暗色。选择存在本机 localStorage.theme，layout 的内联脚本在首屏前应用。 */
export default function ThemeToggle() {
  // 服务端渲染按"跟随系统"，水合后读本机选择
  const theme = useSyncExternalStore(subscribe, savedTheme, () => "system" as Theme);

  function choose(next: Theme) {
    const root = document.documentElement;
    if (next === "system") root.removeAttribute("data-theme");
    else root.setAttribute("data-theme", next);
    try {
      if (next === "system") localStorage.removeItem("theme");
      else localStorage.setItem("theme", next);
    } catch {
      /* 存不下来也让本次切换生效 */
    }
    window.dispatchEvent(new Event(THEME_EVENT));
  }

  return (
    <div className={styles.theme} role="group" aria-label="主题">
      {OPTIONS.map((o) => (
        <button
          key={o.value}
          type="button"
          className={theme === o.value ? `${styles.themeBtn} ${styles.themeBtnActive}` : styles.themeBtn}
          aria-pressed={theme === o.value}
          title={o.label}
          onClick={() => choose(o.value)}
        >
          <Icon name={o.icon} size={16} />
          <span className="visually-hidden">{o.label}</span>
        </button>
      ))}
    </div>
  );
}
