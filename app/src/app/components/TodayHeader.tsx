"use client";

import { useSyncExternalStore } from "react";
import styles from "./dash.module.css";

/** 每分钟刷新一次，跨过整点或零点时问候语和日期跟着变 */
function subscribe(onChange: () => void): () => void {
  const timer = setInterval(onChange, 60_000);
  return () => clearInterval(timer);
}

function clientText(): string {
  const now = new Date();
  const h = now.getHours();
  const greeting = h < 5 ? "夜深了" : h < 11 ? "早上好" : h < 13 ? "中午好" : h < 18 ? "下午好" : "晚上好";
  const date = now.toLocaleDateString("zh-CN", { month: "long", day: "numeric", weekday: "long" });
  return `${greeting}，今天是 ${date}`;
}

const WEEKDAYS = ["一", "二", "三", "四", "五", "六", "日"];

/** 从周一起的七天（纯日期运算，用 UTC 避开时区） */
function weekDates(localMonday: string): string[] {
  const d = new Date(`${localMonday}T00:00:00Z`);
  return WEEKDAYS.map(() => {
    const iso = d.toISOString().slice(0, 10);
    d.setUTCDate(d.getUTCDate() + 1);
    return iso;
  });
}

/**
 * 今天页页头：问候语按浏览器本地时间显示（服务端渲染时留空，水合后填入，不产生不一致）；
 * 右侧的本周七天用 /today 快照里的实例时区日期，快照到达前不显示。
 */
export default function TodayHeader({ localDate, localMonday }: { localDate?: string; localMonday?: string }) {
  const text = useSyncExternalStore(subscribe, clientText, () => "");
  return (
    <div className={styles.pageHeader}>
      <div>
        <h1>今天</h1>
        <p className={styles.pageSub}>{text || " "}</p>
      </div>
      {localDate && localMonday && (
        <ol className={styles.week} aria-label="本周日期">
          {weekDates(localMonday).map((iso, i) => {
            const state = iso === localDate ? styles.weekToday : iso < localDate ? styles.weekPast : "";
            return (
              <li key={iso} className={`${styles.weekDay} ${state}`} aria-current={iso === localDate ? "date" : undefined}>
                <span>{WEEKDAYS[i]}</span>
                <span className={styles.weekNum}>{Number(iso.slice(8))}</span>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
